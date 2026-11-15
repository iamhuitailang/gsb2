import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { openDb } from './db.js';
import {
  createCard, getCard, submitTransaction, getTransaction, listTransactions, HttpError,
} from './service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'web');
const DB_PATH = process.env.GC_DB_PATH || join(__dirname, '..', 'data', 'giftcard.db');
const PORT = Number(process.env.PORT || 3000);

export function createApp(db) {
  return createServer(async (req, res) => {
    try {
      await route(req, res, db);
    } catch (err) {
      sendError(res, err);
    }
  });
}

async function route(req, res, db) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/cards' && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 201, createCard(db, body.cardId, body.initialBalanceCents ?? 0));
  }

  const cardMatch = pathname.match(/^\/api\/cards\/([^/]+)$/);
  if (cardMatch && method === 'GET') {
    const card = getCard(db, decodeURIComponent(cardMatch[1]));
    const txs = listTransactions(db, { cardId: card.cardId });
    return sendJson(res, 200, { ...card, transactions: txs });
  }

  if (pathname === '/api/transactions' && method === 'POST') {
    const body = await readJson(req);
    const result = submitTransaction(db, body);
    return sendJson(res, result.duplicate ? 200 : 201, result);
  }

  if (pathname === '/api/transactions' && method === 'GET') {
    const txs = listTransactions(db, {
      cardId: url.searchParams.get('cardId') || undefined,
      status: url.searchParams.get('status') || undefined,
      type: url.searchParams.get('type') || undefined,
    });
    return sendJson(res, 200, txs);
  }

  const txMatch = pathname.match(/^\/api\/transactions\/(\d+)$/);
  if (txMatch && method === 'GET') {
    return sendJson(res, 200, getTransaction(db, Number(txMatch[1])));
  }

  if (pathname.startsWith('/api/')) {
    throw new HttpError(404, 'NOT_FOUND', '接口不存在');
  }

  return serveStatic(res, pathname);
}

async function serveStatic(res, pathname) {
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safePath === '/' ? 'index.html' : safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    throw new HttpError(403, 'FORBIDDEN', '禁止访问');
  }
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
  };
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    throw new HttpError(404, 'NOT_FOUND', '页面不存在');
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendError(res, err) {
  const status = err instanceof HttpError ? err.statusCode : 500;
  const code = err instanceof HttpError ? err.code : 'INTERNAL_ERROR';
  const message = err instanceof HttpError ? err.message : '服务内部错误';
  if (status === 500) console.error(err);
  sendJson(res, status, { error: { code, message } });
}

// 直接运行时启动服务；被测试模块 import 时不启动
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = openDb(DB_PATH);
  createApp(db).listen(PORT, () => {
    console.log(`礼品卡对账服务已启动: http://localhost:${PORT}`);
    console.log(`数据库: ${DB_PATH}`);
  });
}
