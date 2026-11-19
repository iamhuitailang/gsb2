'use strict';
/**
 * 多组织客服后台（本地演示）
 *
 * 演示要点：
 * 1. 组织绑定在 URL 路径里：/org/:orgId/customers/:localNo
 *    —— 每个标签的地址各自独立，刷新/回退都能认出原组织。
 * 2. 读写接口都要求请求显式携带 orgId，服务端先校验当前用户
 *    对该组织的权限，再用 (orgId, localNo) 复合键查资源。
 * 3. 前端切换组织时用单调递增的请求序号丢弃迟到的旧响应，
 *    旧组织的慢查询不会覆盖新组织的页面。
 * 4. 权限被收回后，读和写都返回 403。
 *
 * 运行：node server.js  然后打开 http://localhost:3000
 */

const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

// ---------- 演示数据 ----------
const users = {
  // 同一个客服账号，同时在甲、乙两个组织
  agent: { id: 'agent', name: '客服小孙', password: 'demo' },
};

// 组织成员关系（可被 admin 接口收回/恢复，用于演示“失去权限”）
const memberships = {
  agent: new Set(['orgA', 'orgB']),
};

const orgs = {
  orgA: { id: 'orgA', name: '甲组织' },
  orgB: { id: 'orgB', name: '乙组织' },
};

// 客户表：复合键 (orgId, localNo)。两边都有本地编号 C01，互不相同。
const customers = new Map();
function seed(orgId, localNo, name, note) {
  customers.set(`${orgId}:${localNo}`, { orgId, localNo, name, note });
}
seed('orgA', 'C01', '王五（甲）', '【甲】初始备注');
seed('orgB', 'C01', '王五（乙）', '【乙】初始备注');

// 会话：token -> userId（内存版，重启即失效）
const sessions = new Map();

// ---------- 工具 ----------
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && body !== null;
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    ...headers,
  });
  res.end(data);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function currentUser(req) {
  const token = parseCookies(req).sid;
  const userId = token && sessions.get(token);
  return userId ? users[userId] : null;
}

function hasAccess(userId, orgId) {
  return memberships[userId] && memberships[userId].has(orgId);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 页面 ----------
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>多组织客服后台（演示）</title>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; max-width: 720px; margin: 32px auto; padding: 0 16px; color: #222; }
  .bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
  .org-btn { padding: 6px 14px; border: 1px solid #999; border-radius: 6px; background: #fff; cursor: pointer; }
  .org-btn.active { background: #2563eb; color: #fff; border-color: #2563eb; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 16px; }
  textarea { width: 100%; height: 96px; box-sizing: border-box; margin: 8px 0; font-size: 14px; }
  button.save { padding: 8px 20px; background: #16a34a; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  button.save:disabled { background: #aaa; cursor: not-allowed; }
  .muted { color: #777; font-size: 13px; }
  .err { color: #b91c1c; }
  #ctx { font-weight: 600; }
  .admin { margin-top: 24px; padding: 12px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; }
</style>
</head>
<body>
<h2>多组织客服后台（演示）</h2>
<div class="bar">
  <span>当前用户：<b id="me">…</b></span>
  <span class="muted">|</span>
  <span>组织：</span>
  <button class="org-btn" data-org="orgA">甲组织</button>
  <button class="org-btn" data-org="orgB">乙组织</button>
  <span class="muted">（切换只改本标签的地址，不影响其他标签）</span>
</div>
<div class="card">
  <div>当前上下文：<span id="ctx">…</span></div>
  <div class="muted" id="cust-meta"></div>
  <textarea id="note" placeholder="备注…"></textarea>
  <button class="save" id="save">保存备注</button>
  <span id="status" class="muted"></span>
</div>
<div class="admin">
  <b>演示控制</b>（模拟权限变化，作用于服务端成员关系）：
  <button id="revokeB">收回我对乙组织的权限</button>
  <button id="grantB">恢复我对乙组织的权限</button>
  <div class="muted">收回后，乙标签的读取和保存都会被服务端拒绝（403）。</div>
</div>
<script>
// —— 组织上下文只来自本标签的 URL，不用任何全局/跨标签存储 ——
function ctxFromUrl() {
  const m = location.pathname.match(/^\\/org\\/([^/]+)\\/customers\\/([^/]+)$/);
  return m ? { orgId: m[1], localNo: m[2] } : null;
}

// 单调递增的请求序号：只接受“最新一次”请求的响应，
// 旧组织发出的慢响应回来时序号已过期，直接丢弃，不覆盖当前页面。
let reqSeq = 0;

const ORG_NAMES = { orgA: '甲组织', orgB: '乙组织' };
const $ = (id) => document.getElementById(id);

function setStatus(msg, isErr) {
  const el = $('status');
  el.textContent = msg;
  el.className = isErr ? 'err' : 'muted';
}

async function load() {
  const ctx = ctxFromUrl();
  if (!ctx) return;
  const mySeq = ++reqSeq;

  // 高亮当前组织按钮
  document.querySelectorAll('.org-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.org === ctx.orgId));
  $('ctx').textContent = ORG_NAMES[ctx.orgId] + ' / 客户 ' + ctx.localNo;
  $('note').value = '';
  $('note').disabled = true;
  $('save').disabled = true;
  setStatus('加载中…');

  try {
    // delay 参数模拟慢网络，便于复现“旧组织的响应后到”
    const res = await fetch('/api/orgs/' + ctx.orgId + '/customers/' + ctx.localNo + '?delay=600',
      { credentials: 'same-origin' });
    if (mySeq !== reqSeq) return; // 已切走，丢弃迟到响应
    if (res.status === 403) {
      $('cust-meta').textContent = '';
      setStatus('没有该组织的权限，已拒绝读取。', true);
      return;
    }
    if (!res.ok) { setStatus('加载失败：' + res.status, true); return; }
    const c = await res.json();
    $('cust-meta').textContent = '客户姓名：' + c.name + '（键：' + c.orgId + ' + ' + c.localNo + '）';
    $('note').value = c.note;
    $('note').disabled = false;
    $('save').disabled = false;
    setStatus('已加载。');
  } catch (e) {
    if (mySeq === reqSeq) setStatus('网络错误', true);
  }
}

async function save() {
  const ctx = ctxFromUrl();
  if (!ctx) return;
  $('save').disabled = true;
  try {
    const res = await fetch('/api/orgs/' + ctx.orgId + '/customers/' + ctx.localNo, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: $('note').value }),
    });
    if (res.status === 403) {
      setStatus('没有该组织的权限，保存被拒绝。', true);
      return;
    }
    if (!res.ok) { setStatus('保存失败：' + res.status, true); return; }
    setStatus('已保存到 ' + ORG_NAMES[ctx.orgId] + ' 的 ' + ctx.localNo + '。');
  } finally {
    $('save').disabled = false;
  }
}

// 切换组织 = 跳转本标签的 URL；其他标签的地址和上下文不受影响
function switchOrg(orgId) {
  const ctx = ctxFromUrl();
  const localNo = ctx ? ctx.localNo : 'C01';
  location.assign('/org/' + orgId + '/customers/' + localNo);
}

async function setMembership(orgId, allowed) {
  await fetch('/api/admin/membership', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgId, allowed }),
  });
  await load(); // 重新校验当前页
}

document.querySelectorAll('.org-btn').forEach((b) =>
  b.addEventListener('click', () => switchOrg(b.dataset.org)));
$('save').addEventListener('click', save);
$('revokeB').addEventListener('click', () => setMembership('orgB', false));
$('grantB').addEventListener('click', () => setMembership('orgB', true));
window.addEventListener('popstate', load); // 前进/后退回到旧地址时按地址恢复上下文

(async function init() {
  const me = await (await fetch('/api/me', { credentials: 'same-origin' })).json();
  $('me').textContent = me.name + '（可进入：' + me.orgs.map((o) => ORG_NAMES[o] || o).join('、') + '）';
  if (!ctxFromUrl()) {
    // 默认落到甲组织的 C01
    history.replaceState(null, '', '/org/orgA/customers/C01');
  }
  load();
})();
</script>
</body>
</html>`;

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    // 登录（演示：自动登录为 agent；保留 /login 接口展示会话建立）
    if (path === '/login') {
      const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessions.set(token, 'agent');
      send(res, 302, '', { Location: '/', 'Set-Cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Lax` });
      return;
    }

    // 页面路由：/org/:orgId/customers/:localNo —— 组织绑定在地址里
    if (req.method === 'GET' && (path === '/' || /^\/org\/[^/]+\/customers\/[^/]+$/.test(path))) {
      if (!currentUser(req)) {
        send(res, 302, '', { Location: '/login' });
        return;
      }
      send(res, 200, PAGE);
      return;
    }

    // 以下 API 都要求已登录
    const user = currentUser(req);
    if (!user) {
      send(res, 401, { error: 'unauthenticated' });
      return;
    }

    if (path === '/api/me' && req.method === 'GET') {
      send(res, 200, { id: user.id, name: user.name, orgs: [...memberships[user.id]] });
      return;
    }

    // 演示用：收回/恢复组织权限
    if (path === '/api/admin/membership' && req.method === 'POST') {
      const body = await readBody(req);
      if (!orgs[body.orgId]) {
        send(res, 400, { error: 'unknown org' });
        return;
      }
      if (body.allowed) memberships[user.id].add(body.orgId);
      else memberships[user.id].delete(body.orgId);
      send(res, 200, { ok: true, orgs: [...memberships[user.id]] });
      return;
    }

    // 客户读写：/api/orgs/:orgId/customers/:localNo
    const m = path.match(/^\/api\/orgs\/([^/]+)\/customers\/([^/]+)$/);
    if (m) {
      const [, orgId, localNo] = m;

      // 1) 先校验当前用户是否有“请求里这个组织”的权限
      if (!orgs[orgId] || !hasAccess(user.id, orgId)) {
        send(res, 403, { error: 'forbidden', message: '没有该组织的权限' });
        return;
      }

      // 2) 再用 (组织, 本地编号) 复合键找资源 —— 不同组织的 C01 互不相干
      const customer = customers.get(`${orgId}:${localNo}`);
      if (!customer) {
        send(res, 404, { error: 'not_found' });
        return;
      }

      if (req.method === 'GET') {
        // 演示用：模拟慢查询，便于复现竞态
        const delay = Number(url.searchParams.get('delay') || 0);
        if (delay > 0) await sleep(Math.min(delay, 5000));
        send(res, 200, customer);
        return;
      }

      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (typeof body.note !== 'string') {
          send(res, 400, { error: 'note must be a string' });
          return;
        }
        customer.note = body.note;
        send(res, 200, customer);
        return;
      }

      send(res, 405, { error: 'method_not_allowed' });
      return;
    }

    send(res, 404, { error: 'not_found' });
  } catch (e) {
    send(res, 500, { error: 'internal', message: String(e && e.message) });
  }
});

server.listen(PORT, () => {
  console.log(`演示后台已启动: http://localhost:${PORT}`);
  console.log('预置数据：甲组织(orgA) 与 乙组织(orgB) 各有客户 C01');
});
