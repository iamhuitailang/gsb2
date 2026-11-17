// 标签页级控制器：一个实例 == 一个浏览器标签页。
// 它只知道「本标签当前的路径」，组织上下文完全由路径派生；
// 两个实例共享同一个浏览器 Cookie（同一客服账号），但状态互不影响。
//
// 该模块不依赖 DOM，浏览器页面与 Node 测试使用同一份实现。

import { createScopedReader, belongsToOrg } from './request-gate.js';

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'UNKNOWN', body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function createApi({ fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));

  async function request(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await doFetch(path, {
        method,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new ApiError('网络异常，请稍后重试', { status: 0, code: 'NETWORK_ERROR' });
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new ApiError(payload?.error?.message || `请求失败（HTTP ${response.status}）`, {
        status: response.status,
        code: payload?.error?.code || 'HTTP_ERROR',
        body: payload,
      });
    }
    return payload;
  }

  const customerUrl = (orgId, customerNo, delayMs) => {
    const base = `/api/orgs/${encodeURIComponent(orgId)}/customers/${encodeURIComponent(customerNo)}`;
    return delayMs > 0 ? `${base}?delayMs=${delayMs}` : base;
  };

  return {
    request,
    session: () => request('/api/session'),
    login: (userId) => request('/api/login', { method: 'POST', body: { userId } }),
    logout: () => request('/api/logout', { method: 'POST', body: {} }),
    listCustomers: (orgId) => request(`/api/orgs/${encodeURIComponent(orgId)}/customers`),
    customer: (orgId, customerNo, { delayMs = 0 } = {}) => request(customerUrl(orgId, customerNo, delayMs)),
    saveRemark: (orgId, customerNo, { remark, expectedVersion }) =>
      request(`/api/orgs/${encodeURIComponent(orgId)}/customers/${encodeURIComponent(customerNo)}/remark`, {
        method: 'PUT',
        body: { remark, expectedVersion },
      }),
    demoMembership: (payload) => request('/api/demo/membership', { method: 'POST', body: payload }),
    demoReset: () => request('/api/demo/reset', { method: 'POST', body: {} }),
  };
}

export function parseRoute(pathname) {
  const clean = pathname.split('?')[0];
  const customerMatch = clean.match(/^\/o\/([^/]+)\/customers\/([^/]+)\/?$/);
  if (customerMatch) {
    return {
      kind: 'customer',
      orgId: decodeURIComponent(customerMatch[1]),
      customerNo: decodeURIComponent(customerMatch[2]),
    };
  }
  const orgMatch = clean.match(/^\/o\/([^/]+)\/?$/);
  if (orgMatch) return { kind: 'org', orgId: decodeURIComponent(orgMatch[1]) };
  return { kind: 'home' };
}

export function customerPath(orgId, customerNo) {
  return `/o/${encodeURIComponent(orgId)}/customers/${encodeURIComponent(customerNo)}`;
}

export function orgPath(orgId) {
  return `/o/${encodeURIComponent(orgId)}`;
}

/**
 * @param {{
 *   api?: ReturnType<typeof createApi>,
 *   fetchImpl?: typeof fetch,
 *   path?: string,
 *   onChange?: () => void,
 *   delayProvider?: () => number,
 * }} options
 */
export function createTabController({ api, fetchImpl, path = '/', onChange = () => {}, delayProvider } = {}) {
  const client = api || createApi({ fetchImpl });

  const reader = createScopedReader({
    buildUrl: ({ orgId, customerNo, delayMs }) => {
      const base = `/api/orgs/${encodeURIComponent(orgId)}/customers/${encodeURIComponent(customerNo)}`;
      return delayMs > 0 ? `${base}?delayMs=${delayMs}` : base;
    },
    isExpectedOrg: belongsToOrg,
    fetchImpl,
  });

  const state = {
    path,
    route: parseRoute(path),
    session: { user: null, orgs: [], demoUsers: [], demo: false },
    // 详情读取状态
    load: 'idle', // idle | loading | ready | error
    loadError: null,
    customer: null,
    orgList: null,
    orgName: null,
    // 编辑状态
    draft: '',
    dirty: false,
    save: 'idle', // idle | saving | saved | error | denied
    saveError: null,
    notice: null,
  };

  // 每次切换路径自增。所有异步结果回到页面之前都要核对它，
  // 确保「旧组织的慢响应」不会写进「新组织的页面」。
  let routeEpoch = 0;
  let noticeTimer = null;

  const emit = () => onChange(state);
  const currentRoute = () => state.route;

  function setNotice(notice, { autoClearMs = 8000 } = {}) {
    state.notice = notice;
    if (noticeTimer) clearTimeout(noticeTimer);
    if (notice && autoClearMs > 0) {
      noticeTimer = setTimeout(() => {
        state.notice = null;
        emit();
      }, autoClearMs);
      if (typeof noticeTimer.unref === 'function') noticeTimer.unref();
    }
    emit();
  }

  function applyPath(nextPath, { silent = false } = {}) {
    const route = parseRoute(nextPath);
    state.path = nextPath;
    state.route = route;
    state.loadError = null;
    state.saveError = null;
    state.save = 'idle';
    state.dirty = false;
    state.draft = '';
    state.customer = null;
    state.orgList = null;
    state.orgName = null;
    state.load = route.kind === 'customer' ? 'loading' : 'idle';
    routeEpoch += 1;
    reader.reset(); // 与本标签旧路径相关的在途读取一律作废
    if (!silent) emit();
    if (route.kind === 'customer') return loadCustomer(route, routeEpoch);
    if (route.kind === 'org') return loadOrgList();
    return Promise.resolve(state);
  }

  async function loadCustomer(route, epoch) {
    const delayMs = delayProvider ? delayProvider() : 0;
    const result = await reader.load({ orgId: route.orgId, customerNo: route.customerNo, delayMs });

    // 三个条件任一不满足就丢弃结果：已被更新的请求取代 / 本标签已换路径 / 响应属于别的组织。
    if (epoch !== routeEpoch) return state;
    if (result.outcome === 'stale' || result.outcome === 'mismatch') return state;

    if (result.outcome === 'ok') {
      const body = result.body;
      if (body.org.id !== route.orgId || body.customer.localCustomerNo !== route.customerNo) {
        return state;
      }
      state.customer = { ...body.customer, orgName: body.org.name };
      state.draft = body.customer.remark ?? '';
      state.dirty = false;
      state.save = 'idle';
      state.load = 'ready';
      emit();
      return state;
    }

    state.load = 'error';
    state.loadError = new ApiError(
      result.body?.error?.message || (result.outcome === 'network-error' ? '网络异常，读取失败' : '读取失败'),
      { status: result.status ?? 0, code: result.body?.error?.code, body: result.body },
    );
    state.customer = null;
    emit();
    return state;
  }

  async function bootstrap() {
    try {
      state.session = await client.session();
    } catch (error) {
      state.session = { user: null, orgs: [], demoUsers: [], demo: false };
      state.notice = { kind: 'error', text: error.message };
    }
    emit();
    return state.session;
  }

  async function login(userId) {
    const result = await client.login(userId);
    state.session = { ...state.session, user: result.user, orgs: result.orgs };
    emit();
    return result;
  }

  async function logout() {
    await client.logout();
    state.session = { user: null, orgs: [] };
    emit();
  }

  function setDraft(value, { silent = false } = {}) {
    state.draft = value;
    state.dirty = value !== (state.customer?.remark ?? '');
    if (state.save === 'saved' || state.save === 'error') state.save = 'idle';
    state.saveError = null;
    if (!silent) emit();
    return state;
  }

  function revertDraft() {
    state.draft = state.customer?.remark ?? '';
    state.dirty = false;
    state.save = 'idle';
    state.saveError = null;
    emit();
  }

  async function saveRemark() {
    const route = currentRoute();
    if (route.kind !== 'customer' || !state.customer) return state;
    const epoch = routeEpoch;
    const draft = state.draft;

    state.save = 'saving';
    state.saveError = null;
    emit();

    try {
      const result = await client.saveRemark(route.orgId, route.customerNo, {
        remark: draft,
        expectedVersion: state.customer.version,
      });
      // 写入返回时若本标签已经切到别的组织/客户，就只丢弃渲染，不污染新页面。
      if (epoch !== routeEpoch) return state;
      state.customer = { ...state.customer, ...result.customer, orgName: result.org.name };
      state.draft = result.customer.remark;
      state.dirty = false;
      state.save = 'saved';
      emit();
      return state;
    } catch (error) {
      if (epoch !== routeEpoch) return state;
      state.saveError = error.message;
      if (error.status === 403) {
        // 失去权限：明确拒绝并锁住表单；草稿保留在界面上，但不会写入任何组织。
        state.save = 'denied';
        emit();
        return state;
      }
      if (error.status === 401) {
        state.session = { ...state.session, user: null, orgs: [] };
        state.save = 'error';
        emit();
        return state;
      }
      state.save = 'error';
      emit();
      return state;
    }
  }

  async function refresh() {
    return applyPath(state.path);
  }

  async function loadOrgList() {
    const route = currentRoute();
    if (route.kind !== 'org') return null;
    // 与详情读取共用 routeEpoch：本标签一换路径，列表结果同样作废，不会刷到别的组织页面上。
    const epoch = routeEpoch;
    state.load = 'loading';
    state.loadError = null;
    emit();
    try {
      const data = await client.listCustomers(route.orgId);
      if (epoch !== routeEpoch) return null;
      if (data.org?.id !== route.orgId) return null;
      state.orgList = data.customers;
      state.orgName = data.org.name;
      state.load = 'ready';
      emit();
      return data;
    } catch (error) {
      if (epoch !== routeEpoch) return null;
      state.load = 'error';
      state.loadError = error;
      emit();
      return null;
    }
  }

  return {
    state,
    client,
    applyPath,
    bootstrap,
    login,
    logout,
    refresh,
    setDraft,
    revertDraft,
    saveRemark,
    loadOrgList,
    setNotice,
    get path() {
      return state.path;
    },
  };
}
