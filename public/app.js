// 单页前端。注意：前端不做任何脱敏决策，所有字段值与 _permissions 均来自后端；
// 前端只负责按后端返回结果渲染。刷新 = 重新请求后端，撤销后自然恢复脱敏。

const state = {
  user: null,
  ttlSeconds: 600,
  timer: null,
};

const $ = (sel) => document.querySelector(sel);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function toast(message, type = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function statusTag(status) {
  const map = {
    pending: ['待审批', 'tag-amber'],
    approved: ['已批准', 'tag-green'],
    revoked: ['已撤销', 'tag-red'],
    expired: ['已过期', 'tag-gray'],
    rejected: ['已驳回', 'tag-gray'],
  };
  const [text, cls] = map[status] || [status, 'tag-gray'];
  return `<span class="tag ${cls}">${text}</span>`;
}

// ---------- 登录 / 退出 ----------

const LOGIN_USERS = [
  { id: 'u_jia', label: '客服甲', desc: '工单客服' },
  { id: 'u_yi', label: '客服乙', desc: '工单客服' },
  { id: 'u_lead', label: '主管', desc: '审批 / 撤销 / 审计' },
];

function renderLogin() {
  $('#login-buttons').innerHTML = LOGIN_USERS.map(
    (u) => `<button class="btn" data-user="${u.id}">${u.label}<span class="muted" style="margin-left:8px">${u.desc}</span></button>`
  ).join('');
  $('#login-buttons').querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const data = await api('/api/login', {
          method: 'POST',
          body: JSON.stringify({ userId: btn.dataset.user }),
        });
        enterApp(data.user);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.hash = '';
  location.reload();
});

function enterApp(user) {
  state.user = user;
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#current-user').textContent = `${user.name}（${user.role === 'supervisor' ? '主管' : '客服'}）`;
  document.querySelectorAll('.supervisor-only').forEach((el) => {
    el.classList.toggle('hidden', user.role !== 'supervisor');
  });
  if (user.role === 'supervisor') $('#nav-my-grants').classList.add('hidden');
  window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = '#/tickets';
  route();
}

// ---------- 路由 ----------

async function route() {
  clearInterval(state.timer);
  const hash = location.hash || '#/tickets';
  document.querySelectorAll('.nav a').forEach((a) => {
    a.classList.toggle('active', hash.startsWith(a.getAttribute('href')));
  });
  const main = $('#main');
  try {
    if (hash.startsWith('#/tickets/')) return renderDetail(hash.slice('#/tickets/'.length));
    if (hash === '#/my-grants') return renderMyGrants();
    if (hash === '#/approvals') return renderApprovals();
    if (hash === '#/audit') return renderAudit();
    return renderTicketList();
  } catch (err) {
    main.innerHTML = `<div class="card empty">${esc(err.message)}</div>`;
  }
}

// ---------- 工单列表 ----------

async function renderTicketList() {
  const main = $('#main');
  main.innerHTML = `
    <h2 class="page-title">工单列表</h2>
    <div class="card">
      <div class="toolbar">
        <input type="search" id="search-input" placeholder="搜索工单号 / 客户 / 状态" />
        <button class="btn" id="search-btn">搜索</button>
      </div>
      <table>
        <thead><tr>
          <th>工单号</th><th>客户</th><th>状态</th><th>联系电话</th><th>备用电话</th><th>建单时间</th><th></th>
        </tr></thead>
        <tbody id="ticket-rows"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody>
      </table>
    </div>`;

  const load = async (q = '') => {
    const { tickets } = await api(`/api/tickets${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    const rows = tickets.map((t) => `
      <tr>
        <td><a class="link" href="#/tickets/${esc(t.id)}">${esc(t.id)}</a></td>
        <td>${esc(t.customer)}</td>
        <td><span class="tag tag-blue">${esc(t.status)}</span></td>
        <td>${phoneCell(t, 'phone')}</td>
        <td>${phoneCell(t, 'backupPhone')}</td>
        <td>${esc(t.createdAt)}</td>
        <td><a class="link" href="#/tickets/${esc(t.id)}">详情</a></td>
      </tr>`).join('');
    $('#ticket-rows').innerHTML = rows || '<tr><td colspan="7" class="empty">没有匹配的工单</td></tr>';
  };

  $('#search-btn').addEventListener('click', () => load($('#search-input').value));
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') load(e.target.value);
  });
  await load();
}

function phoneCell(ticket, field) {
  const perm = ticket._permissions[field];
  return perm.unmasked
    ? `<span class="plain">${esc(ticket[field])}</span>`
    : `<span class="masked">${esc(ticket[field])}</span>`;
}

// ---------- 工单详情 ----------

async function renderDetail(ticketId) {
  const main = $('#main');
  main.innerHTML = '<div class="card empty">加载中…</div>';

  const render = async () => {
    const { ticket } = await api(`/api/tickets/${encodeURIComponent(ticketId)}`);
    const isAgent = state.user.role === 'agent';
    main.innerHTML = `
      <h2 class="page-title">工单 ${esc(ticket.id)}
        <button class="btn btn-ghost btn-sm" style="margin-left:10px" onclick="navigator.clipboard?.writeText(location.href)">复制详情地址</button>
        <a class="btn btn-ghost btn-sm" href="/api/tickets/${esc(ticket.id)}/export">导出 CSV</a>
      </h2>
      <div class="card">
        ${renderSensitive(ticket, 'phone', '联系电话', isAgent)}
        ${renderSensitive(ticket, 'backupPhone', '备用电话', isAgent)}
      </div>
      <div class="card">
        <div class="detail-grid">
          <div class="detail-item"><div class="field-label">客户</div><div class="field-value">${esc(ticket.customer)}</div></div>
          <div class="detail-item"><div class="field-label">状态</div><div class="field-value"><span class="tag tag-blue">${esc(ticket.status)}</span></div></div>
          <div class="detail-item full"><div class="field-label">地址</div><div class="field-value">${esc(ticket.address)}</div></div>
          <div class="detail-item full"><div class="field-label">备注</div><div class="field-value">${esc(ticket.note)}</div></div>
          <div class="detail-item"><div class="field-label">建单时间</div><div class="field-value">${esc(ticket.createdAt)}</div></div>
        </div>
      </div>`;

    main.querySelectorAll('[data-apply]').forEach((btn) => {
      btn.addEventListener('click', () => openApplyModal(ticketId, btn.dataset.apply, ticket.id));
    });
  };

  await render();
  // 每 5 秒重新拉取详情：授权到期或被主管撤销后，页面自动回到脱敏状态。
  state.timer = setInterval(render, 5000);
}

function renderSensitive(ticket, field, label, isAgent) {
  const perm = ticket._permissions[field];
  if (perm.unmasked) {
    const remain = Math.max(0, Math.round((perm.expiresAt - Date.now()) / 1000));
    return `
      <div class="detail-item" style="margin-bottom:18px">
        <div class="field-label">${label}
          <span class="tag tag-green" style="margin-left:8px">临时授权中 · 剩余 <span class="countdown">${remain}s</span></span>
          <span class="muted">（授权号 ${esc(perm.grantId)}）</span>
        </div>
        <div class="field-value plain">${esc(ticket[field])}</div>
        <div class="grant-banner" style="margin-top:8px">你正在查看明文，本次查看已记入审计；授权到期或主管撤销后立即恢复脱敏。</div>
      </div>`;
  }
  return `
    <div class="detail-item" style="margin-bottom:18px">
      <div class="field-label">${label} <span class="tag tag-gray" style="margin-left:8px">已脱敏</span></div>
      <div class="field-value masked">${esc(ticket[field])}</div>
      ${isAgent ? `
        <div class="apply-box">
          <button class="btn btn-sm" data-apply="${field}">因物流问题申请查看该字段</button>
        </div>` : `
        <div class="mask-banner" style="margin-top:8px">主管账号不持有客服授权，同样只能看到脱敏值。</div>`}
    </div>`;
}

function openApplyModal(ticketId, field, displayId) {
  const fieldLabel = field === 'phone' ? '联系电话' : '备用电话';
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal">
      <h3>申请临时查看权限</h3>
      <div class="meta" style="margin-bottom:12px">
        工单：<b>${esc(displayId)}</b>　字段：<b>${fieldLabel}</b><br/>
        批准后限时 <b>${state.ttlSeconds}</b> 秒内可查看明文，仅对你本人生效。
      </div>
      <textarea id="apply-reason" placeholder="请说明物流问题，例如：客户反馈未签收，需电话联系派件员核实"></textarea>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="apply-cancel">取消</button>
        <button class="btn" id="apply-submit">提交申请</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  mask.querySelector('#apply-cancel').addEventListener('click', close);
  mask.querySelector('#apply-submit').addEventListener('click', async () => {
    try {
      await api('/api/grants', {
        method: 'POST',
        body: JSON.stringify({ ticketId, field, reason: mask.querySelector('#apply-reason').value }),
      });
      close();
      toast('申请已提交，等待主管审批', 'success');
      location.hash = '#/my-grants';
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------- 我的申请 ----------

async function renderMyGrants() {
  const { grants } = await api('/api/grants');
  const rows = grants.map((g) => `
    <tr>
      <td>${esc(g.id)}</td>
      <td>${esc(g.ticketId)}</td>
      <td>${esc(g.fieldLabel)}</td>
      <td>${esc(g.reason)}</td>
      <td>${statusTag(g.status)}</td>
      <td>${g.expiresAt ? `${fmtTime(g.expiresAt)} 到期` : '—'}</td>
      <td><a class="link" href="#/tickets/${esc(g.ticketId)}">打开工单</a></td>
    </tr>`).join('');
  $('#main').innerHTML = `
    <h2 class="page-title">我的授权申请</h2>
    <div class="card">
      <table>
        <thead><tr><th>申请号</th><th>工单</th><th>字段</th><th>理由</th><th>状态</th><th>有效期</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="empty">还没有申请记录</td></tr>'}</tbody>
      </table>
    </div>`;
}

// ---------- 主管：审批中心 ----------

async function renderApprovals() {
  const { grants } = await api('/api/grants');
  const rows = grants.map((g) => `
    <tr>
      <td>${esc(g.id)}</td>
      <td>${esc(g.userName)}</td>
      <td><a class="link" href="#/tickets/${esc(g.ticketId)}">${esc(g.ticketId)}</a></td>
      <td>${esc(g.fieldLabel)}</td>
      <td>${esc(g.reason)}</td>
      <td>${statusTag(g.status)}</td>
      <td>${fmtTime(g.createdAt)}</td>
      <td>${grantActions(g)}</td>
    </tr>`).join('');
  $('#main').innerHTML = `
    <h2 class="page-title">审批中心</h2>
    <div class="card">
      <table>
        <thead><tr><th>申请号</th><th>申请人</th><th>工单</th><th>字段</th><th>理由</th><th>状态</th><th>申请时间</th><th>操作</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="empty">暂无申请</td></tr>'}</tbody>
      </table>
    </div>`;

  $('#main').querySelectorAll('[data-decision]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const [action, id] = btn.dataset.decision.split(':');
      try {
        await api(`/api/grants/${id}/${action}`, { method: 'POST' });
        toast(action === 'revoke' ? '授权已撤销，对方下次读取即恢复脱敏' : '操作成功', 'success');
        renderApprovals();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

function grantActions(g) {
  if (g.status === 'pending') {
    return `
      <button class="btn btn-sm" data-decision="approve:${esc(g.id)}">批准</button>
      <button class="btn btn-ghost btn-sm" data-decision="reject:${esc(g.id)}">驳回</button>`;
  }
  if (g.status === 'approved') {
    return `<button class="btn btn-danger btn-sm" data-decision="revoke:${esc(g.id)}">撤销</button>`;
  }
  return '<span class="muted">—</span>';
}

// ---------- 主管：审计日志 ----------

async function renderAudit() {
  const { logs } = await api('/api/audit-logs');
  const ACTION_LABEL = {
    'auth.login': '登录',
    'auth.logout': '退出',
    'grant.request': '提交申请',
    'grant.approve': '批准授权',
    'grant.reject': '驳回申请',
    'grant.revoke': '撤销授权',
    'sensitive.view': '查看明文字段',
    'export.csv': '导出 CSV',
  };
  const rows = logs.map((l) => `
    <tr>
      <td>${esc(new Date(l.at).toLocaleString('zh-CN', { hour12: false }))}</td>
      <td>${esc(ACTION_LABEL[l.action] || l.action)}</td>
      <td>${esc(l.actorName || '')}</td>
      <td>${esc(l.ticketId || '')}</td>
      <td>${esc(l.field || '')}</td>
      <td>${esc(l.grantId || '')}</td>
      <td>${esc(l.reason || '')}</td>
    </tr>`).join('');
  $('#main').innerHTML = `
    <h2 class="page-title">审计日志 <span class="muted" style="font-size:13px">（日志只记录操作元数据，不含任何完整号码）</span></h2>
    <div class="card">
      <table>
        <thead><tr><th>时间</th><th>动作</th><th>操作人</th><th>工单</th><th>字段</th><th>授权号</th><th>申请理由</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="empty">暂无日志</td></tr>'}</tbody>
      </table>
    </div>`;
}

// ---------- 启动 ----------

renderLogin();
api('/api/me')
  .then((data) => {
    state.ttlSeconds = data.ttlSeconds;
    enterApp(data.user);
  })
  .catch(() => {
    $('#login-view').classList.remove('hidden');
  });
