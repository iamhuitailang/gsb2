const state = {
  accountId: null,
  me: null,
  allSites: [],
  statuses: [],
  jobs: [],
  accounts: [],
  selection: { siteIds: new Set(), statuses: new Set(), columns: new Set() },
  search: '',
  pollTimer: null,
  heartbeatTimer: null,
  searchTimer: null,
  lastPermissionVersion: null,
  busy: false,
};

const $ = (selector) => document.querySelector(selector);

const els = {
  accountSelect: $('#account-select'),
  accountSummary: $('#account-summary'),
  reset: $('#reset-demo'),
  flash: $('#flash'),
  ordersTable: $('#orders-table'),
  orderCount: $('#order-count'),
  exportForm: $('#export-form'),
  siteOptions: $('#site-options'),
  statusOptions: $('#status-options'),
  searchInput: $('#search-input'),
  columnOptions: $('#column-options'),
  columnHint: $('#column-hint'),
  previewButton: $('#preview-button'),
  previewWrap: $('#preview-wrap'),
  previewSummary: $('#preview-summary'),
  previewTable: $('#preview-table'),
  jobsList: $('#jobs-list'),
  refreshJobs: $('#refresh-jobs'),
  adminPanel: $('#admin-panel'),
  adminUsers: $('#admin-users'),
};

class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message ?? `请求失败（${status}）`);
    this.status = status;
    this.payload = payload;
  }
}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {};
  if (state.accountId) headers['X-User-Id'] = state.accountId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });

  if (raw) return response;

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  node.replaceChildren();
}

function formatTime(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function formatBytes(size) {
  if (!Number.isFinite(size)) return '—';
  if (size < 1024) return `${size} B`;
  return `${(size / 1024).toFixed(1)} KB`;
}

function showFlash(message, tone = 'warn', timeout = 6000) {
  els.flash.textContent = message;
  els.flash.dataset.tone = tone;
  els.flash.hidden = false;
  clearTimeout(showFlash.timer);
  if (timeout > 0) {
    showFlash.timer = setTimeout(() => {
      els.flash.hidden = true;
    }, timeout);
  }
}

function collectFilters() {
  return {
    siteIds: [...state.selection.siteIds],
    statuses: [...state.selection.statuses],
    q: state.search.trim(),
  };
}

function collectColumns() {
  return [...state.selection.columns];
}

/** 默认勾选的列：日常使用的订单号和状态；没有时退回全部可见列。 */
function defaultColumns(allowedKeys) {
  const daily = allowedKeys.filter((key) => key === 'order_no' || key === 'status');
  return new Set(daily.length > 0 ? daily : allowedKeys);
}

/** 账号或权限变化后，把选择重置为「当前全部可访问站点 + 日常使用的订单号/状态列」。 */
function resetSelectionToAllowed() {
  const allowedColumns = state.me.fields.filter((field) => field.allowed).map((field) => field.key);

  state.selection.siteIds = new Set(state.me.sites.map((site) => site.id));
  state.selection.statuses = new Set();
  // 默认只勾选订单号和状态；联系人等敏感列由用户显式勾选。
  state.selection.columns = defaultColumns(allowedColumns);
  state.search = '';
  els.searchInput.value = '';
}

/** 权限收紧时，把已经不可用的选项从当前选择里剔除，避免继续提交无权内容。 */
function pruneSelection() {
  const allowedSites = new Set(state.me.sites.map((site) => site.id));
  const allowedColumns = new Set(state.me.fields.filter((field) => field.allowed).map((field) => field.key));
  let removed = 0;

  for (const siteId of [...state.selection.siteIds]) {
    if (!allowedSites.has(siteId)) {
      state.selection.siteIds.delete(siteId);
      removed += 1;
    }
  }
  for (const key of [...state.selection.columns]) {
    if (!allowedColumns.has(key)) {
      state.selection.columns.delete(key);
      removed += 1;
    }
  }

  // 只有确实被收回了选项，且选择被清空时，才回落到当前可用范围；
  // 用户主动取消全部勾选时保持原样，不擅自替用户改选择。
  if (removed === 0) return;
  if (state.selection.siteIds.size === 0 && allowedSites.size > 0) {
    state.selection.siteIds = new Set(allowedSites);
  }
  if (state.selection.columns.size === 0) {
    state.selection.columns = defaultColumns([...allowedColumns]);
  }
}

function renderAccountSummary() {
  clear(els.accountSummary);
  const me = state.me;
  if (!me) return;

  const allowedSiteIds = new Set(me.sites.map((site) => site.id));
  const tags = [
    ...me.sites.map((site) => el('span', { class: 'tag tag-ok', text: `站点：${site.name}` })),
    ...state.allSites
      .filter((site) => !allowedSiteIds.has(site.id))
      .map((site) => el('span', { class: 'tag', text: `无权：${site.name}` })),
  ];

  const contactAllowed = me.fields.some((field) => field.key === 'contact_name' && field.allowed);
  tags.push(
    contactAllowed
      ? el('span', { class: 'tag tag-ok', text: '联系人字段：可见' })
      : el('span', { class: 'tag tag-warn', text: '联系人字段：不可见' }),
    el('span', { class: 'tag', text: `权限版本 v${me.permissionVersion}` }),
  );

  if (me.canAdmin) tags.push(el('span', { class: 'tag tag-ok', text: '可管理账号权限' }));
  els.accountSummary.append(...tags);
}

function renderSiteOptions() {
  const allowedIds = new Set(state.me.sites.map((site) => site.id));
  clear(els.siteOptions);

  for (const site of state.allSites) {
    const allowed = allowedIds.has(site.id);
    const input = el('input', {
      type: 'checkbox',
      name: 'site',
      value: site.id,
      checked: allowed && state.selection.siteIds.has(site.id),
      disabled: !allowed,
    });
    if (!allowed) input.disabled = true;

    els.siteOptions.append(
      el('label', { class: `option${allowed ? '' : ' is-disabled'}` }, [
        input,
        el('span', { text: site.name }),
        allowed ? null : el('span', { class: 'option-note', text: '无权限' }),
      ]),
    );
  }
}

function renderStatusOptions() {
  clear(els.statusOptions);
  for (const status of state.statuses) {
    const input = el('input', {
      type: 'checkbox',
      name: 'status',
      value: status,
      checked: state.selection.statuses.has(status),
    });
    els.statusOptions.append(el('label', { class: 'option' }, [input, el('span', { text: status })]));
  }
}

function renderColumnOptions() {
  const me = state.me;
  clear(els.columnOptions);

  let deniedCount = 0;
  for (const field of me.fields) {
    if (!field.allowed) deniedCount += 1;

    const input = el('input', {
      type: 'checkbox',
      name: 'column',
      value: field.key,
      checked: field.allowed && state.selection.columns.has(field.key),
      disabled: !field.allowed,
    });
    if (!field.allowed) input.disabled = true;

    els.columnOptions.append(
      el('label', { class: `option${field.allowed ? '' : ' is-disabled'}` }, [
        input,
        el('span', { text: field.label }),
        field.allowed ? null : el('span', { class: 'option-note', text: '需额外权限' }),
      ]),
    );
  }

  els.columnHint.textContent =
    deniedCount > 0
      ? `灰掉的 ${deniedCount} 列是当前账号无权查看的字段；页面、预览和 CSV 使用同一套判断。`
      : '当前账号可查看全部字段。';
}

function renderOrdersTable(orders, columns) {
  const thead = els.ordersTable.querySelector('thead');
  const tbody = els.ordersTable.querySelector('tbody');
  clear(thead);
  clear(tbody);

  const headerRow = el('tr');
  for (const column of columns) headerRow.append(el('th', { scope: 'col', text: column.label }));
  thead.append(headerRow);

  if (orders.length === 0) {
    const cell = el('td', {
      colspan: String(columns.length || 1),
      text: '当前筛选条件下没有可查看的订单。',
    });
    tbody.append(el('tr', { class: 'empty-row' }, [cell]));
  } else {
    for (const order of orders) {
      const row = el('tr');
      for (const column of columns) row.append(el('td', { text: order[column.key] ?? '' }));
      tbody.append(row);
    }
  }

  els.orderCount.textContent = `${orders.length} 条`;
}

async function loadOrders() {
  const params = new URLSearchParams();
  for (const siteId of state.selection.siteIds) params.append('siteIds', siteId);
  for (const status of state.selection.statuses) params.append('statuses', status);
  if (state.search.trim()) params.set('q', state.search.trim());

  if (state.selection.siteIds.size === 0) {
    renderOrdersTable([], [{ key: 'empty', label: '订单' }]);
    return;
  }

  try {
    const data = await api(`/api/orders?${params.toString()}`);
    renderOrdersTable(data.orders, data.columns);
  } catch (error) {
    renderOrdersTable([], [{ key: 'empty', label: '订单' }]);
    handleApiError(error, '加载订单失败');
  }
}

function renderPreview(preview) {
  els.previewWrap.hidden = false;
  els.previewSummary.textContent = preview.truncated
    ? `共 ${preview.total} 行，预览前 ${preview.rows.length} 行`
    : `共 ${preview.total} 行`;

  const thead = els.previewTable.querySelector('thead');
  const tbody = els.previewTable.querySelector('tbody');
  clear(thead);
  clear(tbody);

  const headerRow = el('tr');
  for (const column of preview.columns) headerRow.append(el('th', { scope: 'col', text: column.label }));
  thead.append(headerRow);

  if (preview.rows.length === 0) {
    tbody.append(
      el('tr', { class: 'empty-row' }, [
        el('td', { colspan: String(preview.columns.length || 1), text: '没有符合条件的订单。' }),
      ]),
    );
    return;
  }

  for (const row of preview.rows) {
    const tr = el('tr');
    for (const column of preview.columns) tr.append(el('td', { text: row[column.key] ?? '' }));
    tbody.append(tr);
  }
}

function hidePreview() {
  els.previewWrap.hidden = true;
}

function validateForm() {
  if (state.selection.siteIds.size === 0) {
    showFlash('请至少选择一个站点。', 'danger');
    return false;
  }
  if (state.selection.columns.size === 0) {
    showFlash('请至少选择一列。', 'danger');
    return false;
  }
  return true;
}

async function handlePreview() {
  if (!validateForm()) return;

  els.previewButton.disabled = true;
  try {
    const preview = await api('/api/exports/preview', {
      method: 'POST',
      body: { ...collectFilters(), columns: collectColumns() },
    });
    renderPreview(preview);
    showFlash('预览使用与页面、CSV 相同的字段权限判断。', 'ok', 3500);
  } catch (error) {
    hidePreview();
    handleApiError(error, '预览失败');
  } finally {
    els.previewButton.disabled = false;
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  if (state.busy || !validateForm()) return;

  state.busy = true;
  const submit = els.exportForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const data = await api('/api/exports', {
      method: 'POST',
      body: { ...collectFilters(), columns: collectColumns() },
    });
    const siteNames = data.job.snapshot.sites.map((site) => site.name).join('、');
    showFlash(
      `导出任务已排队：${siteNames} · ${data.job.snapshot.columns.length} 列。筛选条件和列已固定，执行时会再次核对权限。`,
      'ok',
    );
    hidePreview();
    await loadJobs();
  } catch (error) {
    handleApiError(error, '排队导出失败');
  } finally {
    state.busy = false;
    submit.disabled = false;
  }
}

/**
 * 只把当前仍可用的站点和列填回表单，不会自动提交，
 * 避免在权限变化时替用户做决定。
 */
function reapplyFromJob(job) {
  const allowedSites = new Set(state.me.sites.map((site) => site.id));
  const allowedColumns = new Set(state.me.fields.filter((field) => field.allowed).map((field) => field.key));

  const sites = job.snapshot.sites.map((site) => site.id).filter((id) => allowedSites.has(id));
  const columns = job.snapshot.columns.map((column) => column.key).filter((key) => allowedColumns.has(key));
  const removedSites = job.snapshot.sites.filter((site) => !allowedSites.has(site.id)).map((site) => site.name);
  const removedColumns = job.snapshot.columns
    .filter((column) => !allowedColumns.has(column.key))
    .map((column) => column.label);

  state.selection.siteIds = new Set(sites);
  state.selection.columns = new Set(columns);
  state.selection.statuses = new Set(
    job.snapshot.statuses.filter((status) => state.statuses.includes(status)),
  );
  // 原条件里的站点或列全被收回时，回落到当前可用范围，避免提交一个空选择。
  if (state.selection.siteIds.size === 0) {
    state.selection.siteIds = new Set(allowedSites);
  }
  if (state.selection.columns.size === 0) {
    state.selection.columns = defaultColumns([...allowedColumns]);
  }
  state.search = job.snapshot.q ?? '';
  els.searchInput.value = state.search;

  renderSiteOptions();
  renderStatusOptions();
  renderColumnOptions();
  hidePreview();
  loadOrders().catch(() => {});

  const removed = [
    removedSites.length > 0 ? `站点 ${removedSites.join('、')}` : null,
    removedColumns.length > 0 ? `列 ${removedColumns.join('、')}` : null,
  ].filter(Boolean);

  showFlash(
    removed.length > 0
      ? `已按你当前的权限范围填入可用项，已去除：${removed.join('；')}。请确认后重新提交导出。`
      : '已按原条件填入表单，请确认后重新提交导出。',
    'warn',
    9000,
  );

  els.exportForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function jobNote(job) {
  if (job.status === 'failed') {
    return el('p', { class: 'job-note is-danger', text: job.error?.message ?? '任务失败，请按当前范围重新申请。' });
  }
  if (job.status === 'invalidated') {
    const text =
      job.file?.invalidReason === 'permission_changed'
        ? '权限已变更，旧文件已失效，不能从原地址取回。请按当前范围重新申请导出。'
        : job.error?.message ?? '该文件已失效，请按当前范围重新申请导出。';
    return el('p', { class: 'job-note is-danger', text });
  }
  if (job.status === 'ready' && job.file && !job.file.downloadable) {
    return el('p', {
      class: 'job-note is-warn',
      text: '该文件超出你当前的站点或字段权限，不能下载。请按当前范围重新申请导出。',
    });
  }
  if (job.status === 'ready' && job.file) {
    return el('p', {
      class: 'job-note',
      text: `生成于 ${formatTime(job.file.createdAt)} · ${job.file.rowCount} 行 · ${formatBytes(
        job.file.byteSize,
      )} · 仅申请人可下载。`,
    });
  }
  return el('p', { class: 'job-note', text: '排队中，执行时会重新核对站点与列权限。' });
}

function renderJobs() {
  clear(els.jobsList);

  if (state.jobs.length === 0) {
    els.jobsList.append(el('li', { class: 'empty-state', text: '还没有导出任务。选择站点和列后排队导出。' }));
    return;
  }

  for (const job of state.jobs) {
    const snapshot = el('div', { class: 'job-snapshot' }, [
      el('div', {}, [el('strong', { text: '站点：' }), job.snapshot.sites.map((site) => site.name).join('、')]),
      el('div', {}, [el('strong', { text: '列：' }), job.snapshot.columns.map((column) => column.label).join('、')]),
      el('div', {}, [
        el('strong', { text: '筛选：' }),
        `${job.snapshot.statuses.length > 0 ? job.snapshot.statuses.join('、') : '全部状态'}${
          job.snapshot.q ? ` · 搜索“${job.snapshot.q}”` : ''
        }`,
      ]),
    ]);

    const head = el('div', { class: 'job-head' }, [
      el('div', { class: 'job-title' }, [
        el('span', { class: `status-dot status-${job.status}`, 'aria-hidden': 'true' }),
        el('span', { text: job.statusLabel }),
        el('span', { class: 'mono', text: job.id.slice(0, 8) }),
      ]),
      el('span', { class: 'pill', text: formatTime(job.createdAt) }),
    ]);

    const meta = el('div', { class: 'job-meta' }, [
      el('span', { text: `申请时权限版本 v${job.queuedPermissionVersion}` }),
      job.file ? el('span', { text: `文件权限版本 v${job.file.permissionVersion}` }) : null,
    ]);

    const actions = el('div', { class: 'actions' });
    if (job.status === 'ready' && job.file?.downloadable) {
      actions.append(
        el('button', {
          type: 'button',
          class: 'btn btn-primary',
          text: '下载 CSV',
          onClick: () => downloadJob(job),
        }),
      );
    }
    if (job.needsReapply) {
      actions.append(
        el('button', {
          type: 'button',
          class: 'btn btn-secondary',
          text: '按当前范围重新申请',
          onClick: () => reapplyFromJob(job),
        }),
      );
    }

    const foot = el('div', { class: 'job-foot' }, [jobNote(job)]);
    if (actions.childElementCount > 0) foot.append(actions);

    els.jobsList.append(el('li', { class: 'job' }, [head, meta, snapshot, foot]));
  }
}

async function downloadJob(job) {
  try {
    const response = await api(`/api/exports/${job.id}/download`, { raw: true });
    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      handleApiError(new ApiError(response.status, payload), '下载失败');
      await loadJobs();
      return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: job.file?.filename ?? 'orders.csv' });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showFlash('CSV 已开始下载。', 'ok', 3500);
  } catch (error) {
    handleApiError(error, '下载失败');
  }
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  const pending = state.jobs.some((job) => job.status === 'queued' || job.status === 'running');
  if (!pending) return;
  state.pollTimer = setTimeout(() => {
    loadJobs().catch(() => {});
  }, 700);
}

async function loadJobs() {
  const data = await api('/api/exports');
  state.jobs = data.jobs;
  renderJobs();
  schedulePoll();
}

function renderAdmin(users) {
  clear(els.adminUsers);

  for (const user of users) {
    const siteBoxes = state.allSites.map((site) => {
      const input = el('input', { type: 'checkbox', value: site.id, checked: user.sites.includes(site.id) });
      return { input, node: el('label', { class: 'option' }, [input, el('span', { text: site.name })]) };
    });

    const contactBox = el('input', {
      type: 'checkbox',
      value: 'contact:read',
      checked: user.permissions.includes('contact:read'),
    });
    const adminBox = el('input', {
      type: 'checkbox',
      value: 'admin:users',
      checked: user.permissions.includes('admin:users'),
    });

    const save = el('button', {
      type: 'button',
      class: 'btn btn-secondary',
      text: '保存权限',
      onClick: async () => {
        const sites = siteBoxes.filter((box) => box.input.checked).map((box) => box.input.value);
        const permissions = [];
        if (contactBox.checked) permissions.push('contact:read');
        if (adminBox.checked) permissions.push('admin:users');

        save.disabled = true;
        try {
          const result = await api(`/api/admin/users/${user.id}/access`, {
            method: 'POST',
            body: { sites, permissions },
          });
          if (!result.changed) {
            showFlash('权限未变化。', 'ok', 3500);
          } else {
            showFlash(
              `已更新 ${user.name} 的权限，${result.invalidatedJobs} 个已生成文件立即失效，原下载地址不能再次取回。`,
              'warn',
              9000,
            );
          }
          await refreshAfterAccessChange();
        } catch (error) {
          handleApiError(error, '保存权限失败');
        } finally {
          save.disabled = false;
        }
      },
    });

    els.adminUsers.append(
      el('div', { class: 'admin-card' }, [
        el('div', { class: 'admin-card-head' }, [
          el('h4', { text: user.name }),
          el('span', { class: 'pill', text: `v${user.permissionVersion}` }),
        ]),
        el('div', { class: 'admin-group' }, [
          el('span', { class: 'admin-group-title', text: '站点范围' }),
          el('div', { class: 'option-row' }, siteBoxes.map((box) => box.node)),
        ]),
        el('div', { class: 'admin-group' }, [
          el('span', { class: 'admin-group-title', text: '额外权限' }),
          el('div', { class: 'option-row' }, [
            el('label', { class: 'option' }, [contactBox, el('span', { text: '导出联系人字段' })]),
            el('label', { class: 'option' }, [adminBox, el('span', { text: '账号权限管理' })]),
          ]),
        ]),
        el('div', { class: 'admin-foot' }, [save]),
      ]),
    );
  }
}

async function loadAdmin() {
  if (!state.me?.canAdmin) {
    els.adminPanel.hidden = true;
    return;
  }
  try {
    const data = await api('/api/admin/users');
    els.adminPanel.hidden = false;
    renderAdmin(data.users);
  } catch (error) {
    els.adminPanel.hidden = true;
    handleApiError(error, '加载账号权限失败');
  }
}

/**
 * 重新读取当前账号权限。返回 true 表示权限版本发生变化。
 * 权限收紧时直接剔除已不可用的选择；权限放宽时保留现有选择。
 */
async function loadMe({ silent = false, keepSelection = false } = {}) {
  const data = await api('/api/me');
  const previousVersion = state.lastPermissionVersion;
  const versionChanged = previousVersion !== null && previousVersion !== data.user.permissionVersion;
  const needsRerender = !keepSelection || previousVersion === null || versionChanged;

  state.me = data.user;
  state.allSites = data.allSites;
  state.statuses = data.statuses;

  if (!keepSelection || previousVersion === null) {
    resetSelectionToAllowed();
  } else {
    pruneSelection();
  }

  state.lastPermissionVersion = data.user.permissionVersion;

  if (!silent && versionChanged) {
    showFlash(
      '账号权限已变更。页面、预览和导出都按当前权限范围重新计算；旧文件不能从原地址取回，请按当前范围重新申请。',
      'warn',
      9000,
    );
  }

  renderAccountSummary();
  if (needsRerender) {
    renderSiteOptions();
    renderStatusOptions();
    renderColumnOptions();
    hidePreview();
  }
  return versionChanged;
}

async function refreshAfterAccessChange() {
  await loadMe({ silent: true, keepSelection: true });
  await Promise.all([loadOrders(), loadJobs(), loadAdmin()]);
}

/**
 * 其他标签页或管理员改动权限后，当前页也能及时感知：
 * 刷新可访问范围，并让已有文件按新权限重新判断。
 */
function startHeartbeat() {
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = setInterval(async () => {
    if (document.hidden || state.busy) return;
    try {
      const changed = await loadMe({ silent: false, keepSelection: true });
      if (changed) {
        await Promise.all([loadOrders(), loadJobs(), loadAdmin()]);
      } else {
        await loadJobs();
      }
    } catch {
      // 轮询失败不打断页面使用
    }
  }, 8000);
}

function handleApiError(error, prefix) {
  if (error instanceof ApiError) {
    const code = error.payload?.error?.code ?? '';
    const needsReapply = [
      'sites_forbidden',
      'columns_forbidden',
      'permission_changed',
      'export_invalidated',
    ].includes(code);
    const message = needsReapply ? `${error.message} 请按当前权限范围重新申请导出。` : error.message;
    showFlash(`${prefix}：${message}`, needsReapply ? 'warn' : 'danger', 9000);
    if (needsReapply) {
      loadMe({ silent: true, keepSelection: true })
        .then(() => Promise.all([loadOrders(), loadJobs()]))
        .catch(() => {});
    }
    return;
  }
  showFlash(`${prefix}：${error.message ?? '未知错误'}`, 'danger');
}

function onFilterChange() {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    hidePreview();
    loadOrders();
  }, 220);
}

async function switchAccount(accountId) {
  state.accountId = accountId;
  localStorage.setItem('gsb2.account', accountId);
  clearTimeout(state.pollTimer);
  state.jobs = [];
  state.lastPermissionVersion = null;
  try {
    await loadMe();
    await Promise.all([loadJobs(), loadAdmin()]);
    await loadOrders();
  } catch (error) {
    handleApiError(error, '切换账号失败');
  }
}

function bindEvents() {
  els.accountSelect.addEventListener('change', () => switchAccount(els.accountSelect.value));

  els.reset.addEventListener('click', async () => {
    try {
      await api('/api/demo/reset', { method: 'POST' });
      state.lastPermissionVersion = null;
      await loadMe();
      await Promise.all([loadOrders(), loadJobs(), loadAdmin()]);
      showFlash('演示数据已重置。', 'ok');
    } catch (error) {
      handleApiError(error, '重置失败');
    }
  });

  els.exportForm.addEventListener('submit', handleSubmit);
  els.previewButton.addEventListener('click', handlePreview);
  els.refreshJobs.addEventListener('click', () => {
    loadJobs().catch((error) => handleApiError(error, '刷新任务失败'));
  });

  els.searchInput.addEventListener('input', () => {
    state.search = els.searchInput.value;
    onFilterChange();
  });

  els.siteOptions.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'site' || input.disabled) return;
    if (input.checked) state.selection.siteIds.add(input.value);
    else state.selection.siteIds.delete(input.value);
    onFilterChange();
  });

  els.statusOptions.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'status') return;
    if (input.checked) state.selection.statuses.add(input.value);
    else state.selection.statuses.delete(input.value);
    onFilterChange();
  });

  els.columnOptions.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'column' || input.disabled) return;
    if (input.checked) state.selection.columns.add(input.value);
    else state.selection.columns.delete(input.value);
    hidePreview();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      loadMe({ silent: true, keepSelection: true })
        .then(() => Promise.all([loadOrders(), loadJobs()]))
        .catch(() => {});
    }
  });
}

async function init() {
  bindEvents();
  try {
    const data = await api('/api/demo/accounts');
    state.accounts = data.accounts;
    for (const account of state.accounts) {
      els.accountSelect.append(
        el('option', { value: account.id, text: `${account.name} · ${account.title}` }),
      );
    }

    const saved = localStorage.getItem('gsb2.account');
    const preferred = state.accounts.some((account) => account.id === saved) ? saved : 'agent-lin';
    state.accountId = preferred;
    els.accountSelect.value = preferred;

    await switchAccount(preferred);
    startHeartbeat();
  } catch (error) {
    handleApiError(error, '初始化失败');
  }
}

init();
