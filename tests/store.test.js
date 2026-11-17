import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCsv, createStore } from '../src/store.js';
import { canViewField, pageFields, projectOrderPage, visibleFieldKeys } from '../src/permissions.js';
import { FIELD_BY_KEY } from '../src/data.js';

function freshStore() {
  return createStore({ autoRun: false });
}

function parseCsv(content) {
  const text = content.replace(/^﻿/, '');
  const rows = [];
  let cell = '';
  let row = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r') {
      // CRLF handled by the \n branch
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

test('页面、预览和 CSV 使用同一套字段权限判断', () => {
  const store = freshStore();
  const user = store.getUser('agent-zhou');

  for (const key of visibleFieldKeys(user)) {
    assert.equal(
      canViewField(user, FIELD_BY_KEY[key]),
      true,
      `${key} 应该可见`,
    );
  }
  assert.equal(canViewField(user, FIELD_BY_KEY.contact_phone), false);

  const preview = store.previewExport(user, {
    siteIds: ['site-b'],
    columns: ['order_no', 'status'],
  });
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.preview.columns.map((column) => column.key), ['order_no', 'status']);

  const deniedPreview = store.previewExport(user, {
    siteIds: ['site-b'],
    columns: ['order_no', 'contact_phone'],
  });
  assert.equal(deniedPreview.ok, false);
  assert.equal(deniedPreview.code, 'columns_forbidden');

  const deniedCsv = store.enqueueExport(user, {
    siteIds: ['site-b'],
    columns: ['order_no', 'contact_name'],
  });
  assert.equal(deniedCsv.ok, false);
  assert.equal(deniedCsv.code, 'columns_forbidden');
});

test('站点范围由服务端核对，不能导出未授权站点', () => {
  const store = freshStore();
  const user = store.getUser('agent-lin');

  const result = store.enqueueExport(user, {
    siteIds: ['site-a', 'site-b'],
    columns: ['order_no', 'status'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, 'sites_forbidden');
  assert.deepEqual(result.detail.sites.map((site) => site.name), ['乙站']);

  const preview = store.previewExport(user, {
    siteIds: ['site-b'],
    columns: ['order_no'],
  });
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'sites_forbidden');
});

test('排队时冻结筛选条件与列；执行前权限被撤销则任务失败且不产出文件', () => {
  const store = freshStore();
  const user = store.getUser('agent-lin');

  const queued = store.enqueueExport(user, {
    siteIds: ['site-a'],
    statuses: ['待发货'],
    q: 'A2026',
    columns: ['order_no', 'status', 'contact_name'],
  });
  assert.equal(queued.ok, true);
  assert.deepEqual(queued.job.snapshot.statuses, ['待发货']);
  assert.equal(queued.job.snapshot.q, 'A2026');
  assert.deepEqual(
    queued.job.snapshot.columns.map((column) => column.key),
    ['order_no', 'status', 'contact_name'],
  );

  const admin = store.getUser('admin');
  const revoked = store.updateUserAccess(admin, 'agent-lin', {
    sites: ['site-a'],
    permissions: [],
  });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.changed, true);

  const executed = store.executeJob(queued.job.id);
  assert.equal(executed.status, 'failed');
  assert.equal(executed.file, null);
  assert.equal(executed.needsReapply, true);
  assert.match(executed.error.message, /字段权限/);

  const download = store.getDownload(user, queued.job.id);
  assert.equal(download.status, 409);
});

test('权限撤销后旧文件不能从原地址取回，新申请仍可导出订单号和状态', () => {
  const store = freshStore();
  const user = store.getUser('agent-lin');
  const admin = store.getUser('admin');

  const queued = store.enqueueExport(user, {
    siteIds: ['site-a'],
    columns: ['order_no', 'status', 'contact_name', 'contact_phone'],
  });
  assert.equal(queued.ok, true);

  const ready = store.executeJob(queued.job.id);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.file.downloadable, true);

  const before = store.getDownload(user, queued.job.id);
  assert.equal(before.status, 200);
  assert.match(before.download.content, /联系人姓名/);
  assert.match(before.download.content, /138-0000-0101/);

  const revoked = store.updateUserAccess(admin, 'agent-lin', {
    sites: ['site-a'],
    permissions: [],
  });
  assert.equal(revoked.changed, true);
  assert.equal(revoked.invalidatedJobs, 1);

  // 旧地址（相同 URL）不能再取回内容
  const after = store.getDownload(user, queued.job.id);
  assert.equal(after.status, 410);
  assert.equal(after.error.code, 'permission_changed');

  const jobView = store.getJob(user, queued.job.id);
  assert.equal(jobView.status, 'invalidated');
  assert.equal(jobView.needsReapply, true);
  assert.equal(jobView.file.downloadable, false);
  assert.equal(jobView.file.invalidReason, 'permission_changed');

  // 新申请：只剩订单号与状态列，仍然可以导出甲站
  const reapply = store.enqueueExport(user, {
    siteIds: ['site-a'],
    columns: ['order_no', 'status'],
  });
  assert.equal(reapply.ok, true);
  const regenerated = store.executeJob(reapply.job.id);
  assert.equal(regenerated.status, 'ready');

  const download = store.getDownload(user, reapply.job.id);
  assert.equal(download.status, 200);
  const rows = parseCsv(download.download.content);
  assert.deepEqual(rows[0], ['订单号', '订单状态']);
  assert.ok(rows.length > 1);
  for (const row of rows.slice(1)) {
    assert.equal(row.length, 2);
    assert.match(row[0], /^A2026/);
  }

  // 新的导出里不能出现联系人字段
  assert.doesNotMatch(download.download.content, /联系人/);
  assert.doesNotMatch(download.download.content, /138-0000/);
});

test('只有申请人可以下载已生成文件', () => {
  const store = freshStore();
  const owner = store.getUser('agent-lin');
  const other = store.getUser('agent-zhou');

  const queued = store.enqueueExport(owner, {
    siteIds: ['site-a'],
    columns: ['order_no', 'status'],
  });
  store.executeJob(queued.job.id);

  assert.equal(store.getDownload(other, queued.job.id).status, 404);
  assert.equal(store.getJob(other, queued.job.id), null);
  assert.deepEqual(store.listJobs(other), []);
  assert.equal(store.getDownload(owner, queued.job.id).status, 200);
});

test('权限变更后新版本文件能正常下载，旧文件保持失效', () => {
  const store = freshStore();
  const user = store.getUser('agent-lin');
  const admin = store.getUser('admin');

  const first = store.enqueueExport(user, { siteIds: ['site-a'], columns: ['order_no'] });
  store.executeJob(first.job.id);

  // 增加站点范围也会使旧文件失效，避免用旧范围的文件冒充新权限
  const updated = store.updateUserAccess(admin, 'agent-lin', {
    sites: ['site-a', 'site-b'],
    permissions: ['contact:read'],
  });
  assert.equal(updated.invalidatedJobs, 1);

  const second = store.enqueueExport(user, {
    siteIds: ['site-a', 'site-b'],
    columns: ['order_no', 'contact_phone'],
  });
  const ready = store.executeJob(second.job.id);
  assert.equal(ready.status, 'ready');

  assert.equal(store.getDownload(user, first.job.id).status, 410);
  assert.equal(store.getDownload(user, second.job.id).status, 200);
});

test('排队后站点权限被收回：执行失败，不会生成跨站文件', () => {
  const store = freshStore();
  const lead = store.getUser('lead-chen');
  const admin = store.getUser('admin');

  const queued = store.enqueueExport(lead, {
    siteIds: ['site-a', 'site-b'],
    columns: ['order_no', 'status'],
  });
  assert.equal(queued.ok, true);

  const reduced = store.updateUserAccess(admin, 'lead-chen', {
    sites: ['site-a'],
    permissions: [],
  });
  assert.equal(reduced.changed, true);
  assert.equal(reduced.invalidatedJobs, 0, '尚未生成文件，没有可作废的文件');

  const executed = store.executeJob(queued.job.id);
  assert.equal(executed.status, 'failed');
  assert.equal(executed.file, null);
  assert.equal(executed.error.code, 'sites_forbidden');
  assert.match(executed.error.message, /站点范围/);

  const download = store.getDownload(lead, queued.job.id);
  assert.equal(download.status, 409);
});

test('页面只展示订单号、状态和有权查看的联系人列', () => {
  const store = freshStore();
  const withContact = store.getUser('agent-lin');
  const withoutContact = store.getUser('agent-zhou');

  const allowed = pageFields(withContact).map((field) => field.key);
  assert.deepEqual(allowed, ['order_no', 'status', 'contact_name', 'contact_phone', 'contact_address']);

  const denied = pageFields(withoutContact).map((field) => field.key);
  assert.deepEqual(denied, ['order_no', 'status']);

  const projected = projectOrderPage({ siteId: 'site-a', order_no: 'A1', status: '待发货', contact_phone: '1' }, withoutContact);
  assert.deepEqual(projected, { order_no: 'A1', status: '待发货' });
});

test('CSV 转义公式字符并对引号加倍', () => {
  const { content } = buildCsv(
    [
      { key: 'a', label: '说明' },
      { key: 'b', label: '备注' },
    ],
    [
      { a: '=1+1', b: '带"引号"的值' },
      { a: '@SUM(A1)', b: '-负数开头' },
    ],
  );

  const rows = parseCsv(content);
  assert.deepEqual(rows[0], ['说明', '备注']);
  assert.deepEqual(rows[1], ["'=1+1", '带"引号"的值']);
  assert.deepEqual(rows[2], ["'@SUM(A1)", "'-负数开头"]);
  assert.ok(content.startsWith('﻿'), '应带 UTF-8 BOM');
  assert.ok(content.includes('\r\n'), '应使用 CRLF 换行');
});

test('非管理员不能调整权限', () => {
  const store = freshStore();
  const user = store.getUser('agent-lin');

  const result = store.updateUserAccess(user, 'agent-lin', {
    sites: ['site-a', 'site-b'],
    permissions: ['contact:read'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});
