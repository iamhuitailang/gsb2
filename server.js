'use strict';
/**
 * 项目面板实时推送服务（零依赖，Node >= 18）
 *
 * 安全模型：
 * - 用户能访问哪些项目只由服务端 permissions 表决定；
 * - SSE 推送、事件补发、任务列表、未读数全部在服务端按“当前”权限过滤；
 * - 管理员撤权后：已连接客户端立即收不到该项目更新（广播时逐连接鉴权），
 *   断线重连的补发、历史事件接口、未读数同样不再包含该项目。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-secret';

// ---------------- 数据（内存态，重启即重置） ----------------
const users = {
  alice: { password: 'alice123', displayName: '员工 Alice' },
  bob: { password: 'bob123', displayName: '员工 Bob' },
};

const projects = {
  alpha: { id: 'alpha', name: '甲项目' },
  beta: { id: 'beta', name: '乙项目' },
};

// 权限表：唯一事实来源，只能由管理员接口修改
const permissions = {
  alice: new Set(['alpha', 'beta']),
  bob: new Set(['beta']),
};

const tasks = {
  alpha: [
    { id: 'a1', projectId: 'alpha', title: '甲项目任务一：需求评审', status: '进行中' },
    { id: 'a2', projectId: 'alpha', title: '甲项目任务二：接口联调', status: '待办' },
  ],
  beta: [
    { id: 'b1', projectId: 'beta', title: '乙项目任务一：页面开发', status: '进行中' },
    { id: 'b2', projectId: 'beta', title: '乙项目任务二：测试用例', status: '待办' },
  ],
};

// 事件日志：断线重连补发的数据源
const events = []; // { id, projectId, taskId, title, status, ts }
let nextEventId = 1;

const sessions = new Map(); // token -> username
const sseClients = new Set(); // { res, username }
const lastRead = {}; // username -> 已读到的最大事件 id

function permittedProjects(username) {
  return permissions[username] || new Set();
}

function permittedEvents(username, sinceId = 0) {
  const allowed = permittedProjects(username);
  return events.filter((e) => e.id > sinceId && allowed.has(e.projectId));
}

// ---------------- SSE ----------------
function sseSend(res, type, data, id) {
  let frame = '';
  if (id !== undefined) frame += `id: ${id}\n`;
  frame += `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  res.write(frame);
}

function broadcast(ev) {
  for (const client of sseClients) {
    // 关键：每次推送前按“当前”权限判断，撤权后已连着的客户端立即收不到
    if (!permittedProjects(client.username).has(ev.projectId)) continue;
    sseSend(client.res, 'task', ev, ev.id);
  }
}

// 权限变化时主动通知该用户的所有连接，让客户端丢弃失效数据并重新拉取
function notifyPermissionChange(username) {
  for (const client of sseClients) {
    if (client.username !== username) continue;
    sseSend(client.res, 'sync', { projects: [...permittedProjects(username)] });
  }
}

function recordEvent(projectId, task) {
  const ev = {
    id: nextEventId++,
    projectId,
    taskId: task.id,
    title: task.title,
    status: task.status,
    ts: Date.now(),
  };
  events.push(ev);
  broadcast(ev);
  return ev;
}

// 预置两条任务动态，作为补发/历史数据
for (const pid of Object.keys(tasks)) {
  for (const t of tasks[pid]) recordEvent(pid, t);
}

// ---------------- HTTP 工具 ----------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function currentUser(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)token=([^;]+)/);
  return m ? sessions.get(m[1]) || null : null;
}

// ---------------- 路由 ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  // 静态页面
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    return;
  }

  // 登录
  if (req.method === 'POST' && pathname === '/login') {
    const { user, password } = await readBody(req);
    if (!users[user] || users[user].password !== password) {
      return sendJson(res, 401, { error: '用户名或密码错误' });
    }
    const token = crypto.randomBytes(16).toString('hex');
    sessions.set(token, user);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `token=${token}; HttpOnly; Path=/; SameSite=Strict`,
    });
    res.end(JSON.stringify({ ok: true, displayName: users[user].displayName }));
    return;
  }

  // ---- 管理员接口（Bearer 鉴权）----
  if (pathname.startsWith('/admin/')) {
    if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
      return sendJson(res, 403, { error: '需要管理员令牌' });
    }
    const body = await readBody(req);

    if (req.method === 'POST' && pathname === '/admin/revoke') {
      const { user, project } = body;
      if (permissions[user]) permissions[user].delete(project);
      notifyPermissionChange(user);
      return sendJson(res, 200, { ok: true, projects: [...permittedProjects(user)] });
    }

    if (req.method === 'POST' && pathname === '/admin/grant') {
      const { user, project } = body;
      if (!permissions[user]) permissions[user] = new Set();
      permissions[user].add(project);
      notifyPermissionChange(user);
      return sendJson(res, 200, { ok: true, projects: [...permittedProjects(user)] });
    }

    if (req.method === 'POST' && pathname === '/admin/task') {
      const { project, taskId, status } = body;
      const task = (tasks[project] || []).find((t) => t.id === taskId);
      if (!task) return sendJson(res, 404, { error: '任务不存在' });
      task.status = status || task.status;
      const ev = recordEvent(project, task);
      return sendJson(res, 200, { ok: true, event: ev });
    }

    return sendJson(res, 404, { error: '未知管理接口' });
  }

  // ---- 以下均需登录 ----
  const username = currentUser(req);
  if (!username) return sendJson(res, 401, { error: '未登录' });

  if (req.method === 'GET' && pathname === '/api/me') {
    return sendJson(res, 200, {
      user: username,
      displayName: users[username].displayName,
      projects: [...permittedProjects(username)].map((id) => projects[id]),
    });
  }

  // SSE 实时推送：订阅范围完全由服务端权限决定，客户端无法指定项目
  if (req.method === 'GET' && pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    // 断线重连补发：按 Last-Event-ID 补，但只补当前仍有权限的项目
    const since = parseInt(req.headers['last-event-id'] || '0', 10) || 0;
    for (const ev of permittedEvents(username, since)) {
      sseSend(res, 'task', ev, ev.id);
    }

    const client = { res, username };
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
    return;
  }

  // 任务列表：只返回有权限的项目
  if (req.method === 'GET' && pathname === '/api/tasks') {
    const allowed = permittedProjects(username);
    const out = {};
    for (const pid of allowed) out[pid] = { project: projects[pid], tasks: tasks[pid] };
    return sendJson(res, 200, out);
  }

  // 历史事件：撤权后这里也不再返回该项目，旧标题无法再通过接口拿到
  if (req.method === 'GET' && pathname === '/api/events') {
    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    return sendJson(res, 200, { events: permittedEvents(username, since) });
  }

  // 未读数：按当前权限计算，撤权后自动减少
  if (req.method === 'GET' && pathname === '/api/unread') {
    const readTo = lastRead[username] || 0;
    const unread = permittedEvents(username, readTo);
    const perProject = {};
    for (const ev of unread) perProject[ev.projectId] = (perProject[ev.projectId] || 0) + 1;
    return sendJson(res, 200, { total: unread.length, perProject });
  }

  if (req.method === 'POST' && pathname === '/api/read') {
    const { id } = await readBody(req);
    lastRead[username] = Math.max(lastRead[username] || 0, id || 0);
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`项目面板服务已启动: http://localhost:${PORT}`);
  console.log(`管理员令牌: ${ADMIN_TOKEN}（可用 ADMIN_TOKEN 环境变量覆盖）`);
});
