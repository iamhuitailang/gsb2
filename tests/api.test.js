import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createBrowser, apiCall } from './helpers.js';

test('接口层：读写都必须先通过组织权限校验', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  await t.test('未登录一律 401', async () => {
    const browser = createBrowser(srv.origin);
    const read = await apiCall(browser, '/api/orgs/org-jia/customers/C01');
    assert.equal(read.status, 401);
    const write = await apiCall(browser, '/api/orgs/org-jia/customers/C01/remark', {
      method: 'PUT',
      body: { remark: 'x' },
    });
    assert.equal(write.status, 401);
  });

  await t.test('只属于甲组织的账号不能读写乙组织', async () => {
    const browser = createBrowser(srv.origin);
    assert.equal((await apiCall(browser, '/api/login', { method: 'POST', body: { userId: 'agent-jia' } })).status, 200);

    const read = await apiCall(browser, '/api/orgs/org-yi/customers/C01');
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'ORG_FORBIDDEN');

    const write = await apiCall(browser, '/api/orgs/org-yi/customers/C01/remark', {
      method: 'PUT',
      body: { remark: '越权写入' },
    });
    assert.equal(write.status, 403);

    // 越权写入必须完全没有落到数据里
    const agent = createBrowser(srv.origin);
    await apiCall(agent, '/api/login', { method: 'POST', body: { userId: 'agent' } });
    const yi = await apiCall(agent, '/api/orgs/org-yi/customers/C01');
    assert.equal(yi.status, 200);
    assert.notEqual(yi.body.customer.remark, '越权写入');
    assert.equal(yi.body.customer.version, 1);
  });

  await t.test('同时属于两个组织的账号可以分别读写', async () => {
    const browser = createBrowser(srv.origin);
    await apiCall(browser, '/api/login', { method: 'POST', body: { userId: 'agent' } });
    const jia = await apiCall(browser, '/api/orgs/org-jia/customers/C01');
    const yi = await apiCall(browser, '/api/orgs/org-yi/customers/C01');
    assert.equal(jia.status, 200);
    assert.equal(yi.status, 200);
    assert.equal(jia.body.org.id, 'org-jia');
    assert.equal(yi.body.org.id, 'org-yi');
    assert.equal(jia.body.customer.localCustomerNo, 'C01');
    assert.equal(yi.body.customer.localCustomerNo, 'C01');
    assert.notEqual(jia.body.customer.name, yi.body.customer.name);
  });

  await t.test('组织不存在返回 404，且不泄露客户是否存在', async () => {
    const browser = createBrowser(srv.origin);
    await apiCall(browser, '/api/login', { method: 'POST', body: { userId: 'agent' } });
    const missingOrg = await apiCall(browser, '/api/orgs/org-nope/customers/C01');
    assert.equal(missingOrg.status, 404);
    assert.equal(missingOrg.body.error.code, 'ORG_NOT_FOUND');

    const missingCustomer = await apiCall(browser, '/api/orgs/org-jia/customers/NOPE');
    assert.equal(missingCustomer.status, 404);
    assert.equal(missingCustomer.body.error.code, 'CUSTOMER_NOT_FOUND');
  });

  await t.test('客户编号只在组织内查找，同编号的两条记录互不影响', async () => {
    const browser = createBrowser(srv.origin);
    await apiCall(browser, '/api/login', { method: 'POST', body: { userId: 'agent' } });
    const before = {
      jia: (await apiCall(browser, '/api/orgs/org-jia/customers/C01')).body.customer,
      yi: (await apiCall(browser, '/api/orgs/org-yi/customers/C01')).body.customer,
    };

    const write = await apiCall(browser, '/api/orgs/org-jia/customers/C01/remark', {
      method: 'PUT',
      body: { remark: '只改甲组织', expectedVersion: before.jia.version },
    });
    assert.equal(write.status, 200);

    const after = {
      jia: (await apiCall(browser, '/api/orgs/org-jia/customers/C01')).body.customer,
      yi: (await apiCall(browser, '/api/orgs/org-yi/customers/C01')).body.customer,
    };
    assert.equal(after.jia.remark, '只改甲组织');
    assert.equal(after.jia.version, before.jia.version + 1);
    assert.equal(after.yi.remark, before.yi.remark);
    assert.equal(after.yi.version, before.yi.version);
    assert.equal(after.yi.updatedAt, null);
  });

  await t.test('并发写入用版本号拦截，避免后写覆盖先写', async () => {
    const browser = createBrowser(srv.origin);
    await apiCall(browser, '/api/login', { method: 'POST', body: { userId: 'agent' } });
    const start = (await apiCall(browser, '/api/orgs/org-yi/customers/C01')).body.customer.version;

    const first = await apiCall(browser, '/api/orgs/org-yi/customers/C01/remark', {
      method: 'PUT',
      body: { remark: '第一次', expectedVersion: start },
    });
    assert.equal(first.status, 200);

    const second = await apiCall(browser, '/api/orgs/org-yi/customers/C01/remark', {
      method: 'PUT',
      body: { remark: '第二次', expectedVersion: start },
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'VERSION_CONFLICT');

    const current = (await apiCall(browser, '/api/orgs/org-yi/customers/C01')).body.customer;
    assert.equal(current.remark, '第一次');
  });

  await t.test('失去权限后读取和写入都被拒绝，数据保持不变', async () => {
    const browser = createBrowser(srv.origin);
    await apiCall(browser, '/api/login', { method: 'POST', body: { userId: 'agent' } });
    const before = (await apiCall(browser, '/api/orgs/org-jia/customers/C01')).body.customer;

    const revoke = await apiCall(browser, '/api/demo/membership', {
      method: 'POST',
      body: { userId: 'agent', orgId: 'org-jia', enabled: false },
    });
    assert.equal(revoke.status, 200);

    const read = await apiCall(browser, '/api/orgs/org-jia/customers/C01');
    assert.equal(read.status, 403);
    const write = await apiCall(browser, '/api/orgs/org-jia/customers/C01/remark', {
      method: 'PUT',
      body: { remark: '权限已收回', expectedVersion: before.version },
    });
    assert.equal(write.status, 403);

    const session = await apiCall(browser, '/api/session');
    assert.deepEqual(session.body.orgs.map((o) => o.id), ['org-yi']);

    await apiCall(browser, '/api/demo/membership', {
      method: 'POST',
      body: { userId: 'agent', orgId: 'org-jia', enabled: true },
    });
    const restored = (await apiCall(browser, '/api/orgs/org-jia/customers/C01')).body.customer;
    assert.equal(restored.remark, before.remark);
    assert.equal(restored.version, before.version);
  });
});

test('服务端不保存「当前组织」：同一会话同时读写两个组织互不干扰', async () => {
  const srv = await startServer();
  const browser = createBrowser(srv.origin);
  await apiCall(browser, '/api/login', { method: 'POST', body: { userId: 'agent' } });

  // 模拟两个标签并行：请求交替发出，没有任何「切换组织」的服务端状态。
  const results = await Promise.all([
    apiCall(browser, '/api/orgs/org-jia/customers/C01'),
    apiCall(browser, '/api/orgs/org-yi/customers/C01'),
    apiCall(browser, '/api/orgs/org-jia/customers/C01'),
    apiCall(browser, '/api/orgs/org-yi/customers/C01'),
  ]);
  for (const r of results) assert.equal(r.status, 200);
  assert.deepEqual(
    results.map((r) => r.body.org.id),
    ['org-jia', 'org-yi', 'org-jia', 'org-yi'],
  );

  await srv.close();
});
