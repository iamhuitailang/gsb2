import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { createStore, verifyPassword, DEMO_PASSWORD } from './src/store.js';
import { createSessions } from './src/sessions.js';
import { createExports } from './src/exports.js';
import {
  HttpError,
  findUser,
  membershipsOf,
  requireMembership,
  visibleTickets,
  requireTicketAccess,
  isSupervisor,
} from './src/authz.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, 'data');
const PORT = Number(process.env.PORT ?? 4173);
// 默认只监听本机回环地址：这是本地工具，不应该被局域网随意访问。
const HOST = process.env.HOST ?? '127.0.0.1';

const store = createStore(DATA_DIR);
const sessions = createSessions({ secret: process.env.SESSION_SECRET ?? randomBytes(32).toString('hex') });
const exportsQueue = createExports({ store, delayMs: Number(process.env.EXPORT_DELAY_MS ?? 600) });

const MAX_BODY = 1024 * 1024;

// 不存在的用户名也走一次 scrypt，避免通过响应时间枚举账号。
const DUMMY_USER = {
  passwordSalt: 'ffffffffffffffffffffffffffffffff',
  passwordHash: '00'.repeat(64),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return; // 已经超限，继续读完但不再缓存
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError(413, 'BODY_TOO_LARGE', '请求体过大'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!chunks.length) return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(new HttpError(400, 'BAD_JSON', '请求体不是合法 JSON'));
        return;
      }
      // 只接受 JSON 对象，避免 null / 数组让后续解构抛错变成 500。
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(new HttpError(400, 'BAD_BODY', '请求体必须是 JSON 对象'));
        return;
      }
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[part.slice(0, idx).trim()] = decodeURIComponent(raw);
    } catch {
      out[part.slice(0, idx).trim()] = raw;
    }
  }
  return out;
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  const code = err instanceof HttpError ? err.code : 'INTERNAL';
  const message = err instanceof HttpError ? err.message : '服务器内部错误';
  if (status >= 500) console.error(err);
  if (res.headersSent) {
    // 响应已经开始写出，无法再改状态码，只能中断连接。
    res.destroy();
    return;
  }
  sendJson(res, status, { error: { code, message, ...(err.detail ? { detail: err.detail } : {}) } });
}

function ticketDto(ticket) {
  const assignee = store.data.users.find((u) => u.id === ticket.assigneeId);
  return {
    id: ticket.id,
    orgId: ticket.orgId,
    title: ticket.title,
    status: ticket.status,
    description: ticket.description,
    assigneeId: ticket.assigneeId,
    assigneeName: assignee?.name ?? '未分配',
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    attachments: store.data.attachments
      .filter((a) => a.ticketId === ticket.id)
      .map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: Buffer.byteLength(a.content) })),
  };
}

function currentUser(req) {
  const userId = sessions.resolve(parseCookies(req)[sessions.cookieName]);
  if (!userId) throw new HttpError(401, 'UNAUTHENTICATED', '请先登录');
  const user = findUser(store, userId);
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', '请先登录');
  return user;
}

/* ------------------------------ 路由处理 ------------------------------ */

async function handleLogin(req, res) {
  const { username, password } = await readBody(req);
  const user = store.data.users.find((u) => u.username === String(username ?? '').trim());
  // 用户名不存在时也跑一次校验，避免用响应时间枚举账号。
  const ok = user ? verifyPassword(user, String(password ?? '')) : verifyPassword(DUMMY_USER, String(password ?? ''));
  if (!user || !ok) {
    store.audit(null, 'login.failed', { username: String(username ?? '') });
    throw new HttpError(401, 'BAD_CREDENTIALS', '用户名或密码错误');
  }
  const token = sessions.issue(user.id);
  store.audit(user.id, 'login.success', {});
  sendJson(
    res,
    200,
    { user: { id: user.id, username: user.username, name: user.name }, memberships: membershipsOf(store, user.id) },
    { 'set-cookie': sessions.cookieHeader(token) },
  );
}

async function handleLogout(req, res) {
  sessions.revoke(parseCookies(req)[sessions.cookieName]);
  sendJson(res, 200, { ok: true }, { 'set-cookie': sessions.clearHeader() });
}

function handleMe(req, res) {
  const user = currentUser(req);
  sendJson(res, 200, {
    user: { id: user.id, username: user.username, name: user.name },
    memberships: membershipsOf(store, user.id),
  });
}

/** 进入某个机构前先校验，前端切换机构后所有请求都带 orgId。 */
function handleOrgOverview(req, res, orgId) {
  const user = currentUser(req);
  const { org, membership } = requireMembership(store, user.id, orgId);
  const tickets = visibleTickets(store, membership);
  sendJson(res, 200, {
    org: { id: org.id, name: org.name },
    role: membership.role,
    canManage: isSupervisor(membership),
    tickets: tickets
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(ticketDto),
  });
}

function handleTicketDetail(req, res, orgId, ticketId) {
  const user = currentUser(req);
  // 关键：详情每次请求都按“当前”的机构成员关系判断，不复用列表页结果。
  const { membership, ticket } = requireTicketAccess(store, user.id, orgId, ticketId);
  store.audit(user.id, 'ticket.view', { orgId, ticketId, role: membership.role });
  sendJson(res, 200, { role: membership.role, ticket: ticketDto(ticket) });
}

function handleAttachmentDownload(req, res, orgId, ticketId, attachmentId) {
  const user = currentUser(req);
  // 即使详情页还开着，下载也重新校验一次：撤权后旧页面里的链接立即失效。
  const { membership } = requireTicketAccess(store, user.id, orgId, ticketId);
  const attachment = store.data.attachments.find((a) => a.id === attachmentId && a.ticketId === ticketId);
  if (!attachment) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', '附件不存在');
  store.audit(user.id, 'attachment.download', { orgId, ticketId, attachmentId, role: membership.role });
  const body = Buffer.from(attachment.content, 'utf8');
  res.writeHead(200, {
    'content-type': attachment.contentType,
    'content-length': body.length,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function handleEnqueueExport(req, res, orgId) {
  const user = currentUser(req);
  const { membership } = requireMembership(store, user.id, orgId);
  const job = exportsQueue.enqueue({ userId: user.id, orgId, membershipRole: membership.role });
  sendJson(res, 202, { export: exportDto(job) });
}

function exportDto(job) {
  return {
    id: job.id,
    orgId: job.orgId,
    status: job.status,
    rows: job.rows,
    error: job.error,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    expiresAt: job.expiresAt,
  };
}

function handleExportStatus(req, res, orgId, exportId) {
  const user = currentUser(req);
  // 查看状态也要校验机构权限：撤权后连轮询都不该成功。
  const { membership } = requireMembership(store, user.id, orgId);
  const job = exportsQueue.find(exportId);
  if (!job || job.orgId !== orgId) throw new HttpError(404, 'EXPORT_NOT_FOUND', '导出任务不存在');
  if (job.userId !== user.id && !isSupervisor(membership)) {
    throw new HttpError(403, 'EXPORT_FORBIDDEN', '无权查看该导出任务');
  }
  sendJson(res, 200, { export: exportDto(job) });
}

function handleExportDownload(req, res, orgId, exportId) {
  const user = currentUser(req);
  // 取文件时第三次核对：排队入队、生成、下载三个时间点各查一次。
  const { membership } = requireMembership(store, user.id, orgId);
  const job = exportsQueue.find(exportId);
  if (!job || job.orgId !== orgId) throw new HttpError(404, 'EXPORT_NOT_FOUND', '导出任务不存在');
  if (job.userId !== user.id) throw new HttpError(403, 'EXPORT_FORBIDDEN', '无权下载该导出任务');
  if (job.status === 'denied') {
    throw new HttpError(403, 'EXPORT_DENIED', job.error ?? '导出任务已被拒绝');
  }
  if (job.status !== 'ready') throw new HttpError(409, 'EXPORT_NOT_READY', '导出文件尚未生成');
  if (job.expiresAt <= Date.now()) throw new HttpError(410, 'EXPORT_EXPIRED', '导出文件已过期，请重新导出');
  store.audit(user.id, 'export.download', { orgId, exportId, role: membership.role });
  const body = Buffer.from(job.content ?? '', 'utf8');
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-length': body.length,
    'content-disposition': `attachment; filename="${orgId}-tickets-${exportId}.csv"`,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function handleOrgMembers(req, res, orgId) {
  const user = currentUser(req);
  const { membership } = requireMembership(store, user.id, orgId);
  if (!isSupervisor(membership)) throw new HttpError(403, 'NOT_SUPERVISOR', '只有主管可以查看成员权限');
  const rows = store.data.memberships
    .filter((m) => m.orgId === orgId)
    .map((m) => {
      const u = findUser(store, m.userId);
      return {
        membershipId: m.id,
        userId: m.userId,
        name: u?.name ?? m.userId,
        username: u?.username ?? '',
        role: m.role,
        active: m.active === true && !m.revokedAt,
        revokedAt: m.revokedAt,
      };
    });
  sendJson(res, 200, { members: rows });
}

async function handleRevoke(req, res, orgId, membershipId) {
  const user = currentUser(req);
  const { membership: actor } = requireMembership(store, user.id, orgId);
  if (!isSupervisor(actor)) throw new HttpError(403, 'NOT_SUPERVISOR', '只有主管可以撤销权限');

  // 目标必须属于“本机构”，否则撤甲机构时会误伤乙机构。
  const target = store.data.memberships.find((m) => m.id === membershipId && m.orgId === orgId);
  if (!target) throw new HttpError(404, 'MEMBERSHIP_NOT_FOUND', '该成员不属于当前机构');
  if (target.userId === user.id) throw new HttpError(400, 'CANNOT_REVOKE_SELF', '不能撤销自己的权限');

  if (target.active && !target.revokedAt) {
    target.active = false;
    target.revokedAt = Date.now();
    target.revokedBy = user.id;
    store.save();
    store.audit(user.id, 'membership.revoke', { orgId, targetUserId: target.userId, membershipId });
  }
  sendJson(res, 200, { ok: true, membershipId: target.id, orgId, active: false });
}

async function handleRestore(req, res, orgId, membershipId) {
  const user = currentUser(req);
  const { membership: actor } = requireMembership(store, user.id, orgId);
  if (!isSupervisor(actor)) throw new HttpError(403, 'NOT_SUPERVISOR', '只有主管可以恢复权限');
  const target = store.data.memberships.find((m) => m.id === membershipId && m.orgId === orgId);
  if (!target) throw new HttpError(404, 'MEMBERSHIP_NOT_FOUND', '该成员不属于当前机构');
  if (!target.active || target.revokedAt) {
    target.active = true;
    target.revokedAt = null;
    target.revokedBy = null;
    target.grantedAt = Date.now();
    store.save();
    store.audit(user.id, 'membership.restore', { orgId, targetUserId: target.userId, membershipId });
  }
  sendJson(res, 200, { ok: true, membershipId: target.id, orgId, active: true });
}

/* ------------------------------ 路由分发 ------------------------------ */

const routes = [
  ['POST', /^\/api\/login$/, (req, res) => handleLogin(req, res)],
  ['POST', /^\/api\/logout$/, (req, res) => handleLogout(req, res)],
  ['GET', /^\/api\/me$/, (req, res) => handleMe(req, res)],
  ['GET', /^\/api\/orgs\/([^/]+)$/, (req, res, m) => handleOrgOverview(req, res, decodeURIComponent(m[1]))],
  [
    'GET',
    /^\/api\/orgs\/([^/]+)\/tickets\/([^/]+)$/,
    (req, res, m) => handleTicketDetail(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2])),
  ],
  [
    'GET',
    /^\/api\/orgs\/([^/]+)\/tickets\/([^/]+)\/attachments\/([^/]+)$/,
    (req, res, m) =>
      handleAttachmentDownload(
        req,
        res,
        decodeURIComponent(m[1]),
        decodeURIComponent(m[2]),
        decodeURIComponent(m[3]),
      ),
  ],
  [
    'POST',
    /^\/api\/orgs\/([^/]+)\/exports$/,
    (req, res, m) => handleEnqueueExport(req, res, decodeURIComponent(m[1])),
  ],
  [
    'GET',
    /^\/api\/orgs\/([^/]+)\/exports\/([^/]+)$/,
    (req, res, m) => handleExportStatus(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2])),
  ],
  [
    'GET',
    /^\/api\/orgs\/([^/]+)\/exports\/([^/]+)\/file$/,
    (req, res, m) => handleExportDownload(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2])),
  ],
  ['GET', /^\/api\/orgs\/([^/]+)\/members$/, (req, res, m) => handleOrgMembers(req, res, decodeURIComponent(m[1]))],
  [
    'POST',
    /^\/api\/orgs\/([^/]+)\/members\/([^/]+)\/revoke$/,
    (req, res, m) => handleRevoke(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2])),
  ],
  [
    'POST',
    /^\/api\/orgs\/([^/]+)\/members\/([^/]+)\/restore$/,
    (req, res, m) => handleRestore(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2])),
  ],
];

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'NOT_FOUND', '页面不存在');
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new HttpError(404, 'NOT_FOUND', '页面不存在');
  }
  if (!info.isFile()) throw new HttpError(404, 'NOT_FOUND', '页面不存在');
  const body = await readFile(filePath);
  res.writeHead(200, {
    'content-type': STATIC_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      for (const [method, pattern, handler] of routes) {
        const m = pattern.exec(url.pathname);
        if (!m) continue;
        if (method !== req.method) throw new HttpError(405, 'METHOD_NOT_ALLOWED', '请求方法不支持');
        await handler(req, res, m);
        return;
      }
      throw new HttpError(404, 'NOT_FOUND', '接口不存在');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '请求方法不支持');
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    sendError(res, err);
  }
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`工单后台已启动: http://${HOST}:${port}`);
  console.log(`演示账号（密码均为 ${DEMO_PASSWORD}）：li=李强[主管/甲+乙]  wang=王敏[员工/甲+乙]  zhao=赵磊[员工/甲]`);
  console.log(`数据目录: ${DATA_DIR}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    exportsQueue.cancelAll();
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    // 兜底：有连接未关闭时也不要挂住进程
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
