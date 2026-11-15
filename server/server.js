// HTTP 入口：createApp 工厂便于测试进程内起服务；直接运行时才监听端口。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { normalize, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { HttpError, ingestClicks, ingestPayments, ingestRefunds, listIngestBatches } from './attribution.js';
import { CsvValidationError } from './csv.js';
import {
  getReport, listCampaigns, listOrders, getOrderDetail, buildSummaryCsv, buildDetailCsv,
} from './reports.js';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
};
const INGEST = {
  clicks: ingestClicks,
  payments: ingestPayments,
  refunds: ingestRefunds,
};
const SAMPLE_FILES = {
  clicks: 'clicks.csv',
  payments: 'payments.csv',
  'late-click': 'late-click.csv',
  refunds: 'refunds.csv',
};

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `上传内容超过 ${Math.round(limit / 1024 / 1024)}MB 上限`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeFilename(value) {
  const raw = value ? decodeURIComponent(value) : 'upload.csv';
  return basename(raw).replace(/[^\w.\-一-龥]/g, '_') || 'upload.csv';
}

function sendCsv(res, filename, content) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  res.end(Buffer.from(content, 'utf8'));
}

async function serveStatic(res, publicDir, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = normalize(join(publicDir, rel));
  if (!filePath.startsWith(publicDir)) throw new HttpError(403, '非法路径');
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

async function apiRoute(req, res, url, ctx) {
  const { pathname, searchParams } = url;

  let m = /^\/api\/ingest\/(clicks|payments|refunds)$/.exec(pathname);
  if (m && req.method === 'POST') {
    const body = await readBody(req, MAX_UPLOAD_BYTES);
    const originalName = safeFilename(req.headers['x-filename']);
    try {
      const result = INGEST[m[1]](body, originalName);
      return sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof CsvValidationError) throw new HttpError(400, err.message);
      throw err;
    }
  }

  if (pathname === '/api/reports' && req.method === 'GET') {
    return sendJson(res, 200, getReport({
      date: searchParams.get('date') ?? '',
      startDate: searchParams.get('startDate') ?? '',
      endDate: searchParams.get('endDate') ?? '',
    }));
  }

  if (pathname === '/api/campaigns' && req.method === 'GET') {
    return sendJson(res, 200, listCampaigns());
  }

  if (pathname === '/api/orders' && req.method === 'GET') {
    return sendJson(res, 200, listOrders({
      q: searchParams.get('q') ?? '',
      campaignId: searchParams.get('campaignId') ?? '',
      payDate: searchParams.get('payDate') ?? '',
    }));
  }

  m = /^\/api\/orders\/([^/]+)$/.exec(pathname);
  if (m && req.method === 'GET') {
    const detail = getOrderDetail(decodeURIComponent(m[1]));
    if (!detail) throw new HttpError(404, '订单不存在');
    return sendJson(res, 200, detail);
  }

  if (pathname === '/api/exports/summary.csv' && req.method === 'GET') {
    return sendCsv(res, `归因汇总_${searchParams.get('date') ?? 'range'}.csv`, buildSummaryCsv({
      date: searchParams.get('date') ?? '',
      startDate: searchParams.get('startDate') ?? '',
      endDate: searchParams.get('endDate') ?? '',
    }));
  }

  if (pathname === '/api/exports/orders.csv' && req.method === 'GET') {
    return sendCsv(res, `归因明细_${searchParams.get('date') ?? 'range'}.csv`, buildDetailCsv({
      date: searchParams.get('date') ?? '',
      startDate: searchParams.get('startDate') ?? '',
      endDate: searchParams.get('endDate') ?? '',
    }));
  }

  m = /^\/api\/samples\/([^/]+)$/.exec(pathname);
  if (m && req.method === 'GET') {
    const file = SAMPLE_FILES[m[1]];
    if (!file) throw new HttpError(404, '样例不存在');
    const filePath = join(ctx.samplesDir, file);
    try {
      const content = await readFile(filePath);
      return sendCsv(res, file, content.toString('utf8'));
    } catch {
      throw new HttpError(404, '样例文件缺失');
    }
  }

  if (pathname === '/api/ingest/batches' && req.method === 'GET') {
    return sendJson(res, 200, listIngestBatches());
  }

  throw new HttpError(404, '接口不存在');
}

export function createApp({ publicDir, samplesDir }) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        await apiRoute(req, res, url, { samplesDir });
      } else {
        if (req.method !== 'GET') throw new HttpError(405, '不支持的方法');
        await serveStatic(res, publicDir, decodeURIComponent(url.pathname));
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.statusCode : 500;
      if (status >= 500) console.error(err);
      sendJson(res, status, { error: err.message || '服务器内部错误' });
    }
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dataDir = process.env.DATA_DIR ?? join(root, 'data');
  openDb(join(dataDir, 'app.db'));
  const app = createApp({ publicDir: join(root, 'public'), samplesDir: join(root, 'samples') });
  const port = Number(process.env.PORT ?? 3217);
  app.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 被占用，请用 PORT=xxxx npm start 指定其他端口`);
      process.exit(1);
    }
    throw err;
  });
  app.listen(port, () => {
    console.log(`本地营销归因服务已启动：http://localhost:${port}（数据库 ${join(dataDir, 'app.db')}）`);
  });
}
