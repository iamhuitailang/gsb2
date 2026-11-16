import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createServer } from 'node:http';

import { createApp } from '../src/server.js';

let server;
let baseUrl;
let app;

const cookieJar = new Map();

function storeCookies(setCookie) {
  if (!setCookie) return;
  for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const name = pair.slice(0, index).trim();
    const value = decodeURIComponent(pair.slice(index + 1).trim());
    if (value === '') cookieJar.delete(name);
    else cookieJar.set(name, value);
  }
}

function cookieHeader() {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
}

async function request(method, path, { form = null, follow = false } = {}) {
  const headers = { cookie: cookieHeader() };
  let body;
  if (form) {
    body = new URLSearchParams(form).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body,
    redirect: 'manual',
  });
  storeCookies(res.headers.getSetCookie?.() ?? res.headers.get('set-cookie'));
  const location = res.headers.get('location');
  if (follow && location) return request('GET', location.split('http://localhost')[1] ?? location);
  const text = await res.text();
  return { status: res.status, location, text };
}

function csrfFrom(html) {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  assert.ok(match, 'expected a csrf token in the page');
  return match[1];
}

async function login(email, password, next = '') {
  const page = await request('GET', '/login');
  assert.equal(page.status, 200);
  const csrf = csrfFrom(page.text);
  const result = await request('POST', '/login', {
    form: { email, password, csrf, next },
  });
  assert.equal(result.status, 303, `login failed for ${email}`);
  return result;
}

function logout() {
  cookieJar.clear();
}

before(async () => {
  app = createApp({ seed: true });
  server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test('完整回归场景：甲乙团队邀请、甲改发、乙仍可接受、换号不能冒领', async () => {
  logout();
  await login('admin@gsb2.local', 'admin123');

  // 甲团队先发编辑
  const adminPage = await request('GET', '/admin');
  assert.equal(adminPage.status, 200);
  let csrf = csrfFrom(adminPage.text);
  const firstJia = await request('POST', '/admin/invites', {
    form: { csrf, email: 'alice@example.com', teamId: 'team-jia', role: 'editor' },
  });
  assert.equal(firstJia.status, 303);

  // 乙团队发编辑
  const page2 = await request('GET', '/admin');
  csrf = csrfFrom(page2.text);
  const yi = await request('POST', '/admin/invites', {
    form: { csrf, email: 'alice@example.com', teamId: 'team-yi', role: 'editor' },
  });
  assert.equal(yi.status, 303);

  // 甲团队改发只读
  const page3 = await request('GET', '/admin');
  csrf = csrfFrom(page3.text);
  const secondJia = await request('POST', '/admin/invites', {
    form: { csrf, email: 'alice@example.com', teamId: 'team-jia', role: 'viewer' },
  });
  assert.equal(secondJia.status, 303);

  const jiaInvites = app.store
    .listInvitesForEmail('alice@example.com')
    .filter((invite) => invite.teamId === 'team-jia');
  assert.equal(jiaInvites.length, 2);
  const [newJia, oldJia] = jiaInvites; // sorted newest first
  assert.equal(newJia.status, 'pending');
  assert.equal(newJia.role, 'viewer');
  assert.equal(oldJia.status, 'superseded');
  assert.equal(oldJia.role, 'editor');

  const yiInvites = app.store
    .listInvitesForEmail('alice@example.com')
    .filter((invite) => invite.teamId === 'team-yi');
  assert.equal(yiInvites.length, 1);
  assert.equal(yiInvites[0].status, 'pending');

  const aliceTokens = app.store
    .listMessagesForEmail('alice@example.com')
    .filter((message) => message.kind === 'invite');
  const tokenByInvite = new Map(aliceTokens.map((message) => [message.inviteId, message.token]));
  const oldJiaToken = tokenByInvite.get(oldJia.id);
  const newJiaToken = tokenByInvite.get(newJia.id);
  const yiToken = tokenByInvite.get(yiInvites[0].id);

  // 王大明（另一个账号）打开甲团队新链接无法冒领
  logout();
  await login('bob@example.com', 'bob123');
  const bobView = await request('GET', `/invite/${newJiaToken}`);
  assert.equal(bobView.status, 200);
  assert.match(bobView.text, /不一致/);
  const bobAccept = await request('POST', `/invite/${newJiaToken}/accept`, {
    form: { csrf: csrfFrom(bobView.text) },
  });
  assert.equal(bobAccept.status, 303);
  assert.equal(app.store.getInvite(newJia.id).status, 'pending');
  assert.equal(
    app.store.findMembership('team-jia', app.store.findUserByEmail('bob@example.com').id),
    null,
  );

  // 李小雨登录后旧链接打不开
  logout();
  await login('alice@example.com', 'alice123');
  const oldView = await request('GET', `/invite/${oldJiaToken}`);
  assert.equal(oldView.status, 404);
  assert.match(oldView.text, /已被同一团队的新邀请替代/);

  const inbox = await request('GET', '/inbox');
  assert.equal(inbox.status, 200);
  assert.match(inbox.text, /甲团队/);
  assert.match(inbox.text, /乙团队/);

  // 新链接接受后甲团队只读
  const newView = await request('GET', `/invite/${newJiaToken}`);
  assert.equal(newView.status, 200);
  assert.match(newView.text, /只读/);
  const acceptJia = await request('POST', `/invite/${newJiaToken}/accept`, {
    form: { csrf: csrfFrom(newView.text) },
  });
  assert.equal(acceptJia.status, 303);

  const alice = app.store.findUserByEmail('alice@example.com');
  assert.equal(app.store.findMembership('team-jia', alice.id).role, 'viewer');

  // 乙团队邀请仍可接受
  const yiView = await request('GET', `/invite/${yiToken}`);
  assert.equal(yiView.status, 200);
  const acceptYi = await request('POST', `/invite/${yiToken}/accept`, {
    form: { csrf: csrfFrom(yiView.text) },
  });
  assert.equal(acceptYi.status, 303);
  assert.equal(app.store.findMembership('team-yi', alice.id).role, 'editor');
  assert.equal(
    app.store.listMembershipsForUser(alice.id).filter((m) => m.teamId === 'team-jia').length,
    1,
  );

  // 重复打开旧链接与已接受链接都不会再增加成员关系
  await request('GET', `/invite/${newJiaToken}`);
  assert.equal(app.store.listMembershipsForTeam('team-jia').length, 1);
});

test('POST 缺少 CSRF 时被拒绝', async () => {
  logout();
  await login('admin@gsb2.local', 'admin123');
  const result = await request('POST', '/admin/invites', {
    form: { csrf: 'wrong', email: 'bob@example.com', teamId: 'team-bing', role: 'editor' },
  });
  assert.equal(result.status, 403);
});

test('非管理员无法访问控制台', async () => {
  logout();
  await login('bob@example.com', 'bob123');
  const result = await request('GET', '/admin');
  assert.equal(result.status, 403);
});

test('未登录访问邀请页只显示登录引导，且接受操作被拒绝', async () => {
  logout();
  const sent = app.store.createInvite({
    email: 'bob@example.com',
    teamId: 'team-bing',
    role: 'viewer',
    actorUserId: app.store.findUserByEmail('admin@gsb2.local').id,
  });
  const page = await request('GET', `/invite/${sent.token}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /去登录/);
  const accept = await request('POST', `/invite/${sent.token}/accept`, {
    form: { csrf: 'nope' },
  });
  assert.equal(accept.status, 403);
  assert.equal(app.store.getInvite(sent.invite.id).status, 'pending');
});

test('伪造/失效的邀请令牌返回 404，不泄露邀请信息', async () => {
  logout();
  const result = await request('GET', '/invite/completely-made-up-token');
  assert.equal(result.status, 404);
  assert.match(result.text, /邀请链接不可用/);
});

test('账号邮箱大小写与空白不影响匹配', async () => {
  logout();
  await login('admin@gsb2.local', 'admin123');
  const page = await request('GET', '/admin');
  const sent = await request('POST', '/admin/invites', {
    form: {
      csrf: csrfFrom(page.text),
      email: '  BOB@Example.COM ',
      teamId: 'team-jia',
      role: 'viewer',
    },
  });
  assert.equal(sent.status, 303);
  const bobInvites = app.store
    .listInvitesForEmail('bob@example.com')
    .filter((invite) => invite.teamId === 'team-jia');
  assert.equal(bobInvites.length, 1);
  assert.equal(bobInvites[0].email, 'bob@example.com');
});
