'use strict';
// 第二个本地站点:模拟报告作者引用的外部站点,带请求计数。
// 验证目标:报告预览全程,本站点收到的请求数保持为 0。
const http = require('node:http');
const { barChartPng } = require('./png');

function createSecondSite(port = 18081) {
  const trackerPng = barChartPng();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://second.local');
    if (url.pathname === '/count') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: server.requestCount }));
      return;
    }
    server.requestCount += 1; // 除 /count 外的一切请求都计数
    if (url.pathname === '/tracker.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(trackerPng);
      return;
    }
    res.writeHead(404).end('not found');
  });
  server.requestCount = 0;
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      server.baseUrl = `http://localhost:${server.address().port}`;
      resolve(server);
    });
  });
}

module.exports = { createSecondSite };
