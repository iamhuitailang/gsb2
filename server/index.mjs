// 本地服务：静态页面、素材上传与探测、预览取帧、音频片段、导出与复检。
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  ROOT, PUBLIC_DIR, MEDIA_DIR, EXPORT_DIR, SAMPLE_DIR,
  ensureDirs,
} from './util.mjs';
import { probeMedia, extractFrame } from './ffmpeg.mjs';
import { normalizeProject, validateProject } from '../src/project.js';
import { buildTimeline } from '../src/timeline.js';
import { buildAudioPlan, audioTransitionPlan, normalizeAudio } from '../src/audio.js';
import { SAMPLE_SPECS, SAMPLE_VERSION } from '../src/samples.js';
import { renderProject, verifyExport } from './export.mjs';
import { ensureSamples } from './samples-service.mjs';

const PORT = Number(process.env.PORT || 5273);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text);
  res.writeHead(status, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req, limit = 1024 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeBase(name) {
  return path.basename(String(name || '')).replace(/[^\w.\- ]/g, '_').slice(-120);
}

async function serveFile(res, file, { cache = false, range = null } = {}) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return sendText(res, 404, 'not found');
  }
  if (!stat.isFile()) return sendText(res, 404, 'not found');
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': cache ? 'public, max-age=3600' : 'no-store',
  };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] === '' ? null : Number(m[1]);
      let end = m[2] === '' ? null : Number(m[2]);
      if (start == null) {
        start = Math.max(0, stat.size - (end ?? 0));
        end = stat.size - 1;
      } else if (end == null) {
        end = stat.size - 1;
      }
      end = Math.min(end, stat.size - 1);
      if (start > end) return sendText(res, 416, 'range not satisfiable');
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'content-length': end - start + 1,
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  createReadStream(file).pipe(res);
}

// 从 URL 解析媒体文件：先 public/samples，再 data/media；只允许 basename。
async function findMedia(name) {
  const base = safeBase(path.basename(decodeURIComponent(name)));
  for (const dir of [SAMPLE_DIR, MEDIA_DIR, EXPORT_DIR]) {
    const p = path.join(dir, base);
    try {
      const st = await fs.stat(p);
      if (st.isFile()) return p;
    } catch { /* next */ }
  }
  return null;
}

async function api(req, res, url) {
  const { pathname } = url;
  const q = url.searchParams;

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, version: SAMPLE_VERSION, cwd: ROOT });
  }

  if (pathname === '/api/samples') {
    const items = [];
    for (const spec of SAMPLE_SPECS) {
      const file = path.join(SAMPLE_DIR, spec.fileName);
      let info = null;
      try {
        const st = await fs.stat(file);
        info = await probeMedia(file);
        info.size = st.size;
      } catch { /* missing */ }
      items.push({
        id: spec.id,
        label: spec.label,
        title: spec.title,
        fileName: spec.fileName,
        url: `/media/${spec.fileName}`,
        expected: spec,
        ready: Boolean(info),
        media: info,
      });
    }
    const versionFile = path.join(SAMPLE_DIR, '.version.json');
    let version = null;
    try { version = JSON.parse(await fs.readFile(versionFile, 'utf8')); } catch { /* none */ }
    return sendJson(res, 200, { items, version });
  }

  if (pathname === '/api/upload' && req.method === 'POST') {
    const raw = await readBody(req);
    const name = safeBase(q.get('name') || `clip-${Date.now()}.mp4`);
    const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const ext = path.extname(name) || '.mp4';
    const fileName = `${id}${ext}`;
    const dest = path.join(MEDIA_DIR, fileName);
    await fs.writeFile(dest, raw);
    let info;
    try {
      info = await probeMedia(dest);
    } catch (err) {
      await fs.rm(dest, { force: true });
      return sendJson(res, 400, { error: `无法解析该文件：${err.message}` });
    }
    return sendJson(res, 200, {
      id,
      fileName,
      originalName: name,
      url: `/media/${fileName}`,
      size: raw.length,
      media: info,
    });
  }

  if (pathname === '/api/probe') {
    const p = await findMedia(q.get('file') || '');
    if (!p) return sendJson(res, 404, { error: '文件不存在' });
    const info = await probeMedia(p);
    const st = await fs.stat(p);
    return sendJson(res, 200, { ...info, size: st.size, base: path.basename(p) });
  }

  if (pathname === '/api/analyze' && req.method === 'POST') {
    const project = normalizeProject(JSON.parse((await readBody(req)).toString() || '{}'));
    const timeline = buildTimeline(project);
    const validation = validateProject(project);
    const audioPlan = buildAudioPlan(timeline, project);
    const transitions = timeline.transitions.map((tr) => ({
      ...tr,
      audioPlan: audioTransitionPlan(timeline, tr, project),
    }));
    return sendJson(res, 200, {
      timeline,
      validation: { ok: validation.ok, checks: validation.checks },
      audioPlan: audioPlan.map((a) => ({
        clipIndex: a.clipIndex, start: a.start, end: a.end, duration: a.duration,
        silent: a.silent, reason: a.reason || null, note: a.note || '', points: a.points,
        srcOffset: a.srcOffset,
      })),
      transitions,
    });
  }

  if (pathname === '/api/frame') {
    const file = q.get('file') || '';
    const p = await findMedia(file);
    if (!p) return sendJson(res, 404, { error: '文件不存在' });
    const t = Number(q.get('t') || 0);
    const tmp = path.join(MEDIA_DIR, `frame-${randomBytes(6).toString('hex')}.jpg`);
    try {
      await extractFrame(p, t, tmp, { width: Number(q.get('w')) || undefined, height: Number(q.get('h')) || undefined });
      const buf = await fs.readFile(tmp);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'no-store' });
      res.end(buf);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    } finally {
      await fs.rm(tmp, { force: true });
    }
    return;
  }

  if (pathname === '/api/audio-src') {
    const p = await findMedia(q.get('file') || '');
    if (!p) return sendJson(res, 404, { error: '文件不存在' });
    const { sourceWav } = await import('./audio-mix.mjs');
    const wav = await sourceWav(p);
    if (!wav) return sendJson(res, 404, { error: '该素材没有可用音频' });
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'cache-control': 'public, max-age=600' });
    res.end(wav);
    return;
  }

  if (pathname === '/api/export' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const project = normalizeProject(body.project || body);
    const validation = validateProject(project);
    // 叠化被收窄属于「已说明的提示」，不阻止导出；其余未通过项才需要确认。
    const blocking = validation.checks.filter((c) => !c.ok && c.id !== 'dissolves-fit');
    if (blocking.length && !body.force) {
      return sendJson(res, 400, {
        error: '校验未通过',
        validation: { ok: false, checks: validation.checks, blocking: blocking.map((c) => c.id) },
      });
    }
    try {
      const result = await renderProject(project);
      return sendJson(res, 200, {
        id: result.id,
        file: result.file,
        url: `/exports/${result.file}`,
        wavUrl: `/exports/${result.wav}`,
        metaUrl: `/api/exports/${result.id}`,
        report: result.report,
        timeline: result.timeline,
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (pathname === '/api/exports' && req.method === 'GET') {
    const items = [];
    try {
      const files = await fs.readdir(EXPORT_DIR);
      for (const f of files.filter((x) => x.endsWith('.json'))) {
        try {
          const meta = JSON.parse(await fs.readFile(path.join(EXPORT_DIR, f), 'utf8'));
          items.push({
            id: meta.id, file: meta.file, createdAt: meta.createdAt,
            url: `/exports/${meta.file}`, reportOk: meta.report?.ok ?? null,
            duration: meta.timeline?.duration ?? null,
          });
        } catch { /* skip */ }
      }
    } catch { /* empty */ }
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return sendJson(res, 200, { items });
  }

  const exportMatch = /^\/api\/exports\/([\w-]+)$/.exec(pathname);
  if (exportMatch) {
    const file = path.join(EXPORT_DIR, `${exportMatch[1]}.json`);
    try {
      const meta = JSON.parse(await fs.readFile(file, 'utf8'));
      return sendJson(res, 200, meta);
    } catch {
      return sendJson(res, 404, { error: '导出记录不存在' });
    }
  }

  const reverifyMatch = /^\/api\/exports\/([\w-]+)\/verify$/.exec(pathname);
  if (reverifyMatch && req.method === 'POST') {
    const metaPath = path.join(EXPORT_DIR, `${reverifyMatch[1]}.json`);
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    } catch {
      return sendJson(res, 404, { error: '导出记录不存在' });
    }
    const project = normalizeProject(meta.project);
    const timeline = buildTimeline(project);
    const report = await verifyExport({ ...meta, filePath: path.join(EXPORT_DIR, meta.file) }, project, timeline);
    meta.report = report;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    return sendJson(res, 200, { report });
  }

  if (pathname === '/api/generate-samples' && req.method === 'POST') {
    try {
      const result = await ensureSamples({ force: Boolean(q.get('force')) });
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  return sendJson(res, 404, { error: 'unknown api', path: pathname });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || HOST}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);

    if (url.pathname.startsWith('/samples/')) {
      const p = await findMedia(path.basename(url.pathname));
      return serveFile(res, p || path.join(SAMPLE_DIR, 'missing'), { cache: true, range: req.headers.range });
    }
    if (url.pathname.startsWith('/media/')) {
      const p = await findMedia(path.basename(url.pathname));
      if (!p) return sendText(res, 404, 'not found');
      return serveFile(res, p, { cache: true, range: req.headers.range });
    }
    if (url.pathname.startsWith('/exports/')) {
      const p = path.join(EXPORT_DIR, safeBase(decodeURIComponent(path.basename(url.pathname))));
      return serveFile(res, p, { cache: false, range: req.headers.range });
    }

    if (url.pathname.startsWith('/src/')) {
      // 与浏览器共享的时间线 / 音频 / 工程模型
      const rel = url.pathname.replace(/^\/src\/?/, '');
      // 只允许 src 目录下的单层 .js 文件，避免路径穿越
      if (!/^[A-Za-z0-9_-]+\.js$/.test(rel)) return sendText(res, 404, 'not found');
      const p = path.join(ROOT, 'src', rel);
      return serveFile(res, p, { cache: false });
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.join(PUBLIC_DIR, rel.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'forbidden');
    return serveFile(res, file, { cache: false });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

async function main() {
  await ensureDirs();
  try {
    await ensureSamples({});
  } catch (err) {
    console.warn('[samples] 自动生成失败：', err.message);
    console.warn('[samples] 可稍后运行 npm run generate:samples');
  }
  server.listen(PORT, HOST, () => {
    console.log(`短片拼接与转场检查页: http://${HOST}:${PORT}`);
    console.log(`workspace: ${ROOT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
