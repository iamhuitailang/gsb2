import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeRgbaPng } from '../src/png.js';
import { SAMPLE_DEFINITIONS, sampleManifest } from '../src/samples.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const samplesDir = join(root, 'samples');

/**
 * 示例素材是生成产物（已在 .gitignore 中）。服务器启动时若发现缺失就自动生成，
 * 这样克隆仓库后直接 `npm start` 也能看到样图。
 */
async function ensureSamples() {
  const manifest = join(samplesDir, 'samples.json');
  const missing = SAMPLE_DEFINITIONS.filter((def) => !existsSync(join(samplesDir, def.file)));
  if (existsSync(manifest) && !missing.length) return;
  mkdirSync(samplesDir, { recursive: true });
  for (const def of missing) {
    const image = def.build();
    const bytes = await encodeRgbaPng(image.rgba, image.width, image.height);
    writeFileSync(join(samplesDir, def.file), bytes);
    console.log(`生成示例 ${def.file}`);
  }
  if (!existsSync(manifest)) {
    writeFileSync(manifest, JSON.stringify(sampleManifest(), null, 2) + '\n');
  }
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip',
};

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const filePath = resolve(join(root, normalize(pathname)));
    // 目录穿越保护
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    const stat = statSync(filePath);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      // Worker 与 SharedArrayBuffer 无关，但保留同源策略
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Server error: ${err.message}`);
  }
});

server.listen(port, host, () => {
  console.log(`Palette Forge 已启动： http://${host}:${port}`);
  console.log('按 Ctrl+C 停止。');
});

// 启动后再生成示例；即使失败也不影响页面，浏览器会现场构建示例。
ensureSamples()
  .then(() => console.log(`示例素材就绪：${samplesDir}`))
  .catch((err) =>
    console.warn('自动生成示例素材失败，可在界面里现场构建或手动运行 npm run generate:samples：', err.message),
  );
