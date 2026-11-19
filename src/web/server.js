// 本地静态服务 + API 路由。仅监听本机回环地址，不提供代理或出站请求。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { handleApi } from './api.js';
import { sendJson } from './http-util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, '..', '..', 'public');

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
});

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : normalize(pathname.slice(1));
  const target = resolve(PUBLIC_DIR, rel);
  // 防路径穿越：解析后的绝对路径必须仍在 PUBLIC_DIR 内
  if (target !== PUBLIC_DIR && !target.startsWith(`${PUBLIC_DIR}/`)) {
    sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: '路径不被允许' } });
    return;
  }
  try {
    const body = await readFile(target);
    const ext = target.slice(target.lastIndexOf('.'));
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '资源不存在' } });
  }
}

export function createApp() {
  return createServer(async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '非法 URL' } });
      return;
    }

    if (pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, pathname);
      if (!handled) sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未知 API' } });
      return;
    }
    if (req.method === 'GET') {
      await serveStatic(req, res, pathname);
      return;
    }
    sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '方法不允许' } });
  });
}

export function startServer({ host = '127.0.0.1', port = 8080 } = {}) {
  const server = createApp();
  return new Promise((resolvePromise, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolvePromise(server));
  });
}
