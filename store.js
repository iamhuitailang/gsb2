// 内存数据层：用户、项目成员关系、任务、事件流、已读水位
// 所有"该用户能看到什么"的判断都收敛到 accessibleProjectIds / visibleEvents 两个函数，
// 实时推送、补发、历史接口、未读数共用同一套过滤逻辑，避免各接口口径不一致。

export const STATUS_FLOW = ['待处理', '进行中', '评审中', '已完成'];

const nextStatus = (current) => {
  const i = STATUS_FLOW.indexOf(current);
  return STATUS_FLOW[(i + 1) % STATUS_FLOW.length];
};

// 初始演示数据：甲、乙两个项目，每个项目两条任务，员工对两个项目都有权限
function seedState() {
  return {
    seq: 0,
    users: [
      { id: 'u1', name: '员工小赵', token: 'employee-token', role: 'employee' },
      { id: 'admin', name: '管理员', token: 'admin-token', role: 'admin' },
    ],
    projects: [
      { id: 'proj-alpha', name: '甲项目' },
      { id: 'proj-beta', name: '乙项目' },
    ],
    // 项目成员关系是唯一的权限来源，浏览器无法自行修改
    memberships: [
      { userId: 'u1', projectId: 'proj-alpha' },
      { userId: 'u1', projectId: 'proj-beta' },
    ],
    tasks: [
      { id: 't-a1', projectId: 'proj-alpha', title: '甲-任务1：接口联调', status: '待处理' },
      { id: 't-a2', projectId: 'proj-alpha', title: '甲-任务2：上线检查单', status: '待处理' },
      { id: 't-b1', projectId: 'proj-beta', title: '乙-任务1：数据迁移', status: '待处理' },
      { id: 't-b2', projectId: 'proj-beta', title: '乙-任务2：灰度发布', status: '待处理' },
    ],
    // 全局事件流（只追加）。撤回权限不删除历史，读取时按当前成员关系过滤
    events: [],
    // 每用户每项目的已读水位（已读到哪个事件 id）
    readWatermarks: {},
  };
}

let state = seedState();

export function resetState() {
  state = seedState();
}

export function getUserByToken(token) {
  return state.users.find((u) => u.token === token) || null;
}

export function getUser(userId) {
  return state.users.find((u) => u.id === userId) || null;
}

// 服务端判定某用户当前有权访问的项目；admin 可看全部
export function accessibleProjectIds(userId) {
  const user = getUser(userId);
  if (!user) return [];
  if (user.role === 'admin') return state.projects.map((p) => p.id);
  return state.memberships
    .filter((m) => m.userId === userId)
    .map((m) => m.projectId);
}

export function canAccessProject(userId, projectId) {
  return accessibleProjectIds(userId).includes(projectId);
}

export function getProjects() {
  return state.projects.map((p) => ({ ...p }));
}

export function getTasksForUser(userId) {
  const allowed = new Set(accessibleProjectIds(userId));
  return state.tasks
    .filter((t) => allowed.has(t.projectId))
    .map((t) => ({ ...t }));
}

export function getTask(taskId) {
  return state.tasks.find((t) => t.id === taskId) || null;
}

// 追加一条任务更新事件（全局流，权限在读取/推送时再过滤）
export function appendTaskEvent(task, oldStatus) {
  const event = {
    id: ++state.seq,
    type: 'task.updated',
    projectId: task.projectId,
    taskId: task.id,
    title: task.title,
    status: task.status,
    oldStatus,
    time: new Date().toISOString(),
  };
  state.events.push(event);
  return event;
}

export function updateTask(taskId, newStatus) {
  const task = getTask(taskId);
  if (!task) return null;
  const oldStatus = task.status;
  task.status = newStatus || nextStatus(oldStatus);
  return { task, event: appendTaskEvent(task, oldStatus) };
}

// 权限变更事件也进全局流，重连补发时客户端可据此重建撤权状态
function appendControlEvent(type, userId, projectId) {
  const event = {
    id: ++state.seq,
    type,
    projectId,
    targetUserId: userId,
    title: null,
    time: new Date().toISOString(),
  };
  state.events.push(event);
  return event;
}

// 员工当前可见的事件 = 全局事件 ∩ 当前有权限的项目。
// 撤权事件本身按项目过滤（撤权后不再可见）；授权事件不受项目过滤限制，
// 否则用户重新获得权限时无法通过补发重建状态。
export function visibleEvents(userId, afterId = 0) {
  const allowed = new Set(accessibleProjectIds(userId));
  return state.events.filter(
    (e) =>
      e.id > afterId &&
      (e.type === 'permission.granted'
        ? e.targetUserId === userId
        : allowed.has(e.projectId))
  );
}

// 未读数按"每项目已读水位"统计，撤权后该项目整体不再计入
export function getUnreadCounts(userId) {
  const watermarks = state.readWatermarks[userId] || {};
  const counts = {};
  for (const e of state.events) {
    if (e.type !== 'task.updated' || !canAccessProject(userId, e.projectId)) continue;
    if (e.id > (watermarks[e.projectId] || 0)) {
      counts[e.projectId] = (counts[e.projectId] || 0) + 1;
    }
  }
  return counts;
}

export function markProjectRead(userId, projectId) {
  if (!canAccessProject(userId, projectId)) return false;
  const latest = state.events.reduce(
    (max, e) => (e.projectId === projectId && e.type === 'task.updated' ? Math.max(max, e.id) : max),
    0
  );
  if (!state.readWatermarks[userId]) state.readWatermarks[userId] = {};
  state.readWatermarks[userId][projectId] = latest;
  return true;
}

// 管理员调整成员关系。撤权后：在线连接由 server.js 实时剔除，历史/未读因走
// accessibleProjectIds 过滤而立即失效，无需删除或改写旧事件。
export function setProjectAccess(userId, projectId, grant) {
  const user = getUser(userId);
  const project = state.projects.find((p) => p.id === projectId);
  if (!user || !project || user.role !== 'employee') return null;
  const idx = state.memberships.findIndex(
    (m) => m.userId === userId && m.projectId === projectId
  );
  const had = idx !== -1;
  if (grant && !had) state.memberships.push({ userId, projectId });
  if (!grant && had) state.memberships.splice(idx, 1);
  if (grant === had) return { changed: false };
  const event = appendControlEvent(
    grant ? 'permission.granted' : 'permission.revoked',
    userId,
    projectId
  );
  return { changed: true, granted: grant, event };
}

// 管理员视角的完整快照（演示页用）
export function adminSnapshot() {
  return {
    projects: getProjects(),
    memberships: state.memberships.map((m) => ({ ...m })),
    tasks: state.tasks.map((t) => ({ ...t })),
    unread: null,
  };
}

// 员工视角快照：只包含当前有权限项目的数据
export function employeeSnapshot(userId) {
  const allowed = accessibleProjectIds(userId);
  return {
    projects: state.projects.filter((p) => allowed.includes(p.id)).map((p) => ({ ...p })),
    tasks: getTasksForUser(userId),
    events: visibleEvents(userId),
    unread: getUnreadCounts(userId),
  };
}
