import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';

async function startServer() {
  const store = createStore({ autoRun: false, executionDelayMs: 0 });
  const { server } = createApp({ store });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    store,
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

async function call(base, path, { userId, method = 'GET', body } = {}) {
  const headers = {};
  if (userId) headers['X-User-Id'] = userId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

test('未登录访问接口返回 401', async () => {
  const ctx = await startServer();
  try {
    const response = await call(ctx.base, '/api/orders');
    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, 'login_required');
  } finally {
    await ctx.close();
  }
});

test('客服不能跨站查询订单', async () => {
  const ctx = await startServer();
  try {
    const allowed = await call(ctx.base, '/api/orders?siteIds=site-a', { userId: 'agent-lin' });
    assert.equal(allowed.status, 200);
    assert.ok(allowed.json.orders.length > 0);
    assert.ok(allowed.json.orders.every((order) => order.order_no.startsWith('A2026')));
    assert.ok('contact_phone' in allowed.json.orders[0]);

    const denied = await call(ctx.base, '/api/orders?siteIds=site-b', { userId: 'agent-lin' });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error.code, 'sites_forbidden');

    const noContact = await call(ctx.base, '/api/orders?siteIds=site-b', { userId: 'agent-zhou' });
    assert.equal(noContact.status, 200);
    assert.equal('contact_phone' in noContact.json.orders[0], false);
  } finally {
    await ctx.close();
  }
});

test('完整场景：导出联系人 CSV → 撤销权限 → 旧地址失效 → 新申请可导出', async () => {
  const ctx = await startServer();
  try {
    const created = await call(ctx.base, '/api/exports', {
      userId: 'agent-lin',
      method: 'POST',
      body: {
        siteIds: ['site-a'],
        columns: ['order_no', 'status', 'contact_name', 'contact_phone'],
      },
    });
    assert.equal(created.status, 202);
    const jobId = created.json.job.id;
    assert.equal(created.json.job.status, 'queued');

    // 模拟排队任务执行
    ctx.store.executeJob(jobId);

    const readyJob = await call(ctx.base, `/api/exports/${jobId}`, { userId: 'agent-lin' });
    assert.equal(readyJob.json.job.status, 'ready');
    assert.equal(readyJob.json.job.file.downloadable, true);

    const firstDownload = await call(ctx.base, `/api/exports/${jobId}/download`, { userId: 'agent-lin' });
    assert.equal(firstDownload.status, 200);
    assert.match(firstDownload.headers.get('content-type'), /text\/csv/);
    assert.match(firstDownload.text, /联系人姓名/);
    assert.match(firstDownload.text, /138-0000-0101/);
    assert.equal(firstDownload.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, private');

    // 撤销联系人导出权限
    const revoked = await call(ctx.base, '/api/admin/users/agent-lin/access', {
      userId: 'admin',
      method: 'POST',
      body: { sites: ['site-a'], permissions: [] },
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.json.changed, true);
    assert.equal(revoked.json.invalidatedJobs, 1);

    // 旧文件不能从原地址取回
    const oldDownload = await call(ctx.base, `/api/exports/${jobId}/download`, { userId: 'agent-lin' });
    assert.equal(oldDownload.status, 410);
    assert.equal(oldDownload.json.error.code, 'permission_changed');

    const invalidatedJob = await call(ctx.base, `/api/exports/${jobId}`, { userId: 'agent-lin' });
    assert.equal(invalidatedJob.json.job.status, 'invalidated');
    assert.equal(invalidatedJob.json.job.needsReapply, true);

    // 也不能再用旧文件冒充新权限
    const otherJob = await call(ctx.base, `/api/exports/${jobId}`, { userId: 'agent-zhou' });
    assert.equal(otherJob.status, 404);

    // 新申请仍可导出甲站订单号和状态
    const reapply = await call(ctx.base, '/api/exports', {
      userId: 'agent-lin',
      method: 'POST',
      body: { siteIds: ['site-a'], columns: ['order_no', 'status'] },
    });
    assert.equal(reapply.status, 202);
    const newJobId = reapply.json.job.id;
    ctx.store.executeJob(newJobId);

    const newDownload = await call(ctx.base, `/api/exports/${newJobId}/download`, { userId: 'agent-lin' });
    assert.equal(newDownload.status, 200);
    assert.match(newDownload.text, /订单号/);
    assert.match(newDownload.text, /A20261116001/);
    assert.doesNotMatch(newDownload.text, /联系人/);
    assert.doesNotMatch(newDownload.text, /138-0000/);
  } finally {
    await ctx.close();
  }
});

test('排队时包含无权列会被拒绝，且不会创建任务', async () => {
  const ctx = await startServer();
  try {
    const denied = await call(ctx.base, '/api/exports', {
      userId: 'agent-zhou',
      method: 'POST',
      body: { siteIds: ['site-b'], columns: ['order_no', 'contact_phone'] },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error.code, 'columns_forbidden');

    const preview = await call(ctx.base, '/api/exports/preview', {
      userId: 'agent-zhou',
      method: 'POST',
      body: { siteIds: ['site-b'], columns: ['order_no', 'contact_phone'] },
    });
    assert.equal(preview.status, 403);

    const jobs = await call(ctx.base, '/api/exports', { userId: 'agent-zhou' });
    assert.equal(jobs.json.jobs.length, 0);
  } finally {
    await ctx.close();
  }
});

test('排队后权限被撤销：执行失败且无文件；页面提示按当前范围重新申请', async () => {
  const ctx = await startServer();
  try {
    const created = await call(ctx.base, '/api/exports', {
      userId: 'agent-lin',
      method: 'POST',
      body: { siteIds: ['site-a'], columns: ['order_no', 'contact_name'] },
    });
    const jobId = created.json.job.id;

    await call(ctx.base, '/api/admin/users/agent-lin/access', {
      userId: 'admin',
      method: 'POST',
      body: { sites: ['site-a'], permissions: [] },
    });

    ctx.store.executeJob(jobId);
    const job = await call(ctx.base, `/api/exports/${jobId}`, { userId: 'agent-lin' });
    assert.equal(job.json.job.status, 'failed');
    assert.equal(job.json.job.file, null);
    assert.match(job.json.job.error.message, /重新申请/);

    const download = await call(ctx.base, `/api/exports/${jobId}/download`, { userId: 'agent-lin' });
    assert.equal(download.status, 409);
  } finally {
    await ctx.close();
  }
});

test('非管理员不能调整他人权限', async () => {
  const ctx = await startServer();
  try {
    const denied = await call(ctx.base, '/api/admin/users/agent-zhou/access', {
      userId: 'agent-lin',
      method: 'POST',
      body: { sites: ['site-a', 'site-b'], permissions: ['contact:read'] },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error.code, 'admin_required');
  } finally {
    await ctx.close();
  }
});

test('页面可访问且带安全响应头', async () => {
  const ctx = await startServer();
  try {
    const page = await call(ctx.base, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await ctx.close();
  }
});
