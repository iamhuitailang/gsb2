// 零依赖静态服务器: 调试页直接 import 编译后的 ESM 模块, 引擎只有一份实现。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 5173);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = normalize(urlPath === '/' ? 'public/index.html' : urlPath.slice(1));
    if (rel.startsWith('..')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const file = join(ROOT, rel);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}).listen(PORT, () => {
  console.log(`引导提示调试台: http://localhost:${PORT}/  (先 npm run build)`);
});
