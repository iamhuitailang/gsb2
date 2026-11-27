// 零依赖本地静态服务器:仅监听 127.0.0.1,不访问任何外部地址。
// 路由:
//   GET /                 -> public/index.html
//   GET /styles.css 等     -> public/ 下的静态资源
//   GET /app.js           -> src/ui/app.js(浏览器原生 ES Module)
//   GET /sanitizer/*      -> src/sanitizer/*
//   GET /ui/*             -> src/ui/*
//   GET /api/samples      -> 样例清单
//   GET /api/samples/:f   -> 样例文件内容(限制在 samples/ 目录内)

import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, normalize, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');
const SRC_DIR = join(ROOT, 'src');
const SAMPLES_DIR = join(ROOT, 'samples');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// 统一的安全响应头:应用外壳自身也不允许被嵌套/表单提交
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': MIME['.json'] });
}

// 把 URL 路径映射到磁盘文件,并保证解析结果不逃出允许的目录
function resolveStatic(urlPath) {
  let rel;
  if (urlPath === '/') {
    return join(PUBLIC_DIR, 'index.html');
  }
  if (urlPath.startsWith('/sanitizer/')) {
    rel = urlPath.slice('/sanitizer/'.length);
    return join(SRC_DIR, 'sanitizer', rel);
  }
  if (urlPath.startsWith('/ui/')) {
    rel = urlPath.slice('/ui/'.length);
    return join(SRC_DIR, 'ui', rel);
  }
  if (urlPath === '/app.js') {
    return join(SRC_DIR, 'ui', 'app.js');
  }
  // 其余一律按 public/ 资源处理
  rel = decodeURIComponent(urlPath.slice(1));
  return join(PUBLIC_DIR, rel);
}

function isInside(parent, target) {
  const rel = normalize(relativePath(parent, target));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

function relativePath(from, to) {
  const a = normalize(from).split('/');
  const b = normalize(to).split('/');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return Array(a.length - i).fill('..').concat(b.slice(i)).join('/');
}

const SAMPLE_TITLES = {
  '01-safe-formatting.html': '① 正常排版与安全格式',
  '02-script-injection.html': '② 脚本执行入口(script/事件/协议)',
  '03-dangerous-urls.html': '③ 危险地址与外部请求',
  '04-obfuscation.html': '④ 绕过手法与畸形输入',
  '05-isolation-bypass.html': '⑤ 表单、弹窗与隔离绕过',
  '06-full-document.html': '⑥ 完整 HTML 文档输入'
};

async function handleSamplesList(res) {
  const entries = await readdir(SAMPLES_DIR);
  const files = entries
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((file) => ({ file, title: SAMPLE_TITLES[file] || file }));
  sendJson(res, 200, files);
}

async function handleSampleFile(res, rawName) {
  const name = basename(decodeURIComponent(rawName)); // 只保留文件名,杜绝目录穿越
  if (!/^[\w.-]+\.html$/.test(name)) {
    send(res, 400, 'Invalid sample name');
    return;
  }
  const filePath = join(SAMPLES_DIR, name);
  if (!isInside(SAMPLES_DIR, filePath)) {
    send(res, 403, 'Forbidden');
    return;
  }
  try {
    const body = await readFile(filePath, 'utf8');
    send(res, 200, body, { 'Content-Type': 'text/html; charset=utf-8' });
  } catch {
    send(res, 404, 'Sample not found');
  }
}

export const handler = async (req, res) => {
  if (req.method !== 'GET') {
    send(res, 405, 'Method Not Allowed', { Allow: 'GET' });
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/samples') {
      await handleSamplesList(res);
      return;
    }
    const sampleMatch = /^\/api\/samples\/(.+)$/.exec(url.pathname);
    if (sampleMatch) {
      await handleSampleFile(res, sampleMatch[1]);
      return;
    }

    const filePath = resolveStatic(url.pathname);
    const allowedRoot = filePath.startsWith(SRC_DIR) ? SRC_DIR : PUBLIC_DIR;
    if (!isInside(allowedRoot, filePath)) {
      send(res, 403, 'Forbidden');
      return;
    }
    const body = await readFile(filePath);
    const type = MIME[extname(filePath)] || 'application/octet-stream';
    send(res, 200, body, { 'Content-Type': type });
  } catch (err) {
    if (err.code === 'ENOENT') {
      send(res, 404, 'Not Found');
    } else {
      send(res, 500, `Server Error: ${err.message}`);
    }
  }
};

const server = http.createServer(handler);

// 仅在被直接执行时监听;被测试 import 时不自动启动
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const PORT = Number(process.env.PORT) || 5173;
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`不可信富文本预览台已启动: http://127.0.0.1:${PORT}`);
    console.log('仅监听本机回环地址;按 Ctrl+C 停止。');
  });
}

export { server };
