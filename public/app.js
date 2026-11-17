import { LatestRequestGate } from './guard.js';

const ORG_STORAGE_KEY = 'desk:lastOrgSlug';

// ---------- 地址 = 组织上下文的唯一来源 --------------------------------------
// /o/:org/customers/:code   打开某组织下的某个客户
// /o/:org/customers         只列出该组织客户
// 刷新、前进后退、从历史记录回到旧地址时，组织都从 pathname 恢复，
// 而不是从 Cookie、localStorage 或内存里猜。
function parseLocation() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'o' || !parts[1]) return { orgSlug: null, code: null };
  return { orgSlug: decodeURIComponent(parts[1]), code: parts[2] === 'customers' && parts[3] ? decodeURIComponent(parts[3]) : null };
}

function buildPath(orgSlug, code) {
  return code ? `/o/${orgSlug}/customers/${encodeURIComponent(code)}` : `/o/${orgSlug}/customers`;
}

// 只用于“地址没带组织时”的便捷跳转；打开标签时地址永远优先。
// 用 sessionStorage 而不是 localStorage：它天然是标签级的，不会把某个标签的组织选择带进另一个标签。
function lastOrgSlug() {
  try {
    return sessionStorage.getItem(ORG_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberOrg(orgSlug) {
  try {
    sessionStorage.setItem(ORG_STORAGE_KEY, orgSlug);
  } catch {
    /* 忽略隐私模式下的存储失败 */
  }
}

// ---------- DOM ---------------------------------------------------------------
const els = {
  identity: document.querySelector('#identity'),
  orgSwitch: document.querySelector('#org-switch'),
  customerList: document.querySelector('#customer-list'),
  content: document.querySelector('#content'),
  log: document.querySelector('#log'),
  clearLog: document.querySelector('#clear-log'),
  slowMode: document.querySelector('#slow-mode'),
};

const state = {
  me: null, // { user, organizations }
  orgSlug: null,
  org: null,
  code: null,
};

// 客户详情、客户列表、保存各用一道闸门：切换组织时三道都作废。
const readGate = new LatestRequestGate();
const listGate = new LatestRequestGate();
const writeGate = new LatestRequestGate();

// ---------- 日志 -----------------------------------------------------------------
function log(kind, message) {
  const item = document.createElement('li');
  item.className = `log-item ${kind}`;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const label = {
    request: '请求',
    ok: '完成',
    stale: '已丢弃',
    error: '失败',
    write: '保存',
    info: '信息',
  }[kind] || kind;
  const timeEl = document.createElement('span');
  timeEl.className = 't';
  timeEl.textContent = time;
  const tagEl = document.createElement('span');
  tagEl.className = 'tag';
  tagEl.textContent = label;
  const msgEl = document.createElement('span');
  msgEl.className = 'm';
  msgEl.textContent = message;
  item.append(timeEl, tagEl, msgEl);
  els.log.prepend(item);
  while (els.log.children.length > 60) els.log.lastElementChild.remove();
}

// ---------- API ----------------------------------------------------------------
// 网络层失败（服务没起、断网）统一转成 status 0，避免未处理的 Promise 拒绝；
// 只有主动中止（AbortError）继续向上抛，交给请求闸门判定。
async function requestJson(path, options) {
  try {
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return { ok: false, status: 0, data: {} };
  }
}

function apiGet(path, signal) {
  return requestJson(path, { signal, headers: { accept: 'application/json' } });
}

function apiPut(path, body) {
  return requestJson(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function errorText(result) {
  if (result.status === 0) return '无法连接本地服务，请确认 `npm start` 正在运行';
  return result.data?.error?.message || `HTTP ${result.status}`;
}

// ---------- 身份 -----------------------------------------------------------------
// 返回 { status: 'ok', me } | { status: 'anonymous' } | { status: 'offline' }。
// 把“未登录（401）”和“网络抖动”区分开：后者不应把用户踢出页面。
async function fetchMe() {
  try {
    const result = await apiGet('/api/me');
    if (result.ok) return { status: 'ok', me: result.data };
    if (result.status === 401) return { status: 'anonymous' };
    return { status: 'offline' };
  } catch {
    return { status: 'offline' };
  }
}

async function loadMe() {
  const result = await fetchMe();
  if (result.status === 'offline') return state.me; // 网络抖动：保留上一次已知身份
  state.me = result.status === 'ok' ? result.me : null;
  return state.me;
}

function renderIdentity() {
  if (!state.me) {
    els.identity.replaceChildren();
    const badge = document.createElement('span');
    badge.className = 'badge danger';
    badge.textContent = '未登录';
    const link = document.createElement('a');
    link.className = 'link';
    link.href = '/';
    link.textContent = '回首页登录';
    els.identity.append(badge, link);
    return;
  }
  const orgs = state.me.organizations.map((o) => o.name).join(' / ') || '无组织';
  els.identity.replaceChildren();
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = state.me.user.name;
  const rights = document.createElement('span');
  rights.className = 'muted';
  rights.textContent = `可访问：${orgs}`;
  els.identity.append(who, rights);
}

function renderOrgSwitch() {
  els.orgSwitch.replaceChildren();
  for (const org of state.me?.organizations || []) {
    const button = document.createElement('button');
    button.className = `org-chip ${org.slug === state.orgSlug ? 'active' : ''}`;
    button.type = 'button';
    button.textContent = org.name;
    button.dataset.slug = org.slug;
    button.setAttribute('aria-selected', String(org.slug === state.orgSlug));
    button.addEventListener('click', () => switchOrganization(org.slug));
    els.orgSwitch.append(button);
  }
  if (!state.me?.organizations.length) {
    const hint = document.createElement('p');
    hint.className = 'hint tiny';
    hint.textContent = '当前账号没有任何组织权限';
    els.orgSwitch.append(hint);
  }
}

// ---------- 页面渲染 ---------------------------------------------------------------
function renderPlaceholder(text, variant = '') {
  els.content.replaceChildren();
  const box = document.createElement('div');
  box.className = `placeholder ${variant}`.trim();
  box.textContent = text;
  els.content.append(box);
}

function renderDenied(result) {
  const title = result.status === 401 ? '需要登录' : result.status === 403 ? '无权访问该组织' : '加载失败';
  els.content.replaceChildren();
  const box = document.createElement('div');
  box.className = 'denied';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const detail = document.createElement('p');
  detail.textContent = errorText(result);
  box.append(heading, detail);
  if (result.status === 401) {
    const link = document.createElement('a');
    link.className = 'btn';
    link.href = '/';
    link.textContent = '回首页登录';
    box.append(link);
  }
  els.content.append(box);
  els.customerList.replaceChildren();
}

function renderCustomer(customer, context) {
  els.content.replaceChildren();
  const article = document.createElement('article');
  article.className = 'customer-card';
  article.innerHTML = `
    <div class="cust-head">
      <div>
        <p class="eyebrow" data-org></p>
        <h1 data-name></h1>
        <p class="muted" data-meta></p>
      </div>
      <span class="code">编号 <strong data-code></strong></span>
    </div>
    <label class="field">
      <span>备注（只属于当前组织）</span>
      <textarea id="note" rows="6" spellcheck="false"></textarea>
    </label>
    <div class="actions">
      <button class="btn primary" id="save">保存到当前组织</button>
      <button class="btn" id="reload">重新读取</button>
      <span class="status" id="save-status"></span>
    </div>
  `;
  article.querySelector('[data-org]').textContent = context.org.name;
  article.querySelector('[data-name]').textContent = customer.name;
  article.querySelector('[data-meta]').textContent =
    `电话 ${customer.phone} · 最近更新 ${customer.updatedAt ? new Date(customer.updatedAt).toLocaleString('zh-CN') : '—'}`;
  article.querySelector('[data-code]').textContent = customer.code;

  const textarea = article.querySelector('#note');
  textarea.value = customer.note;
  const status = article.querySelector('#save-status');
  const saveButton = article.querySelector('#save');
  const reloadButton = article.querySelector('#reload');

  // 快照绑定在这张卡片上，页面切走后旧卡片不会被误判为“没有修改”。
  let snapshot = customer.note;
  const card = {
    setSnapshot(note) {
      snapshot = note;
      status.className = 'status';
      status.textContent = '';
    },
  };
  textarea.addEventListener('input', () => {
    status.className = 'status';
    status.textContent = textarea.value === snapshot ? '' : '有未保存的修改';
  });

  saveButton.addEventListener('click', () => saveNote({ textarea, status, saveButton, context, card }));
  reloadButton.addEventListener('click', () => {
    if (context.orgSlug !== state.orgSlug || context.code !== state.code) {
      status.className = 'status warn';
      status.textContent = '页面已切换，无法重新读取这张卡片';
      return;
    }
    loadCustomer({ reason: '手动重新读取' });
  });

  els.content.append(article);
  textarea.focus({ preventScroll: true });
  return card;
}

function renderCustomerList(customers, selectedCode) {
  els.customerList.replaceChildren();
  for (const customer of customers) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = buildPath(state.orgSlug, customer.code);
    a.className = `customer-item ${customer.code === selectedCode ? 'active' : ''}`;
    const codeEl = document.createElement('strong');
    codeEl.textContent = customer.code;
    const nameEl = document.createElement('span');
    nameEl.textContent = customer.name;
    a.append(codeEl, nameEl);
    a.addEventListener('click', (event) => {
      event.preventDefault();
      navigate(customer.code);
    });
    li.append(a);
    els.customerList.append(li);
  }
}

function renderSaveStatus(status, variant, text) {
  status.className = `status ${variant || ''}`.trim();
  status.textContent = text;
}

// ---------- 核心流程 ---------------------------------------------------------------
async function loadCustomer({ reason = '加载' } = {}) {
  if (!state.orgSlug) return;
  if (!state.code) {
    // 只停在组织层面：把内容区换成提示，同时在左侧列出该组织的客户。
    if (state.org) {
      els.content.replaceChildren();
      renderPlaceholder(`「${state.org.name}」：请从左侧选择要处理的客户编号。`);
    }
    await loadCustomerList();
    return;
  }
  // 组织信息可能还没同步（比如轮询刚发现权限恢复），先刷新身份再决定。
  if (!state.org) {
    await loadMe();
    state.org = state.me?.organizations.find((org) => org.slug === state.orgSlug) || null;
    if (!state.org) {
      renderDenied({
        status: state.me ? 403 : 401,
        data: {
          error: {
            message: state.me ? `你没有「${state.orgSlug}」的访问权限` : '请先登录后再查看客户',
          },
        },
      });
      return;
    }
  }
  // 冻结本次请求的上下文：之后即使地址变了，也能判断结果是否过期。
  const requested = { orgSlug: state.orgSlug, code: state.code, org: state.org };
  const orgName = requested.org?.name || requested.orgSlug;

  const outcome = await readGate.run(
    ({ signal }) => {
      log('request', `GET ${orgName} 客户 ${requested.code}（${reason}）`);
      const path = `/api/orgs/${encodeURIComponent(requested.orgSlug)}/customers/${encodeURIComponent(requested.code)}?delay=${els.slowMode.checked ? 3000 : 0}`;
      return apiGet(path, signal);
    },
    {
      onStale: () => log('stale', `旧结果到达：${orgName} / ${requested.code}，当前页面已切走，已丢弃`),
    },
  );

  if (outcome.status !== 'ok') return; // stale / aborted 一律不得触碰当前页面

  const result = outcome.value;
  // 双保险：返回的组织/编号必须仍是当前地址上的那一组，否则视为旧结果丢弃。
  if (requested.orgSlug !== state.orgSlug || requested.code !== state.code) {
    log('stale', `旧结果（${orgName} / ${requested.code}）到达时页面已切走，已丢弃`);
    return;
  }
  if (!result.ok) {
    // 该组织下没有这个编号（撞号客户在两个组织未必都存在）时，回到该组织的客户列表。
    if (result.status === 404 && result.data?.error?.code === 'CUSTOMER_NOT_FOUND') {
      log('info', `${orgName} 下没有编号 ${requested.code}，回到客户列表`);
      window.history.replaceState({}, '', buildPath(requested.orgSlug, null));
      state.code = null;
      els.content.replaceChildren();
      renderPlaceholder(`「${orgName}」下没有编号 ${requested.code}，已切换到客户列表。`);
      await loadCustomerList();
      return;
    }
    log('error', `${result.status} ${errorText(result)}`);
    renderDenied(result);
    return;
  }

  // 双保险：即使闸门认为最新，也核对返回数据确实属于发起请求时的组织。
  if (result.data.organization.id !== requested.org.id || result.data.customer.organizationId !== requested.org.id) {
    log('stale', `返回数据组织不匹配（${result.data.organization.name}），已丢弃`);
    return;
  }

  const customer = result.data.customer;
  log('ok', `已加载 ${result.data.organization.name} 的 ${requested.code}（${customer.name}）`);
  // 渲染上下文固定为发起请求时的组织和编号，卡片上的保存不会漂移。
  renderCustomer(customer, {
    orgSlug: requested.orgSlug,
    org: requested.org,
    code: requested.code,
    organizationId: requested.org.id,
  });
  await loadCustomerList({ silent: true });
}

async function loadCustomerList({ silent = false } = {}) {
  if (!state.orgSlug) return;
  const requested = { orgSlug: state.orgSlug, org: state.org };
  const outcome = await listGate.run(
    ({ signal }) =>
      apiGet(`/api/orgs/${encodeURIComponent(requested.orgSlug)}/customers?t=${Date.now()}`, signal),
    { onStale: () => log('stale', `旧列表到达：${requested.org.name || requested.orgSlug}，已丢弃`) },
  );
  if (outcome.status !== 'ok') return;
  const result = outcome.value;
  // 列表请求同样可能晚到；组织已经不是当前组织时不渲染。
  if (requested.orgSlug !== state.orgSlug) return;
  if (!result.ok) {
    if (!silent) log('error', `客户列表：${errorText(result)}`);
    return;
  }
  renderCustomerList(result.data.customers, state.code);
}

async function saveNote({ textarea, status, saveButton, context, card }) {
  const target = {
    orgSlug: context.orgSlug,
    org: context.org,
    code: context.code,
    organizationId: context.organizationId,
  };
  const note = textarea.value;

  // 页面已经离开这张卡片对应的组织/编号时，这张卡片上的保存不应再落到任何记录上。
  if (target.orgSlug !== state.orgSlug || target.code !== state.code) {
    renderSaveStatus(status, 'warn', '页面已切换，本次保存未提交');
    log('stale', `卡片所属 ${target.org.name} / ${target.code} 已不在当前页面，保存未提交`);
    return;
  }

  saveButton.disabled = true;
  renderSaveStatus(status, '', '保存中…');

  const outcome = await writeGate.run(async () => {
    log('write', `PUT ${target.org.name} 客户 ${target.code} 保存备注`);
    return apiPut(
      `/api/orgs/${encodeURIComponent(target.orgSlug)}/customers/${encodeURIComponent(target.code)}/note`,
      // 组织只由 URL 与登录态决定，客户端传什么都不能改变写入目标。
      { note },
    );
  });

  saveButton.disabled = false;

  if (outcome.status !== 'ok') {
    // 保存目标在请求发起时就已冻结为这张卡片所属的组织/编号；页面若已切走，
    // 结果不再属于当前页面，因此不更新任何界面状态。
    renderSaveStatus(status, 'warn', `页面已切换，本次保存结果未显示（目标：${target.org.name} / ${target.code}）`);
    log('stale', `保存结果属于 ${target.org.name} / ${target.code}，页面已切走，未更新界面`);
    return;
  }

  const result = outcome.value;
  if (!result.ok) {
    renderSaveStatus(status, 'danger', `未保存：${errorText(result)}`);
    log('error', `保存被拒绝：${errorText(result)}`);
    if (result.status === 401 || result.status === 403) renderDenied(result);
    return;
  }

  // 保存响应必须来自发起保存时的那个组织。
  if (result.data.organization.id !== target.organizationId) {
    renderSaveStatus(status, 'warn', '返回组织不匹配，已忽略');
    log('stale', '保存响应组织不匹配，已忽略');
    return;
  }

  card.setSnapshot(result.data.customer.note);
  renderSaveStatus(status, 'ok', `已保存到 ${result.data.organization.name}`);
  log('ok', `已保存：${result.data.organization.name} 的 ${target.code} 备注`);
  await loadCustomerList({ silent: true });
}

// ---------- 导航与组织切换 -------------------------------------------------------------
function navigate(code, { replace = false } = {}) {
  if (!state.orgSlug) return;
  const path = buildPath(state.orgSlug, code);
  if (window.location.pathname === path) {
    loadCustomer({ reason: '同地址重新读取' });
    return;
  }
  if (replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  applyLocationAndLoad();
}

function switchOrganization(orgSlug) {
  if (!orgSlug || orgSlug === state.orgSlug) return;
  const target = state.me?.organizations.find((org) => org.slug === orgSlug);
  if (!target) {
    log('error', '你没有该组织的权限');
    return;
  }
  // 立即让在途请求过期：旧组织的结果即使晚到也只会被判为 stale 并丢弃。
  readGate.invalidate();
  listGate.invalidate();
  writeGate.invalidate();
  log('info', `切换到「${target.name}」，已作废在途请求`);
  state.orgSlug = orgSlug;
  // 地址改变 → 该标签的组织上下文随之改变；其他标签的地址不受影响。
  window.history.pushState({}, '', buildPath(orgSlug, state.code));
  applyLocationAndLoad();
}

function applyLocationAndLoad() {
  const { orgSlug, code } = parseLocation();
  const previousOrgId = state.org?.id;
  state.orgSlug = orgSlug;
  state.code = code;
  state.org = state.me?.organizations.find((org) => org.slug === orgSlug) || null;

  if (orgSlug) rememberOrg(orgSlug);
  renderOrgSwitch();
  renderIdentity();
  lastBlocked = blockedStateOf(state.me); // 地址可能指向无权组织，同步给轮询基线

  if (!state.me) {
    renderDenied({ status: 401, data: { error: { message: '请先登录后再查看客户' } } });
    return;
  }
  if (!orgSlug) {
    redirectToDefaultOrg();
    return;
  }
  if (!state.org) {
    // 地址里的组织不在当前账号的可访问范围内。
    log('error', `「${orgSlug}」不在你的可访问组织内`);
    renderDenied({
      status: 403,
      data: { error: { message: `你没有「${orgSlug}」的访问权限` } },
    });
    return;
  }

  if (previousOrgId !== state.org.id) {
    els.customerList.replaceChildren();
    renderPlaceholder(`正在加载「${state.org.name}」的客户…`);
  }
  loadCustomer({ reason: '打开地址' });
}

function redirectToDefaultOrg() {
  if (!state.me) {
    renderPlaceholder('当前账号没有任何组织权限。');
    return;
  }
  const candidates = [state.me.organizations[0]?.slug, lastOrgSlug()].filter(Boolean);
  const fallback = candidates.find((slug) =>
    state.me.organizations.some((org) => org.slug === slug),
  );
  if (!fallback) {
    renderPlaceholder('当前账号没有任何组织权限。');
    return;
  }
  window.history.replaceState({}, '', buildPath(fallback, state.code || null));
  applyLocationAndLoad();
}

window.addEventListener('popstate', () => {
  // 浏览器前进/后退同样以地址为准；先让在途请求过期。
  readGate.invalidate();
  listGate.invalidate();
  writeGate.invalidate();
  applyLocationAndLoad();
});

// 轮询而不是只靠 focus：自动化环境不一定派发 focus，且页面已聚焦时 focus 不会再触发。
const PERMISSION_POLL_MS = 4000;
let lastBlocked = null; // null = 还没检查过；'ok' | 'no-login' | 'no-org'

async function checkPermissions() {
  const result = await fetchMe();
  // 网络抖动不等于失去权限：忽略这一次，等下一轮再判断。
  if (result.status === 'offline') return;

  state.me = result.status === 'ok' ? result.me : null;
  const me = state.me;
  const blocked = blockedStateOf(me);
  const previous = lastBlocked;
  lastBlocked = blocked;
  const org = me?.organizations.find((o) => o.slug === state.orgSlug) || null;

  if (blocked === 'ok') {
    state.org = org;
    // 权限恢复：按当前地址重新加载。
    if (previous === 'no-login' || previous === 'no-org') {
      renderIdentity();
      renderOrgSwitch();
      applyLocationAndLoad();
    }
    return;
  }

  if (previous === blocked) return; // 已经提示过，且状态没变化

  // 失去登录态或组织权限：作废在途请求，停止把任何旧结果写进页面。
  readGate.cancel();
  listGate.cancel();
  writeGate.cancel();
  state.org = null;
  renderIdentity();
  renderOrgSwitch();
  if (blocked === 'no-login') {
    renderDenied({ status: 401, data: { error: { message: '登录已失效' } } });
    return;
  }
  log('error', '该组织的权限已被收回');
  renderDenied({
    status: 403,
    data: { error: { message: `「${state.orgSlug}」的权限已被收回` } },
  });
}

window.addEventListener('focus', checkPermissions);
setInterval(checkPermissions, PERMISSION_POLL_MS);

els.clearLog.addEventListener('click', () => {
  els.log.replaceChildren();
});

// ---------- 启动 --------------------------------------------------------------------
function blockedStateOf(me) {
  if (!me) return 'no-login';
  if (state.orgSlug && !me.organizations.some((org) => org.slug === state.orgSlug)) {
    return 'no-org';
  }
  return 'ok';
}

(async function boot() {
  const { orgSlug } = parseLocation();
  const result = await fetchMe();
  if (result.status === 'offline') {
    renderPlaceholder('无法连接本地服务，请确认 `npm start` 正在运行后刷新。', 'error');
    return;
  }
  state.me = result.status === 'ok' ? result.me : null;
  lastBlocked = blockedStateOf(state.me); // boot 自己会渲染首屏，轮询只需关注后续变化
  if (!orgSlug) {
    if (!state.me) {
      renderIdentity();
      renderDenied({ status: 401, data: { error: { message: '请先登录后再查看客户' } } });
      return;
    }
    redirectToDefaultOrg();
    return;
  }
  applyLocationAndLoad();
})();
