/**
 * 进程内的媒体登记表。
 *
 * 浏览器只能通过随机 token 访问已经导入过的本地文件；
 * 任意路径不会被直接拼进 /media URL。文件本身仍然是本地原文件，
 * 不复制、不上传（拖拽上传除外），导出时 ffmpeg 直接读原路径。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const MEDIA_EXTENSIONS = {
  video: new Set(['mp4', 'mkv', 'mov', 'm4v', 'webm', 'avi', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', 'wmv', 'flv', 'ogv']),
  audio: new Set(['m4a', 'aac', 'mp3', 'wav', 'flac', 'opus', 'ogg', 'oga', 'wma', 'aif', 'aiff', 'ac3', 'eac3', 'dts', 'mka']),
  subtitle: new Set(['srt', 'vtt', 'ass', 'ssa', 'sup', 'pgs', 'idx', 'sub', 'vob', 'dvb']),
};

const registry = new Map(); // token -> record
const byPath = new Map(); // absolute path -> token

export function extensionOf(filePath) {
  return String(filePath).toLowerCase().split('.').pop() || '';
}

export function guessKindFromPath(filePath) {
  const ext = extensionOf(filePath);
  if (MEDIA_EXTENSIONS.video.has(ext)) return 'video';
  if (MEDIA_EXTENSIONS.audio.has(ext)) return 'audio';
  if (MEDIA_EXTENSIONS.subtitle.has(ext)) return 'subtitle';
  return 'unknown';
}

export function isSupportedTextSubtitle(filePath) {
  return ['srt', 'vtt', 'ass', 'ssa'].includes(extensionOf(filePath));
}

export function isImageSubtitle(filePath) {
  return ['sup', 'pgs', 'idx', 'sub', 'vob', 'dvb'].includes(extensionOf(filePath));
}

export function makeToken() {
  return randomBytes(12).toString('base64url');
}

function pathKey(filePath) {
  return path.resolve(filePath);
}

/** 登记一个本地文件，返回稳定 token 与基础信息。 */
export function registerFile(filePath, { kind = null, name = null } = {}) {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute)) {
    const error = new Error(`文件不存在：${absolute}`);
    error.code = 'not-found';
    throw error;
  }
  const stat = statSync(absolute);
  if (!stat.isFile()) {
    const error = new Error(`不是文件：${absolute}`);
    error.code = 'not-file';
    throw error;
  }

  const existing = byPath.get(absolute);
  if (existing) {
    const record = registry.get(existing);
    record.stat = stat;
    return record;
  }

  const token = makeToken();
  const record = {
    token,
    path: absolute,
    name: name || path.basename(absolute),
    kind: kind || guessKindFromPath(absolute),
    extension: extensionOf(absolute),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    stat,
    createdAt: Date.now(),
  };
  registry.set(token, record);
  byPath.set(absolute, token);
  return record;
}

export function findToken(token) {
  return registry.get(token) || null;
}

export function findTokenByPath(filePath) {
  return byPath.get(pathKey(filePath)) || null;
}

/** 稳定短 id，用于前端本地缓存 / 配置比对。 */
export function fileFingerprint(filePath) {
  const absolute = pathKey(filePath);
  return createHash('sha1').update(absolute).digest('hex').slice(0, 10);
}

export function contentTypeForPath(filePath) {
  const ext = extensionOf(filePath);
  const map = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    ogv: 'video/ogg',
    ts: 'video/mp2t',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    opus: 'audio/ogg',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    srt: 'text/plain; charset=utf-8',
    vtt: 'text/vtt; charset=utf-8',
    ass: 'text/plain; charset=utf-8',
    ssa: 'text/plain; charset=utf-8',
    json: 'application/json; charset=utf-8',
  };
  return map[ext] || 'application/octet-stream';
}

export function listMediaExtensions() {
  return {
    video: [...MEDIA_EXTENSIONS.video].sort(),
    audio: [...MEDIA_EXTENSIONS.audio].sort(),
    subtitle: [...MEDIA_EXTENSIONS.subtitle].sort(),
  };
}
