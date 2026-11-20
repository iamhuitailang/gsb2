// 本地静态服务 + JSON API。
// 仅监听 127.0.0.1，不连接任何外部服务；接口内部复用 src/core 的同一套分析逻辑，
// 保证页面内分析、命令行分析与自动化测试结果一致。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parsePolicy,
  parseHeaderText,
  lintPolicy,
  lintPolicies,
  analyzeCoverage,
  evaluateSample,
  comparePolicies,
} from './src/core/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, 'web');
const SRC_DIR = path.join(__dirname, 'src');
const PORT = Number(process.env.PORT) || 5179;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// 工作台自身的安全响应头：所有资源只允许同源加载，不允许外部连接、插件与嵌入。
const SELF_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');

function securityHeaders(res, extra = {}) {
  const headers = {
    'Content-Security-Policy': SELF_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extra,
  };
  for (const [k, v] of Object.entries(headers)) {
    res.setHeader(k, v);
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  securityHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  // 只允许访问 web/ 与 src/（源码模块供浏览器 import），杜绝路径穿越
  let root = WEB_DIR;
  if (pathname.startsWith('/src/')) root = SRC_DIR;
  const filePath = path.normalize(path.join(root, pathname.replace(/^\/src\//, '/').replace(/^\/+/, '/')));
  if (!filePath.startsWith(root)) {
    securityHeaders(res);
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    securityHeaders(res);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    securityHeaders(res);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体超过 2MB 限制'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function buildPolicy(input) {
  const mode = input.mode === 'report-only' ? 'report-only' : 'enforce';
  // 含逗号则按多策略头解析，否则按单策略解析
  if (typeof input.text === 'string' && input.text.includes(',')) {
    const header = parseHeaderText(input.text, { mode, namePrefix: input.name });
    return { kind: 'header', ...header };
  }
  const policy = parsePolicy(input.text || '', { mode, name: input.name || '' });
  return { kind: 'single', policies: [policy], issues: policy.issues };
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  if (!req.url.startsWith('/api/')) {
    if (req.method === 'GET') return serveStatic(req, res);
    return sendJson(res, 405, { error: '仅支持 GET 静态资源' });
  }

  try {
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};

    switch (req.url) {
      case '/api/parse': {
        const result = buildPolicy(body);
        const semantic = lintPolicies(result.policies).concat(result.policies.flatMap(lintPolicy));
        return sendJson(res, 200, {
          kind: result.kind,
          policies: result.policies.map(serializePolicy),
          issues: [...result.issues, ...semantic],
        });
      }
      case '/api/coverage': {
        const result = buildPolicy(body);
        return sendJson(res, 200, {
          policies: result.policies.map((p) => ({
            name: p.name,
            mode: p.mode,
            coverage: analyzeCoverage(p),
            parseErrors: p.issues.filter((i) => i.severity === 'error'),
          })),
        });
      }
      case '/api/evaluate': {
        const result = buildPolicy({ text: body.policyText, mode: body.mode, name: 'API 策略' });
        if (!body.sample) return sendJson(res, 400, { error: '缺少 sample 参数' });
        const verdict = evaluateSample(body.sample, result.policies);
        return sendJson(res, 200, verdict);
      }
      case '/api/compare': {
        if (!body.policyA || !body.policyB) return sendJson(res, 400, { error: '缺少 policyA / policyB' });
        const a = parsePolicy(body.policyA.text || '', { mode: body.policyA.mode, name: body.policyA.name || 'A' });
        const b = parsePolicy(body.policyB.text || '', { mode: body.policyB.mode, name: body.policyB.name || 'B' });
        return sendJson(res, 200, comparePolicies(a, b));
      }
      default:
        return sendJson(res, 404, { error: `未知接口 ${req.url}` });
    }
  } catch (err) {
    return sendJson(res, 400, { error: `请求处理失败：${err.message}` });
  }
});

function serializePolicy(p) {
  return {
    name: p.name,
    mode: p.mode,
    raw: p.raw,
    canonical: p.canonical,
    hasErrors: p.hasErrors,
    directives: p.directives.map((d) => ({
      name: d.name,
      raw: d.raw,
      known: d.known,
      duplicate: d.duplicate,
      valueRaw: d.valueRaw,
      valueTokens: d.valueTokens,
      loc: d.loc,
      sourceErrors: d.sourceErrors,
    })),
    issues: p.issues,
  };
}

server.listen(PORT, HOST, () => {
  console.log('CSP 审查工作台已启动（纯本地，无外部连接）');
  console.log(`  地址:   http://${HOST}:${PORT}/`);
  console.log('  按 Ctrl+C 停止');
});
