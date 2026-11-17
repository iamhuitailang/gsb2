// 本地工单服务（Node 内置模块，零第三方依赖）。
// 身份由 HttpOnly Cookie 会话承载，URL 本身不携带任何身份或脱敏开关。

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  users,
  tickets,
  SENSITIVE_FIELDS,
  createGrantRequest,
  decideGrant,
  revokeGrant,
  grantRequests,
  auditLogs,
  scrubPhoneNumbers,
  addAuditLog,
  GRANT_TTL_SECONDS,
} from './store.js';
import { serializeTicket, serializeTickets } from './masking.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const sessions = new Map(); // sid -> userId
const SENSITIVE_KEYS = new Set(SENSITIVE_FIELDS.map((f) => f.key));

// ---------- 基础工具 ----------

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    cookies[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

function currentUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const userId = sessions.get(sid);
  return users.find((u) => u.id === userId) || null;
}

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
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- 业务处理 ----------

async function handleLogin(req, res) {
  const body = await readBody(req);
  const user = users.find((u) => u.id === body.userId);
  if (!user) return sendJson(res, 400, { error: '用户不存在' });

  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, user.id);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`,
    'Cache-Control': 'no-store',
  });
  addAuditLog({ action: 'auth.login', actorId: user.id, actorName: user.name });
  res.end(JSON.stringify({ user: publicUser(user) }));
}

function handleLogout(req, res) {
  const sid = parseCookies(req).sid;
  const user = currentUser(req);
  if (sid) sessions.delete(sid);
  if (user) {
    addAuditLog({ action: 'auth.logout', actorId: user.id, actorName: user.name });
  }
  res.writeHead(200, {
    'Set-Cookie': 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0',
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify({ ok: true }));
}

function publicUser(user) {
  return { id: user.id, name: user.name, role: user.role };
}

function handleListTickets(req, res, user, url) {
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  let result = tickets;
  if (q) {
    // 搜索只匹配工单号、客户名、状态，刻意不提供按手机号检索的能力，
    // 避免搜索接口变成号码探测入口。
    result = tickets.filter((t) =>
      [t.id, t.customer, t.status].some((v) => v.toLowerCase().includes(q))
    );
  }
  sendJson(res, 200, { tickets: serializeTickets(result, user) });
}

function handleTicketDetail(req, res, user, ticketId) {
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) return sendJson(res, 404, { error: '工单不存在' });
  sendJson(res, 200, { ticket: serializeTicket(ticket, user) });
}

function handleExportCsv(req, res, user, ticketId) {
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) return sendJson(res, 404, { error: '工单不存在' });

  // 导出与详情走同一个序列化函数：授权决定明文，且每次明文导出都留审计。
  const data = serializeTicket(ticket, user);
  addAuditLog({
    action: 'export.csv',
    actorId: user.id,
    actorName: user.name,
    ticketId: ticket.id,
  });

  const header = ['工单号', '客户', '状态', '地址', '联系电话', '备用电话', '建单时间', '备注'];
  const row = [
    data.id,
    data.customer,
    data.status,
    data.address,
    data.phone,
    data.backupPhone,
    data.createdAt,
    data.note,
  ].map(csvEscape);
  // BOM 让 Excel 正确识别 UTF-8。
  const csv = '﻿' + header.join(',') + '\n' + row.join(',') + '\n';
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="ticket-${ticket.id}.csv"`,
    'Cache-Control': 'no-store',
  });
  res.end(csv);
}

async function handleCreateGrant(req, res, user) {
  const body = await readBody(req);
  const { ticketId, field } = body;
  const reason = scrubPhoneNumbers(String(body.reason || '').trim());

  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) return sendJson(res, 404, { error: '工单不存在' });
  if (!SENSITIVE_KEYS.has(field)) return sendJson(res, 400, { error: '不支持的敏感字段' });
  if (!reason) return sendJson(res, 400, { error: '请填写申请理由（物流问题说明）' });

  const record = createGrantRequest({ userId: user.id, ticketId, field, reason });
  if (record.status === 'pending' && record.reason !== reason) {
    record.reason = reason;
  }
  addAuditLog({
    action: 'grant.request',
    actorId: user.id,
    actorName: user.name,
    grantId: record.id,
    ticketId,
    field,
    reason,
  });
  sendJson(res, 201, { grant: publicGrant(record) });
}

function publicGrant(record) {
  const applicant = users.find((u) => u.id === record.userId);
  return {
    ...record,
    userName: applicant ? applicant.name : record.userId,
    fieldLabel: (SENSITIVE_FIELDS.find((f) => f.key === record.field) || {}).label || record.field,
    ttlSeconds: GRANT_TTL_SECONDS,
  };
}

function handleListGrants(req, res, user) {
  const list =
    user.role === 'supervisor'
      ? grantRequests
      : grantRequests.filter((g) => g.userId === user.id);
  sendJson(res, 200, { grants: list.map(publicGrant) });
}

function handleGrantDecision(req, res, supervisor, id, approve) {
  const record = approve
    ? decideGrant(id, supervisor.id, true)
    : decideGrant(id, supervisor.id, false);
  if (!record) return sendJson(res, 404, { error: '待审批申请不存在或已处理' });
  addAuditLog({
    action: approve ? 'grant.approve' : 'grant.reject',
    actorId: supervisor.id,
    actorName: supervisor.name,
    grantId: record.id,
    ticketId: record.ticketId,
    field: record.field,
    targetUserId: record.userId,
  });
  sendJson(res, 200, { grant: publicGrant(record) });
}

function handleRevoke(req, res, supervisor, id) {
  const record = revokeGrant(id, supervisor.id);
  if (!record) return sendJson(res, 404, { error: '生效中的授权不存在' });
  addAuditLog({
    action: 'grant.revoke',
    actorId: supervisor.id,
    actorName: supervisor.name,
    grantId: record.id,
    ticketId: record.ticketId,
    field: record.field,
    targetUserId: record.userId,
  });
  sendJson(res, 200, { grant: publicGrant(record) });
}

function handleAuditLogs(req, res) {
  sendJson(res, 200, { logs: auditLogs });
}

// ---------- 静态文件 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  // 防目录穿越。
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    });
    res.end(data);
  });
}

// ---------- 路由 ----------

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  try {
    if (pathname === '/api/login' && req.method === 'POST') return await handleLogin(req, res);

    const user = currentUser(req);
    if (pathname.startsWith('/api/') && !user) {
      return sendJson(res, 401, { error: '未登录或会话已失效' });
    }

    if (pathname === '/api/logout' && req.method === 'POST') return handleLogout(req, res);
    if (pathname === '/api/me' && req.method === 'GET') {
      return sendJson(res, 200, { user: publicUser(user), ttlSeconds: GRANT_TTL_SECONDS });
    }

    if (pathname === '/api/tickets' && req.method === 'GET') {
      return handleListTickets(req, res, user, url);
    }
    const detailMatch = pathname.match(/^\/api\/tickets\/([\w-]+)$/);
    if (detailMatch && req.method === 'GET') {
      return handleTicketDetail(req, res, user, detailMatch[1]);
    }
    const exportMatch = pathname.match(/^\/api\/tickets\/([\w-]+)\/export$/);
    if (exportMatch && req.method === 'GET') {
      return handleExportCsv(req, res, user, exportMatch[1]);
    }

    if (pathname === '/api/grants' && req.method === 'POST') {
      if (user.role !== 'agent') return sendJson(res, 403, { error: '仅客服可申请授权' });
      return await handleCreateGrant(req, res, user);
    }
    if (pathname === '/api/grants' && req.method === 'GET') {
      return handleListGrants(req, res, user);
    }
    const decisionMatch = pathname.match(/^\/api\/grants\/([\w-]+)\/(approve|reject|revoke)$/);
    if (decisionMatch && req.method === 'POST') {
      if (user.role !== 'supervisor') return sendJson(res, 403, { error: '仅主管可审批' });
      const [, id, action] = decisionMatch;
      if (action === 'revoke') return handleRevoke(req, res, user, id);
      return handleGrantDecision(req, res, user, id, action === 'approve');
    }

    if (pathname === '/api/audit-logs' && req.method === 'GET') {
      if (user.role !== 'supervisor') return sendJson(res, 403, { error: '仅主管可查看审计' });
      return handleAuditLogs(req, res);
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: '接口不存在' });
    return serveStatic(req, res, url);
  } catch (err) {
    sendJson(res, 400, { error: err.message || '请求处理失败' });
  }
}

export function createServer() {
  return http.createServer(handler);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`工单系统已启动: http://localhost:${port}`);
    console.log(`临时授权有效期: ${GRANT_TTL_SECONDS} 秒（GRANT_TTL_SECONDS 环境变量可调整）`);
  });
}
