'use strict';
// 隔离预览源:独立主机名 127.0.0.1 + 独立端口,与业务页(localhost)不同源。
// - Cookie 按主机名隔离,业务会话 Cookie 永远不会发到这里(代码里计数验证)。
// - 响应带严格 CSP:禁脚本、禁表单、图片仅允许本预览源与 data:。
// - 列表预览的 iframe 另加 sandbox="",独立预览地址由 CSP 提供同一套规则。
const http = require('node:http');
const fs = require('node:fs');

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
};

function createPreviewServer(store, port = 18082) {
  const server = http.createServer((req, res) => {
    // 观测用:任何带 Cookie 的请求都说明隔离失效
    if (req.headers.cookie) server.cookiesSeen += 1;

    const url = new URL(req.url, 'http://preview.local');
    const docMatch = url.pathname.match(/^\/report\/([\w-]+)\/?$/);
    const assetMatch = url.pathname.match(/^\/report\/([\w-]+)\/([\w.%-]+)$/);

    const csp = [
      "default-src 'none'",
      // sandbox 使文档处于 opaque origin,'self' 可能不匹配,故显式列出本预览源
      `img-src 'self' http://127.0.0.1:${server.address().port} data:`,
      "style-src 'unsafe-inline'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ');
    const baseHeaders = {
      'Content-Security-Policy': csp,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    };

    if (docMatch) {
      const file = store.htmlPath(docMatch[1]);
      if (!file) { res.writeHead(404, baseHeaders).end('not found'); return; }
      res.writeHead(200, { ...baseHeaders, 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (assetMatch) {
      const file = store.assetPath(assetMatch[1], assetMatch[2]);
      if (!file) { res.writeHead(404, baseHeaders).end('not found'); return; }
      const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
      res.writeHead(200, { ...baseHeaders, 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404, baseHeaders).end('not found');
  });
  server.cookiesSeen = 0;
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      server.baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve(server);
    });
  });
}

module.exports = { createPreviewServer };
