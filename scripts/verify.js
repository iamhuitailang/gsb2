#!/usr/bin/env node
// 一键验收：起一套独立服务，按用户描述的顺序跑完整场景并打印结论。
// 与 test/acceptance.test.js 覆盖相同的断言，但输出更适合人读、可直接贴进说明。
import assert from 'node:assert/strict';
import { Browser, extractApprovedScopes, extractCsrf, extractHiddenFields, pkcePair } from '../test/helpers.js';
import { startStack, tokenRequest } from '../test/stack.js';

const steps = [];
function ok(label) { steps.push(`  ✓ ${label}`); console.log(`  ✓ ${label}`); }
function section(title) { console.log(`\n${title}`); }

const stack = await startStack();
try {
  section('准备：两个用户、两张工单、两个应用独立凭据');
  console.log(`  用户：${stack.store.state.users.map((u) => u.username).join(', ')}`);
  console.log(`  工单：${stack.store.state.tickets.map((t) => `${t.id}[${t.team}]`).join(', ')}`);
  console.log(`  应用：${stack.store.state.clients.map((c) => c.clientId).join(', ')}（各自独立 secret）`);
  ok('数据就绪');

  const alice = new Browser(stack.origin);
  const bob = new Browser(stack.origin);
  await login(alice, 'alice');
  await login(bob, 'bob');

  section('场景一：只给甲应用读权限');
  const a = await authorize(stack, alice, 'app-a', ['tickets:read']);
  ok(`甲获得范围 ${a.tokens.scope}`);
  const aTickets = await api(stack, a.tokens.access_token, 'GET', '/api/tickets');
  assert.deepEqual(aTickets.json.tickets.map((x) => x.id), ['T-1001']);
  ok(`甲能查到标题：${aTickets.json.tickets.map((x) => x.id + '「' + x.title + '」').join(', ')}`);
  assert.deepEqual(Object.keys(aTickets.json.tickets[0]).sort(), ['id', 'title']);
  ok('只返回 id + title，不含状态/正文');
  const aDenied = await api(stack, a.tokens.access_token, 'POST', '/api/tickets/T-1001/status', { status: 'resolved' });
  assert.equal(aDenied.status, 403);
  ok('甲更新工单被拒：403 insufficient_scope');

  section('场景二：授权乙可更新，用乙改一张单');
  const b = await authorize(stack, bob, 'app-b', ['tickets:read', 'tickets:update']);
  ok(`乙获得范围 ${b.tokens.scope}`);
  const bTickets = await api(stack, b.tokens.access_token, 'GET', '/api/tickets');
  assert.deepEqual(bTickets.json.tickets.map((x) => x.id), ['T-1001', 'T-1002']);
  ok('乙能看到自己可见的两张单（范围仍受用户可见性限制）');
  const bUpdate = await api(stack, b.tokens.access_token, 'POST', '/api/tickets/T-1002/status', { status: 'resolved' });
  assert.equal(bUpdate.status, 200);
  ok(`乙把 T-1002 改为 ${bUpdate.json.status}：成功`);

  section('场景三：撤回乙，验证失效范围');
  const settings = await bob.get('/settings');
  const grantId = findGrantId(settings.text, '乙应用');
  assert.ok(grantId, '设置页应列出乙应用');
  ok('设置页列出乙应用及其范围');
  await bob.post(`/settings/grants/${grantId}/revoke`, { csrf: extractCsrf(settings.text) });
  ok('在设置页撤销乙');
  const bOld = await api(stack, b.tokens.access_token, 'GET', '/api/tickets');
  assert.equal(bOld.status, 401);
  ok('乙的旧访问令牌立即失效：401 invalid_token');
  const refresh = await tokenRequest(stack, 'app-b', stack.credentials['app-b'].clientSecret, {
    grant_type: 'refresh_token', refresh_token: b.tokens.refresh_token,
  });
  assert.equal(refresh.status, 400);
  assert.equal(refresh.json.error, 'invalid_grant');
  ok('乙的旧刷新令牌也失效：invalid_grant（续期能力一并失效）');
  const aAfter = await api(stack, a.tokens.access_token, 'GET', '/api/tickets');
  assert.equal(aAfter.status, 200);
  assert.deepEqual(aAfter.json.tickets.map((x) => x.id), ['T-1001']);
  ok('甲不受影响，仍能查原本可见的标题');

  console.log(`\n全部 ${steps.length} 项检查通过。`);
} catch (err) {
  console.error('\n验收失败：', err);
  process.exitCode = 1;
} finally {
  await stack.close();
}

async function login(browser, username) {
  const page = await browser.get('/login');
  const res = await browser.post('/login', {
    csrf: extractCsrf(page.text), next: '/', username, password: 'ticket-demo-pass',
  });
  assert.equal(res.status, 302);
}

function appConfig(key) {
  const c = stack.credentials[key];
  return c;
}

async function authorize(stack, browser, appKey, scopes) {
  const app = appConfig(appKey);
  const { verifier, challenge } = await pkcePair();
  const q = new URLSearchParams({
    response_type: 'code', client_id: app.clientId, redirect_uri: app.redirectUri,
    scope: scopes.join(' '), state: 'st_verify', code_challenge: challenge, code_challenge_method: 'S256',
  });
  const consent = await browser.get(`/oauth/authorize?${q}`);
  assert.equal(consent.status, 200);
  const post = await browser.post('/oauth/authorize', {
    ...extractHiddenFields(consent.text),
    csrf: extractCsrf(consent.text),
    decision: 'approve',
    approved_scope: extractApprovedScopes(consent.text).filter((s) => scopes.includes(s)),
  });
  assert.equal(post.status, 302);
  const code = new URL(post.location).searchParams.get('code');
  const token = await tokenRequest(stack, app.clientId, app.clientSecret, {
    grant_type: 'authorization_code', code, redirect_uri: app.redirectUri, code_verifier: verifier,
  });
  assert.equal(token.status, 200, JSON.stringify(token.json));
  return { tokens: token.json };
}

async function api(stack, token, method, path, body) {
  const res = await fetch(`${stack.origin}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function findGrantId(html, name) {
  const m = new RegExp(`${name}[\\s\\S]*?/settings/grants/([^/]+)/revoke`).exec(html);
  return m ? decodeURIComponent(m[1]) : null;
}
