// 零依赖静态服务器：仅托管本仓库目录，方便浏览器以 http:// 方式打开
// （file:// 下 ES Module 会被 CORS 拦截）。不收集、不上传任何数据。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const port = Number(process.env.PORT) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const filePath = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    const s = await stat(filePath).catch(() => null);
    if (!s || !s.isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
}).listen(port, () => {
  console.log(`多机位工具已启动: http://localhost:${port}/  （Ctrl+C 退出）`);
});
