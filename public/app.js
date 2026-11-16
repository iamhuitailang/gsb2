// 前端只负责展示。机构、角色、可见工单、附件与导出权限全部由服务端判定；
// 任何 403 都在界面上如实显示，不做“假装还能操作”的前端兜底。

const app = document.getElementById('app');

const state = {
  user: null,
  memberships: [],
  orgId: null,
  view: 'tickets',
  tickets: [],
  ticketsLoading: false,
  loadError: null,
  ticketModal: null,
  exportJob: null,
  notice: null,
};

class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  const type = res.headers.get('content-type') ?? '';
  const payload = type.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    const e = payload?.error ?? {};
    // 会话过期与“登录失败”要区分：只有非登录接口的 401 才踢回登录页。
    if (res.status === 401 && path !== '/api/login' && state.user) {
      state.user = null;
      state.memberships = [];
      state.orgId = null;
      history.replaceState(null, '', location.pathname);
      renderLogin();
    }
    throw new ApiError(res.status, e.code ?? 'HTTP_ERROR', e.message ?? `请求失败（HTTP ${res.status}）`, e.detail);
  }
  return payload;
}

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtTime = (ts) =>
  ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

const fmtSize = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

function setNotice(kind, title, err, code = null) {
  state.notice = {
    kind,
    title,
    message: typeof err === 'string' ? err : err?.message ?? '',
    code: code ?? (typeof err === 'string' ? null : err?.code ?? null),
  };
}

async function refreshMe() {
  const me = await api('/api/me');
  state.user = me.user;
  state.memberships = me.memberships;
  return me;
}

function activeMembership(orgId = state.orgId) {
  return state.memberships.find((m) => m.orgId === orgId) ?? null;
}

/* ------------------------------- 路由 ------------------------------- */

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function parseRoute() {
  const hash = location.hash.replace(/^#/, '');
  let m = /^\/org\/([^/]+)\/tickets$/.exec(hash);
  if (m) return { orgId: decode(m[1]), view: 'tickets' };
  m = /^\/org\/([^/]+)\/ticket\/([^/]+)$/.exec(hash);
  if (m) return { orgId: decode(m[1]), view: 'tickets', ticketId: decode(m[2]) };
  m = /^\/org\/([^/]+)\/members$/.exec(hash);
  if (m) return { orgId: decode(m[1]), view: 'members' };
  return { route: 'home' };
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  if (!state.user) return renderLogin();
  const r = parseRoute();
  if (r.route === 'home') {
    const first = state.memberships[0];
    if (!first) {
      state.orgId = null;
      state.view = 'tickets';
      state.tickets = [];
      renderShell();
      return;
    }
    const target = `#/org/${encodeURIComponent(first.orgId)}/tickets`;
    // 地址栏已是目标 hash 时 hashchange 不会触发，直接进入路由。
    if (location.hash === target) await route();
    else location.replace(target);
    return;
  }

  state.orgId = r.orgId;
  state.loadError = null;
  // 本地权限快照可能已经过期（比如刚被撤权），先跟服务端对齐一次。
  if (!activeMembership(r.orgId)) {
    try {
      await refreshMe();
    } catch {
      /* 未登录会在下面渲染登录页 */
    }
  }

  state.tickets = [];
  state.ticketModal = null;
  state.view = r.view === 'members' ? 'members' : 'tickets';
  // 进入工单视图时先标记为加载中，避免闪一下“没有工单”再变成列表。
  state.ticketsLoading = state.view === 'tickets';
  renderShell();

  // 无论本地快照如何，都发真实请求让服务端裁决：同意则渲染，拒绝则如实显示。
  if (state.view === 'members') {
    await loadMembers();
    return;
  }
  await loadTickets();
  if (r.ticketId) await openTicket(r.ticketId, { fromRoute: true });
}

/* ------------------------------- 渲染 ------------------------------- */

function renderLogin() {
  app.innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="login-form">
        <h1>本地工单后台</h1>
        <p class="sub">登录后选择要进入的机构。每个人可属于多个机构，但一次只在一个机构里操作。</p>
        <div class="field">
          <label for="username">用户名</label>
          <input id="username" name="username" autocomplete="username" required />
        </div>
        <div class="field">
          <label for="password">密码</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
        </div>
        <button class="primary" type="submit" style="width:100%">登录</button>
        <div class="demo-accounts">
          演示账号（密码均为 <code>demo1234</code>）：<br />
          <code>li</code> 李强 — 甲乙两机构主管<br />
          <code>wang</code> 王敏 — 甲乙两机构员工<br />
          <code>zhao</code> 赵磊 — 甲机构员工
        </div>
        <div id="login-error"></div>
      </form>
    </div>`;

  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    document.getElementById('login-error').innerHTML = '';
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          username: form.username.value,
          password: form.password.value,
        }),
      });
      state.user = data.user;
      state.memberships = data.memberships;
      state.notice = null;
      const first = state.memberships[0];
      if (!first) {
        renderShell();
        return;
      }
      const target = `#/org/${encodeURIComponent(first.orgId)}/tickets`;
      // 地址栏恰好已是目标 hash 时不会触发 hashchange，需要手动进入。
      if (location.hash === target) await route();
      else location.hash = target;
    } catch (err) {
      document.getElementById('login-error').innerHTML = noticeHtml(
        { kind: 'error', title: '登录失败', message: err.message, code: err.code },
        true,
      );
      btn.disabled = false;
    }
  });
}

function noticeHtml(n, inline = false) {
  if (!n) return '';
  return `
    <div class="notice ${esc(n.kind)}" ${inline ? '' : 'style="margin-bottom:16px"'}>
      <span class="title">${esc(n.title)}</span>
      ${esc(n.message)}
      ${n.code ? `<div class="code">${esc(n.code)}</div>` : ''}
    </div>`;
}

function roleLabel(role) {
  return role === 'supervisor' ? '主管' : '员工';
}

function renderShell() {
  const org = activeMembership();
  const orgs = state.memberships;

  app.innerHTML = `
    <div class="topbar">
      <span class="brand">本地工单后台</span>
      <span class="who">${esc(state.user?.name ?? '')} · ${esc(state.user?.username ?? '')}</span>
      <span class="spacer"></span>
      <button id="logout">退出登录</button>
    </div>
    <div class="shell">
      <aside class="sidebar">
        <h2>我的机构</h2>
        ${
          orgs.length
            ? orgs
                .map(
                  (m) => `
              <button class="org-btn ${m.orgId === state.orgId ? 'active' : ''}" data-org="${esc(m.orgId)}">
                <span class="name">${esc(m.orgName)}</span>
                <span class="role">${roleLabel(m.role)}</span>
              </button>`,
                )
                .join('')
            : '<p class="muted" style="font-size:13px;padding:0 10px">当前没有任何机构的权限。</p>'
        }
      </aside>
      <main class="main" id="main"></main>
    </div>`;

  document.getElementById('logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    state.memberships = [];
    state.orgId = null;
    state.notice = null;
    history.replaceState(null, '', location.pathname);
    renderLogin();
  });

  for (const btn of document.querySelectorAll('.org-btn')) {
    btn.addEventListener('click', () => {
      state.notice = null;
      state.exportJob = null;
      navigate(`#/org/${encodeURIComponent(btn.dataset.org)}/tickets`);
    });
  }

  renderMain(org);
}

function renderMain(membership) {
  const main = document.getElementById('main');
  // 会话失效时页面可能已经切回登录页，此时没有 #main，直接返回。
  if (!main) return;
  if (state.loadError) {
    main.innerHTML = `
      <h1>无法进入该机构</h1>
      <p class="lead">机构与角色由服务端判定，本页面不会绕过权限检查。</p>
      ${noticeHtml({ kind: 'error', title: '访问被拒绝', message: state.loadError.message, code: state.loadError.code })}
      ${noticeHtml(state.notice)}
      <p class="muted">你仍然可以切换到其他仍有权限的机构。</p>`;
    return;
  }
  if (!membership && !state.orgId) {
    main.innerHTML = `<h1>请选择机构</h1><p class="lead">左侧选择要进入的机构。</p>`;
    return;
  }

  const orgLabel = membership?.orgName ?? state.orgId ?? '';
  const header = `
    <h1>${esc(orgLabel)} · 工单</h1>
    <p class="lead">
      ${
        membership
          ? `当前角色 <span class="chip ${membership.role}">${roleLabel(membership.role)}</span>
             ${membership.role === 'supervisor' ? '可以查看本机构全部工单并管理成员权限' : '只能查看分配给自己的工单'}`
          : '<span class="muted">正在向服务端确认你在该机构的权限…</span>'
      }
    </p>
    <div class="tabs">
      <button class="tab ${state.view === 'tickets' ? 'active' : ''}" data-view="tickets">工单列表</button>
      ${
        membership?.role === 'supervisor'
          ? `<button class="tab ${state.view === 'members' ? 'active' : ''}" data-view="members">成员权限</button>`
          : ''
      }
    </div>`;

  if (state.view === 'members') {
    main.innerHTML = `${header}
      ${noticeHtml(state.notice)}
      <div id="members-area"><div class="empty">加载中…</div></div>`;
  } else {
    main.innerHTML = `${header}
      ${noticeHtml(state.notice)}
      <div class="toolbar">
        <button class="primary" id="export-btn" ${!membership || (state.exportJob && state.exportJob.status === 'queued') ? 'disabled' : ''}>
          批量导出 CSV
        </button>
        <span class="muted" style="font-size:13px" id="export-status"></span>
      </div>
      <div class="table-card" id="tickets-area">
        <div class="empty">加载中…</div>
      </div>`;
    document.getElementById('export-btn').addEventListener('click', startExport);
    renderExportStatus();
    renderTicketTable();
  }

  for (const tab of main.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view;
      state.notice = null;
      navigate(`#/org/${encodeURIComponent(state.orgId)}/${view === 'members' ? 'members' : 'tickets'}`);
    });
  }
}

function renderTicketTable() {
  const area = document.getElementById('tickets-area');
  if (!area) return;
  if (state.ticketsLoading) {
    area.innerHTML = '<div class="empty">加载中…</div>';
    return;
  }
  if (!state.tickets.length) {
    const membership = activeMembership();
    area.innerHTML = `<div class="empty">${
      membership?.role === 'supervisor' ? '这个机构里暂时没有工单。' : '这个机构里暂时没有分配给你的工单。'
    }</div>`;
    return;
  }
  area.innerHTML = `
    <table>
      <thead>
        <tr><th>工单号</th><th>标题</th><th>状态</th><th>负责人</th><th>更新时间</th><th></th></tr>
      </thead>
      <tbody>
        ${state.tickets
          .map(
            (t) => `
          <tr>
            <td class="mono">${esc(t.id)}</td>
            <td class="ticket-title">${esc(t.title)}</td>
            <td>${esc(t.status)}</td>
            <td>${esc(t.assigneeName)}</td>
            <td class="muted">${fmtTime(t.updatedAt)}</td>
            <td><div class="actions"><button data-ticket="${esc(t.id)}">查看详情</button></div></td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
  for (const btn of area.querySelectorAll('[data-ticket]')) {
    btn.addEventListener('click', () => navigate(`#/org/${encodeURIComponent(state.orgId)}/ticket/${encodeURIComponent(btn.dataset.ticket)}`));
  }
}

async function loadTickets() {
  const orgId = state.orgId;
  state.ticketsLoading = true;
  state.tickets = [];
  state.loadError = null;
  renderMain(activeMembership());
  try {
    const data = await api(`/api/orgs/${encodeURIComponent(orgId)}`);
    if (state.orgId !== orgId) return; // 期间切换了机构
    state.tickets = data.tickets;
    state.ticketsLoading = false;
  } catch (err) {
    if (state.orgId !== orgId) return;
    state.tickets = [];
    state.ticketsLoading = false;
    state.loadError = { code: err.code, message: err.message };
    if (err.code === 'NO_ORG_ACCESS') {
      // 权限已被撤销：刷新机构列表，让侧边栏也跟服务端一致。
      await refreshMe().catch(() => {});
      renderShell();
      return;
    }
  }
  renderMain(activeMembership());
}

/* ------------------------------ 工单详情 ------------------------------ */

async function openTicket(ticketId, { fromRoute = false } = {}) {
  const orgId = state.orgId;
  try {
    const data = await api(`/api/orgs/${encodeURIComponent(orgId)}/tickets/${encodeURIComponent(ticketId)}`);
    if (state.orgId !== orgId) return;
    state.ticketModal = { ticket: data.ticket, role: data.role };
    renderTicketModal();
  } catch (err) {
    state.ticketModal = null;
    closeTicketModalDom();
    const denied = err.code === 'TICKET_FORBIDDEN' || err.code === 'NO_ORG_ACCESS';
    const suffix = fromRoute ? `（地址：${location.hash.slice(1)}）` : '';
    setNotice(
      'error',
      denied ? '无法打开这个工单' : '工单加载失败',
      `${err.message}${suffix}`,
      err.code,
    );
    if (denied) {
      // 旧地址可能来自撤权前的页面：重新拉取权限，让界面与服务端一致。
      await refreshMe().catch(() => {});
      if (err.code === 'NO_ORG_ACCESS') state.loadError = { code: err.code, message: err.message };
    }
    renderMain(activeMembership());
  }
}

function closeTicketModal() {
  state.ticketModal = null;
  closeTicketModalDom();
  const r = parseRoute();
  if (r.ticketId) navigate(`#/org/${encodeURIComponent(state.orgId)}/tickets`);
}

function closeTicketModalDom() {
  document.querySelector('.modal-backdrop')?.remove();
  document.removeEventListener('keydown', onModalKey);
  document.body.style.overflow = '';
}

function renderTicketModal() {
  closeTicketModalDom();
  const { ticket, role } = state.ticketModal;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="ticket-title">
      <header>
        <div>
          <h3 id="ticket-title">${esc(ticket.title)}</h3>
          <div class="id">${esc(ticket.id)} · ${esc(ticket.orgId)}</div>
        </div>
        <button class="close" aria-label="关闭">×</button>
      </header>
      <div class="body">
        <dl class="kv">
          <dt>状态</dt><dd>${esc(ticket.status)}</dd>
          <dt>负责人</dt><dd>${esc(ticket.assigneeName)}</dd>
          <dt>创建时间</dt><dd>${fmtTime(ticket.createdAt)}</dd>
          <dt>更新时间</dt><dd>${fmtTime(ticket.updatedAt)}</dd>
          <dt>当前角色</dt><dd><span class="chip ${role}">${roleLabel(role)}</span></dd>
          <dt>详情地址</dt><dd class="mono muted">${esc(location.hash || '#')}</dd>
        </dl>
        <p style="margin:0 0 6px">${esc(ticket.description)}</p>
        <div class="section-title">附件（${ticket.attachments.length}）</div>
        ${
          ticket.attachments.length
            ? `<ul class="attachments">${ticket.attachments
                .map(
                  (a) => `
              <li>
                <span>${esc(a.filename)}</span>
                <span class="size">${fmtSize(a.size)}</span>
                <button data-attachment="${esc(a.id)}">下载</button>
              </li>`,
                )
                .join('')}</ul>
              <p class="muted" style="font-size:12.5px;margin:10px 0 0">
                下载由服务端重新校验机构与角色：权限被撤销后，即使这个详情页还开着也会被拒绝。
              </p>`
            : '<p class="muted">没有附件。</p>'
        }
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  document.body.style.overflow = 'hidden';

  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) closeTicketModal();
  });
  backdrop.querySelector('.close').addEventListener('click', closeTicketModal);
  for (const btn of backdrop.querySelectorAll('[data-attachment]')) {
    btn.addEventListener('click', () => downloadAttachment(ticket.id, btn.dataset.attachment, btn));
  }
  document.addEventListener('keydown', onModalKey);
}

function onModalKey(ev) {
  if (ev.key === 'Escape') closeTicketModal();
}

async function downloadAttachment(ticketId, attachmentId, btn) {
  const orgId = state.orgId;
  const url = `/api/orgs/${encodeURIComponent(orgId)}/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}`;
  btn.disabled = true;
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      const e = payload?.error ?? {};
      throw new ApiError(res.status, e.code ?? 'DOWNLOAD_FAILED', e.message ?? `下载失败（HTTP ${res.status}）`);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') ?? '';
    const m = /filename\*=UTF-8''([^;]+)/.exec(disposition);
    const filename = m ? decodeURIComponent(m[1]) : `${attachmentId}.txt`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  } catch (err) {
    if (err.code === 'NO_ORG_ACCESS' || err.code === 'TICKET_FORBIDDEN') {
      // 撤权后点击旧详情页里的下载：如实提示，并关掉已失效的详情。
      state.ticketModal = null;
      closeTicketModalDom();
      await refreshMe().catch(() => {});
      if (err.code === 'NO_ORG_ACCESS') state.loadError = { code: err.code, message: err.message };
      setNotice('error', '附件下载被拒绝', err.message, err.code);
      renderMain(activeMembership());
    } else {
      setNotice('error', '附件下载失败', err);
      renderTicketModal();
    }
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------- 导出 ------------------------------- */

async function startExport() {
  const orgId = state.orgId;
  state.notice = null;
  try {
    const data = await api(`/api/orgs/${encodeURIComponent(orgId)}/exports`, { method: 'POST' });
    state.exportJob = data.export;
    renderMain(activeMembership());
    pollExport();
  } catch (err) {
    setNotice('error', '导出排队失败', err);
    renderMain(activeMembership());
  }
}

function pollExport() {
  const job = state.exportJob;
  if (!job) return;
  setTimeout(async () => {
    if (!state.exportJob || state.exportJob.id !== job.id || state.orgId !== job.orgId) return;
    try {
      const data = await api(
        `/api/orgs/${encodeURIComponent(job.orgId)}/exports/${encodeURIComponent(job.id)}`,
      );
      state.exportJob = data.export;
      renderExportStatus();
      if (data.export.status === 'queued') {
        pollExport();
      } else if (data.export.status === 'denied') {
        setNotice('error', '导出被拒绝', `${data.export.error}（排队期间权限已变化）`);
        renderMain(activeMembership());
      }
    } catch (err) {
      if (err.code === 'NO_ORG_ACCESS') {
        state.exportJob = null;
        await refreshMe().catch(() => {});
        setNotice('error', '导出状态查询被拒绝', err.message, err.code);
        state.loadError = { code: err.code, message: err.message };
        renderMain(activeMembership());
      } else {
        state.exportJob = null;
        renderExportStatus();
      }
    }
  }, 500);
}

function renderExportStatus() {
  const el = document.getElementById('export-status');
  const job = state.exportJob;
  if (!el || !job || job.orgId !== state.orgId) return;
  if (job.status === 'queued') {
    el.textContent = '导出任务已排队，正在生成…';
  } else if (job.status === 'ready') {
    el.innerHTML = `导出已生成（${job.rows} 行）。<button id="export-download">下载文件</button>`;
    document.getElementById('export-download').addEventListener('click', (ev) => downloadExport(job.id, ev.target));
  } else if (job.status === 'denied') {
    el.textContent = `导出被拒绝：${job.error}`;
  }
}

async function downloadExport(exportId, btn) {
  const orgId = state.orgId;
  btn.disabled = true;
  try {
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/exports/${encodeURIComponent(exportId)}/file`,
      { credentials: 'same-origin' },
    );
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      const e = payload?.error ?? {};
      throw new ApiError(res.status, e.code ?? 'DOWNLOAD_FAILED', e.message ?? `下载失败（HTTP ${res.status}）`);
    }
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${orgId}-tickets-${exportId}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  } catch (err) {
    setNotice('error', '导出下载被拒绝', err);
    if (err.code === 'NO_ORG_ACCESS') {
      state.exportJob = null;
      state.loadError = { code: err.code, message: err.message };
      await refreshMe().catch(() => {});
    }
    renderMain(activeMembership());
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------- 成员权限 ------------------------------- */

async function loadMembers() {
  const area = document.getElementById('members-area');
  if (!area) return;
  try {
    const data = await api(`/api/orgs/${encodeURIComponent(state.orgId)}/members`);
    area.innerHTML = renderMembersTable(data.members);
    bindMemberActions();
  } catch (err) {
    if (err.code === 'NO_ORG_ACCESS') {
      // 权限可能在页面打开期间被撤销：以服务端为准刷新。
      await refreshMe().catch(() => {});
      state.loadError = { code: err.code, message: err.message };
      renderMain(null);
      return;
    }
    if (err.code === 'NOT_SUPERVISOR') {
      area.innerHTML = noticeHtml({
        kind: 'warn',
        title: '只有主管可以管理成员权限',
        message: '你在本机构的角色是员工，看不到成员权限列表。',
        code: err.code,
      });
      return;
    }
    area.innerHTML = noticeHtml({
      kind: 'error',
      title: '成员权限加载失败',
      message: err.message,
      code: err.code,
    });
  }
}

function renderMembersTable(members) {
  return `
    <div class="table-card">
      <table class="members-table">
        <thead><tr><th>姓名</th><th>用户名</th><th>角色</th><th>状态</th><th></th></tr></thead>
        <tbody>
          ${members
            .map(
              (m) => `
            <tr>
              <td>${esc(m.name)}</td>
              <td class="mono">${esc(m.username)}</td>
              <td class="role-cell">${roleLabel(m.role)}</td>
              <td><span class="status-dot ${m.active ? '' : 'off'}"></span>${m.active ? '有效' : `已撤销 ${fmtTime(m.revokedAt)}`}</td>
              <td><div class="actions">
                ${
                  m.userId === state.user?.id
                    ? '<span class="muted" style="font-size:12.5px">当前账号</span>'
                    : m.active
                      ? `<button class="danger" data-revoke="${esc(m.membershipId)}" data-name="${esc(m.name)}">撤销本机构权限</button>`
                      : `<button data-restore="${esc(m.membershipId)}">恢复权限</button>`
                }
              </div></td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <p class="muted" style="font-size:12.5px;margin-top:10px">
      撤销只作用于当前机构。同一个账号在其他机构的角色不受影响。撤销后，该成员的详情页、附件下载与已排队的导出都会在服务端被重新拒绝。
    </p>`;
}

function bindMemberActions() {
  for (const btn of document.querySelectorAll('[data-revoke]')) {
    btn.addEventListener('click', async () => {
      if (!confirm(`确定撤销 ${btn.dataset.name} 在本机构的权限吗？`)) return;
      btn.disabled = true;
      try {
        await api(
          `/api/orgs/${encodeURIComponent(state.orgId)}/members/${encodeURIComponent(btn.dataset.revoke)}/revoke`,
          { method: 'POST' },
        );
        setNotice('ok', '权限已撤销', `${btn.dataset.name} 已不能在本机构查看工单、下载附件或导出。`);
      } catch (err) {
        setNotice('error', '撤销失败', err);
      }
      renderMain(activeMembership());
      await loadMembers();
    });
  }
  for (const btn of document.querySelectorAll('[data-restore]')) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api(
          `/api/orgs/${encodeURIComponent(state.orgId)}/members/${encodeURIComponent(btn.dataset.restore)}/restore`,
          { method: 'POST' },
        );
        setNotice('ok', '权限已恢复', '该成员重新获得了本机构的操作权限。');
      } catch (err) {
        setNotice('error', '恢复失败', err);
      }
      renderMain(activeMembership());
      await loadMembers();
    });
  }
}

/* ------------------------------- 启动 ------------------------------- */

window.addEventListener('hashchange', route);

(async function boot() {
  try {
    await refreshMe();
    await route();
  } catch (err) {
    if (err.status === 401) {
      state.user = null;
      renderLogin();
    } else {
      app.innerHTML = noticeHtml({ kind: 'error', title: '服务不可用', message: err.message, code: err.code });
    }
  }
})();
