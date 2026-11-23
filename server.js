'use strict';
/*
 * server.js — 零依赖本地静态服务器
 * 只绑定 127.0.0.1；不提供目录遍历，只服务仓库内的 public/ 和 src/。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5173);
const HOST = '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

const ALLOWED_ROOTS = ['public', 'src'].map((d) => path.join(ROOT, d));

function resolvePath(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const abs = path.normalize(path.join(ROOT, 'public', p));
  if (abs.startsWith(path.join(ROOT, 'public') + path.sep) && fs.existsSync(abs)) return abs;
  // 允许直接取 src/ 下的模块
  const abs2 = path.normalize(path.join(ROOT, p));
  for (const r of ALLOWED_ROOTS) {
    if (abs2.startsWith(r + path.sep) && fs.existsSync(abs2)) return abs2;
  }
  return null;
}

const server = http.createServer((req, res) => {
  const file = resolvePath(req.url || '/');
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('读取失败: ' + err.message);
      return;
    }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

server.listen(PORT, HOST, () => {
  console.log('立方体环境图工具已启动: http://' + HOST + ':' + PORT);
  console.log('按 Ctrl+C 停止。');
});
