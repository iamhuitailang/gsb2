/**
 * 本地服务：静态页面 + 素材登记 + 计划构建 + 导出 + 读回校验。
 *
 * 仅监听 127.0.0.1，不对外网开放。素材通过 token 访问，不接受任意路径。
 */
import http from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

import {
  contentTypeForPath,
  findToken,
  guessKindFromPath,
  isImageSubtitle,
  isSupportedTextSubtitle,
  listMediaExtensions,
  registerFile,
} from './server/media.js';
import { probeCapabilities, probeMedia, ExternalToolError } from './server/ffmpeg.js';
import { buildPlan, clearProbeCache, hydrateProject, readSubtitleRecord } from './server/project.js';
import { getJob, listJobs, startExport, subscribe } from './server/export.js';
import { verifyOutput } from './server/verify.js';
import { shiftAndClipCues } from './public/shared/subtitles.js';
import { resolveAudioTimeline } from './public/shared/timeline.js';
import { LANGUAGES, guessLanguageFromFileName, normalizeLanguage } from './public/shared/languages.js';
import { SAMPLE_DIR, buildSampleProject, checkSampleSet, ensureSampleSet } from './scripts/samples.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const CACHE_DIR = join(__dirname, '.cache');
const UPLOAD_DIR = join(CACHE_DIR, 'uploads');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 5173);
const MAX_JSON_BODY = 8 * 1024 * 1024; // 计划里带字幕文本，给足空间
const MAX_UPLOAD = 4 * 1024 * 1024 * 1024;

mkdirSync(UPLOAD_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, error, extra = {}) {
  sendJson(res, status, {
    error: {
      code: error.code || 'error',
      message: error.message || String(error),
      ...extra,
    },
  });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY) {
      const error = new Error('请求体过大');
      error.code = 'too-large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    const failure = new Error(`JSON 解析失败：${error.message}`);
    failure.code = 'bad-json';
    throw failure;
  }
}

function safePublicPath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const target = resolve(PUBLIC_DIR, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (!target.startsWith(PUBLIC_DIR + sep) && target !== PUBLIC_DIR) return null;
  return target;
}

function serveStatic(req, res, urlPath) {
  const target = safePublicPath(urlPath);
  if (!target || !existsSync(target) || !statSync(target).isFile()) {
    sendJson(res, 404, { error: { code: 'not-found', message: '页面不存在' } });
    return;
  }
  const ext = extname(target).toLowerCase();
  const stat = statSync(target);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  createReadStream(target).pipe(res);
}

/** 支持 Range 的媒体流；视频拖动进度条依赖 206。 */
function serveMedia(req, res, token) {
  const record = findToken(token);
  if (!record) {
    sendJson(res, 404, { error: { code: 'stale-token', message: '素材已失效，请重新添加' } });
    return;
  }
  if (!existsSync(record.path)) {
    sendJson(res, 410, { error: { code: 'missing-file', message: '素材文件已被移动或删除' } });
    return;
  }
  const stat = statSync(record.path);
  const total = stat.size;
  const type = contentTypeForPath(record.path);
  const range = req.headers.range;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    if (!match) {
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      res.end();
      return;
    }
    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : total - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      res.end();
      return;
    }
    end = Math.min(end, total - 1);
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${total}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    createReadStream(record.path, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': total,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  });
  createReadStream(record.path).pipe(res);
}

function describeEntry(fullPath, name) {
  const stat = statSync(fullPath);
  if (stat.isDirectory()) {
    return { name, path: fullPath, type: 'directory', kind: 'directory', size: null };
  }
  const kind = guessKindFromPath(fullPath);
  return {
    name,
    path: fullPath,
    type: 'file',
    kind,
    size: stat.size,
    extension: extname(fullPath).slice(1).toLowerCase(),
    supportedTextSubtitle: isSupportedTextSubtitle(fullPath),
    imageSubtitle: isImageSubtitle(fullPath),
  };
}

const BROWSE_ROOTS = () => [
  { label: '示例素材', path: SAMPLE_DIR },
  { label: '主目录', path: homedir() },
  { label: '桌面', path: join(homedir(), 'Desktop') },
  { label: '下载', path: join(homedir(), 'Downloads') },
  { label: '影片', path: join(homedir(), 'Movies') },
  { label: '音乐', path: join(homedir(), 'Music') },
  { label: '文稿', path: join(homedir(), 'Documents') },
];

function listDirectory(dirString) {
  const root = dirString ? resolve(dirString) : homedir();
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    const error = new Error(`目录不存在：${root}`);
    error.code = 'no-dir';
    throw error;
  }
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => {
      const fullPath = join(root, entry.name);
      try {
        const info = describeEntry(fullPath, entry.name);
        if (info.type === 'directory') return info;
        if (info.kind !== 'unknown') return info;
        if (['srt', 'vtt', 'ass', 'ssa'].includes(info.extension)) {
          return { ...info, kind: 'subtitle' };
        }
        if (info.extension === 'json') {
          return { ...info, kind: 'config' };
        }
        return null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });

  const parent = dirname(root);
  const isInsideRoot = BROWSE_ROOTS().some(
    (item) => root === item.path || root.startsWith(item.path + sep),
  );
  return {
    dir: root,
    parent: parent !== root && isInsideRoot ? parent : null,
    roots: BROWSE_ROOTS().filter((item) => existsSync(item.path)),
    entries,
  };
}

async function handleImport(req, res) {
  const body = await readJson(req);
  const paths = Array.isArray(body.paths) ? body.paths : [];
  if (!paths.length) {
    sendError(res, 400, Object.assign(new Error('没有提供文件路径'), { code: 'no-paths' }));
    return;
  }
  const results = [];
  for (const item of paths) {
    const filePath = typeof item === 'string' ? item : item.path;
    try {
      const record = registerFile(filePath);
      const kind = record.kind === 'unknown' ? guessKindFromPath(record.path) : record.kind;
      const base = {
        token: record.token,
        name: record.name,
        path: record.path,
        kind,
        extension: record.extension,
        size: record.size,
      };

      if (kind === 'subtitle') {
        base.formatName = record.extension;
        base.duration = null;
        base.audioStreams = 0;
        base.videoStreams = 0;
        base.subtitleStreams = 1;
        base.language = guessLanguageFromFileName(record.name);
        const parsed = readSubtitleRecord(record);
        base.subtitle = parsed.ok
          ? {
              ok: true,
              format: parsed.format,
              cueCount: parsed.cues.length,
              sourceDuration: parsed.sourceDuration,
              styleLost: parsed.styleLost,
            }
          : { ok: false, reason: parsed.reason };
        if (!isSupportedTextSubtitle(record.path)) {
          base.issue = isImageSubtitle(record.path)
            ? '位图字幕暂不支持，请先转成 SRT'
            : `不支持的字幕格式 .${record.extension}`;
        }
        results.push({ ok: true, ...base });
        continue;
      }

      const probe = await probeMedia(record.path);
      base.formatName = probe.formatName;
      base.duration = probe.duration;
      base.audioStreams = probe.streams.filter((s) => s.codecType === 'audio').length;
      base.videoStreams = probe.streams.filter((s) => s.codecType === 'video').length;
      base.subtitleStreams = probe.streams.filter((s) => s.codecType === 'subtitle').length;
      const taggedLanguage = probe.streams.find((s) => s.language && s.language !== 'und')?.language;
      base.language = taggedLanguage
        ? normalizeLanguage(taggedLanguage)
        : guessLanguageFromFileName(record.name);

      if (kind === 'video') {
        const videoStream = probe.streams.find((s) => s.codecType === 'video');
        base.video = videoStream
          ? { width: videoStream.width, height: videoStream.height, codec: videoStream.codecName }
          : null;
      }
      if (kind === 'audio') {
        const stream = probe.streams.find((s) => s.codecType === 'audio');
        base.audio = stream
          ? {
              codec: stream.codecName,
              sampleRate: stream.sampleRate,
              channels: stream.channels,
              channelLayout: stream.channelLayout,
            }
          : null;
        if (!stream) base.issue = '文件中没有音频流';
      }
      results.push({ ok: true, ...base });
    } catch (error) {
      results.push({
        ok: false,
        path: typeof item === 'string' ? item : item.path,
        error: { code: error.code || 'import-failed', message: error.message },
      });
    }
  }
  sendJson(res, 200, { results });
}

async function handleUpload(req, res, query) {
  const fileName = basename(query.get('name') || `upload-${Date.now()}`);
  if (!fileName || fileName === '.' || fileName === '..') {
    sendError(res, 400, Object.assign(new Error('上传文件名无效'), { code: 'bad-name' }));
    return;
  }
  const folder = join(UPLOAD_DIR, randomBytes(8).toString('hex'));
  mkdirSync(folder, { recursive: true });
  const target = join(folder, fileName);

  const handle = createWriteStream(target);
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_UPLOAD) throw Object.assign(new Error('文件超过 4GB 限制'), { code: 'too-large' });
      if (!handle.write(chunk)) await once(handle, 'drain');
    }
    handle.end();
    await once(handle, 'close');
  } catch (error) {
    handle.destroy();
    rmSync(target, { force: true });
    sendError(res, 400, error);
    return;
  }

  try {
    const record = registerFile(target);
    const probe = await probeMedia(target);
    sendJson(res, 200, {
      ok: true,
      token: record.token,
      name: record.name,
      path: record.path,
      kind: record.kind,
      size,
      duration: probe.duration,
      formatName: probe.formatName,
    });
  } catch (error) {
    sendError(res, 400, error);
  }
}

async function handlePlan(req, res) {
  const body = await readJson(req);
  const hydrated = await hydrateProject(body);
  const plan = buildPlan(hydrated);
  const editorConfig = {
    name: plan.name,
    video: plan.video,
    audioTracks: hydrated.audioTracks.map((track) => ({
      id: track.id,
      name: track.name,
      language: track.language,
      offset: track.offset,
      enabled: track.enabled,
      default: track.default,
      sourceDuration: track.sourceDuration,
      path: track.path,
    })),
    subtitleTracks: hydrated.subtitleTracks.map((track) => ({
      id: track.id,
      name: track.name,
      language: track.language,
      offset: track.offset,
      enabled: track.enabled,
      default: track.default,
      sourceDuration: track.sourceDuration,
      path: track.path,
    })),
  };
  sendJson(res, 200, { plan, editorConfig });
}

async function handlePreviewSubtitle(req, res, url) {
  const token = url.searchParams.get('token');
  const offset = Number(url.searchParams.get('offset') || 0);
  const record = findToken(token);
  if (!record) {
    sendError(res, 404, Object.assign(new Error('字幕素材已失效'), { code: 'stale-token' }));
    return;
  }
  const parsed = readSubtitleRecord(record);
  if (!parsed.ok) {
    sendError(res, 422, Object.assign(new Error(parsed.reason), { code: 'bad-subtitle' }), {
      format: parsed.format,
    });
    return;
  }
  sendJson(res, 200, {
    format: parsed.format,
    styleLost: parsed.styleLost,
    cues: parsed.cues,
    offset,
    sourceDuration: parsed.sourceDuration,
  });
}

async function handleExport(req, res) {
  const body = await readJson(req);
  const outputPath = body.outputPath || null;
  const id = await startExport(body.project || body, { outputPath });
  sendJson(res, 202, { jobId: id, eventsUrl: `/api/jobs/${id}/events` });
}

function sendSseHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
}

function handleJobEvents(req, res, job) {
  sendSseHeaders(res);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);
  const cleanup = () => clearInterval(heartbeat);

  const unsubscribe = subscribe(job, (payload) => {
    if (res.writableEnded) return;
    res.write(`event: progress\ndata: ${JSON.stringify(payload)}\n\n`);
    if (payload.status === 'done' || payload.status === 'failed') {
      res.write('event: end\ndata: {}\n\n');
      res.end();
      cleanup();
    }
  });

  req.on('close', () => {
    cleanup();
    unsubscribe();
  });
}

async function handleVerifyFile(req, res) {
  const body = await readJson(req);
  const outputPath = body.path;
  if (!outputPath || !existsSync(outputPath)) {
    sendError(res, 400, Object.assign(new Error('成品文件不存在'), { code: 'no-file' }));
    return;
  }
  const configPath = body.configPath || outputPath.replace(/\.[^.]+$/, '') + '.tracks.json';
  if (!existsSync(configPath)) {
    sendError(res, 400, Object.assign(new Error('找不到轨道配置 .tracks.json'), { code: 'no-config' }));
    return;
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    sendError(res, 400, Object.assign(new Error(`轨道配置无法解析：${error.message}`), { code: 'bad-config' }));
    return;
  }
  if (config.format !== 'trackweave-project') {
    sendError(res, 400, Object.assign(new Error('不是 trackweave 轨道配置'), { code: 'bad-config' }));
    return;
  }

  // 用配置重建计划：配置里存的是绝对路径，重新登记成 token 再走同一条 hydrate 流程。
  try {
    const videoRecord = registerFile(config.video.path);
    const audioForPlan = config.audioTracks.map((track) => {
      if (!track.path) {
        throw Object.assign(new Error(`配置中的音轨「${track.name}」缺少路径`), { code: 'config-missing-path' });
      }
      return { ...track, token: registerFile(track.path).token };
    });
    const subtitleForPlan = config.subtitleTracks.map((track) => {
      if (!track.path) {
        throw Object.assign(new Error(`配置中的字幕「${track.name}」缺少路径`), { code: 'config-missing-path' });
      }
      return { ...track, token: registerFile(track.path).token };
    });

    const hydrated = await hydrateProject({
      name: config.projectName,
      video: { token: videoRecord.token },
      audioTracks: audioForPlan,
      subtitleTracks: subtitleForPlan,
    });
    const plan = buildPlan(hydrated);

    const expected = new Map();
    for (const track of plan.subtitleTracks) {
      if (!track.enabled || !track.supported) continue;
      const source = hydrated.subtitleTracks.find((item) => item.id === track.id);
      const clipped = shiftAndClipCues(source.cues, {
        offset: track.offset,
        videoDuration: hydrated.video.duration,
      });
      expected.set(track.id, {
        cues: clipped.cues,
        count: clipped.cues.length,
        duration: clipped.cues.reduce((max, cue) => Math.max(max, cue.end), 0),
      });
    }
    const verification = await verifyOutput({
      outputPath,
      configPath,
      config,
      plan,
      hydrated,
      expected,
    });
    sendJson(res, 200, { verification, config, plan: { rule: plan.rule } });
  } catch (error) {
    sendError(res, 400, error);
  }
}

function handleConfigRead(req, res, url) {
  const filePath = url.searchParams.get('path');
  if (!filePath || !existsSync(filePath)) {
    sendError(res, 404, Object.assign(new Error('配置文件不存在'), { code: 'no-config' }));
    return;
  }
  try {
    const config = JSON.parse(readFileSync(filePath, 'utf8'));
    if (config.format !== 'trackweave-project') {
      throw Object.assign(new Error('不是 trackweave 轨道配置'), { code: 'bad-config' });
    }
    sendJson(res, 200, { path: filePath, config });
  } catch (error) {
    sendError(res, 400, error);
  }
}

async function handlePreviewAlign(req, res) {
  const body = await readJson(req);
  const offset = Number(body.offset || 0);
  const sourceDuration = Number(body.sourceDuration || 0);
  const videoDuration = Number(body.videoDuration || 0);
  const timeline = resolveAudioTimeline({ offset, sourceDuration, videoDuration });
  sendJson(res, 200, { timeline });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { allow: 'GET,POST,OPTIONS' });
        res.end();
        return;
      }

      if (pathname === '/api/env' && req.method === 'GET') {
        let capabilities = null;
        let ffmpegError = null;
        try {
          const caps = await probeCapabilities();
          capabilities = {
            available: caps.available,
            versionLine: caps.versionLine,
            audioEncoders: ['aac', 'libopus', 'libmp3lame'].filter((name) => caps.hasEncoder(name)),
            videoEncoders: ['libx264', 'h264_videotoolbox', 'mpeg4'].filter((name) => caps.hasEncoder(name)),
            subtitleEncoders: ['srt', 'mov_text', 'webvtt'].filter((name) => caps.hasEncoder(name)),
            matroska: caps.hasMuxer('matroska'),
          };
        } catch (error) {
          ffmpegError = { code: error.code, message: error.message };
        }
        sendJson(res, 200, {
          capabilities,
          ffmpegError,
          platform: process.platform,
          node: process.version,
          languages: LANGUAGES,
          extensions: listMediaExtensions(),
          sampleDir: SAMPLE_DIR,
          sampleExists: existsSync(join(SAMPLE_DIR, 'lesson.mp4')),
        });
        return;
      }

      if (pathname === '/api/fs' && req.method === 'GET') {
        sendJson(res, 200, listDirectory(url.searchParams.get('dir')));
        return;
      }

      if (pathname === '/api/import' && req.method === 'POST') {
        await handleImport(req, res);
        return;
      }

      if (pathname === '/api/upload' && req.method === 'POST') {
        await handleUpload(req, res, url.searchParams);
        return;
      }

      if (pathname === '/api/plan' && req.method === 'POST') {
        await handlePlan(req, res);
        return;
      }

      if (pathname === '/api/subtitle/preview' && req.method === 'GET') {
        await handlePreviewSubtitle(req, res, url);
        return;
      }

      if (pathname === '/api/align' && req.method === 'POST') {
        await handlePreviewAlign(req, res);
        return;
      }

      if (pathname === '/api/export' && req.method === 'POST') {
        await handleExport(req, res);
        return;
      }

      if (pathname === '/api/jobs' && req.method === 'GET') {
        sendJson(res, 200, {
          jobs: listJobs().map(({ listeners, ...rest }) => rest),
        });
        return;
      }

      const jobMatch = /^\/api\/jobs\/([^/]+)(\/events)?$/.exec(pathname);
      if (jobMatch) {
        const job = getJob(jobMatch[1]);
        if (!job) {
          sendJson(res, 404, { error: { code: 'no-job', message: '任务不存在或已过期' } });
          return;
        }
        if (jobMatch[2]) {
          handleJobEvents(req, res, job);
        } else {
          sendJson(res, 200, {
            id: job.id,
            status: job.status,
            phase: job.phase,
            progress: job.progress,
            message: job.message,
            warnings: job.warnings,
            result: job.result,
            error: job.error,
          });
        }
        return;
      }

      if (pathname === '/api/verify' && req.method === 'POST') {
        await handleVerifyFile(req, res);
        return;
      }

      if (pathname === '/api/config' && req.method === 'GET') {
        handleConfigRead(req, res, url);
        return;
      }

      if (pathname === '/api/samples' && req.method === 'POST') {
        const info = await ensureSampleSet({ force: Boolean((await readJson(req)).force) });
        sendJson(res, 200, info);
        return;
      }

      if (pathname === '/api/samples/project' && req.method === 'GET') {
        const project = await buildSampleProject();
        sendJson(res, 200, { project });
        return;
      }

      if (pathname === '/api/samples/check' && req.method === 'POST') {
        const report = await checkSampleSet();
        sendJson(res, 200, report);
        return;
      }

      if (pathname === '/api/cache/clear' && req.method === 'POST') {
        clearProbeCache();
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: { code: 'not-found', message: `未知接口 ${pathname}` } });
      return;
    } catch (error) {
      if (error instanceof ExternalToolError) {
        sendError(res, 500, error, { stderrTail: error.stderr?.slice(-2000) });
        return;
      }
      const status =
        error.code === 'not-found' || error.code === 'missing-file' || error.code === 'stale-token'
          ? 404
          : ['bad-json', 'no-paths', 'too-large', 'bad-config', 'no-dir', 'no-paths'].includes(error.code)
            ? 400
            : error.code === 'not-ready' || error.code === 'unsupported-track'
              ? 422
              : 500;
      sendError(res, status, error);
      return;
    }
  }

  const mediaMatch = /^\/media\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (mediaMatch) {
    serveMedia(req, res, mediaMatch[1]);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, pathname);
    return;
  }
  sendJson(res, 405, { error: { code: 'method', message: '不支持的方法' } });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    sendError(res, 500, error);
  });
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`TrackWeave 已启动：${url}`);
  console.log(`示例素材目录：${SAMPLE_DIR}`);
});

export { server };
