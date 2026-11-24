#!/usr/bin/env node
/**
 * 开发服务器：构建到 dist/ 后用 Node 内置静态服务器托管，并在文件变化时重建。
 * 只用 Node 标准库，不依赖 vite 等工具。
 */
import { spawn } from 'node:child_process';
import { createReadStream, statSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const port = Number(process.env.PORT ?? 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function runBuild() {
  return new Promise((resolveBuild) => {
    const child = spawn(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });
    child.on('exit', (code) => resolveBuild(code === 0));
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const target = normalize(join(dist, pathname));
  if (!target.startsWith(dist)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const stat = statSync(target);
    if (stat.isDirectory()) {
      res.writeHead(302, { location: `${pathname.replace(/\/?$/, '/')}index.html` }).end();
      return;
    }
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(target).pipe(res);
});

const ok = await runBuild();
if (!ok) {
  console.error('首次构建失败，请修复后重试。');
  process.exit(1);
}

server.listen(port, () => {
  console.log(`维修分摊试验台: http://localhost:${port}/`);
});

let timer = null;
let building = false;
const rebuild = async () => {
  if (building) return;
  building = true;
  await runBuild();
  building = false;
};

for (const dir of [join(root, 'src'), join(root, 'public')]) {
  watch(dir, { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(rebuild, 150);
  });
}
