'use strict';

/**
 * 通知页（站点 B，与后台不同来源）
 * - 展示预约通知，提供"查看预约详情"的只读链接（跳到后台来源的 GET 页面，不改变状态）
 * - 提供"发送演示变更"按钮：模拟第三方页面对后台发起的跨站改预约请求
 *   这些请求都应被后台的来源/会话/校验值检查拒绝，预约保持 10:00
 *
 * 零依赖，仅使用 Node 内置模块。
 */

const http = require('node:http');

const PORT = Number(process.env.NOTIFY_PORT || 5002);
const ORIGIN = `http://localhost:${PORT}`;
const BACKEND = process.env.BACKEND_URL || 'http://localhost:5001';
const BOOKING_ID = 'BK-1001';
const CHANGE_URL = `${BACKEND}/bookings/${BOOKING_ID}/change`;
const DETAIL_URL = `${BACKEND}/bookings/${BOOKING_ID}`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>预约通知</title>
<style>
  :root { --line:#e3e6ea; --ink:#1f2733; --muted:#6b7480; --brand:#7c3aed; --danger:#b91c1c; --ok:#0f766e; --bg:#f6f4fb; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:var(--ink); background:var(--bg); }
  header { background:#fff; border-bottom:1px solid var(--line); padding:12px 20px; font-weight:700; color:var(--brand); }
  main { max-width:760px; margin:24px auto; padding:0 16px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:16px; }
  h1 { font-size:20px; margin:0 0 12px; } h2 { font-size:15px; margin:0 0 10px; }
  .muted { color:var(--muted); font-size:13px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px dashed var(--line); font-size:14px; }
  .row:last-child { border-bottom:none; }
  .row .k { color:var(--muted); }
  .time { font-size:26px; font-weight:700; color:var(--brand); }
  .btn { display:inline-block; border:1px solid var(--brand); background:var(--brand); color:#fff; padding:9px 16px; border-radius:8px; font-size:14px; cursor:pointer; text-decoration:none; }
  .btn-danger { border-color:var(--danger); background:var(--danger); }
  .btn-ghost { background:#fff; color:var(--brand); }
  code { background:#f1f3f5; padding:1px 5px; border-radius:5px; font-size:12px; }
  .log { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; background:#0f172a; color:#cbd5e1; border-radius:10px; padding:12px; max-height:300px; overflow:auto; white-space:pre-wrap; }
  .log .ok { color:#6ee7b7; } .log .bad { color:#fca5a5; } .log .info { color:#93c5fd; }
  .attack { border:1px solid #fecaca; background:#fef2f2; border-radius:10px; padding:14px; }
  ul { line-height:1.9; font-size:13.5px; }
  .pill { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; background:#ede9fe; color:var(--brand); }
</style>
</head>
<body>
<header>🔔 预约通知中心 <span class="pill" style="float:right;font-weight:400;">来源 B：${esc(ORIGIN)}</span></header>
<main>
  <div class="card">
    <h1>您的预约已确认</h1>
    <div class="row"><span class="k">预约编号</span><strong>${esc(BOOKING_ID)}</strong></div>
    <div class="row"><span class="k">服务项目</span><span>口腔检查</span></div>
    <div class="row"><span class="k">预约时间</span><span class="time">10:00</span></div>
    <div class="row"><span class="k">归属用户</span><span>alice</span></div>
    <p class="muted" style="margin-top:14px;">
      后台服务运行在另一个来源 <code>${esc(BACKEND)}</code>。下方链接是普通查看链接（GET），打开不会改变任何状态。
    </p>
    <a class="btn" href="${esc(DETAIL_URL)}" target="_blank" rel="noopener">打开预约详情（只读查看）</a>
  </div>

  <div class="card attack">
    <h2 style="color:var(--danger);">⚠️ 演示：跨站发起预约变更（应全部被拒绝）</h2>
    <p class="muted">
      本页与后台<strong>不同源</strong>。下面的按钮模拟恶意第三方页面对后台
      <code>/bookings/${esc(BOOKING_ID)}/change</code> 发起的改时间请求（试图改成 09:00）。
      后台会在会话层与请求层核对来源和校验值并拒绝；预约仍保持 <strong>10:00</strong>，拒绝记录出现在后台审计页的安全事件中。
    </p>
    <p>
      <button class="btn btn-danger" id="attackBtn">发送演示变更（3 种跨站请求）</button>
      <a class="btn btn-ghost" href="${esc(BACKEND)}/audit" target="_blank" rel="noopener">打开后台审计页</a>
    </p>
    <div class="log" id="log">等待发起…</div>
    <!-- 隐藏 iframe：让表单式跨站 POST 在后台完成而不把本页导航走 -->
    <iframe name="csrfSink" style="display:none"></iframe>
    <form id="formAttack" method="post" action="${esc(CHANGE_URL)}" target="csrfSink" style="display:none">
      <input type="hidden" name="newTime" value="09:00">
      <input type="hidden" name="confirm" value="yes">
      <input type="hidden" name="_csrf" value="FORGED-FROM-OTHER-ORIGIN">
    </form>
  </div>

  <div class="card">
    <h2>预期结果对照</h2>
    <ul>
      <li>表单式跨站 POST：浏览器自动带上后台 Cookie（若已登录），但 <code>Origin</code> 是本站 → 后台来源核对拒绝。</li>
      <li>fetch（text/plain，简单请求）：同样携带 Cookie，服务端先按来源拒绝，响应被 CORS 拦截无法读取。</li>
      <li>fetch（application/json，预检失败）：<code>OPTIONS</code> 预检拿不到 CORS 许可，浏览器根本不发 POST。</li>
      <li>回到后台同源页面、带本会话正确校验值并确认后，改到 11:00 才会成功；旧时间 10:00 保留在历史里。</li>
    </ul>
  </div>
</main>

<script>
const logEl = document.getElementById('log');
const CHANGE_URL = ${JSON.stringify(CHANGE_URL)};
function line(msg, cls) {
  const span = document.createElement('div');
  if (cls) span.className = cls;
  span.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
}

document.getElementById('attackBtn').addEventListener('click', async () => {
  logEl.innerHTML = '';

  // ① 经典表单式 CSRF（导航型简单请求，无预检）
  line('① 表单式跨站 POST（伪造 _csrf=FORGED-FROM-OTHER-ORIGIN）…', 'info');
  document.getElementById('formAttack').submit();
  line('   已提交到隐藏 iframe。后台按 Origin 来源核对拒绝（302 跳到拒绝提示），状态未改变。', 'bad');

  // ② fetch 简单请求（text/plain 不触发预检），带伪造校验值
  line('② fetch 跨站 POST（text/plain + 伪造校验值，credentials=include）…', 'info');
  try {
    await fetch(CHANGE_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'text/plain' },
      body: new URLSearchParams({ newTime: '09:00', confirm: 'yes', _csrf: 'FORGED-FROM-OTHER-ORIGIN' }).toString(),
    });
    line('   意外读到了响应（不应发生）。', 'bad');
  } catch (e) {
    line('   服务端已拒绝；浏览器因 CORS 不允许跨源读取响应 → 前端看到 TypeError: ' + e.message, 'ok');
  }

  // ③ fetch 非简单请求（application/json 触发预检）
  line('③ fetch 跨站 POST（application/json，先发 OPTIONS 预检）…', 'info');
  try {
    await fetch(CHANGE_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newTime: '09:00', confirm: 'yes', _csrf: 'FORGED-FROM-OTHER-ORIGIN' }),
    });
    line('   意外读到了响应（不应发生）。', 'bad');
  } catch (e) {
    line('   预检未获得 Access-Control-Allow-Origin 许可，浏览器拦截，POST 未发出: ' + e.message, 'ok');
  }

  line('完成：请刷新后台预约详情确认时间仍为 10:00，并在审计页查看 3 条（含预检外的）安全事件。', 'info');
});
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'",
      'Cache-Control': 'no-store',
    });
    return res.end(page);
  }
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, origin: ORIGIN, backend: BACKEND }));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`[notify] 通知页运行于 ${ORIGIN}（来源 B）-> 后台 ${BACKEND}`);
});

module.exports = { server, ORIGIN };
