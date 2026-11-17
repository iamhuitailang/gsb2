'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { createSeed } = require('./store');
const { createService, ServiceError } = require('./service');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        // 继续读完并丢弃，避免销毁连接后无法回写 413。
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new ServiceError(413, 'BODY_TOO_LARGE', '请求体过大。'));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new ServiceError(400, 'INVALID_BODY', '请求体必须是 JSON 对象。'));
        }
        resolve(parsed);
      } catch {
        reject(new ServiceError(400, 'INVALID_JSON', '请求体不是合法的 JSON。'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let relative;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: '请求地址不合法。' } });
  }
  const target = path.resolve(PUBLIC_DIR, relative);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: '路径不合法。' } });
  }
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      if (path.extname(target) === '') return serveStatic(req, res, '/index.html');
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '资源不存在。' } });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(target).pipe(res);
  });
}

function createApp(options = {}) {
  const db = options.db || createSeed();
  const service = createService(db);

  async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method || 'GET';
    const parts = pathname.split('/').filter(Boolean); // ['api', ...]

    if (['/api/bootstrap', '/api/health'].includes(pathname) && method !== 'GET') {
      return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '方法不被允许。' } });
    }

    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, now: service.now() });
    }

    if (method === 'GET' && pathname === '/api/bootstrap') {
      const userId = url.searchParams.get('userId') || '';
      return sendJson(res, 200, service.getState(userId));
    }

    if (method === 'POST' && pathname === '/api/clock') {
      const body = await readBody(req);
      return sendJson(res, 200, service.setClock(body));
    }

    if (method === 'POST' && pathname === '/api/delegations') {
      const body = await readBody(req);
      return sendJson(res, 201, service.createDelegation(body));
    }

    if (parts[1] === 'delegations' && parts[2]) {
      const delegationId = parts[2];
      const body = method === 'POST' ? await readBody(req) : {};
      if (method === 'POST' && parts[3] === 'accept') {
        return sendJson(res, 200, service.acceptDelegation(body.userId, delegationId));
      }
      if (method === 'POST' && parts[3] === 'decline') {
        return sendJson(res, 200, service.declineDelegation(body.userId, delegationId));
      }
      if (method === 'POST' && parts[3] === 'end') {
        return sendJson(res, 200, service.endDelegation(body.userId, delegationId, body.reason));
      }
    }

    if (parts[1] === 'applications' && parts[2]) {
      const applicationId = parts[2];
      if (method === 'GET') {
        const userId = url.searchParams.get('userId') || '';
        return sendJson(res, 200, service.getApplicationForUser(userId, applicationId));
      }
      if (method === 'POST' && parts[3] === 'decision') {
        const body = await readBody(req);
        return sendJson(
          res,
          200,
          service.decide(body.userId, applicationId, body.action, body.comment)
        );
      }
    }

    if (method === 'POST' && pathname === '/api/demo/grants') {
      const body = await readBody(req);
      return sendJson(res, 200, service.setGrantActive(body.userId, body.storeId, body.active));
    }

    return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在。' } });
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: '请求地址不合法。' } });
    }

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '方法不被允许。' } });
      }
      return serveStatic(req, res, url.pathname);
    }

    handleApi(req, res, url).catch((error) => {
      if (error instanceof ServiceError) {
        return sendJson(res, error.status, {
          error: { code: error.code, message: error.message, details: error.details }
        });
      }
      console.error('[server] unexpected error:', error);
      sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: '服务器内部错误。' } });
    });
  });

  server.db = db;
  server.service = service;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4173;
  const server = createApp();
  server.listen(port, () => {
    console.log(`调价委托演示后台已启动：http://localhost:${port}`);
  });
}

module.exports = { createApp };
