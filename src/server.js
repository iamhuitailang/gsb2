'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const auth = require('./services/authService');
const {
  ServiceError,
  getCustomerById,
  listCustomers,
  updateCustomer,
  listAuditLogs,
} = require('./services/customerService');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new ServiceError(413, 'BODY_TOO_LARGE', '请求体过大'));
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
        reject(new ServiceError(400, 'INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/login.html';

  // 防目录穿越：规范化后必须仍在 public 目录内
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  if (!url.pathname.startsWith('/api/')) {
    return serveStatic(req, res);
  }

  try {
    // ---- 会话与登录 ----
    if (route === 'POST /api/auth/login') {
      const body = await readJsonBody(req);
      const { token, user } = auth.login(body.username, body.password);
      res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=7200`);
      return sendJson(res, 200, { user });
    }

    if (route === 'POST /api/auth/logout') {
      auth.logout(auth.parseCookies(req.headers.cookie).session);
      res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
      return sendJson(res, 200, { ok: true });
    }

    // 以下接口全部需要登录
    const user = auth.requireUser(req);

    if (route === 'GET /api/auth/me') {
      return sendJson(res, 200, { user });
    }

    // ---- 客户：本人资料 ----
    if (route === 'GET /api/customer/me') {
      // 与主管走同一个详情函数，保证两个角色核对的是同一份记录
      return sendJson(res, 200, { customer: getCustomerById(user.customerId) });
    }

    if (route === 'PUT /api/customer/me') {
      const body = await readJsonBody(req);
      const result = updateCustomer(user, user.customerId, body);
      return sendJson(res, 200, result);
    }

    // ---- 主管后台：按 id 查看 / 维护任意客户 ----
    const detailMatch = url.pathname.match(/^\/api\/admin\/customers\/(\d+)$/);
    if (detailMatch && req.method === 'GET') {
      auth.requireRole(user, 'supervisor');
      return sendJson(res, 200, { customer: getCustomerById(Number(detailMatch[1])) });
    }
    if (detailMatch && req.method === 'PUT') {
      auth.requireRole(user, 'supervisor');
      const body = await readJsonBody(req);
      const result = updateCustomer(user, Number(detailMatch[1]), body);
      return sendJson(res, 200, result);
    }

    if (route === 'GET /api/admin/customers') {
      auth.requireRole(user, 'supervisor');
      return sendJson(res, 200, { customers: listCustomers() });
    }

    if (route === 'GET /api/admin/audit-logs') {
      auth.requireRole(user, 'supervisor');
      return sendJson(res, 200, { logs: listAuditLogs() });
    }

    return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
  } catch (err) {
    if (err instanceof ServiceError) {
      const payload = { error: { code: err.code, message: err.message } };
      if (err.rejectedFields) payload.error.rejectedFields = err.rejectedFields;
      if (err.field) payload.error.field = err.field;
      return sendJson(res, err.status, payload);
    }
    console.error(err);
    return sendJson(res, 500, { error: { code: 'INTERNAL', message: '服务器内部错误' } });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`客户资料演示服务已启动: http://localhost:${PORT}/`);
  });
}

module.exports = server;
