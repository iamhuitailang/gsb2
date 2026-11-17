import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../server.mjs';

let server;
let baseUrl;
let dataDir;
let store;

const UA_A = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const UA_B = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/121.0 Safari/537.36';

async function request(pathname, { method = 'GET', cookie, body, userAgent = UA_A } = {}) {
  const headers = { 'User-Agent': userAgent };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  return { status: response.status, payload, setCookie: response.headers.get('set-cookie') };
}

function cookieValue(setCookie) {
  return setCookie ? setCookie.split(';')[0] : '';
}

async function login(deviceName, userAgent = UA_A, { cookie } = {}) {
  const result = await request('/api/login', {
    method: 'POST',
    cookie,
    body: { username: 'demo', password: 'demo1234', deviceName, kind: 'desktop' },
    userAgent,
  });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  return cookieValue(result.setCookie);
}

async function currentDraft(cookie, draftId) {
  const result = await request(`/api/drafts/${draftId}`, { cookie });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  return result.payload.draft;
}

async function sessionsOf(cookie) {
  const result = await request('/api/security/sessions', { cookie });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  return result.payload;
}

function deviceNamed(list, deviceName) {
  return list.devices.find((device) => device.deviceName === deviceName);
}

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'gsb2-test-'));
  const app = await createApp({ dataFile: path.join(dataDir, 'db.json') });
  store = app.store;
  server = app.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await store.close();
  await new Promise((resolve) => {
    server.close(resolve);
    // fetch 会复用 keep-alive 连接，主动断开，避免测试进程等待连接超时。
    server.closeAllConnections?.();
  });
  await rm(dataDir, { recursive: true, force: true });
});

test('安全页列出在线设备、登录时间与最后活动，并标记当前设备', async () => {
  const nameA = '用例1 · 甲';
  const nameB = '用例1 · 乙';
  const cookieA = await login(nameA, UA_A);
  await login(nameB, UA_B);

  const list = await sessionsOf(cookieA);
  const current = deviceNamed(list, nameA);
  const other = deviceNamed(list, nameB);

  assert.ok(current, '应列出甲');
  assert.ok(other, '应列出乙');
  assert.equal(current.isCurrentDevice, true);
  assert.equal(other.isCurrentDevice, false);
  assert.equal(current.activeSessions[0].isCurrent, true);
  assert.equal(other.activeSessions[0].isCurrent, false);

  for (const device of [current, other]) {
    const session = device.activeSessions[0];
    assert.equal(session.status, 'online');
    assert.ok(session.createdAt, '应有登录时间');
    assert.ok(session.lastSeenAt, '应有最后活动时间');
    assert.ok(Date.parse(session.lastSeenAt) >= Date.parse(session.createdAt));
  }
});

test('甲退出乙后，乙不刷新直接保存会被服务端拒绝，原稿不被覆盖', async () => {
  const nameA = '用例2 · 甲';
  const nameB = '用例2 · 乙';
  const cookieA = await login(nameA, UA_A);
  const cookieB = await login(nameB, UA_B);

  const bDevice = deviceNamed(await sessionsOf(cookieA), nameB);
  const bSessionId = bDevice.activeSessions[0].id;

  // 乙先正常保存成功
  const initial = await currentDraft(cookieB, 'draft-launch');
  const before = await request('/api/drafts/draft-launch', {
    method: 'PUT',
    cookie: cookieB,
    userAgent: UA_B,
    body: { content: '乙的第一次修改', baseVersion: initial.version },
  });
  assert.equal(before.status, 200, JSON.stringify(before.payload));
  const originalContent = before.payload.draft.content;
  const originalVersion = before.payload.draft.version;

  // 甲在安全页退出乙
  const revoke = await request(`/api/security/sessions/${bSessionId}/revoke`, {
    method: 'POST',
    cookie: cookieA,
  });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.payload));

  // 乙仍持有旧 Cookie，未刷新页面，直接点保存
  const rejected = await request('/api/drafts/draft-launch', {
    method: 'PUT',
    cookie: cookieB,
    userAgent: UA_B,
    body: { content: '乙被下线后仍然想覆盖', baseVersion: originalVersion },
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.payload.error.code, 'session_revoked');

  // 服务端原稿没有被覆盖
  const saved = await currentDraft(cookieA, 'draft-launch');
  assert.equal(saved.content, originalContent);
  assert.equal(saved.version, originalVersion);
});

test('退出其他所有设备不会让当前设备失效，甲可以继续保存另一份草稿', async () => {
  const nameA = '用例3 · 甲';
  const nameB = '用例3 · 乙';
  const nameC = '用例3 · 丙';
  const cookieA = await login(nameA, UA_A);
  const cookieB = await login(nameB, UA_B);
  await login(nameC, 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1');

  const before = await sessionsOf(cookieA);
  const onlineBefore = before.devices.flatMap((device) => device.activeSessions);
  const othersOnline = onlineBefore.filter((session) => !session.isCurrent).length;
  assert.ok(othersOnline >= 2);

  const result = await request('/api/security/sessions/revoke-others', {
    method: 'POST',
    cookie: cookieA,
  });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  // 退出数量应正好等于操作前"除本机以外的在线会话"数量，且绝不包含当前会话。
  assert.equal(result.payload.revokedCount, othersOnline);

  // 当前设备仍然有效
  const me = await request('/api/me', { cookie: cookieA });
  assert.equal(me.status, 200);

  // 甲继续改另一份草稿，成功
  const retro = await currentDraft(cookieA, 'draft-retro');
  const savedRetro = await request('/api/drafts/draft-retro', {
    method: 'PUT',
    cookie: cookieA,
    body: { content: '甲继续修改第二份草稿', baseVersion: retro.version },
  });
  assert.equal(savedRetro.status, 200);
  assert.equal(savedRetro.payload.draft.content, '甲继续修改第二份草稿');

  // 乙的写入被拒绝
  const bAttempt = await request('/api/drafts/draft-retro', {
    method: 'PUT',
    cookie: cookieB,
    userAgent: UA_B,
    body: { content: '乙试图写入', baseVersion: savedRetro.payload.draft.version },
  });
  assert.equal(bAttempt.status, 401);
  assert.equal(bAttempt.payload.error.code, 'session_revoked');

  // 列表里只剩当前设备在线
  const after = await sessionsOf(cookieA);
  const onlineAfter = after.devices.flatMap((device) => device.activeSessions);
  assert.equal(onlineAfter.length, 1);
  assert.equal(onlineAfter[0].isCurrent, true);
  assert.equal(deviceNamed(after, nameB).activeSessions.length, 0);
  assert.equal(deviceNamed(after, nameC).activeSessions.length, 0);
});

test('乙重新登录后，同一设备下区分新会话与已结束的旧会话', async () => {
  const nameA = '用例4 · 甲';
  const nameB = '用例4 · 乙';
  const cookieA = await login(nameA, UA_A);
  const cookieB = await login(nameB, UA_B);

  const oldSessionId = (await request('/api/me', { cookie: cookieB })).payload.currentSessionId;
  await request(`/api/security/sessions/${oldSessionId}/revoke`, {
    method: 'POST',
    cookie: cookieA,
  });

  const cookieB2 = await login(nameB, UA_B);
  const newSessionId = (await request('/api/me', { cookie: cookieB2 })).payload.currentSessionId;
  assert.notEqual(newSessionId, oldSessionId, '重新登录必须产生新会话');

  const list = await sessionsOf(cookieA);
  const device = deviceNamed(list, nameB);
  assert.ok(device, '应能按设备名聚合');
  assert.equal(device.isCurrentDevice, false);
  assert.equal(device.activeSessions.length, 1);
  assert.equal(device.activeSessions[0].id, newSessionId);
  assert.equal(device.activeSessions[0].status, 'online');

  const ended = device.endedSessions.find((item) => item.id === oldSessionId);
  assert.ok(ended, '旧会话应保留在已结束列表中');
  assert.equal(ended.status, 'ended');
  assert.equal(ended.isCurrent, false);
  assert.ok(ended.revokedAt);
  assert.equal(ended.revokedReason, 'revoked_by_device');
  assert.equal(ended.revokedByDeviceName, nameA);
  assert.ok(list.endedSessionCount >= 1);
});

test('同一浏览器再次登录会结束它自己的旧会话，并显示为新会话', async () => {
  const name = '用例5 · 同一浏览器';
  const cookie1 = await login(name, UA_A);
  const firstId = (await request('/api/me', { cookie: cookie1 })).payload.currentSessionId;

  // 浏览器会带着旧 Cookie 发登录请求
  const cookie2 = await login(name, UA_A, { cookie: cookie1 });
  const secondId = (await request('/api/me', { cookie: cookie2 })).payload.currentSessionId;

  assert.notEqual(firstId, secondId);
  const list = await sessionsOf(cookie2);
  const device = deviceNamed(list, name);
  assert.equal(device.isCurrentDevice, true);
  assert.equal(device.activeSessions.length, 1);
  assert.equal(device.activeSessions[0].id, secondId);
  const ended = device.endedSessions.find((item) => item.id === firstId);
  assert.ok(ended);
  assert.equal(ended.revokedReason, 'replaced_by_new_login');
});

test('不能通过单会话接口退出当前设备；未知会话返回 404', async () => {
  const cookieA = await login('用例6 · 甲', UA_A);
  const me = await request('/api/me', { cookie: cookieA });

  const self = await request(`/api/security/sessions/${me.payload.currentSessionId}/revoke`, {
    method: 'POST',
    cookie: cookieA,
  });
  assert.equal(self.status, 400);
  assert.equal(self.payload.error.code, 'cannot_revoke_current');

  const missing = await request('/api/security/sessions/s_not-a-real-id/revoke', {
    method: 'POST',
    cookie: cookieA,
  });
  assert.equal(missing.status, 404);
});

test('过期版本保存返回 409，并给出服务端最新内容且不写入', async () => {
  const cookieA = await login('用例7 · 甲', UA_A);

  const current = await currentDraft(cookieA, 'draft-launch');
  const first = await request('/api/drafts/draft-launch', {
    method: 'PUT',
    cookie: cookieA,
    body: { content: '甲的版本', baseVersion: current.version },
  });
  assert.equal(first.status, 200);

  const stale = await request('/api/drafts/draft-launch', {
    method: 'PUT',
    cookie: cookieA,
    body: { content: '基于旧版本的写入', baseVersion: current.version },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.error.code, 'version_conflict');
  assert.equal(stale.payload.error.currentContent, '甲的版本');

  const unchanged = await currentDraft(cookieA, 'draft-launch');
  assert.equal(unchanged.content, '甲的版本', '冲突时不应写入');
  assert.equal(unchanged.version, first.payload.draft.version);
});

test('没有会话 Cookie 时保存被拒绝', async () => {
  const result = await request('/api/drafts/draft-launch', {
    method: 'PUT',
    body: { content: '匿名写入', baseVersion: 1 },
  });
  assert.equal(result.status, 401);
  assert.equal(result.payload.error.code, 'unauthenticated');
});
