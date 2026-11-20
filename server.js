#!/usr/bin/env node
/**
 * Minimal zero-dependency static file server for ChromaDeck.
 * ES modules and workers need an http(s) origin, so `file://` is not enough.
 *
 * It also serves the bundled samples. If `samples/` is empty (fresh clone,
 * or the binary files were never committed) the samples are generated on the
 * first request from `src/lib/sample-scenes.js` and then cached on disk.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const SAMPLES_DIR = join(ROOT, 'samples');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip'
};

function sendError(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(message);
}

let sampleBuild = null;
/**
 * Generate the sample files once. Concurrent requests share one build.
 */
function ensureSamples() {
  if (!sampleBuild) {
    sampleBuild = (async () => {
      const { writeAllSamples } = await import('./src/lib/sample-scenes.js');
      const results = await writeAllSamples(SAMPLES_DIR);
      console.log(`[samples] 已生成 ${results.length} 张样例图片到 samples/`);
      return results;
    })().catch((error) => {
      sampleBuild = null;
      throw error;
    });
  }
  return sampleBuild;
}

async function serveSamples(req, res, pathname) {
  let file;
  try {
    file = decodeURIComponent(pathname.slice('/samples/'.length));
  } catch {
    sendError(res, 400, 'Bad sample path');
    return;
  }
  if (!file || file.includes('/') || file.includes('\\') || file.includes('..')) {
    sendError(res, 400, 'Bad sample path');
    return;
  }
  let target = join(SAMPLES_DIR, file);
  let info = await stat(target).catch(() => null);
  if (!info?.isFile()) {
    // Generate on demand (and cache to disk) the first time a sample is asked
    // for; this also rebuilds a partially deleted samples/ directory.
    try {
      await ensureSamples();
    } catch (error) {
      console.error('[samples]', error);
      sendError(res, 500, `样例生成失败：${error.message}`);
      return;
    }
    info = await stat(target).catch(() => null);
  }
  if (!info?.isFile()) {
    sendError(res, 404, `Not found: ${pathname}`);
    return;
  }
  const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, name: 'chromadeck' }));
      return;
    }
    if (url.pathname.startsWith('/api/samples/') || url.pathname.startsWith('/samples/')) {
      const pathname = url.pathname.replace('/api/samples/', '/samples/');
      await serveSamples(req, res, pathname);
      return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const safePath = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
    let filePath = join(ROOT, safePath);
    if (!filePath.startsWith(ROOT + sep) && filePath !== ROOT) {
      sendError(res, 403, 'Forbidden');
      return;
    }

    let info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) {
      filePath = join(filePath, 'index.html');
      info = await stat(filePath).catch(() => null);
    }
    if (!info?.isFile()) {
      sendError(res, 404, `Not found: ${url.pathname}`);
      return;
    }

    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': info.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error('[server]', error);
    sendError(res, 500, 'Internal server error');
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。可通过 PORT=其他端口 npm start 重新启动。`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`ChromaDeck 已启动: http://${HOST}:${PORT}`);
  // Warm the samples in the background so the "载入样例" button is instant.
  ensureSamples().catch((error) => console.error('[samples] 预热失败', error));
});
