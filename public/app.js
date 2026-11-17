// 单页演示：顶部切换的每个身份各持一个独立服务端会话 token
const ROLES = [
  { key: 'customer', label: '客户·王丽', icon: '🙋' },
  { key: 'agent', label: '客服·李敏', icon: '🎧' },
  { key: 'auditor', label: '审计员', icon: '🧾' }
];
const LOGIN_IDS = { customer: 'u_cust', agent: 'u_agent', auditor: 'u_auditor' };
const TTL_OPTIONS = [
  { v: 1, label: '1 分钟（快速演示过期）' },
  { v: 10, label: '10 分钟' },
  { v: 60, label: '1 小时' },
  { v: 240, label: '4 小时' }
];
const AS_TYPES = ['退货退款', '仅退款', '换货', '维修'];
const STATUS_LABEL = { active: '生效中', canceled: '已取消', expired: '已过期', consumed: '已使用' };
const ACTION_LABEL = {
  'login': '登录',
  'logout': '退出登录',
  'auth.create': '客户发起授权',
  'auth.cancel': '客户取消授权',
  'acting.enter': '客服接手代办',
  'acting.exit': '客服退出代办',
  'aftersale.submit': '提交售后申请'
};

const state = {
  role: 'customer',
  tokens: {}, // 每个身份独立会话
  users: {},
  data: {},
  agentTab: 'inbox',
  timer: null
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
const money = (n) => (n == null ? '—' : `¥${n}`);

async function api(path, opts = {}) {
  const token = state.tokens[state.role];
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `请求失败 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

async function login(role) {
  const { token, user } = await api('/api/login', { method: 'POST', body: { userId: LOGIN_IDS[role] } });
  state.tokens[role] = token;
  state.users[role] = user;
}

async function ensureLogin(role) {
  if (!state.tokens[role]) await login(role);
}

async function logout() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {}
  delete state.tokens[state.role];
  delete state.users[state.role];
  state.data = {};
  toast('已退出，服务端会话已清除（代办标记一并清除）');
  render();
}

async function switchRole(role) {
  state.role = role;
  await ensureLogin(role);
  render();
}

// ---------- 数据轮询（客户取消授权后，客服侧 3 秒内感知） ----------
async function refresh() {
  if (!state.tokens[state.role]) return;
  const role = state.role;
  try {
    const me = await api('/api/me');
    const common = { me: me };
    if (role === 'customer') {
      const [orders, auths, aftersales] = await Promise.all([
        api('/api/orders'),
        api('/api/authorizations'),
        api('/api/aftersales')
      ]);
      Object.assign(common, orders, auths, aftersales);
    } else if (role === 'agent') {
      const [orders, auths, aftersales, tickets, knowledge] = await Promise.all([
        api('/api/orders'),
        api('/api/authorizations'),
        api('/api/aftersales'),
        api('/api/my-tickets'),
        api('/api/knowledge')
      ]);
      Object.assign(common, orders, auths, aftersales, tickets, knowledge);
    } else {
      const audits = await api('/api/audits');
      const aftersales = await api('/api/aftersales');
      Object.assign(common, audits, aftersales);
    }
    state.data = common;
    renderShell();
    renderView();
  } catch (err) {
    if (err.status === 401) {
      delete state.tokens[role];
      render();
    }
  }
}

// ---------- 外壳：角色页签 + 会话状态 + 代办横幅 ----------
function renderShell() {
  $('#roleTabs').innerHTML = ROLES.map(
    (r) =>
      `<button data-role="${r.key}" class="${state.role === r.key ? 'active' : ''}">${r.icon} ${r.label}</button>`
  ).join('');

  const user = state.users[state.role];
  $('#sessionBox').innerHTML = user
    ? `当前会话身份：<b>${esc(user.name)}</b>（${esc(user.id)}）<button class="logout" data-act="logout">退出登录</button>`
    : '未登录';

  const acting = state.data.me?.acting;
  const banner = $('#actingBanner');
  if (state.role === 'agent' && acting) {
    if (acting.blockedReason) {
      banner.className = 'acting-banner blocked';
      banner.innerHTML = `⚠️ 代办授权 ${esc(acting.id)} <b>${esc(acting.blockedReason)}</b>，手上表单已锁定不能提交。
        <button class="btn gray" data-act="exit-acting">退出代办</button>`;
    } else if (acting.status === 'consumed') {
      banner.className = 'acting-banner';
      banner.innerHTML = `✅ 授权 ${esc(acting.id)} 已成功提交售后（原申请可回放，不会重复建单）。
        <button class="btn gray" data-act="exit-acting">退出代办</button>`;
    } else {
      banner.className = 'acting-banner';
      banner.innerHTML = `🛡️ 代办中 · 授权编号 <b class="mono">${esc(acting.id)}</b>
        · 客户 <b>${esc(acting.customer.name)}</b> · 订单 <b>${esc(acting.order.orderNo)}</b>
        · 范围：仅售后提交 · 截止 <b>${fmt(acting.expiresAt)}</b>
        · 剩余 <span class="countdown" data-deadline="${acting.expiresAt}">--:--</span>
        <button class="btn gray" data-act="exit-acting">退出代办</button>`;
    }
  } else {
    banner.className = 'acting-banner hidden';
    banner.innerHTML = '';
  }
}

function authBadge(status) {
  return `<span class="badge ${status}">${STATUS_LABEL[status] || status}</span>`;
}

// ---------- 客户视图 ----------
function customerView() {
  const { orders = [], auths = [], aftersales = [] } = state.data;
  const agents = [
    { id: 'u_agent', name: '客服·李敏' },
    { id: 'u_agent2', name: '客服·周强' }
  ];
  return `
    <div class="callout blue">演示要点：授权<b>仅绑定单笔订单</b>、范围固定为「售后提交」、带截止时间；授权编号是客服接手的唯一凭证。</div>
    <div class="section-title">我的订单（共 ${orders.length} 笔）</div>
    <div class="stack">
      ${orders
        .map((o) => {
          const auth = auths.find((a) => a.orderId === o.id);
          const apps = aftersales.filter((a) => a.orderId === o.id);
          return `
          <div class="card">
            <div class="spread">
              <div>
                <h3>${esc(o.title)} <span class="muted mono small">${esc(o.orderNo)}</span></h3>
                <div class="muted small">${money(o.amount)} · ${esc(o.status)} · 下单 ${fmt(o.createdAt)}</div>
              </div>
              ${auth ? authBadge(auth.status) : '<span class="badge info">未授权</span>'}
            </div>
            ${
              auth
                ? `<div class="kv" style="margin-top:12px">
                     <dt>授权编号</dt><dd class="mono auth-code">${esc(auth.id)}</dd>
                     <dt>代办客服</dt><dd>${esc(auth.agent.name)}</dd>
                     <dt>授权范围</dt><dd>仅该订单的售后提交（aftersale:submit）</dd>
                     <dt>截止时间</dt><dd>${fmt(auth.expiresAt)}
                       ${auth.status === 'active' ? `（剩余 <span class="countdown" data-deadline="${auth.expiresAt}">--:--</span>）` : ''}</dd>
                     ${auth.canceledAt ? `<dt>取消时间</dt><dd>${fmt(auth.canceledAt)}</dd>` : ''}
                     ${auth.consumedAt ? `<dt>使用时间</dt><dd>${fmt(auth.consumedAt)}</dd>` : ''}
                   </div>
                   <div class="row" style="margin-top:12px">
                     ${auth.status === 'active' ? `<button class="btn danger" data-act="cancel-auth" data-id="${auth.id}">取消授权</button>` : ''}
                   </div>`
                : `<div class="row" style="margin-top:12px">
                     <label class="field" style="margin:0">授权给客服
                       <select id="agentSel-${o.id}">
                         ${agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}
                       </select>
                     </label>
                     <label class="field" style="margin:0">有效期
                       <select id="ttlSel-${o.id}">
                         ${TTL_OPTIONS.map((t) => `<option value="${t.v}" ${t.v === 10 ? 'selected' : ''}>${t.label}</option>`).join('')}
                       </select>
                     </label>
                     <button class="btn" data-act="create-auth" data-order="${o.id}">发起该订单的代办授权</button>
                   </div>
                   <div class="muted small" style="margin-top:8px">授权范围固定：仅允许该客服就本订单提交一次售后申请，不含其他任何操作。</div>`
            }
          </div>`;
        })
        .join('')}
    </div>

    <div class="section-title">我的售后申请（可查实际操作人与授权编号）</div>
    <div class="card">
      ${
        aftersales.length
          ? `<table><thead><tr><th>申请编号</th><th>订单</th><th>类型</th><th>客户身份</th><th>实际提交客服</th><th>使用授权</th><th>时间</th><th>状态</th></tr></thead>
            <tbody>${aftersales
              .map(
                (a) => `<tr>
                <td class="mono">${esc(a.id)}</td><td>${esc(a.order.orderNo)}</td><td>${esc(a.type)}</td>
                <td>${esc(a.customer.name)}</td><td><b>${esc(a.agent.name)}</b></td>
                <td class="mono">${esc(a.authId)}</td><td>${fmt(a.createdAt)}</td><td>${esc(a.status)}</td></tr>`
              )
              .join('')}</tbody></table>`
          : `<div class="muted">暂无售后申请</div>`
      }
    </div>`;
}

// ---------- 客服视图 ----------
function agentView() {
  const { auths = [], aftersales = [], orders = [], tickets = [], articles = [], me } = state.data;
  const acting = me?.acting;
  const tabs = [
    { k: 'inbox', label: '📥 待接手授权' },
    { k: 'aftersale', label: '📝 代办售后' },
    { k: 'tickets', label: '📋 我的工单' },
    { k: 'knowledge', label: '📚 知识库' }
  ];
  return `
    <div class="tabs">
      ${tabs.map((t) => `<button data-tab="${t.k}" class="${state.agentTab === t.k ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    ${
      state.agentTab === 'inbox'
        ? agentInbox(auths, orders)
        : state.agentTab === 'aftersale'
          ? agentAftersale(auths, aftersales, acting)
          : state.agentTab === 'tickets'
            ? agentTickets(tickets)
            : agentKnowledge(articles)
    }`;
}

function agentInbox(auths, orders) {
  const mine = auths.filter((a) => a.agentId === state.users.agent.id);
  return `
    <div class="callout blue">输入客户给的授权编号接手。代办状态下只开放售后流程；工单、知识库等页面仍以你本人身份工作。</div>
    <div class="grid" style="margin-top:14px">
      <div class="card">
        <h2>凭授权编号接手</h2>
        <label class="field">授权编号</label>
        <input id="takeAuthNo" placeholder="例如 AUTH202611180001" class="mono" />
        <div class="row" style="margin-top:10px">
          <button class="btn" data-act="enter-acting">接手代办</button>
        </div>
      </div>
      <div class="card">
        <h2>发给我的授权</h2>
        ${
          mine.length
            ? `<table><thead><tr><th>授权编号</th><th>订单</th><th>状态</th><th>截止</th><th></th></tr></thead><tbody>
              ${mine
                .map(
                  (a) => `<tr>
                  <td class="mono small">${esc(a.id)}</td><td>${esc(a.order.orderNo)}<div class="muted small">${esc(a.order.title)}</div></td>
                  <td>${authBadge(a.status)}</td><td class="small">${fmt(a.expiresAt)}</td>
                  <td>${a.status === 'active' ? `<button class="btn ghost small" data-act="quick-enter" data-id="${a.id}">接手</button>` : ''}</td>
                </tr>`
                )
                .join('')}</tbody></table>`
            : `<div class="muted">暂无授权，请客户在客户页发起</div>`
        }
      </div>
    </div>`;
}

function agentAftersale(auths, aftersales, acting) {
  if (!acting) {
    return `<div class="card"><h2>代办售后</h2>
      <div class="callout red">当前不在代办状态。请先到「待接手授权」凭客户授权编号接手，才能提交售后。</div></div>`;
  }
  const blocked = acting.blockedReason;
  const consumed = acting.status === 'consumed';
  const existing = aftersales.find((a) => a.authId === acting.id);
  return `
    <div class="grid">
      <div class="card ${blocked ? 'locked' : ''}">
        <h2>售后申请单 ${blocked ? '（已锁定）' : consumed ? '（已提交，重复点击只回放原单）' : ''}</h2>
        <div class="kv">
          <dt>代办客户</dt><dd>${esc(acting.customer.name)}（${esc(acting.customer.id)}）</dd>
          <dt>授权编号</dt><dd class="mono">${esc(acting.id)}</dd>
          <dt>授权范围</dt><dd>仅本订单售后提交</dd>
          <dt>对应订单</dt><dd>${esc(acting.order.orderNo)} · ${esc(acting.order.title)}</dd>
          <dt>截止时间</dt><dd>${fmt(acting.expiresAt)}</dd>
        </div>
        ${
          blocked
            ? `<div class="callout red" style="margin-top:12px">${esc(blocked)}，本表单不能提交。请退出代办后联系客户重新授权。</div>`
            : `
            <div style="margin-top:12px" class="stack">
              <div><label class="field">售后类型</label>
                <select id="asType">${AS_TYPES.map((t, i) => `<option ${existing && existing.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
              <div><label class="field">退款金额（可选）</label><input id="asAmount" type="number" placeholder="0.00" value="${existing?.amount ?? ''}" /></div>
              <div><label class="field">问题描述</label><textarea id="asReason">${esc(existing?.reason || '')}</textarea></div>
              <button class="btn" data-act="submit-aftersale">${consumed ? '再点一次（只返回原申请结果）' : '以客户身份提交售后申请'}</button>
              <div class="muted small">提交记录会同时保存：客户身份、实际操作客服（你）、授权编号。${consumed ? '该授权已消费，再次点击不会生成第二张单。' : '重复点击不会生成第二张单。'}</div>
            </div>`
        }
      </div>
      <div class="card">
        <h2>本授权的申请结果</h2>
        ${
          existing
            ? `<div class="callout green">该授权已提交成功，再点提交只会返回原申请（幂等）。</div>
              <div class="kv" style="margin-top:10px">
                <dt>申请编号</dt><dd class="mono">${esc(existing.id)}</dd>
                <dt>订单</dt><dd>${esc(existing.order.orderNo)}</dd>
                <dt>类型</dt><dd>${esc(existing.type)}</dd>
                <dt>客户身份</dt><dd>${esc(existing.customer.name)}</dd>
                <dt>实际提交</dt><dd><b>${esc(existing.agent.name)}</b></dd>
                <dt>授权编号</dt><dd class="mono">${esc(existing.authId)}</dd>
                <dt>状态</dt><dd>${esc(existing.status)}</dd>
              </div>`
            : `<div class="muted">尚未提交。</div>`
        }
        <div class="section-title">授权范围之外的订单（只读，不能代办）</div>
        <div class="stack">
          ${getOtherOrders(acting).map(
            (o) => `<div class="spread" style="padding:8px 0;border-bottom:1px solid var(--line)">
              <div>${esc(o.orderNo)} · ${esc(o.title)} <span class="muted small">${money(o.amount)}</span></div>
              <button class="btn gray" disabled title="当前授权只覆盖 ${esc(acting.order.orderNo)}">无权代办</button>
            </div>`
          )}
        </div>
      </div>
    </div>`;
}

function getOtherOrders(acting) {
  // 演示第二笔订单：当前授权只覆盖 acting.orderId，其余订单一律无权代办
  const all = state.data.orders || [];
  return all.filter((o) => o.id !== acting.orderId);
}

function agentTickets(tickets) {
  return `<div class="card">
    <h2>我的工单 <span class="badge purple">始终以客服本人身份</span></h2>
    <div class="callout green" style="margin-bottom:10px">${esc(tickets.note || '')}</div>
    <table><thead><tr><th>工单号</th><th>负责人</th><th>标题</th><th>状态</th></tr></thead>
    <tbody>${tickets.tickets
      .map(
        (t) => `<tr><td class="mono">${esc(t.id)}</td><td>${esc(t.owner)}</td><td>${esc(t.title)}</td><td>${esc(t.state)}</td></tr>`
      )
      .join('')}</tbody></table>
  </div>`;
}

function agentKnowledge(articles) {
  return `<div class="card"><h2>知识库 <span class="badge purple">客服本人身份</span></h2>
    <div class="stack">${articles
      .map((a) => `<div class="spread" style="padding:10px 0;border-bottom:1px solid var(--line)">
        <span class="mono small">${esc(a.id)}</span><b>${esc(a.title)}</b>
        <button class="btn ghost" disabled>查看</button></div>`)
      .join('')}</div></div>`;
}

// ---------- 审计视图 ----------
function auditorView() {
  const { audits = [], aftersales = [] } = state.data;
  return `
    <div class="card">
      <h2>售后申请审计（谁实际操作 / 用了哪次授权）</h2>
      ${
        aftersales.length
          ? `<table><thead><tr><th>申请编号</th><th>订单</th><th>客户身份</th><th>实际操作客服</th><th>授权编号</th><th>类型</th><th>提交时间</th></tr></thead>
          <tbody>${aftersales
            .map(
              (a) => `<tr>
              <td class="mono">${esc(a.id)}</td><td>${esc(a.order.orderNo)}</td>
              <td>${esc(a.customer.name)}<div class="muted small mono">${esc(a.customer.id)}</div></td>
              <td><b>${esc(a.agent.name)}</b><div class="muted small mono">${esc(a.agent.id)}</div></td>
              <td class="mono">${esc(a.authId)}</td><td>${esc(a.type)}</td><td>${fmt(a.createdAt)}</td></tr>`
            )
            .join('')}</tbody></table>`
          : `<div class="muted">暂无售后申请</div>`
      }
    </div>
    <div class="section-title">操作审计日志（授权全生命周期 + 提交动作，含重复提交标记）</div>
    <div class="card">
      <table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>明细</th></tr></thead>
      <tbody>${audits
        .map((l) => {
          const d = l.detail || {};
          const detailHtml = Object.entries(d)
            .map(([k, v]) => `${esc(k)}: <b>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</b>`)
            .join(' · ');
          return `<tr><td class="small">${fmt(l.at)}</td>
            <td>${l.actor ? esc(l.actor.name) : '系统'}</td>
            <td><span class="badge info">${esc(ACTION_LABEL[l.action] || l.action)}</span></td>
            <td class="small mono">${detailHtml}</td></tr>`;
        })
        .join('')}</tbody></table>
    </div>`;
}

// ---------- 登录页 ----------
function loginView() {
  return `<div class="login-wrap">
    <h1>本地演示后台 · 选择身份进入</h1>
    <p class="muted" style="text-align:center">三种身份各自建立独立服务端会话，可随时切换，互不串号</p>
    <div class="role-cards">
      ${ROLES.map(
        (r) => `<div class="role-card" data-role="${r.key}">
          <div class="icon">${r.icon}</div>
          <div class="name">${r.label}</div>
          <div class="desc">${
            r.key === 'customer'
              ? '发起/取消订单代办授权，查看售后与操作人'
              : r.key === 'agent'
                ? '凭授权编号接手，代办售后申请'
                : '查看售后记录与全量审计日志'
          }</div>
        </div>`
      ).join('')}
    </div>
  </div>`;
}

function renderView() {
  const app = $('#app');
  if (!state.tokens[state.role]) return (app.innerHTML = loginView());
  app.innerHTML =
    state.role === 'customer' ? customerView() : state.role === 'agent' ? agentView() : auditorView();
  updateCountdowns();
}
function render() {
  renderShell();
  renderView();
}

function updateCountdowns() {
  document.querySelectorAll('[data-deadline]').forEach((el) => {
    const ms = Number(el.dataset.deadline) - Date.now();
    if (ms <= 0) return (el.textContent = '已到期');
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    el.textContent = `${m}分${String(s).padStart(2, '0')}秒`;
  });
}
setInterval(updateCountdowns, 1000);

// ---------- 全局事件 ----------
document.addEventListener('click', async (e) => {
  const roleEl = e.target.closest('[data-role]');
  if (roleEl) return switchRole(roleEl.dataset.role);

  const actEl = e.target.closest('[data-act]');
  if (!actEl) return;
  const act = actEl.dataset.act;
  try {
    if (act === 'logout') return await logout();
    if (act === 'create-auth') {
      const orderId = actEl.dataset.order;
      const agentId = $(`#agentSel-${orderId}`).value;
      const ttlMinutes = Number($(`#ttlSel-${orderId}`).value);
      const r = await api('/api/authorizations', {
        method: 'POST',
        body: { orderId, agentId, ttlMinutes }
      });
      toast(`授权已生成：${r.auth.id}，截止 ${fmt(r.auth.expiresAt)}`, 'success');
      return refresh();
    }
    if (act === 'cancel-auth') {
      await api(`/api/authorizations/${actEl.dataset.id}/cancel`, { method: 'POST' });
      toast('授权已取消，客服侧已打开的表单将被锁定', 'success');
      return refresh();
    }
    if (act === 'enter-acting') {
      const authId = $('#takeAuthNo').value.trim();
      if (!authId) return toast('请输入授权编号', 'error');
      await api('/api/acting/enter', { method: 'POST', body: { authId } });
      state.agentTab = 'aftersale';
      toast('已接手代办，仅开放该订单售后流程', 'success');
      return refresh();
    }
    if (act === 'quick-enter') {
      await api('/api/acting/enter', { method: 'POST', body: { authId: actEl.dataset.id } });
      state.agentTab = 'aftersale';
      toast('已接手代办', 'success');
      return refresh();
    }
    if (act === 'exit-acting') {
      await api('/api/acting/exit', { method: 'POST' });
      toast('已退出代办，客户身份未留在你的会话中', 'success');
      return refresh();
    }
    if (act === 'submit-aftersale') {
      const body = {
        type: $('#asType').value,
        reason: $('#asReason').value,
        amount: Number($('#asAmount').value) || null
      };
      const r = await api('/api/aftersales', { method: 'POST', body });
      toast(
        r.duplicated
          ? `该授权已提交过，返回原申请 ${r.aftersale.id}（未重复建单）`
          : `售后申请已提交：${r.aftersale.id}，请确认后点「退出代办」清除客户身份`,
        r.duplicated ? '' : 'success'
      );
      return refresh();
    }
  } catch (err) {
    toast(err.message, 'error');
    refresh();
  }
});

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    state.agentTab = tab.dataset.tab;
    renderView();
  }
});

// 启动：默认进入客户登录页
render();
refresh();
setInterval(refresh, 3000);
