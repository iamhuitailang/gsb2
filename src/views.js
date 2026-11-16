export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
:root {
  --bg: #0f1216;
  --panel: #171c22;
  --panel-2: #1e252d;
  --line: #2a333d;
  --text: #e6edf3;
  --muted: #8b98a5;
  --accent: #4f8cff;
  --accent-2: #2f6fe4;
  --danger: #e5534b;
  --ok: #3fb950;
  --warn: #d29922;
  --radius: 10px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header.topbar {
  display: flex; align-items: center; gap: 20px;
  padding: 14px 28px; border-bottom: 1px solid var(--line);
  background: rgba(23,28,34,.9); position: sticky; top: 0; backdrop-filter: blur(8px);
}
.brand { font-weight: 700; letter-spacing: .3px; }
.brand span { color: var(--accent); }
.nav { display: flex; gap: 16px; margin-left: 8px; }
.nav a { color: var(--muted); font-size: 14px; padding: 4px 0; border-bottom: 2px solid transparent; }
.nav a.active, .nav a:hover { color: var(--text); border-bottom-color: var(--accent); text-decoration: none; }
.spacer { flex: 1; }
.who { color: var(--muted); font-size: 13px; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 24px 80px; }
h1 { font-size: 24px; margin: 0 0 6px; }
h2 { font-size: 17px; margin: 0 0 14px; }
p.lead { color: var(--muted); margin: 0 0 24px; }
.grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; }
.card + .card { margin-top: 20px; }
label { display: block; font-size: 13px; color: var(--muted); margin: 12px 0 5px; }
input, select, button, textarea { font: inherit; }
input, select {
  width: 100%; padding: 9px 11px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--panel-2); color: var(--text);
}
input:focus, select:focus { outline: 2px solid rgba(79,140,255,.35); border-color: var(--accent); }
button {
  cursor: pointer; border: 1px solid transparent; border-radius: 8px;
  padding: 9px 16px; background: var(--accent); color: #fff; font-weight: 600;
}
button:hover { background: var(--accent-2); }
button.secondary { background: transparent; border-color: var(--line); color: var(--text); }
button.secondary:hover { background: var(--panel-2); }
button.danger { background: transparent; border-color: transparent; color: var(--danger); padding: 6px 10px; }
button.danger:hover { background: rgba(229,83,75,.12); }
button:disabled { opacity: .45; cursor: not-allowed; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
tr:last-child td { border-bottom: none; }
.badge {
  display: inline-block; padding: 2px 9px; border-radius: 999px;
  font-size: 12px; border: 1px solid var(--line); color: var(--muted);
}
.badge.pending { color: var(--warn); border-color: rgba(210,153,34,.4); background: rgba(210,153,34,.1); }
.badge.accepted, .badge.editor { color: var(--ok); border-color: rgba(63,185,80,.4); background: rgba(63,185,80,.1); }
.badge.revoked, .badge.superseded { color: var(--muted); background: rgba(139,152,165,.08); }
.badge.viewer { color: var(--accent); border-color: rgba(79,140,255,.4); background: rgba(79,140,255,.1); }
.flash { padding: 11px 14px; border-radius: 8px; margin-bottom: 20px; font-size: 14px; border: 1px solid var(--line); }
.flash.success { border-color: rgba(63,185,80,.45); background: rgba(63,185,80,.1); color: #a7e3b1; }
.flash.error { border-color: rgba(229,83,75,.45); background: rgba(229,83,75,.1); color: #f0a8a3; }
.flash.info { border-color: rgba(79,140,255,.45); background: rgba(79,140,255,.1); color: #b9d0ff; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-all; }
.inline-form { display: inline-flex; gap: 8px; align-items: center; }
.inline-form select { width: auto; padding: 5px 8px; font-size: 13px; }
.inline-form button { padding: 5px 10px; font-size: 13px; }
.empty { color: var(--muted); padding: 18px 0; text-align: center; }
.invite-hero { text-align: center; padding: 40px 24px; }
.invite-hero .team { font-size: 26px; font-weight: 700; margin: 10px 0; }
.invite-hero .role { font-size: 15px; color: var(--muted); margin-bottom: 26px; }
.actions { display: flex; gap: 12px; justify-content: center; margin-top: 22px; }
a.button-link {
  display: inline-block; padding: 9px 16px; border-radius: 8px;
  background: var(--accent); color: #fff; font-weight: 600; text-decoration: none;
}
a.button-link:hover { background: var(--accent-2); text-decoration: none; }
a.button-link.secondary { background: transparent; border: 1px solid var(--line); color: var(--text); }
.notice { max-width: 560px; margin: 0 auto; }
.stack > * + * { margin-top: 12px; }
hr.sep { border: none; border-top: 1px solid var(--line); margin: 22px 0; }
.kv { display: flex; justify-content: space-between; gap: 16px; font-size: 14px; padding: 5px 0; }
.kv span:first-child { color: var(--muted); }
.message { border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; background: var(--panel); }
.message + .message { margin-top: 14px; }
.message h3 { margin: 0 0 4px; font-size: 15px; }
.message .meta { color: var(--muted); font-size: 12px; margin-bottom: 10px; }
.message .body { font-size: 14px; color: #ccd6e0; }
.login-wrap { max-width: 420px; margin: 8vh auto 0; }
.demo { margin-top: 18px; padding: 14px; border-radius: 8px; background: var(--panel-2); font-size: 13px; color: var(--muted); }
.demo code { color: var(--text); }
@media (max-width: 620px) { header.topbar { padding: 12px 16px; gap: 12px; flex-wrap: wrap; } main { padding: 22px 16px 60px; } }
`;

export function layout({ title, user, active = '', unread = 0, flash = null, body }) {
  const nav = user
    ? `
      <nav class="nav">
        ${user.role === 'admin' ? `<a href="/admin" class="${active === 'admin' ? 'active' : ''}">管理控制台</a>` : ''}
        <a href="/inbox" class="${active === 'inbox' ? 'active' : ''}">本地收件箱${unread ? ` <span class="badge pending">${unread}</span>` : ''}</a>
      </nav>`
    : '';
  const who = user
    ? `<span class="who">${escapeHtml(user.name)} · ${escapeHtml(user.email)}</span>
       <form method="post" action="/logout" style="margin:0">
         <input type="hidden" name="csrf" value="${escapeHtml(user.csrf)}">
         <button class="secondary" type="submit">退出</button>
       </form>`
    : '';
  const flashHtml = flash
    ? `<div class="flash ${escapeHtml(flash.type)}">${escapeHtml(flash.text)}</div>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · GSB2 项目组</title>
<style>${STYLE}</style>
</head>
<body>
<header class="topbar">
  <div class="brand">GSB2<span>·</span>项目组</div>
  ${nav}
  <div class="spacer"></div>
  ${who}
</header>
<main>
${flashHtml}
${body}
</main>
</body>
</html>`;
}

export function loginPage({ csrf, error = null, next = '', currentUser = null }) {
  return layout({
    title: '登录',
    user: null,
    flash: error ? { type: 'error', text: error } : null,
    body: `
<div class="login-wrap">
  <div class="card">
    <h1>登录</h1>
    ${
      currentUser
        ? `<p class="lead">当前已登录 <strong>${escapeHtml(currentUser.email)}</strong>。在下面登录其他账号会切换身份。</p>`
        : '<p class="lead">使用已完成邮箱验证的账号登录，才能接受发给该邮箱的邀请。</p>'
    }
    <form method="post" action="/login">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <label for="email">邮箱</label>
      <input id="email" name="email" type="email" autocomplete="username" required autofocus>
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <div class="actions" style="justify-content:flex-start">
        <button type="submit">登录</button>
      </div>
    </form>
    <div class="demo">
      演示账号：<br>
      管理员 <code>admin@gsb2.local</code> / <code>admin123</code><br>
      李小雨 <code>alice@example.com</code> / <code>alice123</code><br>
      王大明 <code>bob@example.com</code> / <code>bob123</code><br>
      未验证邮箱 <code>unverified@example.com</code> / <code>unverified123</code>
    </div>
  </div>
</div>`,
  });
}

function roleBadge(role) {
  return `<span class="badge ${escapeHtml(role)}">${escapeHtml(role === 'editor' ? '编辑' : '只读')}</span>`;
}

function statusBadge(status, labels) {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(labels[status] ?? status)}</span>`;
}

export function adminPage({ user, csrf, teams, invites, membersByTeam, knownEmails = [], statusLabels, unread = 0, flash }) {
  const teamOptions = teams
    .map((team) => `<option value="${escapeHtml(team.id)}">${escapeHtml(team.name)}</option>`)
    .join('');

  const inviteRows = invites.length
    ? invites
        .map(
          (invite) => `
      <tr>
        <td>${escapeHtml(invite.email)}</td>
        <td>${escapeHtml(invite.teamName)}</td>
        <td>${roleBadge(invite.role)}</td>
        <td>${statusBadge(invite.status, statusLabels)}</td>
        <td class="small muted">${escapeHtml(formatTime(invite.createdAt))}</td>
        <td>
          ${
            invite.status === 'pending'
              ? `<form method="post" action="/admin/invites/${escapeHtml(invite.id)}/revoke" style="margin:0">
                   <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
                   <button class="danger" type="submit">撤销</button>
                 </form>`
              : '<span class="muted small">—</span>'
          }
        </td>
      </tr>`,
        )
        .join('')
    : '';

  const memberSections = teams
    .map((team) => {
      const members = membersByTeam[team.id] ?? [];
      const rows = members.length
        ? members
            .map(
              (member) => `
        <tr>
          <td>${escapeHtml(member.name)}<div class="small muted">${escapeHtml(member.email)}</div></td>
          <td>${roleBadge(member.role)}</td>
          <td>
            <form class="inline-form" method="post" action="/admin/members/role">
              <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
              <input type="hidden" name="teamId" value="${escapeHtml(team.id)}">
              <input type="hidden" name="userId" value="${escapeHtml(member.userId)}">
              <select name="role" aria-label="调整角色">
                <option value="editor" ${member.role === 'editor' ? 'selected' : ''}>编辑</option>
                <option value="viewer" ${member.role === 'viewer' ? 'selected' : ''}>只读</option>
              </select>
              <button class="secondary" type="submit">调整</button>
            </form>
          </td>
        </tr>`,
            )
            .join('')
        : '';
      return `
    <div class="card">
      <h2>${escapeHtml(team.name)} · 成员</h2>
      ${
        members.length
          ? `<table><thead><tr><th>成员</th><th>角色</th><th>调整</th></tr></thead><tbody>${rows}</tbody></table>`
          : '<div class="empty">暂无成员</div>'
      }
    </div>`;
    })
    .join('');

  return layout({
    title: '管理控制台',
    user: { ...user, csrf },
    active: 'admin',
    unread,
    flash,
    body: `
<h1>管理控制台</h1>
<p class="lead">按邮箱、团队和角色发送邀请。同一团队同一邮箱只保留最新一封有效邀请。</p>

<div class="card">
  <h2>发送邀请</h2>
  <form method="post" action="/admin/invites">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <div class="grid">
      <div>
        <label for="invite-email">受邀人邮箱</label>
        <input id="invite-email" name="email" type="email" list="known-emails" placeholder="name@example.com" required>
        <datalist id="known-emails">
          ${knownEmails.map((email) => `<option value="${escapeHtml(email)}">`).join('')}
        </datalist>
      </div>
      <div>
        <label for="invite-team">团队</label>
        <select id="invite-team" name="teamId" required>${teamOptions}</select>
      </div>
      <div>
        <label for="invite-role">角色</label>
        <select id="invite-role" name="role" required>
          <option value="editor">编辑</option>
          <option value="viewer">只读</option>
        </select>
      </div>
    </div>
    <div class="actions" style="justify-content:flex-start">
      <button type="submit">发送邀请</button>
    </div>
  </form>
  <p class="small muted" style="margin-bottom:0">邀请会直接投递到该邮箱对应的本地收件箱。</p>
</div>

<div class="card">
  <h2>邀请记录</h2>
  ${
    invites.length
      ? `<table>
           <thead><tr><th>邮箱</th><th>团队</th><th>角色</th><th>状态</th><th>发送时间</th><th></th></tr></thead>
           <tbody>${inviteRows}</tbody>
         </table>`
      : '<div class="empty">还没有发送过邀请</div>'
  }
</div>

${memberSections}`,
  });
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function inboxHint(invite) {
  if (!invite) return '邀请链接不可用';
  switch (invite.status) {
    case 'accepted':
      return '已接受，无需重复操作';
    case 'superseded':
      return '此邀请已被同团队的新邀请替代，请以最新一封为准';
    case 'revoked':
      return '此邀请已被撤销';
    default:
      return '邀请链接不可用';
  }
}

export function inboxPage({ user, csrf, messages, teamsById, statusLabels, unread = 0, flash }) {
  const cards = messages.length
    ? messages
        .map((message) => {
          const invite = message.invite;
          const teamName = invite ? (teamsById[invite.teamId] ?? '未知团队') : '';
          const link =
            invite && message.token && invite.status === 'pending'
              ? `<a class="button-link" href="/invite/${escapeHtml(message.token)}">打开邀请</a>`
              : `<span class="muted small">${inboxHint(invite)}</span>`;
          return `
      <div class="message">
        <h3>${escapeHtml(message.subject)}</h3>
        <div class="meta">发给 ${escapeHtml(message.email)} · ${escapeHtml(formatTime(message.createdAt))}</div>
        <div class="body">${escapeHtml(message.body)}</div>
        <div class="kv" style="margin-top:10px">
          <span>状态</span>
          <span>${invite ? statusBadge(invite.status, statusLabels) : '—'}</span>
        </div>
        <div class="kv"><span>团队</span><span>${escapeHtml(teamName)}</span></div>
        <div class="actions" style="justify-content:flex-start;margin-top:14px">${link}</div>
      </div>`;
        })
        .join('')
    : '<div class="card"><div class="empty">收件箱是空的。管理员发送邀请后会出现在这里。</div></div>';

  return layout({
    title: '本地收件箱',
    user: { ...user, csrf },
    active: 'inbox',
    unread,
    flash,
    body: `
<h1>本地收件箱</h1>
<p class="lead">发给 <strong>${escapeHtml(user.email)}</strong> 的全部邀请。每个团队独立处理。</p>
${cards}`,
  });
}

export function invitePage({ user, csrf, invite, token, teamName, statusLabels, toLogin, notice, canAccept, alreadyMember, blockReason = null, unread = 0, flash }) {
  const statusLine = statusBadge(invite.status, statusLabels);

  let actionArea = '';
  if (invite.status === 'pending') {
    if (!user) {
      actionArea = `
        <p class="muted">请先用 <strong>${escapeHtml(invite.email)}</strong> 登录，再接受邀请。</p>
        <div class="actions"><a class="button-link" href="${escapeHtml(toLogin)}">去登录</a></div>`;
    } else if (canAccept) {
      actionArea = `
        ${alreadyMember ? `<p class="muted small">你已是「${escapeHtml(teamName)}」成员，接受后不会重复生成成员关系。</p>` : ''}
        <form method="post" action="/invite/${escapeHtml(token)}/accept" style="margin:0">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <div class="actions"><button type="submit">接受邀请</button></div>
        </form>`;
    } else {
      const message =
        blockReason === 'email_unverified'
          ? `当前账号 ${user.email} 的邮箱尚未验证，无法接受邀请。`
          : `当前登录账号 ${user.email} 与受邀邮箱 ${invite.email} 不一致，无法接受。`;
      actionArea = `
        <p class="muted">${escapeHtml(message)}</p>
        <div class="actions"><a class="button-link secondary" href="${escapeHtml(toLogin)}">切换账号</a></div>`;
    }
  } else {
    actionArea = notice ? `<p class="muted">${escapeHtml(notice)}</p>` : '';
  }

  return layout({
    title: '团队邀请',
    user: user ? { ...user, csrf } : null,
    active: 'inbox',
    unread,
    flash,
    body: `
<div class="notice card invite-hero">
  <div class="small muted">团队邀请</div>
  <div class="team">${escapeHtml(teamName)}</div>
  <div class="role">角色：${invite.role === 'editor' ? '编辑' : '只读'} · ${statusLine}</div>
  <div class="kv" style="justify-content:center"><span>受邀邮箱</span><span>${escapeHtml(invite.email)}</span></div>
  ${actionArea}
</div>`,
  });
}

export function errorPage({ user, csrf, status = 404, title, message, unread = 0, flash = null }) {
  return layout({
    title,
    user: user ? { ...user, csrf } : null,
    unread,
    flash,
    body: `<div class="card notice" style="text-align:center">
      <h1>${escapeHtml(title)}</h1>
      <p class="muted">${escapeHtml(message)}</p>
      <div class="actions"><a class="button-link secondary" href="/">返回首页</a></div>
    </div>`,
  });
}
