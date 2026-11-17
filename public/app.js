// 前端：只负责展示服务端下发的数据。订阅哪些项目完全由 /api/stream 服务端决定，
// 前端没有任何"添加订阅项目"的入口，EventSource 连接也不带项目参数。

const $ = (sel) => document.querySelector(sel);
const state = {
  token: localStorage.getItem('token') || '',
  me: null,
  snapshot: null,
  // 被撤权的项目（收到控制事件后标记，配合重新拉取做即时视觉反馈）
  revokedProjects: new Set(),
  evtSource: null,
};

// 所有动态文本都走 textContent，避免把任务标题当作 HTML 注入
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(child?.nodeType ? child : document.createTextNode(String(child ?? '')));
  }
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function logLine(text, cls = '') {
  const box = $('#live-log');
  const line = el('div', { class: cls }, `[${new Date().toLocaleTimeString()}] ${text}`);
  box.prepend(line);
}

// ---------- 登录 / 视图切换 ----------
document.querySelectorAll('#login button').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.token = btn.dataset.token;
    localStorage.setItem('token', state.token);
    boot();
  });
});

async function boot() {
  try {
    state.me = await api('/api/me');
  } catch {
    localStorage.removeItem('token');
    location.reload();
    return;
  }
  $('#login').hidden = true;
  $('#identity').textContent = `${state.me.name}（${state.me.role === 'admin' ? '管理员' : '员工'}）`;
  if (state.me.role === 'admin') return bootAdmin();
  bootEmployee();
}

// ---------- 员工视图 ----------
async function bootEmployee() {
  $('#employee-view').hidden = false;
  await refreshEmployee();
  connectStream();
  $('#btn-refresh').addEventListener('click', refreshEmployee);
}

async function refreshEmployee() {
  // 重开页面/手动刷新都重新请求服务端：撤权项目的历史标题不会再出现在响应里
  state.snapshot = await api('/api/state');
  state.revokedProjects = new Set();
  renderProjects();
}

function renderProjects() {
  const grid = $('#project-grid');
  grid.replaceChildren();
  const { projects, tasks, unread } = state.snapshot;

  for (const project of projects) {
    const projectTasks = tasks.filter((t) => t.projectId === project.id);
    const unreadCount = unread[project.id] || 0;
    const card = el('div', { class: 'project-card' },
      el('h3', {}, project.name),
      el('div', { class: 'meta' },
        `项目 ID: ${project.id} ｜ 未读 `,
        el('span', { class: unreadCount ? 'badge unread' : 'badge' }, String(unreadCount))
      ),
      el('button', {
        class: 'secondary small',
        onClick: () => markRead(project.id),
      }, '全部标为已读')
    );
    for (const task of projectTasks) {
      card.append(el('div', { class: 'task' },
        el('span', {}, task.title),
        el('span', { class: 'badge' }, task.status)
      ));
    }
    grid.append(card);
  }
}

async function markRead(projectId) {
  const result = await api('/api/read', { method: 'POST', body: JSON.stringify({ projectId }) });
  state.snapshot.unread = result.unread;
  renderProjects();
}

function connectStream() {
  // 注意：URL 里只有 token，没有任何项目参数——订阅集合服务端说了算
  const es = new EventSource(`/api/stream?token=${encodeURIComponent(state.token)}`);
  state.evtSource = es;

  es.addEventListener('open', () => logLine('SSE 连接已建立', 'sys'));

  es.addEventListener('subscribed', (e) => {
    const { projectIds } = JSON.parse(e.data);
    logLine(`服务端确认订阅范围：${projectIds.join(', ') || '（空）'}`, 'sys');
  });

  es.addEventListener('task.updated', (e) => {
    const ev = JSON.parse(e.data);
    logLine(`${ev.projectId} ｜ 《${ev.title}》：${ev.oldStatus} → ${ev.status}`);
    // 以服务端重新下发的快照为准（权限可能已变化）
    refreshEmployee();
  });

  es.addEventListener('permission.revoked', (e) => {
    const ev = JSON.parse(e.data);
    state.revokedProjects.add(ev.projectId);
    logLine(`权限变更：你已被移出 ${ev.projectId}，停止接收该项目更新`, 'ctrl');
    refreshEmployee();
  });

  es.addEventListener('permission.granted', (e) => {
    const ev = JSON.parse(e.data);
    logLine(`权限变更：你已加入 ${ev.projectId}`, 'ctrl');
    refreshEmployee();
  });

  // 浏览器原生重连会自动带上 Last-Event-ID，服务端按当前权限过滤后补发
  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CONNECTING) {
      logLine('连接断开，正在重连并按当前权限申请补发…', 'sys');
    }
  });
}

// ---------- 管理员视图 ----------
async function bootAdmin() {
  $('#admin-view').hidden = false;
  await refreshAdmin();
}

async function refreshAdmin() {
  const snapshot = await api('/api/admin/state');
  const me = await api('/api/me');
  renderAccess(snapshot);
  renderAdminTasks(snapshot);
}

function renderAccess(snapshot) {
  const panel = $('#access-panel');
  panel.replaceChildren();
  const employeeId = 'u1';
  for (const project of snapshot.projects) {
    const member = snapshot.memberships.some(
      (m) => m.userId === employeeId && m.projectId === project.id
    );
    panel.append(el('div', { class: 'row', style: 'margin:10px 0' },
      el('strong', { style: 'min-width:120px' }, project.name),
      member
        ? el('button', {
            class: 'danger',
            onClick: () => setAccess(employeeId, project.id, false),
          }, '移出员工（撤销权限）')
        : el('button', {
            class: 'ok',
            onClick: () => setAccess(employeeId, project.id, true),
          }, '加回员工（恢复权限）')
    ));
  }
}

async function setAccess(userId, projectId, grant) {
  await api('/api/admin/access', {
    method: 'POST',
    body: JSON.stringify({ userId, projectId, grant }),
  });
  refreshAdmin();
}

function renderAdminTasks(snapshot) {
  const grid = $('#admin-tasks');
  grid.replaceChildren();
  for (const project of snapshot.projects) {
    const card = el('div', { class: 'project-card' }, el('h3', {}, project.name));
    for (const task of snapshot.tasks.filter((t) => t.projectId === project.id)) {
      card.append(el('div', { class: 'task' },
        el('span', {}, `${task.title}（${task.status}）`),
        el('button', {
          class: 'small',
          onClick: () => advanceTask(task.id),
        }, '推进状态')
      ));
    }
    grid.append(card);
  }
}

async function advanceTask(taskId) {
  await api('/api/admin/tasks/update', {
    method: 'POST',
    body: JSON.stringify({ taskId }),
  });
  refreshAdmin();
}
