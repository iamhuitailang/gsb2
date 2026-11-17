'use strict';

/**
 * 预约后台（站点 A）
 * - 基于会话 Cookie 的登录
 * - 所有"改变状态"的接口在会话层与请求层双重核对：来源(Origin/Referer) + 校验值(CSRF token)
 * - 普通查看链接(GET) 不改变任何状态
 * - 拒绝原因记为安全事件，日志中只保留校验值的哈希前缀，绝不记录原文
 * - 改预约保留旧预约（历史快照）
 *
 * 零依赖，仅使用 Node 内置模块。
 */

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.BACKEND_PORT || 5001);
const ORIGIN = `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// 内存数据（演示用，重启即重置）
// ---------------------------------------------------------------------------

const users = {
  alice: { username: 'alice', password: 'alice123', displayName: 'Alice' },
  bob: { username: 'bob', password: 'bob123', displayName: 'Bob' },
};

// 预约：10:00 的样例预约
const bookings = new Map([
  [
    'BK-1001',
    {
      id: 'BK-1001',
      owner: 'alice',
      service: '口腔检查',
      currentTime: '10:00',
      history: [{ time: '10:00', changedAt: null, note: '初始预约' }],
    },
  ],
]);

/** sessionId -> { username, csrfToken, createdAt } */
const sessions = new Map();

/** 审计流水：业务事件 + 安全事件统一存放，type 区分 */
const auditLog = [];
let auditSeq = 0;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 校验值脱敏：只取 SHA-256 前 8 位用于审计关联，无法还原原文 */
function maskToken(token) {
  if (!token) return null;
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 8);
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 记录一条审计。
 * @param {object} p
 * @param {'business'|'security'} p.type
 * @param {string} p.actor       操作者用户名（未知用 anonymous）
 * @param {string} p.action      动作
 * @param {string} p.target      目标对象
 * @param {'success'|'denied'|'info'} p.result
 * @param {string} [p.reason]    拒绝/说明原因（人类可读，不含敏感原文）
 * @param {object} [p.detail]    结构化细节（禁止放入 token 原文）
 */
function recordEvent({ type, actor, action, target, result, reason, detail }) {
  auditLog.push({
    id: `EVT-${++auditSeq}`,
    at: nowIso(),
    type,
    actor: actor || 'anonymous',
    action,
    target: target || '-',
    result,
    reason: reason || null,
    detail: detail || {},
  });
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function readFormBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(new URLSearchParams(text));
    });
    req.on('error', reject);
  });
}

function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:",
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(html);
}

function redirect(res, location, setCookie) {
  const headers = { Location: location };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  res.writeHead(302, headers);
  res.end();
}

function sessionCookie(sid) {
  // SameSite=Lax：跨站 POST 默认不带 Cookie，是浏览器层的第一道防线；
  // 服务端仍独立核对来源与校验值，不依赖该属性。
  return `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`;
}

function clearSessionCookie() {
  return 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0';
}

function getSession(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  return sessions.get(sid) || null;
}

// ---------------------------------------------------------------------------
// 来源核对（请求层）
// ---------------------------------------------------------------------------

/**
 * 校验状态变更请求的来源。
 * 规则：
 *  - Origin 存在时，必须与本站来源完全一致（协议+主机+端口）
 *  - Origin 缺失时（老浏览器/部分代理），回退校验 Referer 必须以本站来源开头
 *  - 两者都缺失或不匹配 -> 拒绝
 * @returns {{ok: boolean, reason?: string, origin: string|null, referer: string|null}}
 */
function checkOrigin(req) {
  const expected = `http://${req.headers.host}`;
  const origin = req.headers.origin || null;
  const referer = req.headers.referer || null;

  if (origin) {
    if (origin === expected) return { ok: true, origin, referer };
    return {
      ok: false,
      reason: `来源不匹配：Origin=${origin}，期望=${expected}`,
      origin,
      referer,
    };
  }
  if (referer) {
    if (referer === expected || referer.startsWith(expected + '/')) {
      return { ok: true, origin, referer };
    }
    return {
      ok: false,
      reason: `来源不匹配：Referer=${referer}，期望前缀=${expected}/`,
      origin,
      referer,
    };
  }
  return { ok: false, reason: '缺少 Origin 与 Referer，无法确认提交来源', origin, referer };
}

// ---------------------------------------------------------------------------
// 页面骨架
// ---------------------------------------------------------------------------

function layout({ title, session, active, body }) {
  const navUser = session
    ? `<span class="user">${esc(session.displayName)}（${esc(session.username)}）</span>
       <form method="post" action="/logout" class="inline">
         <input type="hidden" name="_csrf" value="${esc(session.csrfToken)}">
         <button type="submit" class="btn btn-ghost">退出登录</button>
       </form>`
    : `<a class="btn btn-ghost" href="/login">登录</a>`;
  const links = [
    ['/', '首页'],
    ['/bookings/BK-1001', '预约详情（只读链接）'],
    ['/audit', '审计页'],
  ]
    .map(
      ([href, label]) =>
        `<a href="${href}" class="navlink ${active === href ? 'on' : ''}">${label}</a>`,
    )
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 预约后台</title>
<style>
  :root { --line:#e3e6ea; --ink:#1f2733; --muted:#6b7480; --brand:#2563eb; --ok:#0f766e; --danger:#b91c1c; --bg:#f6f7f9; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:var(--ink); background:var(--bg); }
  header { background:#fff; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:16px; padding:10px 20px; flex-wrap:wrap; }
  header .brand { font-weight:700; color:var(--brand); }
  header nav { display:flex; gap:6px; flex:1; flex-wrap:wrap; }
  .navlink { padding:6px 10px; border-radius:8px; text-decoration:none; color:var(--muted); font-size:14px; }
  .navlink.on, .navlink:hover { background:#eef2ff; color:var(--brand); }
  .user { font-size:13px; color:var(--muted); }
  main { max-width:880px; margin:24px auto; padding:0 16px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:16px; }
  h1 { font-size:20px; margin:0 0 14px; } h2 { font-size:15px; margin:0 0 10px; }
  .muted { color:var(--muted); font-size:13px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px dashed var(--line); font-size:14px; }
  .row:last-child { border-bottom:none; }
  .row .k { color:var(--muted); }
  .btn { display:inline-block; border:1px solid var(--brand); background:var(--brand); color:#fff; padding:8px 14px; border-radius:8px; font-size:14px; cursor:pointer; text-decoration:none; }
  .btn-ghost { background:#fff; color:var(--brand); }
  .inline { display:inline; }
  input[type=text],input[type=password],input[type=time],select { padding:8px 10px; border:1px solid var(--line); border-radius:8px; font-size:14px; width:100%; }
  label { display:block; font-size:13px; color:var(--muted); margin:10px 0 4px; }
  .flash { padding:10px 12px; border-radius:8px; font-size:14px; margin-bottom:14px; }
  .flash-ok { background:#ecfdf5; color:var(--ok); border:1px solid #a7f3d0; }
  .flash-err { background:#fef2f2; color:var(--danger); border:1px solid #fecaca; }
  .flash-info { background:#eff6ff; color:var(--brand); border:1px solid #bfdbfe; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th,td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; white-space:nowrap; }
  .tag { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; }
  .tag-ok { background:#ecfdf5; color:var(--ok); } .tag-denied { background:#fef2f2; color:var(--danger); } .tag-info { background:#eff6ff; color:var(--brand); }
  .tag-sec { background:#fff7ed; color:#c2410c; } .tag-biz { background:#f0f9ff; color:#0369a1; }
  code { background:#f1f3f5; padding:1px 5px; border-radius:5px; font-size:12px; }
  .checks { font-family:ui-monospace,monospace; font-size:11.5px; color:var(--muted); }
  .history { font-size:13px; } .history li { margin:3px 0; }
</style>
</head>
<body>
<header>
  <span class="brand">🦷 预约后台</span>
  <nav>${links}</nav>
  ${navUser}
</header>
<main>${body}</main>
</body>
</html>`;
}

function flashHtml(flash) {
  if (!flash) return '';
  return `<div class="flash flash-${esc(flash.kind)}">${esc(flash.text)}</div>`;
}

// 一次性 flash 消息通过查询参数传递（不含敏感信息）
function flashFromQuery(url) {
  const map = {
    login_required: ['err', '该操作需要先登录后台。'],
    denied: ['err', '预约变更被拒绝，详情见审计页的安全事件。'],
    changed: ['ok', '预约时间已更新，旧预约已保留。'],
    confirm_required: ['err', '请勾选确认复选框后再提交。'],
    bad_time: ['err', '时间格式无效，请选择合法时间。'],
    not_owner: ['err', '只能修改属于自己的预约。'],
    logout_ok: ['info', '已退出登录，原会话及其校验值已失效。'],
    login_ok: ['ok', '登录成功，已为本次会话签发新的校验值。'],
    login_fail: ['err', '用户名或密码错误。'],
  };
  const key = url.searchParams.get('flash');
  if (key && map[key]) return { kind: map[key][0], text: map[key][1] };
  return null;
}

// ---------------------------------------------------------------------------
// 页面渲染
// ---------------------------------------------------------------------------

function renderLogin(req, url) {
  const body = `
    <div class="card" style="max-width:420px;margin:40px auto;">
      <h1>后台登录</h1>
      <p class="muted">演示账号：<code>alice / alice123</code>、<code>bob / bob123</code></p>
      <form method="post" action="/login">
        <label>用户名</label>
        <input type="text" name="username" autocomplete="username" required autofocus>
        <label>密码</label>
        <input type="password" name="password" autocomplete="current-password" required>
        <div style="margin-top:16px;"><button class="btn" type="submit">登录</button></div>
      </form>
    </div>`;
  return layout({ title: '登录', session: null, active: '/login', body });
}

function renderHome(session) {
  const body = `
    <div class="card">
      <h1>预约后台</h1>
      <p class="muted">本服务运行于来源 <code>${esc(ORIGIN)}</code>。通知页运行在另一个端口、另一个来源。</p>
      ${
        session
          ? `<p>你好，<strong>${esc(session.displayName)}</strong>。可以前往预约详情修改自己的预约时间。</p>
             <a class="btn" href="/bookings/BK-1001">查看 / 修改我的预约</a>`
          : `<p>当前未登录。通知页跳来的只读详情无需登录即可查看；修改预约必须先登录并通过确认流程。</p>
             <a class="btn" href="/login">前往登录</a>`
      }
    </div>
    <div class="card">
      <h2>防护要点</h2>
      <ul class="muted" style="margin:6px 0 0 18px;line-height:1.9;">
        <li>所有状态变更接口核对 <code>Origin/Referer</code> 是否来自本站来源</li>
        <li>每个会话签发独立 CSRF 校验值，服务端用恒定时间比较核对</li>
        <li>登录 / 切换账号会轮换会话与校验值，旧页面里的旧校验值立即失效</li>
        <li>查看类 GET 接口不改变状态；跨站提交被拒绝并记为安全事件</li>
        <li>安全事件只记录校验值哈希前缀，不记录原文</li>
      </ul>
    </div>`;
  return layout({ title: '首页', session, active: '/', body });
}

function renderBookingDetail(req, url, session) {
  const booking = bookings.get('BK-1001');
  const isOwner = session && session.username === booking.owner;
  const flash = flashFromQuery(url);

  const historyHtml = booking.history
    .map(
      (h) =>
        `<li>${esc(h.time)} — ${esc(h.note)}${
          h.changedAt ? `（变更于 ${esc(h.changedAt)}）` : ''
        }</li>`,
    )
    .join('');

  let formHtml = '';
  if (!session) {
    formHtml = `
      <div class="flash flash-info">
        你正在通过通知链接以<strong>未登录</strong>身份查看，本页为只读。<br>
        如需修改时间，请<a href="/login">登录后台</a>后再操作。
      </div>`;
  } else if (!isOwner) {
    formHtml = `
      <div class="flash flash-err">该预约属于 <code>${esc(booking.owner)}</code>，你（${esc(
        session.username,
      )}）无权修改。</div>`;
  } else {
    formHtml = `
      <h2 style="margin-top:18px;">修改预约时间（需确认）</h2>
      <form method="post" action="/bookings/BK-1001/change" class="change-form">
        <input type="hidden" name="_csrf" value="${esc(session.csrfToken)}">
        <label>新的预约时间</label>
        <input type="time" name="newTime" value="${esc(booking.currentTime)}" required>
        <label style="display:block;margin-top:12px;">
          <input type="checkbox" name="confirm" value="yes">
          我确认要提交本次预约变更（旧时间会保留在历史中）
        </label>
        <div style="margin-top:14px;"><button class="btn" type="submit">确认提交变更</button></div>
        <p class="muted" style="margin-top:10px;">本表单仅能在后台同源页面提交；服务端还会再次核对来源与校验值。</p>
      </form>`;
  }

  const body = `
    ${flashHtml(flash)}
    <div class="card">
      <h1>预约详情 ${esc(booking.id)}</h1>
      <div class="row"><span class="k">服务项目</span><strong>${esc(booking.service)}</strong></div>
      <div class="row"><span class="k">当前预约时间</span><strong style="font-size:18px;">${esc(
        booking.currentTime,
      )}</strong></div>
      <div class="row"><span class="k">归属用户</span><span>${esc(booking.owner)}</span></div>
      <div class="row"><span class="k">登录状态</span><span>${
        session ? esc(session.username) : '未登录（只读查看）'
      }</span></div>
    </div>
    <div class="card">
      <h2>预约历史（旧预约保留）</h2>
      <ul class="history">${historyHtml}</ul>
    </div>
    <div class="card">${formHtml}</div>`;
  return layout({ title: '预约详情', session, active: '/bookings/BK-1001', body });
}

function renderAudit(session) {
  const biz = auditLog.filter((e) => e.type === 'business');
  const sec = auditLog.filter((e) => e.type === 'security');

  const row = (e) => `
    <tr>
      <td>${esc(e.id)}</td>
      <td style="white-space:nowrap;">${esc(e.at.replace('T', ' ').replace('Z', ' Z'))}</td>
      <td>${esc(e.actor)}</td>
      <td>${esc(e.action)}</td>
      <td>${esc(e.target)}</td>
      <td><span class="tag tag-${esc(e.result)}">${esc(e.result)}</span></td>
      <td>${esc(e.reason || '')}</td>
      <td class="checks">${esc(
        Object.keys(e.detail).length ? JSON.stringify(e.detail) : '',
      )}</td>
    </tr>`;

  const table = (rows) => `
    <table>
      <thead><tr><th>ID</th><th>时间(UTC)</th><th>操作者</th><th>动作</th><th>对象</th><th>结果</th><th>原因</th><th>结构化细节</th></tr></thead>
      <tbody>${rows.map(row).join('') || '<tr><td colspan="8" class="muted">暂无记录</td></tr>'}</tbody>
    </table>`;

  const body = `
    <div class="card">
      <h1>审计页 <span class="tag tag-biz">业务事件 ${biz.length}</span>
      <span class="tag tag-sec">安全事件 ${sec.length}</span></h1>
      <p class="muted">安全事件记录拒绝原因与校验值<strong>哈希前缀</strong>，不包含校验值原文。机器可读 JSON：<a href="/audit.json">/audit.json</a></p>
    </div>
    <div class="card">
      <h2>① 安全事件（被拦截的跨站 / 越权 / 校验失败请求）</h2>
      ${table(sec)}
    </div>
    <div class="card">
      <h2>② 业务审计（登录、成功的预约变更等）</h2>
      ${table(biz)}
    </div>`;
  return layout({ title: '审计', session, active: '/audit', body });
}

// ---------------------------------------------------------------------------
// 路由处理
// ---------------------------------------------------------------------------

async function handleLogin(req, res) {
  const form = await readFormBody(req);
  const username = (form.get('username') || '').trim();
  const password = form.get('password') || '';
  const user = users[username];

  if (!user || !timingSafeEqualHex(crypto.createHash('sha256').update(password).digest('hex'),
                                   crypto.createHash('sha256').update(user.password).digest('hex'))) {
    recordEvent({
      type: 'security',
      actor: username || 'anonymous',
      action: 'login',
      target: 'session',
      result: 'denied',
      reason: '用户名或密码错误',
      detail: { ip: req.socket.remoteAddress },
    });
    return redirect(res, '/login?flash=login_fail');
  }

  // 登录成功：轮换全新会话 ID 与全新 CSRF 校验值（防止会话固定）
  const sid = randomToken();
  const csrfToken = randomToken();
  sessions.set(sid, { username, displayName: user.displayName, csrfToken, createdAt: nowIso() });
  recordEvent({
    type: 'business',
    actor: username,
    action: 'login',
    target: 'session',
    result: 'success',
    detail: { sessionIssued: true },
  });
  redirect(res, '/?flash=login_ok', sessionCookie(sid));
}

function handleLogout(req, res, session, sid) {
  // 销毁会话：该会话的校验值随之失效，旧页面里拿到的 token 不能再用
  if (session) {
    recordEvent({
      type: 'business',
      actor: session.username,
      action: 'logout',
      target: 'session',
      result: 'info',
      detail: { sessionDestroyed: true },
    });
  }
  sessions.delete(sid);
  redirect(res, '/?flash=logout_ok', clearSessionCookie());
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function handleChange(req, res, url) {
  const bookingId = url.pathname.split('/')[2];
  const booking = bookings.get(bookingId);
  const cookies = parseCookies(req);
  const sid = cookies.sid || null;
  const session = sid ? sessions.get(sid) : null;
  const actor = session ? session.username : 'anonymous';
  const requestId = randomToken(8);

  // 统一拒绝出口：记安全事件（detail 内绝不放 token 原文）
  const deny = (reason, checks) => {
    recordEvent({
      type: 'security',
      actor,
      action: 'change_booking',
      target: bookingId,
      result: 'denied',
      reason,
      detail: { requestId, ...checks },
    });
    redirect(res, `/bookings/${bookingId}?flash=denied`);
  };

  // 第 1 层：请求层来源核对
  const originCheck = checkOrigin(req);
  if (!originCheck.ok) {
    return deny(originCheck.reason, {
      origin: originCheck.origin,
      referer: originCheck.referer,
      tokenHash: null,
    });
  }

  // 第 2 层：会话层——必须持有有效登录会话
  if (!session) {
    return deny('未登录或会话已过期/已轮换，缺少有效会话', {
      originOk: true,
      sessionOk: false,
      tokenHash: null,
    });
  }

  // 第 3 层：会话层——只能改自己的预约
  if (!booking || booking.owner !== session.username) {
    return deny(`越权：预约 ${bookingId} 不属于当前会话用户 ${session.username}`, {
      originOk: true,
      sessionOk: true,
      ownerOk: false,
      tokenHash: null,
    });
  }

  const form = await readFormBody(req);
  const submittedToken = form.get('_csrf') || '';

  // 第 4 层：请求层——CSRF 校验值恒定时间比对（不记录原文）
  const tokenOk = timingSafeEqualHex(submittedToken, session.csrfToken);
  if (!tokenOk) {
    return deny('CSRF 校验值缺失、错误或属于已失效的旧会话', {
      originOk: true,
      sessionOk: true,
      ownerOk: true,
      tokenOk: false,
      tokenHash: maskToken(submittedToken),
    });
  }

  // 第 5 层：确认流程——必须显式勾选确认
  if (form.get('confirm') !== 'yes') {
    recordEvent({
      type: 'business',
      actor: session.username,
      action: 'change_booking',
      target: bookingId,
      result: 'denied',
      reason: '未勾选确认复选框，确认流程未完成',
      detail: { requestId, originOk: true, sessionOk: true, ownerOk: true, tokenOk: true },
    });
    return redirect(res, `/bookings/${bookingId}?flash=confirm_required`);
  }

  // 第 6 层：业务字段校验
  const newTime = (form.get('newTime') || '').trim();
  if (!TIME_RE.test(newTime)) {
    recordEvent({
      type: 'business',
      actor: session.username,
      action: 'change_booking',
      target: bookingId,
      result: 'denied',
      reason: `非法时间格式: ${newTime || '(空)'}`,
      detail: { requestId },
    });
    return redirect(res, `/bookings/${bookingId}?flash=bad_time`);
  }

  // 全部通过：保留旧预约，再更新
  const oldTime = booking.currentTime;
  booking.history.push({ time: oldTime, changedAt: nowIso(), note: '变更前时间（自动保留）' });
  booking.currentTime = newTime;

  recordEvent({
    type: 'business',
    actor: session.username,
    action: 'change_booking',
    target: bookingId,
    result: 'success',
    detail: {
      requestId,
      oldTime,
      newTime,
      originOk: true,
      sessionOk: true,
      ownerOk: true,
      tokenOk: true,
      confirmed: true,
    },
  });
  redirect(res, `/bookings/${bookingId}?flash=changed`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const session = getSession(req);
  const sid = parseCookies(req).sid || null;

  try {
    // 只读查看类路由（GET）——不改变任何状态
    if (req.method === 'GET' && url.pathname === '/') {
      return sendHtml(res, 200, renderHome(session));
    }
    if (req.method === 'GET' && url.pathname === '/login') {
      if (session) return redirect(res, '/');
      return sendHtml(res, 200, renderLogin(req, url));
    }
    if (req.method === 'GET' && url.pathname === '/bookings/BK-1001') {
      return sendHtml(res, 200, renderBookingDetail(req, url, session));
    }
    if (req.method === 'GET' && url.pathname === '/audit') {
      return sendHtml(res, 200, renderAudit(session));
    }
    if (req.method === 'GET' && url.pathname === '/audit.json') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify({ origin: ORIGIN, events: auditLog }, null, 2));
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, origin: ORIGIN }));
    }

    // 状态变更类路由（POST）
    if (req.method === 'POST' && url.pathname === '/login') return handleLogin(req, res);
    if (req.method === 'POST' && url.pathname === '/logout') {
      // 登出同样做来源核对，防止跨站强制登出
      const oc = checkOrigin(req);
      if (!oc.ok) {
        recordEvent({
          type: 'security',
          actor: session ? session.username : 'anonymous',
          action: 'logout',
          target: 'session',
          result: 'denied',
          reason: oc.reason,
          detail: { origin: oc.origin, referer: oc.referer },
        });
        return redirect(res, '/?flash=denied');
      }
      return handleLogout(req, res, session, sid);
    }
    if (req.method === 'POST' && url.pathname === '/bookings/BK-1001/change') {
      return handleChange(req, res, url);
    }

    // 其它方法（如跨站 PUT/DELETE 试探）统一拒绝并记录
    recordEvent({
      type: 'security',
      actor: session ? session.username : 'anonymous',
      action: req.method.toLowerCase(),
      target: url.pathname,
      result: 'denied',
      reason: `不支持的方法/路径: ${req.method} ${url.pathname}`,
      detail: { origin: req.headers.origin || null },
    });
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    recordEvent({
      type: 'security',
      actor: session ? session.username : 'anonymous',
      action: 'server_error',
      target: url.pathname,
      result: 'denied',
      reason: `服务器异常: ${err.message}`,
      detail: {},
    });
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log(`[backend] 预约后台运行于 ${ORIGIN}（来源 A）`);
});

module.exports = { server, ORIGIN, maskToken, checkOrigin, sessions, bookings, auditLog };
