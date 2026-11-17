'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

let app;
let base; // http://127.0.0.1:PORT

// 带独立 Cookie 罐的“浏览器”客户端，模拟多个独立会话
function client() {
  let cookie = '';
  return {
    async req(path, { method = 'GET', headers = {}, body } = {}) {
      const h = { ...headers };
      if (cookie) h.cookie = cookie;
      let payload;
      if (body !== undefined) {
        h['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
      const setc = res.headers.get('set-cookie');
      if (setc && !setc.includes('Max-Age=0')) cookie = setc.split(';')[0];
      if (setc && setc.includes('Max-Age=0')) cookie = '';
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    },
    async login(account, password) {
      return this.req('/api/login', { method: 'POST', body: { account, password } });
    },
    async token() {
      const r = await this.req('/api/token');
      return r.json.token;
    },
    async settings() {
      const r = await this.req('/api/settings');
      return r.json.settings;
    },
  };
}

function goodHeaders(token, extra = {}) {
  return { origin: base, 'x-csrf-token': token, ...extra };
}

before(async () => {
  app = createApp();
  const port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
});

after(async () => { await app.close(); });

test('正确来源 + 正确令牌：修改生效', async () => {
  const c = client();
  await c.login('alice', 'alice123');
  const token = await c.token();
  const r = await c.req('/api/settings', {
    method: 'POST', headers: goodHeaders(token),
    body: { displayName: 'Alice-OK' },
  });
  assert.equal(r.status, 200);
  assert.equal((await c.settings()).displayName, 'Alice-OK');
});

test('来源边界：域名后缀相似、端口不符、协议不符都被精确拒绝', async () => {
  const c = client();
  await c.login('alice', 'alice123');
  const token = await c.token();
  const before = await c.settings();

  for (const origin of [
    'http://127.0.0.1.evil.test',          // 后缀相似主机名
    'http://evil-127.0.0.1:' + app.port,   // 前缀相似
    `http://127.0.0.1:${app.port + 1}`,    // 端口不符
    `https://127.0.0.1:${app.port}`,       // 协议不符
    'null',
  ]) {
    const r = await c.req('/api/settings', {
      method: 'POST', headers: { origin, 'x-csrf-token': token },
      body: { displayName: 'Hacked' },
    });
    assert.equal(r.status, 403, `origin=${origin} 应被拒绝`);
    assert.match(r.json.reason, /Origin/);
  }
  assert.deepEqual(await c.settings(), before, '被拒绝的请求不能留下任何变更');
});

test('来源边界：允许列表内的 localhost 与 127.0.0.1 精确匹配可通过', async () => {
  const c = client();
  await c.login('alice', 'alice123');
  const token = await c.token();
  for (const origin of [`http://localhost:${app.port}`, `http://127.0.0.1:${app.port}`]) {
    const r = await c.req('/api/settings', {
      method: 'POST', headers: { origin, 'x-csrf-token': token },
      body: { displayName: 'Exact-' + origin.slice(7, 11) },
    });
    assert.equal(r.status, 200, `origin=${origin} 应通过`);
  }
});

test('来源后备：无 Origin 时合法 Referer 可通过；两者都缺则拒绝', async () => {
  const c = client();
  await c.login('alice', 'alice123');
  const token = await c.token();

  const ok = await c.req('/api/settings', {
    method: 'POST', headers: { referer: `${base}/`, 'x-csrf-token': token },
    body: { displayName: 'Via-Referer' },
  });
  assert.equal(ok.status, 200);

  const badRef = await c.req('/api/settings', {
    method: 'POST', headers: { referer: 'http://evil.test/page', 'x-csrf-token': token },
    body: { displayName: 'Bad-Referer' },
  });
  assert.equal(badRef.status, 403);

  const none = await c.req('/api/settings', {
    method: 'POST', headers: { 'x-csrf-token': token },
    body: { displayName: 'No-Origin' },
  });
  assert.equal(none.status, 403);
  assert.match(none.json.reason, /缺少 Origin 和 Referer/);
});

test('令牌缺失或错误：拒绝且数据不变', async () => {
  const c = client();
  await c.login('alice', 'alice123');
  const before = await c.settings();

  const missing = await c.req('/api/settings', {
    method: 'POST', headers: { origin: base }, body: { displayName: 'X' },
  });
  assert.equal(missing.status, 403);
  assert.match(missing.json.reason, /缺少防护令牌/);

  const wrong = await c.req('/api/settings', {
    method: 'POST', headers: goodHeaders('forged-token'), body: { displayName: 'X' },
  });
  assert.equal(wrong.status, 403);
  assert.match(wrong.json.reason, /不匹配/);

  assert.deepEqual(await c.settings(), before);
});

test('令牌与会话绑定：另一个账号的令牌不能用于当前会话', async () => {
  const alice = client();
  const bob = client();
  await alice.login('alice', 'alice123');
  await bob.login('bob', 'bob123');
  const bobToken = await bob.token();
  const before = await alice.settings();

  const r = await alice.req('/api/settings', {
    method: 'POST', headers: goodHeaders(bobToken), body: { displayName: 'Cross' },
  });
  assert.equal(r.status, 403);
  assert.deepEqual(await alice.settings(), before);
});

test('退出后旧令牌失效；重新登录签发新令牌，旧令牌仍不可用', async () => {
  const c = client();
  await c.login('alice', 'alice123');
  const oldToken = await c.token();

  const out = await c.req('/api/logout', { method: 'POST', headers: goodHeaders(oldToken) });
  assert.equal(out.status, 200);

  // 旧页面（仍持有旧 sid cookie 已被清除 + 旧令牌）再改设置：未登录
  const afterLogout = await c.req('/api/settings', {
    method: 'POST', headers: goodHeaders(oldToken), body: { displayName: 'Stale' },
  });
  assert.equal(afterLogout.status, 401);

  await c.login('alice', 'alice123');
  const newToken = await c.token();
  assert.notEqual(newToken, oldToken, '重新登录必须签发新令牌');

  const stale = await c.req('/api/settings', {
    method: 'POST', headers: goodHeaders(oldToken), body: { displayName: 'Stale' },
  });
  assert.equal(stale.status, 403, '旧会话令牌在新会话中不可用');

  const fresh = await c.req('/api/settings', {
    method: 'POST', headers: goodHeaders(newToken), body: { displayName: 'Fresh' },
  });
  assert.equal(fresh.status, 200);
});

test('同一会话多次取令牌是同一个，多个“页面”不会互相作废', async () => {
  const c = client();
  await c.login('alice', 'alice123');
  const t1 = await c.token();
  const t2 = await c.token();
  assert.equal(t1, t2);
  // 模拟第二个页面用各自取到的令牌提交
  const r = await c.req('/api/settings', {
    method: 'POST', headers: goodHeaders(t2), body: { displayName: 'Page-Two' },
  });
  assert.equal(r.status, 200);
});

test('多个独立会话并发操作：各自令牌各自生效，互不串号', async () => {
  const a1 = client();
  const a2 = client();
  const b = client();
  await a1.login('alice', 'alice123');
  await a2.login('alice', 'alice123');
  await b.login('bob', 'bob123');
  const [ta1, ta2, tb] = await Promise.all([a1.token(), a2.token(), b.token()]);
  assert.notEqual(ta1, ta2, '同账号不同会话令牌应不同');

  const results = await Promise.all([
    a1.req('/api/settings', { method: 'POST', headers: goodHeaders(ta1), body: { displayName: 'A1' } }),
    a2.req('/api/settings', { method: 'POST', headers: goodHeaders(ta2), body: { displayName: 'A2' } }),
    b.req('/api/settings', { method: 'POST', headers: goodHeaders(tb), body: { displayName: 'B1' } }),
    // 交叉使用：a1 的会话拿 a2 的令牌，应拒绝
    a1.req('/api/settings', { method: 'POST', headers: goodHeaders(ta2), body: { displayName: 'Cross' } }),
  ]);
  assert.equal(results[0].status, 200);
  assert.equal(results[1].status, 200);
  assert.equal(results[2].status, 200);
  assert.equal(results[3].status, 403);

  const aliceName = (await a1.settings()).displayName;
  assert.ok(['A1', 'A2'].includes(aliceName));
  assert.equal((await b.settings()).displayName, 'B1', 'bob 的数据不受 alice 会话影响');
});

test('GET 读取请求携带参数也不会修改数据', async () => {
  const c = client();
  await c.login('alice', 'alice123');
  const before = await c.settings();
  const r = await c.req('/api/settings?displayName=Hacked&theme=dark&email=evil@x.com');
  assert.equal(r.status, 200);
  assert.deepEqual(await c.settings(), before, 'GET 必须保持只读');
});

test('参数校验失败：整个请求被拒绝，不留部分变更', async () => {
  const c = client();
  await c.login('alice', 'alice123');
  const token = await c.token();
  const before = await c.settings();
  const r = await c.req('/api/settings', {
    method: 'POST', headers: goodHeaders(token),
    body: { displayName: 'Valid-Name', theme: 'neon' }, // theme 非法
  });
  assert.equal(r.status, 400);
  assert.deepEqual(await c.settings(), before, '部分合法字段也不应被写入');
});

test('日志串起账号与结果，且不包含令牌或会话凭据', async () => {
  const c = client();
  await c.login('bob', 'bob123');
  const token = await c.token();
  await c.req('/api/settings', { method: 'POST', headers: goodHeaders(token), body: { displayName: 'Bob-Log' } });
  await c.req('/api/settings', { method: 'POST', headers: { origin: 'http://evil.test', 'x-csrf-token': token }, body: { displayName: 'X' } });

  const logs = (await c.req('/api/logs')).json.logs;
  const mine = logs.filter((l) => l.account === 'bob');
  assert.ok(mine.some((l) => l.result === '允许' && l.action === 'POST /api/settings'));
  assert.ok(mine.some((l) => l.result === '拒绝' && /Origin/.test(l.reason)));

  const raw = JSON.stringify(logs);
  assert.ok(!raw.includes(token), '日志不得包含令牌');
  assert.ok(!raw.includes('sid='), '日志不得包含会话 Cookie');
});
