import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canAccessOrganization,
  getOrganization,
  getUser,
  listOrganizationsForUser,
  store,
} from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const COOKIE_NAME = 'gt_sid';
const MAX_DELAY_MS = 5000;

// sid -> userId。会话只记录“是谁”，绝不记录“当前在哪个组织”：
// 组织上下文属于每一个标签页自己的地址，而不是整个浏览器会话。
const sessions = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[key] = part.slice(index + 1).trim();
    }
  }
  return out;
}

function currentUser(req) {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (!sid) return null;
  const userId = sessions.get(sid);
  if (!userId) return null;
  return getUser(userId) || null;
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

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function resolveOrg(rawOrg) {
  if (!rawOrg) return null;
  const direct = getOrganization(rawOrg);
  if (direct) return direct;
  // 允许用 slug（jia / yi）或 id（org-jia / org-yi）寻址。
  const bySlug = [...store.organizations.values()].find((org) => org.slug === rawOrg);
  return bySlug || null;
}

function publicOrg(org) {
  return { id: org.id, slug: org.slug, name: org.name };
}

function publicCustomer(customer) {
  return {
    organizationId: customer.organizationId,
    code: customer.code,
    name: customer.name,
    phone: customer.phone,
    note: customer.note,
    updatedAt: customer.updatedAt || null,
  };
}

/**
 * 鉴权入口：请求路径里的组织 + 当前登录用户。
 * 未登录 401；组织不存在 404；没有该组织权限 403。
 * 任何后续按 (组织, 客户编号) 取数的逻辑都只在鉴权通过后执行。
 */
function authorizeOrganization(req, res, rawOrg) {
  const user = currentUser(req);
  if (!user) {
    sendError(res, 401, 'UNAUTHENTICATED', '请先登录');
    return null;
  }
  const org = resolveOrg(rawOrg);
  if (!org) {
    sendError(res, 404, 'ORGANIZATION_NOT_FOUND', '组织不存在');
    return null;
  }
  if (!canAccessOrganization(user, org.id)) {
    sendError(res, 403, 'ORGANIZATION_FORBIDDEN', `你没有「${org.name}」的访问权限`);
    return null;
  }
  return { user, org };
}

function delayFromQuery(url) {
  const raw = Number(url.searchParams.get('delay'));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.round(raw), MAX_DELAY_MS);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 模拟慢查询：等待指定毫秒后，用“最新”的登录态与权限重新确认一次。
 * 等待期间权限被收回或登录失效，必须返回错误而不是把旧数据交出去。
 * 返回 true 表示可以继续，false 表示已经写出错误响应。
 */
async function waitWithReauth(req, res, url, org) {
  const delay = delayFromQuery(url);
  if (!delay) return true;
  await sleep(delay);
  const latestUser = currentUser(req);
  if (!latestUser) {
    sendError(res, 401, 'UNAUTHENTICATED', '登录已失效');
    return false;
  }
  if (!canAccessOrganization(latestUser, org.id)) {
    sendError(res, 403, 'ORGANIZATION_FORBIDDEN', '权限已变化，请重试');
    return false;
  }
  return true;
}

async function handleApi(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendError(res, 400, 'BAD_REQUEST', '路径编码不合法');
  }

  if (pathname === '/api/me' && req.method === 'GET') {
    const user = currentUser(req);
    if (!user) return sendError(res, 401, 'UNAUTHENTICATED', '请先登录');
    return sendJson(res, 200, {
      user: { id: user.id, name: user.name },
      organizations: listOrganizationsForUser(user).map(publicOrg),
    });
  }

  // 演示用：切换登录身份，方便复现“失去权限”。
  if (pathname === '/api/session' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendError(res, 400, 'BAD_REQUEST', '请求体不是合法 JSON');
    }
    const user = getUser(String(body.userId || ''));
    if (!user) return sendError(res, 404, 'USER_NOT_FOUND', '演示用户不存在');
    const sid = crypto.randomUUID();
    sessions.set(sid, user.id);
    return sendJson(
      res,
      200,
      { user: { id: user.id, name: user.name }, organizations: listOrganizationsForUser(user).map(publicOrg) },
      { 'set-cookie': `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax` },
    );
  }

  if (pathname === '/api/session' && req.method === 'DELETE') {
    const sid = parseCookies(req)[COOKIE_NAME];
    if (sid) sessions.delete(sid);
    return sendJson(res, 200, { ok: true }, { 'set-cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0` });
  }

  // GET /api/orgs/:org/customers
  let match = pathname.match(/^\/api\/orgs\/([^/]+)\/customers$/);
  if (match && req.method === 'GET') {
    const auth = authorizeOrganization(req, res, match[1]);
    if (!auth) return;
    if (!(await waitWithReauth(req, res, url, auth.org))) return;
    return sendJson(res, 200, {
      organization: publicOrg(auth.org),
      customers: store.listCustomers(auth.org.id).map(publicCustomer),
    });
  }

  // GET /api/orgs/:org/customers/:code
  match = pathname.match(/^\/api\/orgs\/([^/]+)\/customers\/([^/]+)$/);
  if (match && req.method === 'GET') {
    const auth = authorizeOrganization(req, res, match[1]);
    if (!auth) return;
    const code = match[2];
    if (!(await waitWithReauth(req, res, url, auth.org))) return;
    // 核心：用“组织 + 本地客户编号”联合定位，绝不会按编号跨组织串号。
    const customer = store.getCustomer(auth.org.id, code);
    if (!customer) return sendError(res, 404, 'CUSTOMER_NOT_FOUND', '该组织下没有这个客户编号');
    return sendJson(res, 200, {
      organization: publicOrg(auth.org),
      customer: publicCustomer(customer),
    });
  }

  // PUT /api/orgs/:org/customers/:code/note
  match = pathname.match(/^\/api\/orgs\/([^/]+)\/customers\/([^/]+)\/note$/);
  if (match && req.method === 'PUT') {
    const auth = authorizeOrganization(req, res, match[1]);
    if (!auth) return;
    const code = match[2];
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendError(res, 400, 'BAD_REQUEST', '请求体不是合法 JSON');
    }
    if (typeof body.note !== 'string') {
      return sendError(res, 400, 'BAD_REQUEST', 'note 必须是字符串');
    }
    // 若客户端额外声明了组织，必须与 URL 上的组织一致，防止用甲的地址写乙的数据。
    if (body.organizationId !== undefined && body.organizationId !== auth.org.id) {
      return sendError(res, 400, 'ORGANIZATION_MISMATCH', '请求体中的组织与地址不一致');
    }
    if (body.note.length > 2000) {
      return sendError(res, 400, 'BAD_REQUEST', '备注过长');
    }
    // 读请求体期间权限可能被收回，写入前再确认一次。
    if (!currentUser(req) || !canAccessOrganization(currentUser(req), auth.org.id)) {
      return sendError(res, 403, 'ORGANIZATION_FORBIDDEN', '权限已变化，请重试');
    }
    const customer = store.getCustomer(auth.org.id, code);
    if (!customer) return sendError(res, 404, 'CUSTOMER_NOT_FOUND', '该组织下没有这个客户编号');
    const updated = store.setCustomer(auth.org.id, code, { note: body.note });
    return sendJson(res, 200, {
      organization: publicOrg(auth.org),
      customer: publicCustomer(updated),
    });
  }

  return sendError(res, 404, 'NOT_FOUND', '接口不存在');
}

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('bad request');
  }
  if (pathname === '/') pathname = '/index.html';
  // 任何 /o/:slug/... 的地址都回落到前端路由页，刷新时不丢组织上下文。
  if (pathname.startsWith('/o/')) pathname = '/app.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }
  // 目录不直接回目录列表。
  if (pathname.endsWith('/')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

export function createApp() {
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, url);
      } else {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
      }
    } catch (error) {
      console.error(error);
      if (!res.headersSent) sendError(res, 500, 'INTERNAL', '服务器错误');
      else res.end();
    }
  };
  return { handler, sessions };
}
