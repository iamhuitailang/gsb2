export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function nav(auth) {
  if (auth.mode === 'session') {
    return `
      <nav class="topbar">
        <a href="/">值班后台</a>
        <span class="spacer"></span>
        <a href="/duty">值班表</a>
        <a href="/inbox">收件箱</a>
        <a href="/security">安全</a>
        <span class="who">${esc(auth.user.username)} · ${esc(auth.device.name)}</span>
        <form method="post" action="/logout" class="inline"><button class="link-btn">退出</button></form>
      </nav>`;
  }
  if (auth.mode === 'pending') {
    return `
      <nav class="topbar">
        <a href="/login/waiting">值班后台</a>
        <span class="spacer"></span>
        <a href="/inbox">收件箱</a>
        <form method="post" action="/logout" class="inline"><button class="link-btn">退出</button></form>
      </nav>`;
  }
  return `
    <nav class="topbar">
      <a href="/login">值班后台</a>
      <span class="spacer"></span>
      <a href="/inbox">收件箱（模拟邮箱）</a>
    </nav>`;
}

export function page(title, body, auth = { mode: 'anonymous' }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 值班后台</title>
<style>
  :root { --bg:#f5f6f8; --card:#fff; --line:#e3e6ea; --ink:#1f2329; --sub:#6b7280; --brand:#2563eb; --danger:#dc2626; --ok:#059669; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  .topbar { display:flex; align-items:center; gap:16px; background:var(--card); border-bottom:1px solid var(--line); padding:10px 24px; }
  .topbar a { color:var(--brand); text-decoration:none; font-weight:600; }
  .topbar .spacer { flex:1; }
  .topbar .who { color:var(--sub); font-size:13px; }
  .wrap { max-width: 860px; margin: 32px auto; padding: 0 20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:24px; margin-bottom:20px; }
  h1 { font-size:20px; margin:0 0 16px; }
  h2 { font-size:16px; margin:0 0 12px; }
  label { display:block; font-size:13px; color:var(--sub); margin:12px 0 4px; }
  input[type=text], input[type=password] { width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:7px; font-size:15px; }
  button, .btn { background:var(--brand); color:#fff; border:0; border-radius:7px; padding:9px 18px; font-size:15px; cursor:pointer; text-decoration:none; display:inline-block; }
  button.danger { background:var(--danger); }
  button.ghost, .btn.ghost { background:#fff; color:var(--ink); border:1px solid var(--line); }
  .link-btn { background:none; border:0; color:var(--brand); padding:0; font:inherit; cursor:pointer; }
  .inline { display:inline; margin:0; }
  .err { background:#fef2f2; color:var(--danger); border:1px solid #fecaca; border-radius:7px; padding:10px 12px; margin-bottom:14px; font-size:14px; }
  .ok-msg { background:#ecfdf5; color:var(--ok); border:1px solid #a7f3d0; border-radius:7px; padding:10px 12px; margin-bottom:14px; font-size:14px; }
  .hint { color:var(--sub); font-size:13px; margin-top:12px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); font-size:14px; }
  th { color:var(--sub); font-weight:500; font-size:13px; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; background:#eef2ff; color:var(--brand); }
  .badge.warn { background:#fffbeb; color:#b45309; }
  .mail { border:1px solid var(--line); border-radius:8px; padding:14px; margin-bottom:12px; }
  .mail.unread { border-left:4px solid var(--brand); }
  .mail .meta { color:var(--sub); font-size:12px; margin-bottom:6px; }
  .mail a { word-break:break-all; }
  .row { display:flex; align-items:center; gap:12px; }
  .row form { margin:0; }
  .muted { color:var(--sub); font-size:13px; }
  code { background:#f1f3f5; padding:1px 6px; border-radius:4px; }
</style>
</head>
<body>
${nav(auth)}
<div class="wrap">
${body}
</div>
</body>
</html>`;
}

export function loginView(error) {
  const body = `
  <div class="card" style="max-width:420px;margin:40px auto;">
    <h1>值班后台登录</h1>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <form method="post" action="/login">
      <label for="username">账号</label>
      <input id="username" name="username" type="text" autocomplete="username" required autofocus>
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <label for="deviceName">这台设备的名称（仅自己可见）</label>
      <input id="deviceName" name="deviceName" type="text" placeholder="例如：办公室 Chrome / 个人 MacBook" maxlength="40">
      <label style="display:flex;align-items:center;gap:8px;color:var(--ink);margin-top:14px;">
        <input type="checkbox" name="remember" value="1" style="width:auto;">
        记住这台设备，下次同一浏览器免确认
      </label>
      <button type="submit" style="width:100%;margin-top:18px;">登录</button>
    </form>
    <p class="hint">演示账号：<code>admin</code> / <code>duty123</code>。新设备或未记住的设备，密码正确后仍需到<a href="/inbox">收件箱</a>完成确认。</p>
  </div>`;
  return page('登录', body);
}

export function waitingView(auth, error) {
  const body = `
  <div class="card" style="max-width:520px;margin:30px auto;">
    <h1>等待设备确认</h1>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <p>账号 <b>${esc(auth.user.username)}</b> 已通过密码校验，但这台浏览器（<b>${esc(auth.device.name)}</b>）还没有被信任。</p>
    <p>请打开项目自带的 <a href="/inbox" target="_blank">收件箱</a>，点击最新一封“设备确认”邮件里的确认链接。链接仅对本次登录、本浏览器有效，10 分钟内有效。</p>
    <p class="muted" id="status">页面每 2 秒自动检查一次确认状态，确认通过后自动进入后台……</p>
    <p class="hint">在确认完成前，本浏览器访问任何值班数据接口都会被拒绝。</p>
  </div>
  <script>
    async function poll() {
      try {
        const r = await fetch('/api/login-status');
        const d = await r.json();
        if (d.mode === 'session') { location.href = '/'; return; }
        if (d.mode !== 'pending') { location.href = '/login'; return; }
      } catch {}
      setTimeout(poll, 2000);
    }
    setTimeout(poll, 2000);
  </script>`;
  return page('等待确认', body, auth);
}

export function confirmErrorView(auth, message) {
  const body = `
  <div class="card" style="max-width:520px;margin:30px auto;">
    <h1>确认链接无效</h1>
    <div class="err">${esc(message)}</div>
    <p>确认链接只能用于发起它的那次登录和那台浏览器，且使用一次后立即失效。</p>
    <p><a class="btn" href="/login">返回登录</a></p>
  </div>`;
  return page('确认失败', body, auth);
}

export function confirmPromptView(auth, token) {
  const body = `
  <div class="card" style="max-width:520px;margin:30px auto;">
    <h1>设备确认</h1>
    <p>确认允许浏览器 <b>${esc(auth.device.name)}</b> 登录账号 <b>${esc(auth.user.username)}</b> 吗？</p>
    <p class="muted">本次确认仅对当前等待中的登录（${new Date(auth.pending.createdAt).toLocaleString('zh-CN')} 发起）有效。${auth.pending.remember ? '勾选了“记住设备”，确认后本浏览器下次登录可直接进入。' : '未勾选记住设备，下次登录仍需重新确认。'}</p>
    <form method="post" action="/login/confirm?token=${esc(token)}">
      <button type="submit">确认登录</button>
      <a class="btn ghost" href="/login/waiting">返回等待页</a>
    </form>
  </div>`;
  return page('设备确认', body, auth);
}

export function inboxView(auth, messages) {
  const items = messages.length
    ? messages.map((m) => `
      <div class="mail ${m.read ? '' : 'unread'}">
        <div class="meta">${fmtTime(m.createdAt)} · ${m.read ? '已读' : '<b>未读</b>'}</div>
        <h2>${esc(m.subject)}</h2>
        <p>确认链接（仅对发起该登录的浏览器有效）：</p>
        <p><a href="${esc(m.link)}">${esc(m.link)}</a></p>
        <form method="post" action="/inbox/read">
          <input type="hidden" name="id" value="${esc(m.id)}">
          <button class="ghost" type="submit">标记为已读</button>
        </form>
      </div>`).join('')
    : '<p class="muted">收件箱为空。新设备登录触发确认邮件后会出现在这里。</p>';
  const body = `
  <div class="card">
    <h1>收件箱（模拟邮箱）</h1>
    ${items}
  </div>`;
  return page('收件箱', body, auth);
}

export function dashboardView(auth) {
  const body = `
  <div class="card">
    <h1>值班概览</h1>
    <p>欢迎，<b>${esc(auth.user.username)}</b>。当前浏览器：<b>${esc(auth.device.name)}</b>。</p>
    <p>今天是 2026-11-18（周三），白班：王磊，夜班：陈静。</p>
    <p><a class="btn" href="/duty">查看完整值班表</a> <a class="btn ghost" href="/security">管理已信任设备</a></p>
  </div>`;
  return page('首页', body, auth);
}

export function dutyView(auth, schedule) {
  const rows = schedule.rows
    .map((r) => `<tr><td>${esc(r.date)} ${esc(r.weekday)}</td><td>${esc(r.dayShift)}</td><td>${esc(r.nightShift)}</td><td>${esc(r.phone)}</td></tr>`)
    .join('');
  const body = `
  <div class="card">
    <h1>本周值班表</h1>
    <p class="muted">数据更新于 ${esc(schedule.updatedAt)}</p>
    <table>
      <thead><tr><th>日期</th><th>白班</th><th>夜班</th><th>联系电话</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
  return page('值班表', body, auth);
}

export function securityView(auth, devices, flash) {
  const rows = devices
    .map((d) => `
    <tr>
      <td>
        <form method="post" action="/security/rename" class="row">
          <input type="text" name="name" value="${esc(d.name)}" maxlength="40" required>
          <input type="hidden" name="deviceId" value="${esc(d.id)}">
          <button class="ghost" type="submit">改名</button>
        </form>
      </td>
      <td>${d.trusted ? '<span class="badge">已记住</span>' : '<span class="badge warn">未记住</span>'}</td>
      <td>${esc(fmtTime(d.lastActiveAt))}</td>
      <td>
        <form method="post" action="/security/revoke" class="inline"
              onsubmit="return confirm('取消信任后，该设备下次登录需要重新确认。确定？')">
          <input type="hidden" name="deviceId" value="${esc(d.id)}">
          <button class="danger" type="submit">取消信任</button>
        </form>
      </td>
    </tr>`)
    .join('');
  const body = `
  <div class="card">
    <h1>安全 · 设备管理</h1>
    ${flash ? `<div class="ok-msg">${esc(flash)}</div>` : ''}
    <p class="muted">设备记录只显示自定义名称与最近活动时间，不展示内部标识。取消某台设备的信任不影响其他已记住的浏览器。</p>
    <table>
      <thead><tr><th>设备名称</th><th>信任状态</th><th>最近活动</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
  return page('安全', body, auth);
}

export function errorView(auth, status, message) {
  const body = `
  <div class="card" style="max-width:520px;margin:40px auto;">
    <h1>${esc(status)}</h1>
    <p>${esc(message)}</p>
    <p><a class="btn" href="/login">去登录</a></p>
  </div>`;
  return page(String(status), body, auth);
}
