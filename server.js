'use strict';
/**
 * 本机 CSRF 防护验证台（零依赖，仅 Node 标准库）
 * 演示要点：来源精确匹配（Origin 优先 / Referer 后备 / 都缺则拒）、
 * 会话绑定防护令牌、凭据更新后的失效边界、操作日志复查。
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_COOKIE = 'sid';

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function maskToken(token) {
  if (!token) return '(无)';
  return token.slice(0, 6) + '…(已隐藏)';
}

function createApp() {
  // ---- 本地生成的模拟账号与数据（不依赖任何外部服务）----
  const accounts = {
    alice: { password: 'alice123', settings: { displayName: 'Alice', email: 'alice@local.test', theme: 'light' } },
    bob:   { password: 'bob123',   settings: { displayName: 'Bob',   email: 'bob@local.test',   theme: 'dark'  } },
  };

  const sessions = new Map(); // sid -> { account, token, createdAt }
  const logs = [];
  const allowedOrigins = new Set(); // listen 之后按实际端口填充

  const app = { port: 0, accounts, sessions, logs, allowedOrigins };

  function log(entry) {
    // 日志只记录账号、动作、结果、原因，绝不记录令牌 / 会话凭据 / 完整 Cookie
    logs.push({ time: new Date().toISOString(), ...entry });
    if (logs.length > 500) logs.shift();
  }

  function getSession(req) {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]+)'));
    if (!m) return {};
    const sid = decodeURIComponent(m[1]);
    const session = sessions.get(sid);
    return session ? { sid, session } : {};
  }

  // ---- 来源判断：协议+主机+端口 精确匹配允许列表 ----
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (origin) {
      // 精确字符串匹配：http://localhost.evil.test、错端口、错协议都不会通过
      if (allowedOrigins.has(origin)) return { ok: true, via: 'Origin' };
      return { ok: false, reason: `Origin 不在允许列表（收到 ${origin}，要求协议+主机+端口精确匹配）` };
    }
    const referer = req.headers.referer;
    if (referer) {
      try {
        const u = new URL(referer);
        if (allowedOrigins.has(u.origin)) return { ok: true, via: 'Referer(后备)' };
        return { ok: false, reason: `Referer 来源不在允许列表（来源 ${u.origin}）` };
      } catch {
        return { ok: false, reason: 'Referer 无法解析' };
      }
    }
    return { ok: false, reason: '请求缺少 Origin 和 Referer，无法判断来源，修改请求被拒绝' };
  }

  function send(res, status, obj, extraHeaders = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 1e5) req.destroy();
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  async function readJson(req) {
    const raw = await readBody(req);
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return null; }
  }

  // ---- 所有修改数据的请求统一经过：登录态 + 来源校验 + 会话绑定令牌 ----
  function guardMutation(req, res, action) {
    const { sid, session } = getSession(req);
    if (!session) {
      send(res, 401, { ok: false, reason: '未登录或会话已失效' });
      log({ account: '(未登录)', action, result: '拒绝', reason: '无有效会话' });
      return null;
    }
    const originCheck = checkOrigin(req);
    if (!originCheck.ok) {
      send(res, 403, { ok: false, reason: originCheck.reason });
      log({ account: session.account, action, result: '拒绝', reason: originCheck.reason });
      return null;
    }
    const token = req.headers['x-csrf-token'];
    if (!token) {
      const reason = '缺少防护令牌（X-CSRF-Token）';
      send(res, 403, { ok: false, reason });
      log({ account: session.account, action, result: '拒绝', reason });
      return null;
    }
    // 令牌必须等于当前会话持有的令牌：其他账号、旧会话、过期会话的令牌都不匹配
    if (token !== session.token) {
      const reason = '防护令牌与当前登录会话不匹配';
      send(res, 403, { ok: false, reason });
      log({ account: session.account, action, result: '拒绝', reason });
      return null;
    }
    return { sid, session, via: originCheck.via };
  }

  // ---- 设置校验：先整体校验，全部通过才一次性写入，失败不留部分变更 ----
  function validateSettings(body) {
    if (!body || typeof body !== 'object') return { error: '请求体不是合法 JSON' };
    const out = {};
    if ('displayName' in body) {
      const v = body.displayName;
      if (typeof v !== 'string' || v.trim().length < 1 || v.trim().length > 30) {
        return { error: 'displayName 需为 1-30 个字符' };
      }
      out.displayName = v.trim();
    }
    if ('email' in body) {
      const v = body.email;
      if (typeof v !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        return { error: 'email 格式不正确' };
      }
      out.email = v;
    }
    if ('theme' in body) {
      if (!['light', 'dark'].includes(body.theme)) return { error: 'theme 只能是 light 或 dark' };
      out.theme = body.theme;
    }
    if (Object.keys(out).length === 0) return { error: '没有可更新的字段' };
    return { patch: out };
  }

  // ---- 演示场景：服务端作为“攻击者/浏览器”发起真实 HTTP 请求 ----
  const DEMO_SCENARIOS = {
    'ok':                  '正确来源 + 正确令牌（应成功）',
    'missing-token':       '缺少防护令牌（应拒绝）',
    'wrong-token':         '错误的防护令牌（应拒绝）',
    'other-account-token': '使用另一个账号的令牌（应拒绝）',
    'bad-origin-suffix':   '来源域名后缀相似（localhost.evil.test，应拒绝）',
    'bad-origin-port':     '来源端口不符（应拒绝）',
    'no-origin':           '来源信息完全缺失（应拒绝）',
    'referer-fallback':    '无 Origin，合法 Referer 后备（应成功）',
    'get-disguise':        'GET 读取请求伪装修改（应无效）',
  };

  function otherAccountOf(account) {
    return account === 'alice' ? 'bob' : 'alice';
  }

  // 为“另一个账号”准备一个真实存在的会话，返回其有效令牌
  function tokenOfOtherAccount(account) {
    const other = otherAccountOf(account);
    for (const s of sessions.values()) {
      if (s.account === other) return s.token;
    }
    const sid = randomToken(16);
    sessions.set(sid, { account: other, token: randomToken(), createdAt: Date.now(), demo: true });
    return sessions.get(sid).token;
  }

  async function runDemo(scenario, sid, session) {
    const port = app.port;
    const base = `http://127.0.0.1:${port}`;
    const me = session.account;
    const before = JSON.parse(JSON.stringify(accounts[me].settings));
    const stamp = Date.now().toString(36).slice(-5);
    const body = JSON.stringify({ displayName: `演示-${scenario}-${stamp}` });
    const jsonHeaders = { 'content-type': 'application/json' };

    const defs = {
      'ok': () => ({
        method: 'POST', url: '/api/settings',
        headers: { ...jsonHeaders, origin: base, 'x-csrf-token': session.token }, body,
      }),
      'missing-token': () => ({
        method: 'POST', url: '/api/settings',
        headers: { ...jsonHeaders, origin: base }, body,
      }),
      'wrong-token': () => ({
        method: 'POST', url: '/api/settings',
        headers: { ...jsonHeaders, origin: base, 'x-csrf-token': 'forged-' + randomToken(8) }, body,
      }),
      'other-account-token': () => ({
        method: 'POST', url: '/api/settings',
        headers: { ...jsonHeaders, origin: base, 'x-csrf-token': tokenOfOtherAccount(me) }, body,
      }),
      'bad-origin-suffix': () => ({
        method: 'POST', url: '/api/settings',
        headers: { ...jsonHeaders, origin: 'http://localhost.evil.test', 'x-csrf-token': session.token }, body,
      }),
      'bad-origin-port': () => ({
        method: 'POST', url: '/api/settings',
        headers: { ...jsonHeaders, origin: `http://127.0.0.1:${port + 1}`, 'x-csrf-token': session.token }, body,
      }),
      'no-origin': () => ({
        method: 'POST', url: '/api/settings',
        headers: { ...jsonHeaders, 'x-csrf-token': session.token }, body, // 不带 Origin / Referer
      }),
      'referer-fallback': () => ({
        method: 'POST', url: '/api/settings',
        headers: { ...jsonHeaders, referer: `${base}/`, 'x-csrf-token': session.token }, body,
      }),
      'get-disguise': () => ({
        method: 'GET', url: '/api/settings?displayName=伪装修改&theme=dark',
        headers: {}, body: undefined,
      }),
    };

    const def = defs[scenario] && defs[scenario]();
    if (!def) return { error: '未知演示场景' };

    const headers = { ...def.headers, cookie: `${SESSION_COOKIE}=${sid}` };
    const res = await fetch(base + def.url, { method: def.method, headers, body: def.body });
    const json = await res.json().catch(() => null);
    const after = accounts[me].settings;
    const changed = JSON.stringify(before) !== JSON.stringify(after);

    // 展示用请求信息：隐藏令牌与 Cookie
    const shownHeaders = {};
    for (const [k, v] of Object.entries(def.headers)) {
      shownHeaders[k] = k === 'x-csrf-token' ? maskToken(v) : v;
    }
    shownHeaders['cookie'] = `${SESSION_COOKIE}=<已隐藏>`;

    return {
      scenario,
      title: DEMO_SCENARIOS[scenario],
      request: { method: def.method, url: def.url, headers: shownHeaders },
      status: res.status,
      allowed: res.status < 400,
      reason: (json && json.reason) || (def.method === 'GET' ? '读取请求，服务端按只读处理，未修改数据' : '校验通过，修改已应用'),
      changed,
      before,
      after: changed ? after : undefined,
    };
  }

  // ---- 路由 ----
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${u.pathname}`;
    try {
      // 页面
      if (route === 'GET /') {
        const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      // 登录（建立会话，不属于对已登录数据的修改）
      if (route === 'POST /api/login') {
        const body = await readJson(req);
        const acc = body && accounts[body.account];
        if (!acc || acc.password !== body.password) {
          log({ account: body && body.account || '(未知)', action: 'POST /api/login', result: '拒绝', reason: '账号或密码错误' });
          return send(res, 401, { ok: false, reason: '账号或密码错误' });
        }
        const sid = randomToken(16);
        sessions.set(sid, { account: body.account, token: randomToken(), createdAt: Date.now() });
        log({ account: body.account, action: 'POST /api/login', result: '允许', reason: '会话建立，签发新令牌' });
        return send(res, 200, { ok: true, account: body.account }, {
          'set-cookie': `${SESSION_COOKIE}=${sid}; HttpOnly; Path=/; SameSite=Lax`,
        });
      }

      // 退出（销毁会话，旧令牌随之失效）
      if (route === 'POST /api/logout') {
        const ctx = guardMutation(req, res, 'POST /api/logout');
        if (!ctx) return;
        sessions.delete(ctx.sid);
        log({ account: ctx.session.account, action: 'POST /api/logout', result: '允许', reason: `会话销毁（来源校验经由 ${ctx.via}）` });
        return send(res, 200, { ok: true }, {
          'set-cookie': `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`,
        });
      }

      // 当前登录信息
      if (route === 'GET /api/me') {
        const { session } = getSession(req);
        if (!session) return send(res, 401, { ok: false, reason: '未登录' });
        return send(res, 200, { ok: true, account: session.account, settings: accounts[session.account].settings });
      }

      // 取令牌：同一会话多次取到的是同一个令牌，多个页面不会互相作废
      if (route === 'GET /api/token') {
        const { session } = getSession(req);
        if (!session) return send(res, 401, { ok: false, reason: '未登录' });
        return send(res, 200, { ok: true, token: session.token });
      }

      // 读取设置：GET 永不修改状态，携带参数也会被忽略（并记录日志）
      if (route === 'GET /api/settings') {
        const { session } = getSession(req);
        if (!session) return send(res, 401, { ok: false, reason: '未登录' });
        if ([...u.searchParams.keys()].length > 0) {
          log({ account: session.account, action: 'GET /api/settings', result: '忽略', reason: '读取请求携带参数，按只读处理，未修改任何数据' });
        }
        return send(res, 200, { ok: true, account: session.account, settings: accounts[session.account].settings });
      }

      // 修改设置：来源 + 令牌双校验，整体校验后原子写入
      if (route === 'POST /api/settings') {
        const ctx = guardMutation(req, res, 'POST /api/settings');
        if (!ctx) return;
        const body = await readJson(req);
        const { patch, error } = validateSettings(body);
        if (error) {
          log({ account: ctx.session.account, action: 'POST /api/settings', result: '拒绝', reason: `参数校验失败：${error}` });
          return send(res, 400, { ok: false, reason: `参数校验失败：${error}` });
        }
        Object.assign(accounts[ctx.session.account].settings, patch);
        log({
          account: ctx.session.account, action: 'POST /api/settings', result: '允许',
          reason: `来源校验经由 ${ctx.via}，令牌匹配；已更新字段：${Object.keys(patch).join(', ')}`,
        });
        return send(res, 200, { ok: true, settings: accounts[ctx.session.account].settings });
      }

      // 演示场景列表
      if (route === 'GET /api/demo-scenarios') {
        return send(res, 200, { ok: true, scenarios: Object.entries(DEMO_SCENARIOS).map(([id, title]) => ({ id, title })) });
      }

      // 执行演示场景（本身也是修改类请求，同样过双校验）
      if (route === 'POST /api/demo') {
        const ctx = guardMutation(req, res, 'POST /api/demo');
        if (!ctx) return;
        const body = await readJson(req);
        const result = await runDemo(body && body.scenario, ctx.sid, ctx.session);
        if (result.error) return send(res, 400, { ok: false, reason: result.error });
        return send(res, 200, { ok: true, result });
      }

      // 日志（不含令牌 / 会话凭据 / Cookie）
      if (route === 'GET /api/logs') {
        return send(res, 200, { ok: true, logs: logs.slice().reverse() });
      }

      send(res, 404, { ok: false, reason: '接口不存在' });
    } catch (err) {
      send(res, 500, { ok: false, reason: '服务器内部错误' });
    }
  });

  app.listen = (port) => new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      app.port = server.address().port;
      allowedOrigins.add(`http://localhost:${app.port}`);
      allowedOrigins.add(`http://127.0.0.1:${app.port}`);
      resolve(app.port);
    });
  });
  app.close = () => new Promise((resolve) => server.close(resolve));
  app.server = server;
  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT || 3847);
  app.listen(port).then((p) => {
    console.log(`CSRF 验证台已启动: http://localhost:${p}`);
    console.log('模拟账号: alice / alice123 , bob / bob123');
  });
}

module.exports = { createApp };
