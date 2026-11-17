// 本地演示后台（零依赖）。
// 设计要点：
//  1. 会话 Cookie 只标识「当前是谁」，绝不在服务端保存「当前组织」——否则多个标签会互相串台。
//  2. 组织上下文由每个标签自己的 URL 承载（/o/:orgId/customers/:no），刷新、回退、复制地址都能还原。
//  3. 每个读写接口都以「请求里的 orgId + 本地客户编号」定位资源，并在查资源之前先校验成员权限。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createStore, REMARK_MAX_LENGTH } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const JSON_LIMIT = 64 * 1024;
const MAX_DELAY_MS = 5000;
const SESSION_COOKIE = 'sid';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createApp({ demoMode = true } = {}) {
  const store = createStore();
  /** @type {Map<string, string>} token -> userId */
  const sessions = new Map();
  /** @type {Map<string, number>} user 最近一次“在网络中”的请求，仅用于演示慢响应时机的可观测性 */
  const activity = new Map();

  function parseCookies(header) {
    const out = new Map();
    if (!header) return out;
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const name = part.slice(0, idx).trim();
      let value = part.slice(idx + 1).trim();
      // 畸形编码的 Cookie 不能让整个请求 500，直接当作无效值。
      try {
        value = decodeURIComponent(value);
      } catch {
        value = '';
      }
      out.set(name, value);
    }
    return out;
  }

  function sessionUser(req) {
    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (!token) return null;
    const userId = sessions.get(token);
    if (!userId) return null;
    const user = store.getUser(userId);
    if (!user) {
      sessions.delete(token);
      return null;
    }
    return { token, user };
  }

  function sendJson(res, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...extraHeaders,
    });
    res.end(body);
  }

  function sendError(res, status, code, message, extra = {}) {
    sendJson(res, status, { error: { code, message, ...extra } });
  }

  async function readJsonBody(req) {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      const err = new Error('请求必须使用 application/json');
      err.status = 415;
      err.code = 'UNSUPPORTED_MEDIA_TYPE';
      throw err;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > JSON_LIMIT) {
        const err = new Error('请求体过大');
        err.status = 413;
        err.code = 'PAYLOAD_TOO_LARGE';
        throw err;
      }
      chunks.push(chunk);
    }
    if (size === 0) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const err = new Error('请求体必须是 JSON 对象');
        err.status = 400;
        err.code = 'INVALID_JSON';
        throw err;
      }
      return parsed;
    } catch (e) {
      if (e.status) throw e;
      const err = new Error('请求体不是合法 JSON');
      err.status = 400;
      err.code = 'INVALID_JSON';
      throw err;
    }
  }

  // 本地演示用的同源校验：浏览器发来的写请求若带 Origin，必须与 Host 一致。
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  function requireUser(res, req) {
    const session = sessionUser(req);
    if (!session) {
      sendError(res, 401, 'UNAUTHENTICATED', '请先登录');
      return null;
    }
    return session;
  }

  // 权限判定：未知组织 404，非成员 403。必须在读取客户数据之前调用，避免泄露他组织是否存在该客户。
  function requireOrgAccess(res, session, orgId) {
    if (!store.getOrg(orgId)) {
      sendError(res, 404, 'ORG_NOT_FOUND', '组织不存在');
      return null;
    }
    if (!store.isMember(session.user.id, orgId)) {
      sendError(res, 403, 'ORG_FORBIDDEN', '当前账号没有该组织的权限', { orgId });
      return null;
    }
    return store.getOrg(orgId);
  }

  function normalizeCustomerNo(raw) {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value || value.length > 64 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    return value;
  }

  function parseDelay(value) {
    if (!demoMode || value == null) return 0;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.floor(n), MAX_DELAY_MS);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 路径参数解码：畸形的百分号编码返回 null，由调用方以 400 处理，而不是冒成 500。
  const safeDecode = (raw) => {
    try {
      const value = decodeURIComponent(raw);
      return value.includes('/') ? null : value;
    } catch {
      return null;
    }
  };

  // ---- API 路由 ----
  async function handleApi(req, res, url) {
    const { pathname, searchParams } = url;
    const method = req.method;

    if (method === 'GET' && pathname === '/api/session') {
      const session = sessionUser(req);
      if (!session) {
        return sendJson(res, 200, {
          user: null,
          orgs: [],
          demoUsers: demoMode ? store.listDemoUsers() : [],
          demo: demoMode,
        });
      }
      return sendJson(res, 200, {
        user: { id: session.user.id, name: session.user.name },
        orgs: store.listOrgsFor(session.user.id),
        demoUsers: demoMode ? store.listDemoUsers() : [],
        demo: demoMode,
      });
    }

    if (method === 'POST' && pathname === '/api/login') {
      if (!sameOrigin(req)) return sendError(res, 403, 'BAD_ORIGIN', '来源不合法');
      const body = await readJsonBody(req);
      const user = typeof body.userId === 'string' ? store.getUser(body.userId) : null;
      if (!user) return sendError(res, 400, 'UNKNOWN_USER', '演示账号不存在');
      const token = randomBytes(24).toString('hex');
      sessions.set(token, user.id);
      const previous = sessionUser(req);
      if (previous && previous.token !== token) sessions.delete(previous.token);
      return sendJson(
        res,
        200,
        { user: { id: user.id, name: user.name }, orgs: store.listOrgsFor(user.id) },
        { 'set-cookie': `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax` },
      );
    }

    if (method === 'POST' && pathname === '/api/logout') {
      if (!sameOrigin(req)) return sendError(res, 403, 'BAD_ORIGIN', '来源不合法');
      const session = sessionUser(req);
      if (session) sessions.delete(session.token);
      return sendJson(res, 200, { ok: true }, { 'set-cookie': `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0` });
    }

    // GET /api/orgs/:orgId/customers/:localCustomerNo
    const readMatch = pathname.match(/^\/api\/orgs\/([^/]+)\/customers\/([^/]+)$/);
    if (method === 'GET' && readMatch) {
      const session = requireUser(res, req);
      if (!session) return;
      const orgId = safeDecode(readMatch[1]);
      if (!orgId) return sendError(res, 400, 'INVALID_ORG', '组织标识不合法');
      if (!requireOrgAccess(res, session, orgId)) return;
      const localCustomerNo = normalizeCustomerNo(safeDecode(readMatch[2]));
      if (!localCustomerNo) return sendError(res, 400, 'INVALID_CUSTOMER_NO', '客户编号不合法');

      const delay = parseDelay(searchParams.get('delayMs'));
      if (delay) {
        activity.set(session.user.id, Date.now());
        await sleep(delay);
      }
      // 延迟之后重新校验一次：慢请求在路上期间，成员关系可能已被收回，会话也可能已失效。
      if (!sessionUser(req)) return sendError(res, 401, 'UNAUTHENTICATED', '请先登录');
      if (!requireOrgAccess(res, session, orgId)) return;
      const customer = store.getCustomer(orgId, localCustomerNo);
      if (!customer) return sendError(res, 404, 'CUSTOMER_NOT_FOUND', '该组织下没有这个客户编号');
      return sendJson(res, 200, {
        org: { id: orgId, name: store.getOrg(orgId).name },
        customer: {
          localCustomerNo: customer.localCustomerNo,
          name: customer.name,
          remark: customer.remark,
          version: customer.version,
          updatedAt: customer.updatedAt,
          updatedBy: customer.updatedBy,
        },
        serverTime: new Date().toISOString(),
      });
    }

    // PUT /api/orgs/:orgId/customers/:localCustomerNo/remark
    const writeMatch = pathname.match(/^\/api\/orgs\/([^/]+)\/customers\/([^/]+)\/remark$/);
    if (method === 'PUT' && writeMatch) {
      if (!sameOrigin(req)) return sendError(res, 403, 'BAD_ORIGIN', '来源不合法');
      const session = requireUser(res, req);
      if (!session) return;
      const orgId = safeDecode(writeMatch[1]);
      if (!orgId) return sendError(res, 400, 'INVALID_ORG', '组织标识不合法');
      if (!requireOrgAccess(res, session, orgId)) return;
      const localCustomerNo = normalizeCustomerNo(safeDecode(writeMatch[2]));
      if (!localCustomerNo) return sendError(res, 400, 'INVALID_CUSTOMER_NO', '客户编号不合法');

      const body = await readJsonBody(req);
      if (typeof body.remark !== 'string') return sendError(res, 400, 'INVALID_REMARK', '备注必须是字符串');
      if (body.remark.length > REMARK_MAX_LENGTH) {
        return sendError(res, 400, 'REMARK_TOO_LONG', `备注不能超过 ${REMARK_MAX_LENGTH} 个字符`);
      }
      const expectedVersion = body.expectedVersion;
      if (expectedVersion != null && !Number.isInteger(expectedVersion)) {
        return sendError(res, 400, 'INVALID_VERSION', 'expectedVersion 必须是整数');
      }

      const existing = store.getCustomer(orgId, localCustomerNo);
      if (!existing) return sendError(res, 404, 'CUSTOMER_NOT_FOUND', '该组织下没有这个客户编号');
      if (expectedVersion != null && existing.version !== expectedVersion) {
        return sendError(res, 409, 'VERSION_CONFLICT', '记录已被其他操作更新，请重新载入', {
          currentVersion: existing.version,
        });
      }

      const updated = store.updateRemark({
        orgId,
        localCustomerNo,
        remark: body.remark,
        userId: session.user.id,
      });
      return sendJson(res, 200, {
        org: { id: orgId, name: store.getOrg(orgId).name },
        customer: {
          localCustomerNo: updated.localCustomerNo,
          name: updated.name,
          remark: updated.remark,
          version: updated.version,
          updatedAt: updated.updatedAt,
          updatedBy: updated.updatedBy,
        },
      });
    }

    // 演示接口：组织内客户列表，同样受成员校验保护。
    const listMatch = pathname.match(/^\/api\/orgs\/([^/]+)\/customers$/);
    if (method === 'GET' && listMatch) {
      const session = requireUser(res, req);
      if (!session) return;
      const orgId = safeDecode(listMatch[1]);
      if (!orgId) return sendError(res, 400, 'INVALID_ORG', '组织标识不合法');
      if (!requireOrgAccess(res, session, orgId)) return;
      return sendJson(res, 200, {
        org: { id: orgId, name: store.getOrg(orgId).name },
        customers: store.listCustomers(orgId),
      });
    }

    // 演示控制台：模拟账号在各个组织里的权限变化（仅 demoMode）。
    if (demoMode && method === 'POST' && pathname === '/api/demo/membership') {
      if (!sameOrigin(req)) return sendError(res, 403, 'BAD_ORIGIN', '来源不合法');
      const session = requireUser(res, req);
      if (!session) return;
      const body = await readJsonBody(req);
      if (typeof body.userId !== 'string' || typeof body.orgId !== 'string' || typeof body.enabled !== 'boolean') {
        return sendError(res, 400, 'INVALID_PAYLOAD', '需要 userId、orgId、enabled');
      }
      if (!store.getUser(body.userId) || !store.getOrg(body.orgId)) {
        return sendError(res, 404, 'NOT_FOUND', '账号或组织不存在');
      }
      store.setMembership(body.userId, body.orgId, body.enabled);
      return sendJson(res, 200, { ok: true, demoUsers: store.listDemoUsers() });
    }

    if (demoMode && method === 'POST' && pathname === '/api/demo/reset') {
      if (!sameOrigin(req)) return sendError(res, 403, 'BAD_ORIGIN', '来源不合法');
      store.reset();
      return sendJson(res, 200, { ok: true });
    }

    return sendError(res, 404, 'NOT_FOUND', '接口不存在');
  }

  // ---- 静态资源与 SPA 回退 ----
  async function serveStatic(req, res, pathname) {
    let rel;
    if (pathname === '/' || pathname === '/index.html') {
      rel = 'index.html';
    } else if (pathname.startsWith('/o/')) {
      // /o/:orgId/customers/:no 是客户端路由；刷新或直接打开都要能拿到同一份应用外壳。
      rel = 'index.html';
    } else {
      rel = pathname.replace(/^\/+/, '');
    }
    const filePath = path.resolve(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const data = await readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': ext === '.html' ? 'no-store' : 'no-cache',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
          return sendError(res, 405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
        }
        return await handleApi(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendError(res, 405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
      }
      return await serveStatic(req, res, url.pathname);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      return sendError(res, status, err.code || 'INTERNAL_ERROR', err.expose === false ? '服务内部错误' : err.message);
    }
  });

  return { server, store, sessions, activity };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 5173);
  const demoMode = process.env.DEMO_MODE !== 'false';
  const { server } = createApp({ demoMode });
  server.listen(port, '127.0.0.1', () => {
    console.log(`本地演示后台已启动: http://127.0.0.1:${port}`);
    console.log('演示账号: agent（同时属于甲、乙）/ agent-jia（只属于甲）');
  });
}
