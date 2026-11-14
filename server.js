// 本地 HTTP 入口：只做路由与协议，业务逻辑全部在 lib/。
// 启动：node server.js（默认 3000 端口，PORT 环境变量可改）。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

import { getState, initStore, reload } from './lib/store.js';
import { CATEGORIES, filterByCategory, filterWaybills, summarize } from './lib/aggregate.js';
import { buildDetailsCsv, buildSummaryCsv } from './lib/export.js';

const PUBLIC_DIR = join(process.cwd(), 'public');
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': MIME['.json'] });
  res.end(body);
}

function readFilters(url) {
  return {
    site: url.searchParams.get('site')?.trim() || '',
    dateFrom: url.searchParams.get('date_from')?.trim() || '',
    dateTo: url.searchParams.get('date_to')?.trim() || '',
  };
}

function scopedWaybills(url) {
  const filters = readFilters(url);
  return { filters, waybills: filterWaybills(getState().enriched, filters) };
}

async function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const relPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = normalize(join(PUBLIC_DIR, relPath));

  // 防路径穿越：解析后必须仍在 public/ 内
  if (!filePath.startsWith(resolve(PUBLIC_DIR) + '/') && filePath !== resolve(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

function sendCsv(res, filename, csv) {
  res.writeHead(200, {
    'Content-Type': MIME['.csv'],
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  res.end(csv);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (!pathname.startsWith('/api/')) return await serveStatic(req, res);

    if (req.method === 'GET' && pathname === '/api/health') {
      const s = getState();
      return sendJson(res, 200, { ok: true, loadedAt: s.loadedAt, counts: s.counts });
    }

    if (req.method === 'GET' && pathname === '/api/sites') {
      return sendJson(res, 200, { sites: getState().sites });
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      const s = getState();
      return sendJson(res, 200, {
        loadedAt: s.loadedAt,
        counts: s.counts,
        dataErrors: s.dataErrors,
      });
    }

    if (req.method === 'GET' && pathname === '/api/summary') {
      const { filters, waybills } = scopedWaybills(url);
      return sendJson(res, 200, { filters, rows: summarize(waybills) });
    }

    if (req.method === 'GET' && pathname === '/api/details') {
      const category = url.searchParams.get('category') || 'all';
      if (!CATEGORIES.includes(category)) {
        return sendJson(res, 400, { error: `category 仅支持: ${CATEGORIES.join(', ')}` });
      }
      const { filters, waybills } = scopedWaybills(url);
      return sendJson(res, 200, {
        filters,
        category,
        rows: filterByCategory(waybills, category),
      });
    }

    if (req.method === 'GET' && pathname === '/api/missing-rates') {
      const { filters, waybills } = scopedWaybills(url);
      return sendJson(res, 200, {
        filters,
        rows: filterByCategory(waybills, 'missing_rate'),
      });
    }

    if (req.method === 'POST' && pathname === '/api/reload') {
      try {
        const s = await reload();
        return sendJson(res, 200, {
          ok: true,
          loadedAt: s.loadedAt,
          counts: s.counts,
          dataErrors: s.dataErrors,
        });
      } catch (err) {
        // 新数据整体不生效，内存保留上一份可用数据
        return sendJson(res, 400, { ok: false, error: err.message, dataErrors: getState().dataErrors });
      }
    }

    if (req.method === 'GET' && pathname === '/api/export/summary') {
      const { filters, waybills } = scopedWaybills(url);
      const csv = buildSummaryCsv(summarize(waybills));
      return sendCsv(res, `配送费汇总_${filters.dateFrom || '起始'}_${filters.dateTo || '至今'}.csv`, csv);
    }

    if (req.method === 'GET' && pathname === '/api/export/details') {
      const { filters, waybills } = scopedWaybills(url);
      const csv = buildDetailsCsv(waybills);
      return sendCsv(res, `运单明细_${filters.dateFrom || '起始'}_${filters.dateTo || '至今'}.csv`, csv);
    }

    return sendJson(res, 404, { error: '接口不存在' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
});

if (process.env.NODE_SERVER_NO_LISTEN !== '1') {
  initStore()
    .then(() => {
      server.listen(PORT, () => {
        console.log(`配送费核算工具已启动: http://localhost:${PORT}`);
        console.log(`数据目录: ${process.env.DELIVERY_FEE_DATA_DIR || join(process.cwd(), 'data')}`);
      });
    })
    .catch((err) => {
      console.error('启动失败（数据文件有误，请修正后重试）:', err.message);
      process.exit(1);
    });
}

export { server };
