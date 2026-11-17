// HTTP 入口：零依赖原生 http 服务，提供 JSON API 与前端静态资源。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { openDatabase, initDatabase } from './src/db.js';
import { createService, ServiceError } from './src/services.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const DEFAULT_DB_PATH = join(__dirname, 'data', 'demo.db');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) {
      throw new ServiceError('VALIDATION_ERROR', '请求体过大', 413);
    }
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ServiceError('VALIDATION_ERROR', '请求体不是合法 JSON', 400);
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  // 防目录穿越：规范化后必须仍在 PUBLIC_DIR 内
  const filePath = normalize(join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[filePath.slice(filePath.lastIndexOf('.'))] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

export function createApp(db) {
  const service = createService(db);

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    // 静态资源与前端路由
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      return serveStatic(req, res);
    }

    // API 路由
    try {
      const route = `${req.method} ${pathname}`;
      if (route === 'GET /api/users') {
        return sendJson(res, 200, { users: service.listUsers() });
      }
      if (route === 'GET /api/instructions') {
        return sendJson(res, 200, { instructions: service.listInstructions() });
      }
      if (route === 'POST /api/reset') {
        return sendJson(res, 200, { instructions: service.reset() });
      }

      const detailMatch = pathname.match(/^\/api\/instructions\/([\w-]+)$/);
      if (req.method === 'GET' && detailMatch) {
        return sendJson(res, 200, service.getInstructionDetail(detailMatch[1]));
      }

      const approveMatch = pathname.match(/^\/api\/instructions\/([\w-]+)\/approvals$/);
      if (req.method === 'POST' && approveMatch) {
        const body = await readBody(req);
        return sendJson(res, 200, service.approve({
          id: approveMatch[1],
          userId: body.user_id,
          expectedVersion: body.expected_version,
        }));
      }

      const editMatch = pathname.match(/^\/api\/instructions\/([\w-]+)\/versions$/);
      if (req.method === 'POST' && editMatch) {
        const body = await readBody(req);
        return sendJson(res, 200, service.editInstruction({
          id: editMatch[1],
          userId: body.user_id,
          payee: body.payee,
          amountYuan: body.amount_yuan,
          expectedVersion: body.expected_version,
        }));
      }

      if (route === 'POST /api/instructions') {
        const body = await readBody(req);
        return sendJson(res, 201, service.createInstruction({
          userId: body.user_id,
          payee: body.payee,
          amountYuan: body.amount_yuan,
        }));
      }

      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
    } catch (err) {
      if (err instanceof ServiceError) {
        return sendJson(res, err.httpStatus, {
          error: { code: err.code, message: err.message, current_version: err.current_version },
        });
      }
      console.error(err);
      return sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } });
    }
  });
}

// 直接运行时启动服务；测试中 import createApp 自行管理端口与数据库
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dbPath = process.env.DEMO_DB_PATH || DEFAULT_DB_PATH;
  const db = openDatabase(dbPath);
  initDatabase(db);
  const port = Number(process.env.PORT) || 3000;
  const server = createApp(db);
  server.listen(port, () => {
    console.log(`付款指令复核演示系统已启动: http://localhost:${port}`);
    console.log(`数据库文件: ${dbPath}（仅保存演示样例数据，页面右上角可重置）`);
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
