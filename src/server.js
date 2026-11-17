import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIELDS, ORDER_STATUSES, SITES } from './data.js';
import { canViewField, normalizeQuery, pageFields, projectOrderPage } from './permissions.js';
import { createStore } from './store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, check) {
  return sendJson(res, check.status ?? 400, {
    error: { code: check.code, message: check.message, detail: check.detail ?? null },
  });
}

async function readJson(req, limitBytes = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const error = new Error('payload_too_large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('invalid_json');
    error.status = 400;
    throw error;
  }
}

function queryList(searchParams, name) {
  const values = searchParams.getAll(name).flatMap((value) => value.split(','));
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

function parseFilters(url) {
  const statuses = queryList(url.searchParams, 'statuses');
  return {
    siteIds: queryList(url.searchParams, 'siteIds'),
    statuses,
    q: url.searchParams.get('q') ?? '',
  };
}

export function createApp(options = {}) {
  const store = options.store ?? createStore(options.storeOptions);

  function resolveUser(req) {
    const header = req.headers['x-user-id'];
    const headerValue = Array.isArray(header) ? header[0] : header;
    const userId = (headerValue ?? '').trim();
    return userId ? store.getUser(userId) : null;
  }

  function publicUser(user) {
    return {
      id: user.id,
      name: user.name,
      title: user.title,
      sites: user.sites.map((siteId) => ({ id: siteId, name: SITES.find((site) => site.id === siteId)?.name ?? siteId })),
      permissions: [...user.permissions],
      permissionVersion: user.permissionVersion,
      fields: FIELDS.map((field) => ({
        key: field.key,
        label: field.label,
        group: field.group,
        permission: field.permission,
        allowed: canViewField(user, field),
      })),
      canAdmin: user.permissions.includes('admin:users'),
    };
  }

  function requireUser(req, res) {
    const user = resolveUser(req);
    if (!user) {
      sendJson(res, 401, {
        error: { code: 'login_required', message: '请选择演示账号后再继续。' },
      });
      return null;
    }
    return user;
  }

  async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method ?? 'GET';

    if (pathname === '/api/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/demo/accounts' && method === 'GET') {
      return sendJson(res, 200, { accounts: store.listUsers() });
    }

    const user = requireUser(req, res);
    if (!user) return undefined;

    if (pathname === '/api/demo/reset' && method === 'POST') {
      // 演示环境的重置按钮：只恢复内存中的虚构数据，不涉及真实账号。
      store.reset();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/me' && method === 'GET') {
      return sendJson(res, 200, {
        user: publicUser(user),
        allSites: SITES,
        allFields: FIELDS,
        statuses: ORDER_STATUSES,
      });
    }

    if (pathname === '/api/orders' && method === 'GET') {
      const normalized = normalizeQuery(user, parseFilters(url));
      if (!normalized.ok) return sendError(res, normalized);
      const rows = store.filterOrders(normalized.query, user);
      return sendJson(res, 200, {
        orders: rows.map((order) => projectOrderPage(order, user)),
        columns: pageFields(user).map((field) => ({ key: field.key, label: field.label })),
      });
    }

    if (pathname === '/api/exports/preview' && method === 'POST') {
      const body = await readJson(req);
      const result = store.previewExport(user, body);
      if (!result.ok) return sendError(res, result);
      return sendJson(res, 200, result.preview);
    }

    if (pathname === '/api/exports' && method === 'POST') {
      const body = await readJson(req);
      const result = store.enqueueExport(user, body);
      if (!result.ok) return sendError(res, result);
      return sendJson(res, 202, { job: result.job });
    }

    if (pathname === '/api/exports' && method === 'GET') {
      return sendJson(res, 200, { jobs: store.listJobs(user) });
    }

    const jobMatch = pathname.match(/^\/api\/exports\/([0-9a-f-]+)$/);
    if (jobMatch && method === 'GET') {
      const job = store.getJob(user, jobMatch[1]);
      if (!job) {
        return sendJson(res, 404, { error: { code: 'export_not_found', message: '导出任务不存在。' } });
      }
      return sendJson(res, 200, { job });
    }

    const downloadMatch = pathname.match(/^\/api\/exports\/([0-9a-f-]+)\/download$/);
    if (downloadMatch && method === 'GET') {
      const result = store.getDownload(user, downloadMatch[1]);
      if (result.status !== 200) {
        return sendJson(res, result.status, { error: result.error });
      }
      const { filename, content } = result.download;
      const asciiName = `orders-export-${downloadMatch[1].slice(0, 8)}.csv`;
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Content-Length': Buffer.byteLength(content, 'utf8'),
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        Pragma: 'no-cache',
        Expires: '0',
      });
      return res.end(content);
    }

    if (pathname === '/api/admin/users' && method === 'GET') {
      if (!user.permissions.includes('admin:users')) {
        return sendJson(res, 403, {
          error: { code: 'admin_required', message: '只有权限管理员可以查看账号权限。' },
        });
      }
      return sendJson(res, 200, { users: store.listUsers() });
    }

    const accessMatch = pathname.match(/^\/api\/admin\/users\/([a-z0-9-]+)\/access$/);
    if (accessMatch && method === 'POST') {
      const body = await readJson(req);
      const result = store.updateUserAccess(user, accessMatch[1], body);
      if (!result.ok) return sendError(res, result);
      return sendJson(res, 200, {
        changed: result.changed,
        invalidatedJobs: result.invalidatedJobs,
        user: result.user,
      });
    }

    return sendJson(res, 404, { error: { code: 'not_found', message: '接口不存在。' } });
  }

  async function serveStatic(req, res, url) {
    const rawPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const relative = normalize(rawPath).replace(/^([/\\])+/, '');
    if (relative.startsWith('..') || relative.includes(`..${sep}`)) {
      return sendJson(res, 400, { error: { code: 'bad_path', message: '路径不合法。' } });
    }

    const filePath = join(PUBLIC_DIR, relative);
    try {
      const content = await readFile(filePath);
      const type = MIME[extname(filePath)] ?? 'application/octet-stream';
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': type,
        'Content-Length': content.length,
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(content);
    } catch {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('未找到页面');
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url);
      }
      if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
        res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' });
        return res.end('Method Not Allowed');
      }
      return await serveStatic(req, res, url);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error('[server]', error);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: {
            code: status === 500 ? 'internal_error' : error.message,
            message: status === 500 ? '服务器内部错误。' : '请求格式不正确。',
          },
        });
      } else {
        res.end();
      }
      return undefined;
    }
  });

  return { server, store };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 4321);
  const { server } = createApp();
  server.listen(port, () => {
    console.log(`GSB2 订单导出演示已启动：http://localhost:${port}`);
  });
}
