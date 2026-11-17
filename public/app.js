// 界面层：只负责渲染与浏览器历史，业务状态与竞态控制都在 tab-controller.js。
// 每个标签页各跑一个控制器实例 —— 两个标签互不共享组织状态。

import {
  createApi,
  createTabController,
  customerPath,
  orgPath,
} from './tab-controller.js';

const app = document.getElementById('app');
const api = createApi();

/** 每个标签页自己的「下一次载入慢 3 秒」开关，用来手工复现慢响应覆盖问题。 */
let slowNextLoad = false;

const tab = createTabController({
  api,
  path: location.pathname,
  onChange: () => render(),
  // 只对紧接着的那一次载入生效，然后自动复位。
  delayProvider: () => {
    const delay = slowNextLoad ? 3000 : 0;
    slowNextLoad = false;
    return delay;
  },
});

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (['disabled', 'checked', 'selected', 'value'].includes(key)) node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ---------- 导航：URL 是组织上下文的唯一真源 ----------

function navigate(pathname, { replace = false } = {}) {
  if (pathname === location.pathname) {
    tab.applyPath(pathname);
    return;
  }
  if (replace) history.replaceState({ path: pathname }, '', pathname);
  else history.pushState({ path: pathname }, '', pathname);
  tab.applyPath(pathname);
}

window.addEventListener('popstate', () => {
  tab.applyPath(location.pathname);
});

// ---------- 渲染 ----------

function render() {
  const { state } = tab;
  app.replaceChildren();

  app.append(
    el(
      'header',
      { class: 'topbar' },
      el('h1', {}, '多组织客服工作台'),
      renderSessionBar(state),
    ),
  );

  const main = el('main', { class: 'workspace', id: 'main' });
  app.append(main, el('aside', { class: 'demo-panel', id: 'demo-panel' }));

  if (state.notice) {
    main.append(el('div', { class: `banner ${state.notice.kind}` }, state.notice.text));
  }

  const route = state.route;
  if (!state.session.user) {
    main.append(renderLogin(state));
  } else if (route.kind === 'home') {
    main.append(renderHome(state));
  } else if (route.kind === 'org') {
    main.append(renderOrgPage(state));
  } else {
    main.append(renderCustomerPage(state, route));
  }

  document.getElementById('demo-panel').replaceChildren(...renderDemoPanel(state));
}

function renderSessionBar(state) {
  const { user, orgs } = state.session;
  if (!user) {
    return el(
      'form',
      {
        class: 'login',
        onsubmit: async (event) => {
          event.preventDefault();
          const select = event.currentTarget.querySelector('select');
          try {
            await tab.login(select.value);
            await tab.bootstrap();
            tab.applyPath(location.pathname);
          } catch (error) {
            tab.setNotice({ kind: 'error', text: error.message });
          }
        },
      },
      el('label', {}, '演示账号 ', el(
        'select',
        {},
        ...(state.session.demoUsers || []).map((u) =>
          el('option', { value: u.id }, `${u.name}（${u.id}）`),
        ),
      )),
      el('button', { type: 'submit' }, '登录'),
    );
  }

  return el(
    'div',
    { class: 'who' },
    el('span', { class: 'pill' }, `${user.name}（${user.id}）`),
    el('span', { class: 'muted' }, '可访问组织'),
    ...(orgs.length
      ? orgs.map((org) =>
          el(
            'a',
            {
              class: 'org-chip',
              href: orgPath(org.id),
              onclick: (event) => {
                event.preventDefault();
                navigate(orgPath(org.id));
              },
            },
            org.name,
          ),
        )
      : [el('span', { class: 'danger' }, '无')]),
    el(
      'button',
      {
        class: 'ghost',
        type: 'button',
        onclick: async () => {
          await tab.logout();
          await tab.bootstrap();
          tab.applyPath(location.pathname);
        },
      },
      '退出',
    ),
  );
}

function renderLogin(state) {
  return el(
    'section',
    { class: 'card' },
    el('h2', {}, '请先登录'),
    el('p', { class: 'muted' }, 'agent 同时属于甲、乙两个组织；agent-jia 只属于甲组织，可用于验证无权限时被拒绝。'),
    el('p', { class: 'muted' }, '登录状态在同一浏览器的标签页间共享，但每个标签的「当前组织」不会共享。'),
  );
}

function renderHome(state) {
  return el(
    'section',
    { class: 'card' },
    el('h2', {}, '选择组织'),
    el('p', { class: 'muted' }, '组织由地址 /o/&lt;组织&gt; 绑定；切换只影响当前标签页。'),
    el(
      'div',
      { class: 'org-grid' },
      ...state.session.orgs.map((org) =>
        el(
          'a',
          {
            class: 'org-card',
            href: orgPath(org.id),
            onclick: (event) => {
              event.preventDefault();
              navigate(orgPath(org.id));
            },
          },
          el('strong', {}, org.name),
          el('code', { class: 'muted' }, org.id),
          el('span', { class: 'muted' }, '两个组织里都可能存在编号相同的客户'),
        ),
      ),
      ...(state.session.orgs.length ? [] : [el('p', { class: 'danger' }, '当前账号没有任何组织权限。')]),
    ),
  );
}

function renderOrgPage(state) {
  const route = state.route;
  if (state.load === 'loading' || !state.orgList) {
    if (state.load === 'error') {
      return renderErrorCard(state.loadError, route.orgId);
    }
    return el(
      'section',
      { class: 'card' },
      el('div', { class: 'org-banner' }, el('strong', {}, `组织：${route.orgId}`)),
      el('p', { class: 'muted' }, '正在加载客户列表…'),
    );
  }
  return el(
    'section',
    { class: 'card' },
    el('div', { class: 'org-banner' }, el('strong', {}, `组织：${state.orgName}`), el('code', {}, route.orgId)),
    el('h2', {}, '客户列表'),
    el(
      'ul',
      { class: 'customer-list' },
      ...state.orgList.map((c) =>
        el(
          'li',
          {},
          el(
            'a',
            {
              href: customerPath(route.orgId, c.localCustomerNo),
              onclick: (event) => {
                event.preventDefault();
                navigate(customerPath(route.orgId, c.localCustomerNo));
              },
            },
            `${c.localCustomerNo} · ${c.name}`,
          ),
          el('span', { class: 'muted' }, c.updatedAt ? `最近更新 ${new Date(c.updatedAt).toLocaleString()}` : '未修改过'),
        ),
      ),
    ),
  );
}

function renderErrorCard(error, orgId) {
  const forbidden = error?.status === 403;
  const unauthenticated = error?.status === 401;
  return el(
    'section',
    { class: 'card', id: 'error-card' },
    el('h2', {}, forbidden ? '没有该组织的权限' : unauthenticated ? '登录已失效' : '读取失败'),
    el('p', { class: forbidden ? 'danger' : '' }, `${error?.message || '未知错误'}（组织：${orgId}）`),
    el(
      'p',
      { class: 'muted' },
      forbidden
        ? '地址里的组织信息仍然保留；重新获得权限后刷新本页即可恢复。'
        : '请稍后重试。',
    ),
    el(
      'a',
      {
        class: 'button-link',
        href: '/',
        onclick: (event) => {
          event.preventDefault();
          navigate('/');
        },
      },
      '返回组织列表',
    ),
  );
}

function renderCustomerPage(state, route) {
  if (state.load === 'loading' || state.load === 'idle') {
    return el(
      'section',
      { class: 'card' },
      el(
        'div',
        { class: 'org-banner' },
        el('strong', {}, `组织：${route.orgId}`),
        el('span', { class: 'muted' }, '（组织由本标签地址绑定）'),
      ),
      el('p', { class: 'muted' }, `正在加载 ${route.customerNo} …`),
    );
  }
  if (state.load === 'error') return renderErrorCard(state.loadError, route.orgId);

  const customer = state.customer;
  if (!customer) {
    return el('section', { class: 'card' }, el('p', {}, '暂无数据'));
  }

  const locked = state.save === 'denied';
  const saving = state.save === 'saving';

  const textarea = el('textarea', {
    id: 'remark-input',
    rows: '6',
    maxlength: '2000',
    placeholder: `在 ${route.orgId} 下填写备注…`,
    disabled: locked,
    // 输入过程中不整页重绘：否则会丢焦点/光标。只同步「保存」按钮的可用状态。
    oninput: (event) => {
      tab.setDraft(event.target.value, { silent: true });
      const saveButton = document.getElementById('save-remark');
      if (saveButton) saveButton.disabled = locked || saving || !tab.state.dirty;
    },
  });
  textarea.value = state.draft;

  const form = el(
    'form',
    {
      class: 'remark-form',
      onsubmit: async (event) => {
        event.preventDefault();
        await tab.saveRemark();
      },
    },
    el('label', { for: 'remark-input' }, `备注（写入 ${route.orgId} / ${route.customerNo}）`),
    textarea,
    el(
      'div',
      { class: 'actions' },
      el(
        'button',
        { type: 'submit', id: 'save-remark', disabled: locked || saving || !state.dirty },
        saving ? '保存中…' : '保存到本组织',
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'ghost',
          disabled: locked,
          onclick: () => tab.revertDraft(),
        },
        '还原',
      ),
      el(
        'label',
        { class: 'delay' },
        el('input', {
          type: 'checkbox',
          checked: slowNextLoad,
          onchange: (event) => {
            slowNextLoad = event.target.checked;
          },
        }),
        ' 下一次载入延迟 3 秒',
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'ghost',
          onclick: () => tab.refresh(),
        },
        '重新载入本页',
      ),
    ),
    state.saveError ? el('p', { class: 'danger', id: 'save-error' }, state.saveError) : null,
    state.save === 'saved' ? el('p', { class: 'success' }, '已保存到当前组织。') : null,
  );

  return el(
    'section',
    { class: 'card customer-card', id: 'customer-card' },
    el(
      'div',
      { class: 'org-banner' },
      el('strong', {}, `组织：${customer.orgName}`),
      el('code', {}, route.orgId),
      el('span', { class: 'muted' }, `客户编号：${customer.localCustomerNo}`),
      el('span', { class: 'badge' }, `版本 ${customer.version}`),
    ),
    el('h2', { id: 'customer-name' }, customer.name),
    el(
      'dl',
      { class: 'meta' },
      el('dt', {}, '最近修改'),
      el(
        'dd',
        { id: 'customer-updated' },
        customer.updatedAt
          ? `${new Date(customer.updatedAt).toLocaleString()} · ${customer.updatedBy?.name || '未知'}`
          : '未修改过',
      ),
    ),
    el(
      'div',
      { class: 'org-switch' },
      el('span', { class: 'muted' }, '在本标签切换组织：'),
      ...state.session.orgs.map((org) =>
        el(
          'button',
          {
            type: 'button',
            class: org.id === route.orgId ? 'chip current' : 'chip',
            disabled: org.id === route.orgId,
            onclick: () => navigate(customerPath(org.id, route.customerNo)),
          },
          org.name,
        ),
      ),
    ),
    form,
    el(
      'p',
      { class: 'hint' },
      '本页地址 ',
      el('code', { id: 'current-path' }, location.pathname),
      ' 就是本标签的组织上下文；刷新或前进/后退都会从地址还原。',
    ),
  );
}

function renderDemoPanel(state) {
  const nodes = [];
  if (!state.session.demo) return nodes;
  const activeUserId = state.session.user?.id || 'agent';

  const demoUsers = state.session.demoUsers || [];
  nodes.push(
    el(
      'section',
      { class: 'card' },
      el('h2', {}, '演示控制'),
      el('p', { class: 'muted' }, '模拟组织权限变化；不会改写任何标签的地址。'),
      ...demoUsers.map((u) =>
        el(
          'div',
          { class: 'demo-user' },
          el('strong', {}, `${u.name}（${u.id}）`),
          ...(u.orgIds.length
            ? u.orgIds.map((id) => el('span', { class: 'pill' }, id))
            : [el('span', { class: 'pill danger' }, '无组织')]),
        ),
      ),
      el(
        'div',
        { class: 'demo-actions' },
        el(
          'button',
          {
            type: 'button',
            class: 'ghost',
            onclick: async () => {
              await api.demoMembership({ userId: activeUserId, orgId: 'org-jia', enabled: false });
              const notice = { kind: 'warn', text: `已收回 ${activeUserId} 的甲组织权限；对该组织的读写将返回 403。` };
              await tab.bootstrap();
              tab.state.notice = notice;
              tab.applyPath(location.pathname);
            },
          },
          '收回当前账号的甲组织权限',
        ),
        el(
          'button',
          {
            type: 'button',
            class: 'ghost',
            onclick: async () => {
              await api.demoMembership({ userId: activeUserId, orgId: 'org-jia', enabled: true });
              await tab.bootstrap();
              tab.state.notice = { kind: 'warn', text: '已恢复甲组织权限；刷新即可重新读取。' };
              tab.applyPath(location.pathname);
            },
          },
          '恢复甲组织权限',
        ),
        el(
          'button',
          {
            type: 'button',
            class: 'ghost',
            onclick: async () => {
              await api.demoReset();
              await tab.bootstrap();
              tab.state.notice = { kind: 'warn', text: '演示数据已重置。' };
              tab.applyPath(location.pathname);
            },
          },
          '重置演示数据',
        ),
      ),
    ),
  );

  nodes.push(
    el(
      'section',
      { class: 'card' },
      el('h2', {}, '这个演示里做了什么'),
      el(
        'ol',
        { class: 'notes' },
        el('li', {}, '登录票据只记录「是谁」，服务端不保存「当前组织」。'),
        el('li', {}, '组织上下文写在每个标签各自的地址里。'),
        el('li', {}, '所有读写接口先校验组织权限，再用（组织, 本地客户编号）定位记录。'),
        el('li', {}, '读取带序号；旧组织的慢响应到达时会被丢弃。'),
      ),
    ),
  );

  return nodes;
}

// ---------- 启动 ----------

(async function boot() {
  await tab.bootstrap();
  // 地址里已带组织，直接按地址加载（刷新/直达/收藏都走这条路径）。
  await tab.applyPath(location.pathname);
})();

// 供手工验证与自动化测试观察当前标签状态（不影响业务逻辑）。
window.__tab = tab;
window.__navigate = navigate;
window.__hasUnsavedDraft = () => tab.state.dirty;
