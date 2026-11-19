// 演示应用集成测试：从应用页面发起授权、回调换令牌、更新工单、撤销后失效。
// 覆盖浏览器实际会走的三方跳转链路，而不只是直接调 API。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, extractApprovedScopes, extractCsrf, extractHiddenFields } from './helpers.js';
import { startStack } from './stack.js';

// 让应用页完成一次“点登录 → 授权服务确认 → 回到应用”的完整跳转。
async function appAuthorize(stack, appUrl, user, scopes) {
  const appBrowser = new Browser(appUrl);
  const authBrowser = new Browser(stack.origin);
  await login(authBrowser, user);

  // 应用生成 PKCE 并跳授权服务；这里用应用的 /login 拿到跳转地址。
  const start = await appBrowser.get('/login');
  assert.equal(start.status, 302);
  const authorizeUrl = start.location;
  assert.ok(authorizeUrl.startsWith(stack.origin), 'should redirect to auth server');

  // 授权服务需要登录态：把 auth 浏览器的 cookie 带到跳转请求。
  const consent = await authBrowser.get(authorizeUrl.replace(stack.origin, ''));
  assert.equal(consent.status, 200);
  const checked = extractApprovedScopes(consent.text).filter((s) => scopes.includes(s));
  const approve = await authBrowser.post('/oauth/authorize', {
    ...extractHiddenFields(consent.text),
    csrf: extractCsrf(consent.text),
    decision: 'approve',
    approved_scope: checked,
  });
  assert.equal(approve.status, 302);
  const callbackUrl = approve.location;
  assert.ok(callbackUrl.startsWith(appUrl), 'callback should return to the app');

  // 应用回调：用同一 app 浏览器把 code 交给应用（应用会用自身凭据换令牌）。
  const cb = await appBrowser.get(callbackUrl.replace(appUrl, ''));
  assert.equal(cb.status, 302);
  assert.equal(cb.location, '/');
  const home = await appBrowser.get('/');
  return { appBrowser, home };
}

async function login(browser, username) {
  const page = await browser.get('/login');
  const res = await browser.post('/login', {
    csrf: extractCsrf(page.text), next: '/', username, password: 'ticket-demo-pass',
  });
  assert.equal(res.status, 302);
}

test('乙应用 UI：授权后可更新，撤销后界面显示失效', async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const { appBrowser, home } = await appAuthorize(stack, stack.appB, 'bob', ['tickets:read', 'tickets:update']);
  assert.match(home.text, /T-1001/);
  assert.match(home.text, /T-1002/);
  assert.match(home.text, /更新工单状态/);

  // 在应用上更新一张单。
  const update = await appBrowser.post('/update', { ticketId: 'T-1002', status: 'resolved' });
  assert.equal(update.status, 302);
  const afterUpdate = await appBrowser.get('/');
  assert.match(afterUpdate.text, /已更新 T-1002/);

  // 从应用页断开本地会话后，回到未授权状态。
  const disconnect = await appBrowser.post('/disconnect', {});
  assert.equal(disconnect.status, 302);
  const afterDisconnect = await appBrowser.get('/');
  assert.match(afterDisconnect.text, /使用工单系统账号授权/);
});

test('甲应用 UI：只读时看不到更新表单', async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const { home } = await appAuthorize(stack, stack.appA, 'alice', ['tickets:read']);
  assert.match(home.text, /T-1001/);
  assert.doesNotMatch(home.text, /T-1002/);
  assert.match(home.text, /当前只有只读范围/);
  assert.doesNotMatch(home.text, /name="status"/);
});
