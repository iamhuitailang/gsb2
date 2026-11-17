'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../server/server');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  // fetch 使用 keep-alive，先断掉空闲连接，避免测试进程等 4 秒才退出。
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

async function request(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

test('HTTP：乙可审门店一，门店二返回 403，到期后审核页被拦', async (t) => {
  const server = createApp();
  const port = await listen(server);
  t.after(() => closeServer(server));

  const bootstrap = await request(port, 'GET', '/api/bootstrap?userId=u_yi');
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(
    bootstrap.json.todos.map((todo) => todo.id).sort(),
    ['a1', 'a2']
  );

  const forbidden = await request(port, 'GET', '/api/applications/a3?userId=u_yi');
  assert.equal(forbidden.status, 403);

  const decision = await request(port, 'POST', '/api/applications/a1/decision', {
    userId: 'u_yi',
    action: 'approve',
    comment: '同意'
  });
  assert.equal(decision.status, 200);
  assert.equal(decision.json.application.status, 'approved');

  // 快进越过委托结束时间
  await request(port, 'POST', '/api/clock', { offsetMs: 3 * 60 * 60 * 1000 });

  const stale = await request(port, 'GET', '/api/applications/a2?userId=u_yi');
  assert.equal(stale.status, 403);
  assert.equal(stale.json.error.code, 'DELEGATION_EXPIRED');

  const submit = await request(port, 'POST', '/api/applications/a2/decision', {
    userId: 'u_yi',
    action: 'approve'
  });
  assert.equal(submit.status, 403);

  const after = await request(port, 'GET', '/api/bootstrap?userId=u_yi');
  assert.deepEqual(after.json.todos, []);
});

test('HTTP：静态页与未知接口', async (t) => {
  const server = createApp();
  const port = await listen(server);
  t.after(() => closeServer(server));

  const page = await request(port, 'GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /调价审核/);

  const deepLink = await request(port, 'GET', '/applications/a1');
  assert.equal(deepLink.status, 200);

  const missing = await request(port, 'GET', '/api/nope');
  assert.equal(missing.status, 404);

  const method = await request(port, 'DELETE', '/api/bootstrap');
  assert.equal(method.status, 405);

  // fetch 可能先规范化路径；无论走到 403 还是 404，都不能读到 public 之外的文件。
  const traversal = await request(port, 'GET', '/..%2f..%2fpackage.json');
  assert.ok([403, 404].includes(traversal.status), `unexpected status ${traversal.status}`);
});

test('HTTP：非法 JSON 返回 400 而不是 500', async (t) => {
  const server = createApp();
  const port = await listen(server);
  t.after(() => closeServer(server));

  const res = await fetch(`http://127.0.0.1:${port}/api/clock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json'
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'INVALID_JSON');
});

test('HTTP：委托全流程（创建 → 接受 → 代审 → 提前结束）', async (t) => {
  const server = createApp();
  const port = await listen(server);
  t.after(() => closeServer(server));

  // 甲把门店二委托给丙，只给审核通过
  const created = await request(port, 'POST', '/api/delegations', {
    delegatorId: 'u_jia',
    delegateeId: 'u_bing',
    storeIds: ['s2'],
    actions: ['approve'],
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    note: '门店二补位'
  });
  assert.equal(created.status, 201);
  const delegationId = created.json.delegation.id;
  assert.equal(created.json.delegation.status, 'pending_acceptance');

  // 未接受前，丙看不到门店二
  const before = await request(port, 'GET', '/api/bootstrap?userId=u_bing');
  const beforeIds = before.json.todos.map((todo) => todo.id);
  assert.ok(!beforeIds.includes('a3'));

  const accepted = await request(port, 'POST', `/api/delegations/${delegationId}/accept`, {
    userId: 'u_bing'
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.delegation.status, 'active');

  const after = await request(port, 'GET', '/api/bootstrap?userId=u_bing');
  const afterIds = after.json.todos.map((todo) => todo.id);
  assert.ok(afterIds.includes('a3'));
  assert.ok(afterIds.includes('a4'));

  // 驳回不在委托动作里
  const reject = await request(port, 'POST', '/api/applications/a3/decision', {
    userId: 'u_bing',
    action: 'reject'
  });
  assert.equal(reject.status, 403);
  assert.equal(reject.json.error.code, 'ACTION_NOT_DELEGATED');

  const approve = await request(port, 'POST', '/api/applications/a3/decision', {
    userId: 'u_bing',
    action: 'approve',
    comment: '同意'
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.json.application.decision.via.delegationId, delegationId);

  // 甲提前结束，丙之后访问门店二被拦
  const ended = await request(port, 'POST', `/api/delegations/${delegationId}/end`, {
    userId: 'u_jia'
  });
  assert.equal(ended.status, 200);

  const blocked = await request(port, 'GET', '/api/applications/a4?userId=u_bing');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'DELEGATION_ENDED');
});

test('HTTP：丙无权委托（范围超过自有权限）', async (t) => {
  const server = createApp();
  const port = await listen(server);
  t.after(() => closeServer(server));

  const res = await request(port, 'POST', '/api/delegations', {
    delegatorId: 'u_bing',
    delegateeId: 'u_yi',
    storeIds: ['s1'],
    actions: ['approve'],
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'SCOPE_EXCEEDS_OWN_PERMISSION');
});
