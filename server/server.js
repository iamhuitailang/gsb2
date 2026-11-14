// HTTP 入口：JSON API + 静态页面。零依赖，基于 node:http。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import {
  listWarehouses,
  listBatches,
  getOrCreateBatch,
  getBatchDetail,
  submitUpload,
  previewBatch,
  publishBatch,
  getSubmissionFile,
  queryInventory,
  HttpError,
} from './batches.js';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 单张盘点表上限 20MB
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createApp({ publicDir, uploadRoot }) {
  return createServer(async (req, res) => {
    try {
      await route(req, res, { publicDir, uploadRoot });
    } catch (err) {
      const status = err.statusCode ?? 500;
      if (status >= 500) console.error(err);
      sendJson(res, status, { error: err.message || '服务器内部错误' });
    }
  });
}

async function route(req, res, ctx) {
  const { url } = req;
  const path = decodeURIComponent(new URL(url, 'http://x').pathname);
  const method = req.method ?? 'GET';

  // ---- API ----
  if (path.startsWith('/api/')) return apiRoute(method, path, req, res, ctx);

  // ---- 静态资源（只允许 public 目录内）----
  if (method === 'GET') return serveStatic(res, ctx.publicDir, path);

  throw new HttpError(405, '不支持的方法');
}

async function apiRoute(method, path, req, res, ctx) {
  const m = path.match(/^\/api\/batches\/(\d+)\/warehouses\/([^/]+)\/(submission|file)$/);
  if (m) {
    const batchId = Number(m[1]);
    const whCode = m[2];
    if (m[3] === 'submission' && method === 'PUT') {
      const originalName = safeFilename(req.headers['x-filename']) || `${whCode}.csv`;
      const buffer = await readBody(req, MAX_UPLOAD_BYTES);
      return sendJson(
        res,
        200,
        submitUpload(batchId, whCode, originalName, buffer, ctx.uploadRoot)
      );
    }
    if (m[3] === 'file' && method === 'GET') {
      const file = getSubmissionFile(batchId, whCode);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
      });
      const data = await readFile(file.storedPath);
      return res.end(data);
    }
  }

  if (path === '/api/warehouses' && method === 'GET') {
    return sendJson(res, 200, { warehouses: listWarehouses() });
  }
  if (path === '/api/batches' && method === 'GET') {
    return sendJson(res, 200, { batches: listBatches() });
  }
  if (path === '/api/batches' && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, getOrCreateBatch(String(body.countDate ?? '').trim()));
  }

  const bm = path.match(/^\/api\/batches\/(\d+)(\/(preview|publish))?$/);
  if (bm) {
    const batchId = Number(bm[1]);
    const action = bm[3];
    if (!action && method === 'GET') return sendJson(res, 200, getBatchDetail(batchId));
    if (action === 'preview' && method === 'GET') return sendJson(res, 200, previewBatch(batchId));
    if (action === 'publish' && method === 'POST') return sendJson(res, 200, publishBatch(batchId));
  }

  if (path === '/api/inventory' && method === 'GET') {
    const params = new URL(req.url, 'http://x').searchParams;
    return sendJson(
      res,
      200,
      queryInventory({ q: params.get('q') ?? '', whCode: params.get('whCode') ?? '' })
    );
  }

  throw new HttpError(404, '接口不存在');
}

async function serveStatic(res, publicDir, path) {
  const rel = path === '/' ? '/index.html' : path;
  const filePath = normalize(join(publicDir, rel));
  if (!filePath.startsWith(publicDir)) throw new HttpError(403, '非法路径');
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `文件超过 ${Math.round(limit / 1024 / 1024)}MB 上限`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

function sendJson(res, status, payload) {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(buf);
}

// 只保留文件名部分，避免路径穿越；服务端真正的存储名由服务端自己生成
function safeFilename(value) {
  if (Array.isArray(value)) value = value[0];
  if (!value) return '';
  return String(value).split(/[\\/]/).pop().replace(/[^\w.\-一-龥]/g, '_');
}

// 直接运行时启动服务；被测试 import 时不自动监听端口
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const { openDb } = await import('./db.js');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dataDir = process.env.DATA_DIR ?? join(root, 'data');
  openDb(join(dataDir, 'app.db'));
  const port = Number(process.env.PORT ?? 3210);
  createApp({ publicDir: join(root, 'public'), uploadRoot: join(dataDir, 'uploads') })
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`端口 ${port} 已被占用，可用 PORT=端口号 npm start 指定其他端口`);
        process.exit(1);
      }
      throw err;
    })
    .listen(port, () => console.log(`盘点批次接收系统已启动：http://localhost:${port}`));
}
