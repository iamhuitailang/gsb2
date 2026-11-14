import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { openDb } from './db.js';
import { ensureInitialized, publishNext, getStatus, queryChanges } from './supplier.js';
import { SyncEngine } from './sync-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * 组装一个完整的应用（供应商接口 + 同步台 API + 静态页），但不监听端口。
 * 测试可传入内存库和任意 baseUrl，再自己 listen(0) 拿随机端口。
 */
export function createApp(db, { baseUrl = 'http://127.0.0.1:3000', root = ROOT } = {}) {
  ensureInitialized(db);
  const engine = new SyncEngine(db, { baseUrl });
  engine.recoverInterrupted();

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      sendJson(res, err.statusCode ?? 500, { error: err.message ?? String(err) });
    }
  });

  async function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;

    // ---------- 模拟供应商接口 ----------
    if (req.method === 'GET' && pathname === '/api/supplier/status') {
      return sendJson(res, 200, getStatus(db));
    }
    if (req.method === 'POST' && pathname === '/api/supplier/publish-next') {
      const batch = publishNext(db);
      if (!batch) return sendJson(res, 409, { error: '没有更多批次可发布' });
      return sendJson(res, 200, { published: batch, status: getStatus(db) });
    }
    if (req.method === 'GET' && pathname === '/api/supplier/changes') {
      const sinceVersion = Number(url.searchParams.get('since_version') ?? 0);
      const cursor = url.searchParams.get('cursor');
      const limit = Number(url.searchParams.get('limit') ?? 3);
      return sendJson(res, 200, queryChanges(db, sinceVersion, cursor, limit));
    }

    // ---------- 同步台 API ----------
    let m;
    if (req.method === 'GET' && pathname === '/api/console/stats') {
      return sendJson(res, 200, { catalog: engine.catalogStats(), activeRun: engine.getActiveRun() ?? null });
    }
    if (req.method === 'GET' && pathname === '/api/console/runs') {
      return sendJson(res, 200, { runs: engine.listRuns() });
    }
    if ((m = pathname.match(/^\/api\/console\/runs\/(\d+)$/)) && req.method === 'GET') {
      return sendJson(res, 200, engine.mustGet(Number(m[1])));
    }
    if (req.method === 'POST' && pathname === '/api/console/sync/start') {
      const { run } = await engine.start();
      return sendJson(res, 201, run);
    }
    if ((m = pathname.match(/^\/api\/console\/sync\/(\d+)\/pause$/)) && req.method === 'POST') {
      return sendJson(res, 200, engine.requestPause(Number(m[1])));
    }
    if ((m = pathname.match(/^\/api\/console\/sync\/(\d+)\/resume$/)) && req.method === 'POST') {
      const { run } = await engine.resume(Number(m[1]));
      return sendJson(res, 200, run);
    }
    if (req.method === 'GET' && pathname === '/api/console/products') {
      return sendJson(res, 200, { products: engine.listProducts(url.searchParams.get('keyword') ?? '') });
    }
    if ((m = pathname.match(/^\/api\/console\/products\/([\w-]+)$/)) && req.method === 'GET') {
      const product = engine.getProduct(m[1]);
      if (!product) return sendJson(res, 404, { error: `未找到商品 ${m[1]}` });
      return sendJson(res, 200, product);
    }

    // ---------- 静态页面 ----------
    if (req.method === 'GET') {
      const rel = pathname === '/' ? 'public/index.html' : join('public', normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
      const filePath = join(root, rel);
      if (!filePath.startsWith(join(root, 'public'))) return sendJson(res, 403, { error: 'forbidden' });
      try {
        const body = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': MIME[filePath.slice(filePath.lastIndexOf('.'))] ?? 'application/octet-stream' });
        return res.end(body);
      } catch {
        return sendJson(res, 404, { error: 'not found' });
      }
    }

    sendJson(res, 404, { error: 'not found' });
  }

  return { server, db, engine };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

// 直接运行本文件时启动常驻服务
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const PORT = Number(process.env.PORT) || 3000;
  const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'catalog.db');
  const db = openDb(DB_PATH);
  const { server } = createApp(db, { baseUrl: `http://127.0.0.1:${PORT}` });
  server.listen(PORT, () => {
    console.log(`同步台已启动: http://127.0.0.1:${PORT}`);
    console.log(`数据库文件: ${DB_PATH}`);
  });
}
