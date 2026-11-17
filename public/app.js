/* global window, document, fetch, localStorage */
'use strict';

const STORAGE_KEY = 'price-delegation-demo.user';
const POLL_MS = 4000;

const state = {
  userId: null,
  bootstrap: null,
  timer: null,
  review: null,
  busy: false,
  formDirty: false
};

const ACTIONS_LABEL = { view: '查看', approve: '审核通过', reject: '审核驳回' };
const STATUS_LABEL = {
  pending_acceptance: '待接受',
  scheduled: '未生效',
  active: '生效中',
  expired: '已到期',
  ended: '已结束',
  declined: '已拒绝',
  approved: '已通过',
  rejected: '已驳回',
  pending: '待审核'
};

/* --------------------------------------------------------------- utils -- */

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'hidden') node.hidden = !!value;
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children || [])) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtClock(ms) {
  return fmtTime(new Date(ms).toISOString());
}

function fmtMoney(value) {
  return `¥${Number(value).toFixed(2)}`;
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} 分钟`;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

function isoLocalValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function actionLabel(action) {
  return ACTIONS_LABEL[action] || action;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function toast(message, isError) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.toggle('is-error', !!isError);
  node.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

/* ---------------------------------------------------------------- api --- */

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const error = new Error(
      (payload && payload.error && payload.error.message) || `请求失败（${res.status}）`
    );
    error.status = res.status;
    error.code = payload && payload.error && payload.error.code;
    throw error;
  }
  return payload;
}

function currentUserId() {
  if (state.userId) return state.userId;
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) return saved;
  return null;
}

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

/* ------------------------------------------------------------- routing -- */

const ROUTES = [
  { pattern: /^\/$/, name: 'todos' },
  { pattern: /^\/delegations$/, name: 'delegations' },
  { pattern: /^\/demo$/, name: 'demo' },
  { pattern: /^\/applications\/([\w-]+)$/, name: 'review' }
];

function matchRoute(pathname) {
  for (const route of ROUTES) {
    const m = pathname.match(route.pattern);
    if (m) return { name: route.name, params: m.slice(1) };
  }
  return { name: 'notfound', params: [] };
}

function navigate(path) {
  const userId = currentUserId();
  const target = userId ? `${path}${path.includes('?') ? '&' : '?'}userId=${encodeURIComponent(userId)}` : path;
  if (window.location.pathname + window.location.search === target) return;
  window.history.pushState({}, '', target);
  render();
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-link]');
  if (!link) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  navigate(link.getAttribute('href'));
});

window.addEventListener('popstate', () => render());

/* ------------------------------------------------------------ bootstrap - */

async function load(userId) {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  try {
    state.bootstrap = await api('GET', `/api/bootstrap${query}`);
  } catch (error) {
    // localStorage 里可能残留已不存在的员工 id；回退到家列表的第一个。
    if (userId && error.status === 404 && error.code === 'USER_NOT_FOUND') {
      state.userId = null;
      localStorage.removeItem(STORAGE_KEY);
      state.bootstrap = await api('GET', '/api/bootstrap');
    } else {
      throw error;
    }
  }
  if (!state.bootstrap.currentUser && state.bootstrap.users.length > 0) {
    state.userId = state.bootstrap.users[0].id;
    localStorage.setItem(STORAGE_KEY, state.userId);
    await load(state.userId);
  }
}

async function refresh(options = {}) {
  // 轮询落在提交过程中时直接跳过；用户操作后的强制刷新不受影响。
  if (state.busy && !options.force) return;
  try {
    await load(currentUserId());
    paintChrome();
    const route = matchRoute(window.location.pathname);
    if (options.force) {
      await paintPage({ soft: true });
      return;
    }
    // 用户正在填写表单时不重绘，避免清空内容或打断光标。审核页例外，
    // 因为它需要持续提示“权限已失效”。
    const active = document.activeElement;
    const editing = !!active && typeof active.closest === 'function' && !!active.closest('form');
    if (state.formDirty || (editing && route.name !== 'review')) return;
    // 演示页里有时间输入框，轮询不重绘整页（顶栏时钟已更新）。
    if (route.name === 'demo') return;
    await paintPage({ soft: true });
  } catch (error) {
    console.error(error);
  }
}

/* --------------------------------------------------------------- chrome - */

function paintChrome() {
  const boot = state.bootstrap;
  if (!boot) return;

  const clockbar = document.getElementById('clockbar');
  document.getElementById('clock-now').textContent = fmtClock(boot.clock.now);
  const simulated = boot.clock.simulated;
  clockbar.classList.toggle('is-simulated', simulated);
  document.getElementById('clock-badge').hidden = !simulated;
  document.getElementById('clock-reset').hidden = !simulated;

  const switcher = document.getElementById('user-switch');
  // 只在身份列表或选中项变化时重建，避免轮询打断点击。
  const signature = boot.users.map((user) => `${user.id}:${user.name}:${user.title}`).join('|') +
    `#${boot.currentUser ? boot.currentUser.id : ''}`;
  if (switcher.dataset.signature !== signature) {
    switcher.dataset.signature = signature;
    clear(switcher);
    for (const user of boot.users) {
      const button = el(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(boot.currentUser && boot.currentUser.id === user.id),
          onclick: () => switchUser(user.id)
        },
        [user.name, el('small', null, user.title)]
      );
      switcher.append(button);
    }
  }

  const demoHint = document.getElementById('demo-clock-hint');
  if (demoHint) demoHint.textContent = `当前：${fmtClock(boot.clock.now)}`;

  const routeName = matchRoute(window.location.pathname).name;
  for (const link of document.querySelectorAll('#tabs a')) {
    if (link.dataset.tab === routeName) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function switchUser(userId) {
  state.userId = userId;
  localStorage.setItem(STORAGE_KEY, userId);
  const url = new URL(window.location.href);
  url.searchParams.set('userId', userId);
  window.history.replaceState({}, '', url.pathname + url.search);
  render();
}

document.getElementById('clock-reset').addEventListener('click', async () => {
  await api('POST', '/api/clock', { offsetMs: 0 });
  toast('演示时钟已回到真实时间');
  refresh({ force: true });
});

/* ---------------------------------------------------------------- pages - */

async function render() {
  try {
    await load(currentUserId());
  } catch (error) {
    document.getElementById('main').innerHTML = `<div class="empty">加载失败：${error.message}</div>`;
    return;
  }
  paintChrome();
  await paintPage({ soft: false });
  schedulePoll();
}

function schedulePoll() {
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_MS);
}

async function paintPage({ soft }) {
  const route = matchRoute(window.location.pathname);
  const main = document.getElementById('main');

  // 离开带表单的页面后，脏标记随之失效（审核页也要重置，否则不会再做失效检查）。
  if (route.name !== 'delegations') state.formDirty = false;

  if (route.name === 'review') {
    // 审核页自己管理 DOM（含轮询时的局部刷新），避免软刷新时清空已填写的意见
    if (!soft || !document.getElementById('review-root')) {
      await paintReview(route.params[0]);
    } else {
      await revalidateReview(route.params[0]);
    }
    return;
  }

  if (route.name === 'todos') paintTodos(main);
  else if (route.name === 'delegations') paintDelegations(main);
  else if (route.name === 'demo') paintDemo(main);
  else {
    main.innerHTML = '<div class="empty">页面不存在。 <a href="/" data-link>返回待办</a></div>';
  }
}

/* ---------------------------------------------------------------- todos - */

function sourceChip(todo) {
  if (todo.source && todo.source.type === 'delegation') {
    return el('span', { class: 'chip chip-delegation', title: '权限来自他人委托' }, [
      '⤵ ',
      todo.source.label
    ]);
  }
  return el('span', { class: 'chip chip-direct' }, '自有权限');
}

function todoRow(todo) {
  const deltaClass = todo.delta < 0 ? 'delta-down' : 'delta-up';
  return el('div', { class: 'todo' }, [
    el('div', { class: 'todo-main' }, [
      el('div', { class: 'todo-top' }, [
        el('span', { class: 'todo-title', text: todo.product }),
        el('span', { class: 'chip chip-store', text: todo.storeName }),
        sourceChip(todo),
        el('span', { class: 'chip chip-pending', text: STATUS_LABEL[todo.status] || todo.status })
      ]),
      el('div', { class: 'todo-meta' }, [
        el('span', { class: 'price' }, [
          el('span', { class: 'price-old', text: fmtMoney(todo.originalPrice) }),
          `${fmtMoney(todo.proposedPrice)} `
        ]),
        el('span', { class: deltaClass }, `${todo.delta > 0 ? '+' : ''}${todo.deltaPercent}%`),
        `　·　${todo.sku}　·　${todo.requesterName} 提交于 ${fmtTime(todo.createdAt)}`
      ]),
      el('div', { class: 'todo-reason', text: todo.reason }),
      todo.source && todo.source.type === 'delegation' && todo.source.endsAt
        ? el('div', { class: 'todo-reason' }, `委托有效期至 ${fmtTime(todo.source.endsAt)}`)
        : null
    ]),
    el('div', { class: 'todo-actions' }, [
      el(
        'a',
        { class: 'btn btn-sm', href: `/applications/${todo.id}`, 'data-link': true },
        '打开审核页'
      )
    ])
  ]);
}

function paintTodos(main) {
  clear(main);
  const boot = state.bootstrap;
  const todos = boot.todos || [];
  const perms = boot.permissions || [];

  main.append(
    el('div', { class: 'page-head' }, [
      el('div', null, [
        el('h2', { text: `${boot.currentUser ? boot.currentUser.name : ''}的待办` }),
        el('p', {
          class: 'sub',
          text: todos.length
            ? `共 ${todos.length} 条待审核申请（含自有权限与受托门店）`
            : '当前没有可以处理的调价申请'
        })
      ])
    ])
  );

  main.append(
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [
        el('span', { text: '待审核' }),
        el('span', { class: 'hint', text: '列表每 4 秒自动刷新' })
      ]),
      todos.length
        ? el('div', null, todos.map(todoRow))
        : el('div', { class: 'empty' }, '没有待办。可到「委托管理」查看委托状态，或在「演示控制」调整时钟。')
    ])
  );

  main.append(
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [
        el('span', { text: '我的有效权限' }),
        el('span', { class: 'hint', text: '受托权限随委托人权限、委托状态实时变化' })
      ]),
      el('div', { class: 'card-pad' }, [
        perms.length
          ? el(
              'div',
              { class: 'perm-grid' },
              perms.map((entry) =>
                el('div', { class: 'perm-card' }, [
                  el('h4', null, [
                    entry.storeName,
                    entry.directActions.length
                      ? el('span', { class: 'chip chip-direct' }, '自有')
                      : el('span', { class: 'chip chip-delegation' }, '受托')
                  ]),
                  el(
                    'div',
                    { class: 'perm-actions' },
                    entry.actions.map((action) =>
                      el('span', { class: 'chip chip-muted', text: actionLabel(action) })
                    )
                  ),
                  entry.viaDelegation.length
                    ? el(
                        'div',
                        { class: 'perm-source' },
                        entry.viaDelegation.map((source) =>
                          el('div', null, [
                            `来自 ${source.delegatorName} 的委托 · ${source.actions
                              .map(actionLabel)
                              .join('/')} · 至 ${fmtTime(source.endsAt)}`
                          ])
                        )
                      )
                    : null
                ])
              )
            )
          : el('div', { class: 'empty', text: '暂无任何门店权限' })
      ])
    ])
  );
}

/* ---------------------------------------------------------- delegations - */

function statusChip(status) {
  const map = {
    active: 'chip-active',
    pending_acceptance: 'chip-pending',
    scheduled: 'chip-pending',
    expired: 'chip-muted',
    ended: 'chip-muted',
    declined: 'chip-danger'
  };
  return el('span', { class: `chip ${map[status] || 'chip-muted'}`, text: STATUS_LABEL[status] || status });
}

function delegationCard(delegation) {
  const boot = state.bootstrap;
  const me = boot.currentUser;
  const isDelegator = me && me.id === delegation.delegatorId;
  const isDelegatee = me && me.id === delegation.delegateeId;
  const inactive = ['expired', 'ended', 'declined'].includes(delegation.status);
  const shifted = !!delegation.revoked;

  const actions = [];
  if (isDelegatee && delegation.status === 'pending_acceptance') {
    actions.push(
      el(
        'button',
        {
          class: 'btn btn-primary btn-sm',
          onclick: (e) => act(e.target, () => acceptDelegation(delegation.id), '已接受委托')
        },
        '接受委托'
      ),
      el(
        'button',
        {
          class: 'btn btn-sm',
          onclick: (e) => act(e.target, () => declineDelegation(delegation.id), '已拒绝委托')
        },
        '拒绝'
      )
    );
  }
  if (isDelegator && !inactive) {
    actions.push(
      el(
        'button',
        {
          class: 'btn btn-sm btn-reject',
          onclick: (e) => act(e.target, () => endDelegation(delegation.id), '委托已提前结束')
        },
        '提前结束'
      )
    );
  }

  return el(
    'div',
    { class: `delegation${inactive ? ' is-inactive' : ''}` },
    [
      el('div', { class: 'delegation-main' }, [
        el('div', { class: 'delegation-title' }, [
          `${delegation.delegatorName} → ${delegation.delegateeName}`,
          shifted
            ? el('span', { class: 'chip chip-muted', text: '实际已失效（委托人权限被收回）' })
            : statusChip(delegation.status),
          ...delegation.storeNames.map((name) => el('span', { class: 'chip chip-store', text: name }))
        ]),
        el('div', { class: 'delegation-meta' }, [
          el('span', null, `动作：${delegation.actions.map(actionLabel).join(' / ')}`),
          el('span', null, `起：${fmtTime(delegation.startsAt)}`),
          el('span', null, `止：${fmtTime(delegation.endsAt)}`),
          el('span', null, `剩余：${remaining(delegation)}`)
        ]),
        delegation.note ? el('div', { class: 'delegation-note', text: `备注：${delegation.note}` }) : null,
        shifted
          ? el('div', { class: 'scope-warning' }, '委托人的权限已被收回，该委托当前没有任何实际生效的门店权限。')
          : null,
        !shifted && !delegation.delegatorScopeIntact && delegation.status === 'active'
          ? el('div', { class: 'scope-warning' }, '委托人当前权限已不能完全覆盖该委托，代审范围按交集生效。')
          : null
      ]),
      el('div', { class: 'delegation-actions' }, actions)
    ]
  );
}

function remaining(delegation) {
  if (delegation.status !== 'active' && delegation.status !== 'scheduled') return '—';
  const now = state.bootstrap.clock.now;
  if (delegation.status === 'scheduled') {
    return `${fmtDuration(new Date(delegation.startsAt) - now)}后开始`;
  }
  return fmtDuration(new Date(delegation.endsAt) - now);
}

async function acceptDelegation(id) {
  await api('POST', `/api/delegations/${id}/accept`, { userId: state.bootstrap.currentUser.id });
  await refresh({ force: true });
}

async function declineDelegation(id) {
  await api('POST', `/api/delegations/${id}/decline`, { userId: state.bootstrap.currentUser.id });
  await refresh({ force: true });
}

async function endDelegation(id) {
  await api('POST', `/api/delegations/${id}/end`, { userId: state.bootstrap.currentUser.id });
  await refresh({ force: true });
}

async function act(button, fn, okMessage) {
  if (state.busy) return;
  state.busy = true;
  button.disabled = true;
  try {
    await fn();
    if (okMessage) toast(okMessage);
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.busy = false;
    button.disabled = false;
  }
}

function paintDelegations(main) {
  clear(main);
  // 每次真正重绘都生成一份新表单，脏标记随之重置。
  state.formDirty = false;
  const boot = state.bootstrap;
  const me = boot.currentUser;

  main.append(
    el('div', { class: 'page-head' }, [
      el('div', null, [
        el('h2', { text: '委托管理' }),
        el('p', { class: 'sub', text: '委托范围不能超过发起人当前自有权限；受托权限不能再次转委托。' })
      ])
    ])
  );

  const mineDelegator = boot.delegations.filter((d) => me && d.delegatorId === me.id);
  const mineDelegatee = boot.delegations.filter((d) => me && d.delegateeId === me.id);

  // 每条委托单独列出：它们各有自己的时间窗与动作范围，接受/结束也按条生效。
  const groups = [
    { title: '我发起的委托', list: mineDelegator },
    { title: '我受托的委托', list: mineDelegatee }
  ].filter((group) => group.list.length > 0);

  for (const group of groups) {
    main.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [el('span', { text: group.title })]),
        el('div', null, group.list.map(delegationCard))
      ])
    );
  }

  const canDelegate = boot.permissions.some(
    (entry) => entry.directActions.includes('approve') || entry.directActions.includes('reject')
  );
  if (me && canDelegate) main.append(delegationForm(me));
  else if (me) {
    main.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [el('span', { text: '新建委托' })]),
        el('div', { class: 'card-pad' }, [
          el('div', { class: 'banner' }, [
            me.id === 'u_yi'
              ? '乙当前只有代来的权限。代来的权限不能再次转委托给第三人，因此这里不提供新建入口。'
              : '当前身份没有可委托的自有审核权限。'
          ])
        ])
      ])
    );
  }
}

function delegationForm(me) {
  const boot = state.bootstrap;
  const now = boot.clock.now;
  const others = boot.users.filter((user) => user.id !== me.id);

  let preselectDone = false;
  const storeChecks = boot.stores.map((store) => {
    const perm = boot.permissions.find((entry) => entry.storeId === store.id);
    const owned = perm ? perm.directActions : [];
    // 只有拥有自有审核动作的门店才可委托；代来的权限不计入。
    const delegatable = owned.includes('approve') || owned.includes('reject');
    // 默认勾选第一个可委托门店，避免一上来就两个门店全勾上。
    const preselect = delegatable && !preselectDone;
    if (preselect) preselectDone = true;
    return el('label', { class: `check${delegatable ? '' : ' is-locked'}` }, [
      el('input', {
        type: 'checkbox',
        name: 'store',
        value: store.id,
        disabled: !delegatable,
        checked: preselect
      }),
      `${store.name}${delegatable ? '' : '（无可委托权限）'}`
    ]);
  });

  const actionChecks = ['view', 'approve', 'reject'].map((action) =>
    el('label', { class: 'check' }, [
      el('input', {
        type: 'checkbox',
        name: 'action',
        value: action,
        checked: action !== 'view'
      }),
      `${actionLabel(action)}${action === 'view' ? '（审核动作自动包含）' : ''}`
    ])
  );

  const delegateeSelect = el(
    'select',
    { class: 'select', name: 'delegatee' },
    others.map((user) => el('option', { value: user.id, text: `${user.name} · ${user.title}` }))
  );

  const startInput = el('input', {
    class: 'input',
    type: 'datetime-local',
    name: 'startsAt',
    value: isoLocalValue(now)
  });
  const endInput = el('input', {
    class: 'input',
    type: 'datetime-local',
    name: 'endsAt',
    value: isoLocalValue(now + 2 * 60 * 60 * 1000)
  });

  const noteInput = el('input', {
    class: 'input',
    type: 'text',
    name: 'note',
    placeholder: '例如：休假期间代审门店一',
    maxlength: '200'
  });

  const message = el('span', { class: 'form-msg' });

  const form = el('form', { class: 'card' }, [
    el('div', { class: 'card-title' }, [
      el('span', { text: '新建委托' }),
      el('span', { class: 'hint', text: `发起人：${me.name}（${me.title}）` })
    ]),
    el('div', { class: 'form-grid' }, [
      el('div', { class: 'field' }, [
        el('label', { text: '被委托人' }),
        delegateeSelect,
        el('span', { class: 'desc', text: '被委托人需要先接受委托才会生效。' })
      ]),
      el('div', { class: 'field' }, [el('label', { text: '备注' }), noteInput]),
      el('div', { class: 'field span-2' }, [
        el('label', { text: '门店范围' }),
        el('div', { class: 'checkrow' }, storeChecks),
        el('span', { class: 'desc', text: '只能勾选你当前拥有权限的门店。' })
      ]),
      el('div', { class: 'field span-2' }, [
        el('label', { text: '允许的动作' }),
        el('div', { class: 'checkrow' }, actionChecks)
      ]),
      el('div', { class: 'field' }, [el('label', { text: '开始时间' }), startInput]),
      el('div', { class: 'field' }, [el('label', { text: '结束时间' }), endInput])
    ]),
    el('div', { class: 'form-foot' }, [
      el('button', { class: 'btn btn-primary', type: 'submit' }, '创建委托'),
      message
    ])
  ]);

  form.addEventListener('input', () => {
    state.formDirty = true;
  });
  form.addEventListener('change', () => {
    state.formDirty = true;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.textContent = '';
    message.classList.remove('ok');
    const storeIds = [...form.querySelectorAll('input[name="store"]:checked')].map((i) => i.value);
    const actions = [...form.querySelectorAll('input[name="action"]:checked')].map((i) => i.value);
    if (!storeIds.length) {
      message.textContent = '请至少选择一个门店。';
      return;
    }
    if (!actions.length) {
      message.textContent = '请至少选择一个动作。';
      return;
    }
    const startMs = new Date(startInput.value).getTime();
    const endMs = new Date(endInput.value).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      message.textContent = '请填写完整的开始与结束时间。';
      return;
    }
    if (endMs <= startMs) {
      message.textContent = '结束时间必须晚于开始时间。';
      return;
    }
    const payload = {
      delegatorId: me.id,
      delegateeId: delegateeSelect.value,
      storeIds,
      actions,
      startsAt: new Date(startMs).toISOString(),
      endsAt: new Date(endMs).toISOString(),
      note: noteInput.value
    };
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api('POST', '/api/delegations', payload);
      toast('委托已创建，等待被委托人接受');
      await refresh({ force: true });
    } catch (error) {
      message.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  return form;
}

/* ----------------------------------------------------------- demo page -- */

function paintDemo(main) {
  clear(main);
  const boot = state.bootstrap;

  main.append(
    el('div', { class: 'page-head' }, [
      el('div', null, [
        el('h2', { text: '演示控制' }),
        el('p', { class: 'sub', text: '调整本地演示时钟，模拟委托到期；收回主管权限，验证联动。' })
      ])
    ])
  );

  const customInput = el('input', {
    class: 'input',
    type: 'datetime-local',
    value: isoLocalValue(boot.clock.now)
  });

  main.append(
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [
        el('span', { text: '演示时钟' }),
        el('span', { class: 'hint', id: 'demo-clock-hint', text: `当前：${fmtClock(boot.clock.now)}` })
      ]),
      el('div', { class: 'card-pad' }, [
        el('div', { class: 'checkrow' }, [
          el(
            'button',
            {
              class: 'btn btn-sm',
              onclick: (e) => shift(e.target, 30 * 60 * 1000)
            },
            '快进 30 分钟'
          ),
          el(
            'button',
            {
              class: 'btn btn-sm',
              onclick: (e) => shift(e.target, 60 * 60 * 1000)
            },
            '快进 1 小时'
          ),
          el(
            'button',
            {
              class: 'btn btn-sm',
              onclick: (e) => shift(e.target, 2 * 60 * 60 * 1000)
            },
            '快进 2 小时'
          ),
          el(
            'button',
            {
              class: 'btn btn-sm',
              onclick: (e) => shift(e.target, -30 * 60 * 1000)
            },
            '回拨 30 分钟'
          )
        ]),
        el('div', { class: 'form-grid', style: 'padding:14px 0 0' }, [
          el('div', { class: 'field' }, [
            el('label', { text: '跳到指定时间' }),
            customInput,
            el('span', { class: 'desc', text: '修改时钟后，待办与审核页会在数秒内自动刷新。' })
          ]),
          el('div', { class: 'field', style: 'justify-content:flex-end' }, [
            el(
              'button',
              {
                class: 'btn btn-primary',
                onclick: (e) => setClockTo(e.target, customInput.value)
              },
              '跳转'
            )
          ])
        ])
      ])
    ])
  );

  const managerCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, [
      el('span', { text: '主管甲的权限开关' }),
      el('span', { class: 'hint', text: '收回后，乙的代审核权限立即失效' })
    ]),
    el('div', { class: 'card-pad' }, [
      el(
        'div',
        { class: 'checkrow' },
        boot.stores.map((store) => {
          const grant = boot.grants.find(
            (item) => item.userId === 'u_jia' && item.storeId === store.id
          );
          return el('label', { class: 'check' }, [
            el('input', {
              type: 'checkbox',
              checked: !!grant && grant.active,
              onchange: (event) => setGrant(store.id, event.target.checked)
            }),
            `甲 · ${store.name} 直接权限`
          ]);
        })
      ),
      el('p', {
        class: 'desc',
        style: 'margin-top:10px',
        text: '勾选 = 权限有效；取消勾选 = 权限被收回。代审委托按与发起人当前权限的交集生效。'
      })
    ])
  ]);
  main.append(managerCard);

  main.append(
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('span', { text: '演示脚本' })]),
      el('div', { class: 'demo-grid' }, [
        el('div', { class: 'demo-step' }, [
          el('h4', { text: '① 样例已含委托' }),
          el('p', {
            text: '甲 → 乙，门店一，查看/通过/驳回，2 小时，乙已接受。也可以切到甲，在「委托管理」里再发起一条新委托。'
          })
        ]),
        el('div', { class: 'demo-step' }, [
          el('h4', { text: '② 乙只能审门店一' }),
          el('p', {
            text: '切到乙：待办只有门店一的申请，并标注「代 甲 审核」。门店二申请的审核地址会被直接拦住。'
          })
        ]),
        el('div', { class: 'demo-step' }, [
          el('h4', { text: '③ 审核页停留期间到期' }),
          el('p', {
            text: '先以乙打开一条门店一申请的审核页，再回到本页快进 2 小时：审核页按钮变灰并提示失效，刷新会被拦。'
          })
        ]),
        el('div', { class: 'demo-step' }, [
          el('h4', { text: '④ 收回权限 / 提前结束' }),
          el('p', {
            text: '取消「甲 · 门店一」的勾选：乙的待办立即少掉门店一，已打开的审核页也无法提交。也可由甲在委托管理里“提前结束”。'
          })
        ]),
        el('div', { class: 'demo-step' }, [
          el('h4', { text: '⑤ 主管权限不受影响' }),
          el('p', {
            text: '切到甲：两家门店的申请都还在；审核记录会写明通过的是自有权限还是代审。'
          })
        ]),
        el('div', { class: 'demo-step' }, [
          el('h4', { text: '⑥ 不能再转委托' }),
          el('p', {
            text: '乙的委托管理页没有新建入口；即便直接调用接口，也会因为“代来的权限”被拒绝。'
          })
        ])
      ])
    ])
  );

  // 演示脚本区保留在卡片下方
}

async function setGrant(storeId, active) {
  try {
    await api('POST', '/api/demo/grants', { userId: 'u_jia', storeId, active });
    toast(active ? '已恢复甲的权限' : '已收回甲的权限，代审权限同步失效');
    await refresh({ force: true });
  } catch (error) {
    toast(error.message, true);
  }
}

async function shift(button, deltaMs) {
  button.disabled = true;
  try {
    const next = state.bootstrap.clock.now + deltaMs;
    await api('POST', '/api/clock', { offsetMs: next - Date.now() });
    toast(`演示时钟：${fmtClock(next)}`);
    await refresh({ force: true });
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function setClockTo(button, value) {
  if (!value) return;
  button.disabled = true;
  try {
    await api('POST', '/api/clock', { iso: new Date(value).toISOString() });
    await refresh({ force: true });
    toast('演示时钟已跳转');
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

/* --------------------------------------------------------------- review - */

async function paintReview(applicationId) {
  const main = document.getElementById('main');
  clear(main);
  const root = el('div', { id: 'review-root' });
  main.append(root);
  state.review = { applicationId, openedAt: state.bootstrap ? state.bootstrap.clock.now : Date.now() };

  let payload;
  try {
    payload = await api(
      'GET',
      `/api/applications/${applicationId}?userId=${encodeURIComponent(currentUserId())}`
    );
  } catch (error) {
    renderBlocked(root, error);
    return;
  }

  renderReview(root, payload.application);
}

function renderBlocked(root, error) {
  clear(root);
  root.append(
    el('div', { class: 'blocked' }, [
      el('div', { class: 'icon', text: '!' }),
      el('h2', { text: '无法打开该审核页' }),
      error.code ? el('div', { class: 'code', text: error.code }) : null,
      el('p', { text: error.message }),
      el('p', {
        style: 'margin-top:8px;font-size:12px;color:#8b949e',
        text: '委托到期或权限被收回后，即使保存了直接地址也无法继续处理。'
      }),
      el('a', { class: 'btn', href: '/', 'data-link': true }, '返回待办')
    ])
  );
}

function renderReview(root, application) {
  clear(root);
  const perm = application.permission;
  const closed = application.status !== 'pending';

  root.append(
    el('div', { class: 'page-head' }, [
      el('div', null, [
        el('h2', { text: `审核 · ${application.product}` }),
        el('p', {
          class: 'sub',
          text: `${application.storeName} · ${application.sku} · ${application.requesterName} 提交于 ${fmtTime(
            application.createdAt
          )}`
        })
      ]),
      el('a', { class: 'btn btn-sm', href: '/', 'data-link': true }, '← 返回待办')
    ])
  );

  const sources = perm.sources || [];
  const hasDirect = sources.some((source) => source.type === 'direct');
  const delegationSource = hasDirect ? null : sources.find((source) => source.type === 'delegation');
  if (delegationSource) {
    const delegator = (state.bootstrap.users || []).find((user) => user.id === delegationSource.delegatorId);
    root.append(
      el('div', { class: 'banner info', id: 'review-banner' }, [
        `你正在以受托身份处理该申请：来自 ${delegator ? delegator.name : delegationSource.delegatorId} 的委托，有效期至 ${fmtTime(delegationSource.endsAt)}。`
      ])
    );
  } else {
    root.append(el('div', { class: 'banner info', id: 'review-banner' }, '该申请由你的自有权限处理。'));
  }

  root.append(
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [
        el('span', { text: '申请详情' }),
        el('span', { class: 'chip chip-pending', text: STATUS_LABEL[application.status] || application.status })
      ]),
      el('div', { class: 'card-pad' }, [
        el('dl', { class: 'kv' }, [
          el('dt', { text: '门店' }),
          el('dd', { text: application.storeName }),
          el('dt', { text: '商品' }),
          el('dd', { text: `${application.product}（${application.sku}）` }),
          el('dt', { text: '原价' }),
          el('dd', { class: 'price', text: `${fmtMoney(application.originalPrice)} / ${application.unit}` }),
          el('dt', { text: '申请价' }),
          el('dd', null, [
            el('span', {
              class: `price ${application.delta < 0 ? 'delta-down' : 'delta-up'}`,
              text: `${fmtMoney(application.proposedPrice)} / ${application.unit}`
            }),
            el('span', {
              style: 'margin-left:8px;color:#8b949e;font-size:12.5px',
              text: `${application.delta > 0 ? '+' : ''}${application.deltaPercent}%`
            })
          ]),
          el('dt', { text: '申请理由' }),
          el('dd', { text: application.reason })
        ])
      ])
    ])
  );

  if (closed) {
    const decision = application.decision;
    root.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [el('span', { text: '处理结果' })]),
        el('div', { class: 'card-pad' }, [
          el('dl', { class: 'kv' }, [
            el('dt', { text: '结果' }),
            el('dd', { text: decision ? (decision.action === 'approve' ? '已通过' : '已驳回') : '—' }),
            el('dt', { text: '处理人' }),
            el('dd', { text: (decision && (decision.byName || decision.by)) || '—' }),
            el('dt', { text: '处理时间' }),
            el('dd', { text: decision ? fmtTime(decision.at) : '—' }),
            el('dt', { text: '处理途径' }),
            el('dd', {
              text:
                decision && decision.via
                  ? decision.via.type === 'delegation'
                    ? '受托代审'
                    : '自有权限'
                  : '—'
            }),
            el('dt', { text: '意见' }),
            el('dd', { text: (decision && decision.comment) || '—' })
          ])
        ])
      ])
    );
    return;
  }

  const comment = el('textarea', {
    class: 'textarea',
    placeholder: '审核意见（选填）',
    maxlength: '200'
  });
  const message = el('span', { class: 'form-msg' });

  const approveBtn = el(
    'button',
    {
      class: 'btn btn-approve',
      disabled: !perm.canApprove,
      onclick: () => submitDecision('approve', comment.value, [approveBtn, rejectBtn], message, root)
    },
    '审核通过'
  );
  const rejectBtn = el(
    'button',
    {
      class: 'btn btn-reject',
      disabled: !perm.canReject,
      onclick: () => submitDecision('reject', comment.value, [approveBtn, rejectBtn], message, root)
    },
    '驳回'
  );

  root.append(
    el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [el('span', { text: '处理' })]),
      el('div', { class: 'card-pad' }, [
        el('div', { class: 'field' }, [el('label', { text: '审核意见' }), comment])
      ]),
      el('div', { class: 'form-foot' }, [
        approveBtn,
        rejectBtn,
        message,
        el('span', { class: 'spacer' }),
        el('span', { class: 'hint', id: 'review-guard', text: '提交时会再次校验权限与委托时效' })
      ])
    ])
  );
}

async function submitDecision(action, comment, buttons, message, root) {
  if (state.busy) return;
  state.busy = true;
  buttons.forEach((button) => (button.disabled = true));
  message.textContent = '';
  message.classList.remove('ok');

  try {
    // 关键：提交前重新拉取一次，避免用过期页面提交
    const fresh = await api(
      'GET',
      `/api/applications/${state.review.applicationId}?userId=${encodeURIComponent(currentUserId())}`
    );
    if (!fresh.application.permission[action === 'approve' ? 'canApprove' : 'canReject']) {
      throw Object.assign(new Error('权限已变化，无法提交。'), { status: 403 });
    }
    await api('POST', `/api/applications/${state.review.applicationId}/decision`, {
      userId: currentUserId(),
      action,
      comment
    });
    toast(action === 'approve' ? '已审核通过' : '已驳回');
    await render();
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      renderBlocked(root, error);
    } else {
      message.textContent = error.message;
      buttons.forEach((button) => (button.disabled = false));
    }
  } finally {
    state.busy = false;
  }
}

/**
 * 审核页停留期间被轮询时调用：只更新可提交状态，不清空已填写的意见。
 */
async function revalidateReview(applicationId) {
  const root = document.getElementById('review-root');
  if (!root) return;
  let payload;
  try {
    payload = await api(
      'GET',
      `/api/applications/${applicationId}?userId=${encodeURIComponent(currentUserId())}`
    );
  } catch (error) {
    renderBlocked(root, error);
    return;
  }
  const application = payload.application;
  // 被拦后权限又恢复（例如主管补回权限、时钟调回）：重新渲染完整审核页。
  if (!root.querySelector('.form-foot') || application.status !== 'pending') {
    renderReview(root, application);
    return;
  }

  const buttons = [...root.querySelectorAll('.form-foot .btn')];
  for (const button of buttons) {
    const text = button.textContent;
    if (text === '审核通过') button.disabled = !application.permission.canApprove;
    if (text === '驳回') button.disabled = !application.permission.canReject;
  }
  const guard = root.querySelector('#review-guard');
  if (guard) {
    const allowed = application.permission.canApprove || application.permission.canReject;
    guard.textContent = allowed ? '提交时会再次校验权限与委托时效' : '当前已无提交权限';
    guard.style.color = allowed ? '' : '#b42318';
  }
}

/* ------------------------------------------------------------------ boot - */

function boot() {
  const requested = qs('userId');
  if (requested) {
    state.userId = requested;
    localStorage.setItem(STORAGE_KEY, requested);
  }
  render();
}

boot();
