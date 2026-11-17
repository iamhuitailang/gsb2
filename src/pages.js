// 纯字符串模板渲染页面；所有动态值经 esc() 转义，防止 XSS
import { PENDING_TTL_MS } from './store.js';

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function layout(title, body, { nav = '' } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - 值班后台</title>
<style>
  :root { --border:#d9dee5; --muted:#6b7280; --primary:#2563eb; --danger:#dc2626; --bg:#f5f7fa; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background:var(--bg); color:#111827; }
  header { background:#fff; border-bottom:1px solid var(--border); padding:12px 24px; display:flex; align-items:center; gap:20px; }
  header .brand { font-weight:700; }
  header nav a { margin-right:16px; color:var(--primary); text-decoration:none; }
  main { max-width:880px; margin:28px auto; padding:0 20px; }
  .card { background:#fff; border:1px solid var(--border); border-radius:10px; padding:24px; margin-bottom:20px; }
  h1 { font-size:20px; margin:0 0 16px; }
  h2 { font-size:16px; margin:0 0 12px; }
  label { display:block; font-size:13px; color:#374151; margin:12px 0 4px; }
  input[type=text], input[type=password] { width:100%; padding:9px 10px; border:1px solid var(--border); border-radius:7px; font-size:14px; }
  button { margin-top:16px; padding:9px 18px; background:var(--primary); color:#fff; border:0; border-radius:7px; font-size:14px; cursor:pointer; }
  button.ghost { background:#fff; color:var(--danger); border:1px solid var(--danger); margin:0; padding:5px 12px; }
  .error { background:#fef2f2; border:1px solid #fecaca; color:#991b1b; padding:10px 12px; border-radius:7px; font-size:13px; margin-bottom:14px; }
  .ok { background:#f0fdf4; border:1px solid #bbf7d0; color:#166534; padding:10px 12px; border-radius:7px; font-size:13px; margin-bottom:14px; }
  .muted { color:var(--muted); font-size:13px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:600; font-size:12px; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; background:#fef3c7; color:#92400e; }
  .badge.ok { background:#dcfce7; color:#166534; }
  form.inline { display:inline; }
  code { background:#f3f4f6; padding:1px 5px; border-radius:4px; font-size:12px; word-break:break-all; }
  .msg { border:1px solid var(--border); border-radius:8px; padding:14px 16px; margin-bottom:12px; }
  .msg .meta { font-size:12px; color:var(--muted); margin-bottom:6px; }
  .msg .link { margin-top:8px; font-size:13px; word-break:break-all; }
  .msg .link a { color:var(--primary); }
</style>
</head>
<body>
<header>
  <span class="brand">🕓 值班账号后台</span>
  <nav>${nav}</nav>
</header>
<main>
${body}
</main>
</body>
</html>`;
}

const authNav = `<a href="/">值班表</a><a href="/inbox">收件箱</a><a href="/security">安全设置</a>
<form class="inline" method="post" action="/logout"><button class="ghost" type="submit">退出登录</button></form>`;

export function loginPage(error = '') {
  const body = `
<div class="card" style="max-width:420px;margin:40px auto;">
  <h1>登录</h1>
  ${error ? `<div class="error">${esc(error)}</div>` : ''}
  <form method="post" action="/login">
    <label for="username">账号</label>
    <input id="username" name="username" type="text" autocomplete="username" required autofocus>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <label style="display:flex;align-items:center;gap:8px;margin-top:14px;">
      <input type="checkbox" name="remember" value="1" style="width:auto;"> 记住这台设备（下次免设备确认）
    </label>
    <label for="deviceName">设备自定义名称（可选，仅显示在安全页）</label>
    <input id="deviceName" name="deviceName" type="text" placeholder="例如：我的 MacBook / 工位 Chrome">
    <button type="submit">登录</button>
  </form>
  <p class="muted" style="margin-top:16px;">未记住的浏览器即使密码正确，也需到内置<a href="/inbox">收件箱</a>完成设备确认。</p>
</div>`;
  return layout('登录', body);
}

export function waitingPage() {
  const minutes = PENDING_TTL_MS / 60000;
  const body = `
<div class="card" style="max-width:520px;margin:40px auto;">
  <h1><span class="badge">等待设备确认</span></h1>
  <p>密码正确，但当前浏览器尚未被信任。确认链接已发送到内置<a href="/inbox">收件箱</a>，请在 <b>${minutes} 分钟</b>内完成确认。</p>
  <p class="muted">确认链接仅对本次登录、当前浏览器有效，复制到其他浏览器打开不会通过。</p>
  <p>当前状态：<span id="status" class="badge">等待确认中…</span></p>
  <form method="post" action="/logout" class="inline">
    <button class="ghost" type="submit">取消并返回登录</button>
  </form>
</div>
<script>
  async function poll() {
    try {
      const res = await fetch('/wait/status', { cache: 'no-store' });
      if (res.status === 403) { document.getElementById('status').textContent = '等待已失效，请重新登录'; return; }
      const data = await res.json();
      if (data.status === 'confirmed') {
        document.getElementById('status').textContent = '已确认，正在跳转…';
        document.getElementById('status').className = 'badge ok';
        location.href = '/';
        return;
      }
    } catch (_) { /* 离线时静默重试 */ }
    setTimeout(poll, 2000);
  }
  setTimeout(poll, 2000);
</script>`;
  return layout('等待确认', body);
}

export function confirmErrorPage(message) {
  const body = `
<div class="card" style="max-width:520px;margin:40px auto;">
  <h1>设备确认失败</h1>
  <div class="error">${esc(message)}</div>
  <p class="muted">确认链接只能由发起本次登录的那台浏览器使用。请回到正在等待确认的浏览器，在其中打开收件箱完成确认。</p>
  <a href="/waiting">返回等待页</a>
</div>`;
  return layout('确认失败', body);
}

export function rosterPage(roster, username, deviceName) {
  const rows = roster
    .map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.day)}</td><td>${esc(r.primary)}</td><td>${esc(r.backup)}</td><td>${esc(r.phone)}</td></tr>`)
    .join('');
  const body = `
<div class="card">
  <h1>本周值班表</h1>
  <p class="muted">登录账号：${esc(username)}${deviceName ? ` · 当前设备：${esc(deviceName)}` : ''}</p>
  <table>
    <thead><tr><th>日期</th><th>星期</th><th>主班</th><th>备班</th><th>联系电话</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
  return layout('值班表', body, { nav: authNav });
}

export function inboxPage(messages, authed) {
  const nav = authed ? authNav : '';
  const list = messages.length
    ? messages
        .map(
          (m) => `<div class="msg">
  <div class="meta">${esc(fmtTime(m.createdAt))} · 收件人 ${esc(m.to)} · 主题：${esc(m.subject)}</div>
  <div>${m.html}</div>
</div>`
        )
        .join('')
    : '<p class="muted">收件箱为空。新浏览器登录时，确认邮件会出现在这里。</p>';
  const body = `
<div class="card">
  <h1>内置收件箱</h1>
  <p class="muted">本项目自带的模拟邮箱，无需外部邮件服务。</p>
  ${list}
</div>`;
  return layout('收件箱', body, { nav });
}

export function securityPage(devices, username, flash = '') {
  const rows = devices.length
    ? devices
        .map(
          (d) => `<tr>
  <td>${esc(d.name)}</td>
  <td>${esc(fmtTime(d.lastAt))}</td>
  <td><form class="inline" method="post" action="/devices/${esc(d.id)}/revoke">
    <button class="ghost" type="submit">取消信任</button>
  </form></td>
</tr>`
        )
        .join('')
    : '<tr><td colspan="3" class="muted">当前没有已记住的设备。</td></tr>';
  const body = `
<div class="card">
  <h1>安全设置 - 可信设备</h1>
  ${flash ? `<div class="ok">${esc(flash)}</div>` : ''}
  <p class="muted">账号：${esc(username)} · 取消信任后，该设备下次登录需重新确认；其他设备不受影响。</p>
  <table>
    <thead><tr><th>设备名称</th><th>最近活动时间</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="muted" style="margin-top:14px;">出于安全考虑，设备标识令牌不展示在页面上，这里只显示自定义名称与活动时间。</p>
</div>`;
  return layout('安全设置', body, { nav: authNav });
}
