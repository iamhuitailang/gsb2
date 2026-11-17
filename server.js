// 本地服务：SSE 实时推送 + 服务端权限过滤
//
// 安全要点：
// 1. /api/stream 不接受任何"订阅哪些项目"的入参，订阅集合只由 token 对应用户的
//    成员关系决定（store.accessibleProjectIds），浏览器切换页面/改请求都无法扩权。
// 2. 每条事件推送前实时校验权限，撤权后的连接立即收不到该项目的新事件，
//    同时收到一条 permission.revoked 控制事件用于清理界面。
// 3. 重连补发（Last-Event-ID）、历史列表、未读数共用 store.visibleEvents /
//    accessibleProjectIds，撤权后旧标题不会再由任何接口返回。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  STATUS_FLOW,
  accessibleProjectIds,
  adminSnapshot,
  canAccessProject,
  employeeSnapshot,
  getTask,
  getUserByToken,
  markProjectRead,
  resetState,
  setProjectAccess,
  updateTask,
  visibleEvents,
} from './store.js';

// PORT=0 时由内核分配空闲端口（测试场景用）；默认 3000
const PORT = Number.isInteger(Number(process.env.PORT)) && Number(process.env.PORT) >= 0
  ? Number(process.env.PORT)
  : 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// 在线 SSE 连接：userId -> Set<res>
const clients = new Map();

function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
}

function removeClient(userId, res) {
  const set = clients.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(userId);
}

// ---- HTTP 小工具 ----
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// 从 Authorization: Bearer 或 ?token= 取身份（SSE 的 EventSource 无法自定义请求头）
function authenticate(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return getUserByToken(header.slice(7).trim());
  }
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  return token ? getUserByToken(token) : null;
}

// ---- SSE ----
function writeSseEvent(res, event, data) {
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.payload ?? data)}\n\n`);
}

function handleStream(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  // 建立连接时服务端主动下发当前订阅范围，客户端无权修改
  writeSseEvent(res, { id: 0, type: 'subscribed', payload: { projectIds: accessibleProjectIds(user.id) } });

  // 断线重连补发：按"当前"权限过滤 afterId 之后的事件
  const lastId = Number(req.headers['last-event-id']) || 0;
  for (const event of visibleEvents(user.id, lastId)) {
    writeSseEvent(res, event, event);
  }

  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(user.id, res);
  });
  addClient(user.id, res);
}

// 推送前再次实时校验权限——这是撤权即时生效的关键
function broadcastTaskEvent(event) {
  for (const [userId, connections] of clients) {
    if (!canAccessProject(userId, event.projectId)) continue;
    for (const res of connections) writeSseEvent(res, event, event);
  }
}

function broadcastControlEvent(event) {
  const connections = clients.get(event.targetUserId);
  if (!connections) return;
  for (const res of connections) writeSseEvent(res, event, event);
}

// ---- 业务路由 ----
async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/health') return sendJson(res, 200, { ok: true });

  if (route === 'POST /api/test/reset') {
    resetState();
    return sendJson(res, 200, { ok: true });
  }

  const user = authenticate(req);
  if (!user) return sendJson(res, 401, { error: '未认证：token 无效' });

  if (route === 'GET /api/me') {
    return sendJson(res, 200, {
      id: user.id,
      name: user.name,
      role: user.role,
      projectIds: accessibleProjectIds(user.id),
    });
  }

  // 员工面板数据：项目、任务、事件列表、未读数，全部已按当前权限过滤
  if (route === 'GET /api/state') {
    return sendJson(res, 200, employeeSnapshot(user.id));
  }

  // 显式校验越权读取：即使猜到项目 id，撤权后也拿不到任何内容
  if (req.method === 'GET' && url.pathname.startsWith('/api/projects/')) {
    const projectId = url.pathname.split('/')[3];
    if (!canAccessProject(user.id, projectId)) {
      return sendJson(res, 403, { error: '无权访问该项目' });
    }
    const snapshot = employeeSnapshot(user.id);
    return sendJson(res, 200, {
      events: snapshot.events.filter((e) => e.projectId === projectId),
      unread: snapshot.unread[projectId] || 0,
    });
  }

  if (route === 'POST /api/read') {
    const body = await readBody(req);
    if (!canAccessProject(user.id, body.projectId)) {
      return sendJson(res, 403, { error: '无权访问该项目' });
    }
    markProjectRead(user.id, body.projectId);
    return sendJson(res, 200, { ok: true, unread: employeeSnapshot(user.id).unread });
  }

  if (route === 'GET /api/stream') {
    return handleStream(req, res, user);
  }

  // ---- 以下仅管理员 ----
  if (user.role !== 'admin') return sendJson(res, 403, { error: '需要管理员权限' });

  if (route === 'GET /api/admin/state') {
    return sendJson(res, 200, adminSnapshot());
  }

  if (route === 'POST /api/admin/tasks/update') {
    const body = await readBody(req);
    const task = getTask(body.taskId);
    if (!task) return sendJson(res, 404, { error: '任务不存在' });
    if (body.status && !STATUS_FLOW.includes(body.status)) {
      return sendJson(res, 400, { error: '非法状态' });
    }
    const result = updateTask(body.taskId, body.status);
    broadcastTaskEvent(result.event);
    return sendJson(res, 200, { task: result.task, event: result.event });
  }

  if (route === 'POST /api/admin/access') {
    const body = await readBody(req);
    const outcome = setProjectAccess(body.userId, body.projectId, !!body.grant);
    if (!outcome) return sendJson(res, 400, { error: '用户或项目不存在' });
    if (outcome.changed) broadcastControlEvent(outcome.event);
    return sendJson(res, 200, {
      ok: true,
      changed: outcome.changed,
      projectIds: accessibleProjectIds(body.userId),
    });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

// ---- 静态页面 ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method === 'GET') return await serveStatic(req, res, url);
    sendJson(res, 405, { error: 'Method Not Allowed' });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => {
  const actualPort = server.address().port;
  console.log(`项目面板服务已启动: http://localhost:${actualPort}`);
  console.log('员工 token: employee-token ｜ 管理员 token: admin-token');
});
