// 端到端场景：完全通过 HTTP 走完用户描述的全部验收点。
// 每个用例独立起一套服务，避免授权状态互相污染。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Browser,
  extractApprovedScopes,
  extractCsrf,
  extractHiddenFields,
  pkcePair,
} from './helpers.js';
import { startStack, tokenRequest } from './stack.js';

async function setup(t) {
  const stack = await startStack();
  t.after(() => stack.close());
  const alice = new Browser(stack.origin);
  const bob = new Browser(stack.origin);
  await login(alice, 'alice');
  await login(bob, 'bob');
  return { stack, alice, bob };
}

async function login(browser, username) {
  const page = await browser.get('/login');
  const csrf = extractCsrf(page.text);
  const res = await browser.post('/login', { csrf, next: '/', username, password: 'ticket-demo-pass' });
  assert.equal(res.status, 302, `login ${username} should redirect`);
}

function appConfig(stack, key) {
  const creds = stack.credentials[key];
  return { clientId: creds.clientId, redirectUri: creds.redirectUri, clientSecret: creds.clientSecret };
}

// 让某个浏览器代表某个应用完成一次授权，返回 { tokens, scopes, consentHtml }。
async function authorize(stack, browser, appKey, scopes) {
  const app = appConfig(stack, appKey);
  const { verifier, challenge } = await pkcePair();
  const state = `st_${Math.random().toString(36).slice(2)}`;
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const consent = await browser.get(`/oauth/authorize?${q}`);
  assert.equal(consent.status, 200, 'authorize should render consent page');
  const csrf = extractCsrf(consent.text);
  const hidden = extractHiddenFields(consent.text);
  const checked = extractApprovedScopes(consent.text);
  const approved = checked.filter((s) => scopes.includes(s));

  const post = await browser.post('/oauth/authorize', {
    ...hidden,
    csrf,
    decision: 'approve',
    approved_scope: approved,
  });
  assert.equal(post.status, 302, 'approve should redirect back to app');
  const callback = new URL(post.location);
  const code = callback.searchParams.get('code');
  assert.ok(code, 'redirect should contain code');
  assert.equal(callback.searchParams.get('state'), state);

  const token = await tokenRequest(stack, app.clientId, app.clientSecret, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: app.redirectUri,
    code_verifier: verifier,
  });
  assert.equal(token.status, 200, `token exchange failed: ${JSON.stringify(token.json)}`);
  return { tokens: token.json, consent };
}

async function apiWith(stack, token, method, path, body) {
  const res = await fetch(`${stack.origin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function findGrantId(html, name) {
  const m = new RegExp(`${name}[\\s\\S]*?/settings/grants/([^/]+)/revoke`).exec(html);
  return m ? decodeURIComponent(m[1]) : null;
}

test('甲只读：能查标题、不能更新；也不能申请更新范围', async (t) => {
  const { stack, alice } = await setup(t);
  const { tokens } = await authorize(stack, alice, 'app-a', ['tickets:read']);
  assert.equal(tokens.scope, 'tickets:read');

  const list = await apiWith(stack, tokens.access_token, 'GET', '/api/tickets');
  assert.equal(list.status, 200);
  // alice 能看到 T-1001（platform），看不到 ops 的 T-1002。
  assert.deepEqual(list.json.tickets.map((x) => x.id), ['T-1001']);
  // 只返回标题，不含状态/正文。
  assert.deepEqual(Object.keys(list.json.tickets[0]).sort(), ['id', 'title']);

  const update = await apiWith(stack, tokens.access_token, 'POST', '/api/tickets/T-1001/status', { status: 'resolved' });
  assert.equal(update.status, 403, '只读令牌不能更新');
  assert.equal(update.json.error, 'insufficient_scope');

  // 甲申请注册范围之外的更新权限，授权服务应拒绝。
  const app = appConfig(stack, 'app-a');
  const { challenge } = await pkcePair();
  const q = new URLSearchParams({
    response_type: 'code', client_id: app.clientId, redirect_uri: app.redirectUri,
    scope: 'tickets:update', code_challenge: challenge, code_challenge_method: 'S256',
  });
  const res = await alice.get(`/oauth/authorize?${q}`);
  assert.equal(res.status, 302);
  assert.match(res.location, /error=invalid_scope/);
});

test('授权乙可更新后，用乙改一张单成功；甲依旧只读', async (t) => {
  const { stack, alice, bob } = await setup(t);

  const b = await authorize(stack, bob, 'app-b', ['tickets:read', 'tickets:update']);
  assert.equal(b.tokens.scope, 'tickets:read tickets:update');

  const list = await apiWith(stack, b.tokens.access_token, 'GET', '/api/tickets');
  assert.deepEqual(list.json.tickets.map((x) => x.id), ['T-1001', 'T-1002'], 'bob 两张单都能看到');

  const update = await apiWith(stack, b.tokens.access_token, 'POST', '/api/tickets/T-1002/status', { status: 'resolved' });
  assert.equal(update.status, 200);
  assert.deepEqual(update.json, { id: 'T-1002', status: 'resolved' });

  const a = await authorize(stack, alice, 'app-a', ['tickets:read']);
  const aList = await apiWith(stack, a.tokens.access_token, 'GET', '/api/tickets');
  assert.deepEqual(aList.json.tickets.map((x) => x.id), ['T-1001']);
  const aUpdate = await apiWith(stack, a.tokens.access_token, 'POST', '/api/tickets/T-1001/status', { status: 'closed' });
  assert.equal(aUpdate.status, 403);
});

test('撤回乙后：旧令牌与续期能力一起失效，甲不受影响', async (t) => {
  const { stack, alice, bob } = await setup(t);
  const b = await authorize(stack, bob, 'app-b', ['tickets:read', 'tickets:update']);
  const a = await authorize(stack, alice, 'app-a', ['tickets:read']);

  // 乙的令牌此刻可用。
  assert.equal((await apiWith(stack, b.tokens.access_token, 'GET', '/api/tickets')).status, 200);

  // 从设置页撤销乙。
  const settings = await bob.get('/settings');
  assert.match(settings.text, /乙应用/);
  const grantId = findGrantId(settings.text, '乙应用');
  assert.ok(grantId, '设置页应列出乙应用');
  const revoke = await bob.post(`/settings/grants/${grantId}/revoke`, { csrf: extractCsrf(settings.text) });
  assert.equal(revoke.status, 302);

  // 撤销后设置页不再列出乙。
  const afterSettings = await bob.get('/settings');
  assert.doesNotMatch(afterSettings.text, /乙应用/);

  // 旧访问令牌立即失效。
  const after = await apiWith(stack, b.tokens.access_token, 'GET', '/api/tickets');
  assert.equal(after.status, 401);
  assert.equal(after.json.error, 'invalid_token');

  // 旧刷新令牌也不能再续期。
  const app = appConfig(stack, 'app-b');
  const refreshed = await tokenRequest(stack, app.clientId, app.clientSecret, {
    grant_type: 'refresh_token',
    refresh_token: b.tokens.refresh_token,
  });
  assert.equal(refreshed.status, 400);
  assert.equal(refreshed.json.error, 'invalid_grant');

  // 甲仍然可读，且只能看到原本可见的标题。
  const aList = await apiWith(stack, a.tokens.access_token, 'GET', '/api/tickets');
  assert.equal(aList.status, 200);
  assert.deepEqual(aList.json.tickets.map((x) => x.id), ['T-1001']);
});

test('乙从只读升级为可更新，需新的确认页；旧的只读凭据仍按原范围', async (t) => {
  const { stack, bob } = await setup(t);

  // 先只读授权。
  const readOnly = await authorize(stack, bob, 'app-b', ['tickets:read']);
  assert.equal(readOnly.tokens.scope, 'tickets:read');
  const denied = await apiWith(stack, readOnly.tokens.access_token, 'POST', '/api/tickets/T-1001/status', { status: 'closed' });
  assert.equal(denied.status, 403);

  // 升级：再次进入授权页，必须展示“权限升级”确认。
  const app = appConfig(stack, 'app-b');
  const { verifier, challenge } = await pkcePair();
  const q = new URLSearchParams({
    response_type: 'code', client_id: app.clientId, redirect_uri: app.redirectUri,
    scope: 'tickets:update', code_challenge: challenge, code_challenge_method: 'S256',
  });
  const consent = await bob.get(`/oauth/authorize?${q}`);
  assert.equal(consent.status, 200);
  assert.match(consent.text, /权限升级/, '升级必须经过新的确认页');

  // 未完成升级前，旧的只读令牌仍然只读。
  const stillDenied = await apiWith(stack, readOnly.tokens.access_token, 'POST', '/api/tickets/T-1001/status', { status: 'closed' });
  assert.equal(stillDenied.status, 403, '升级完成前，旧只读令牌不能更新');

  // 完成升级确认。
  const post = await bob.post('/oauth/authorize', {
    ...extractHiddenFields(consent.text),
    csrf: extractCsrf(consent.text),
    decision: 'approve',
    approved_scope: 'tickets:update',
  });
  assert.equal(post.status, 302);
  const code = new URL(post.location).searchParams.get('code');
  const upgraded = await tokenRequest(stack, app.clientId, app.clientSecret, {
    grant_type: 'authorization_code', code, redirect_uri: app.redirectUri, code_verifier: verifier,
  });
  assert.equal(upgraded.status, 200);
  // 新令牌能更新。
  const canUpdate = await apiWith(stack, upgraded.json.access_token, 'POST', '/api/tickets/T-1001/status', { status: 'closed' });
  assert.equal(canUpdate.status, 200);

  // 已发出的旧只读令牌仍按原范围处理：不能更新，但还能读。
  const oldDenied = await apiWith(stack, readOnly.tokens.access_token, 'POST', '/api/tickets/T-1001/status', { status: 'open' });
  assert.equal(oldDenied.status, 403, '已发出的只读凭据不能被升级放大');
  const oldRead = await apiWith(stack, readOnly.tokens.access_token, 'GET', '/api/tickets');
  assert.equal(oldRead.status, 200, '旧只读令牌仍可读');
});

test('应用只能用自己归属的凭据', async (t) => {
  const { stack } = await setup(t);
  // 拿甲的 secret 冒充乙。
  const res = await tokenRequest(stack, 'app-b', stack.credentials['app-a'].clientSecret, {
    grant_type: 'refresh_token',
    refresh_token: 'whatever',
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'invalid_client');
});

test('可见范围实时收紧：去掉用户团队后，令牌查不到原工单', async (t) => {
  const { stack, bob } = await setup(t);
  const { tokens } = await authorize(stack, bob, 'app-b', ['tickets:update']);
  const before = await apiWith(stack, tokens.access_token, 'GET', '/api/tickets');
  // 乙这次只申请了 update，没有 read，列表接口应 403；用更新接口验证可见性。
  assert.equal(before.status, 403);
  const canUpdateBefore = await apiWith(stack, tokens.access_token, 'POST', '/api/tickets/T-1002/status', { status: 'resolved' });
  assert.equal(canUpdateBefore.status, 200, 'bob 属于 ops，原本可更新 T-1002');

  await stack.store.transaction((s) => {
    const u = s.users.find((x) => x.username === 'bob');
    u.teams = u.teams.filter((x) => x !== 'ops');
  });
  const afterUpdate = await apiWith(stack, tokens.access_token, 'POST', '/api/tickets/T-1002/status', { status: 'closed' });
  assert.equal(afterUpdate.status, 404, '可见范围收紧后，同一张单不再可更新');
});

test('设置页展示已授权应用与范围', async (t) => {
  const { stack, alice } = await setup(t);
  await authorize(stack, alice, 'app-a', ['tickets:read']);
  const page = await alice.get('/settings');
  assert.match(page.text, /甲应用/);
  assert.match(page.text, /查看工单标题/);
  assert.doesNotMatch(page.text, /乙应用/);
});
