/**
 * ffmpeg / ffprobe 调用封装。
 *
 * 所有外部进程都通过 spawn 传参数数组，不经过 shell，文件名里的空格、引号、
 * 中文都不会被二次解释。
 */
import { spawn } from 'node:child_process';

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';

const STDERR_TAIL_LIMIT = 256 * 1024;

export class ExternalToolError extends Error {
  constructor(message, { command, exitCode, stderr, stdout } = {}) {
    super(message);
    this.name = 'ExternalToolError';
    this.code = 'external-tool';
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr || '';
    this.stdout = stdout || '';
  }
}

function tailAppend(current, chunk) {
  const next = current + chunk;
  return next.length > STDERR_TAIL_LIMIT ? next.slice(next.length - STDERR_TAIL_LIMIT) : next;
}

function spawnProcess(bin, args, { onStdoutLine, onStderrLine } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new ExternalToolError(`${bin} 无法启动：${error.message}`, { command: [bin, ...args] }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutLineBuffer = '';
    let stderrLineBuffer = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout = stdout.length > STDERR_TAIL_LIMIT ? stdout.slice(-STDERR_TAIL_LIMIT) + text : stdout + text;
      if (onStdoutLine) {
        stdoutLineBuffer += text;
        const lines = stdoutLineBuffer.split('\n');
        stdoutLineBuffer = lines.pop() || '';
        for (const line of lines) onStdoutLine(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr = tailAppend(stderr, text);
      if (onStderrLine) {
        stderrLineBuffer += text;
        const lines = stderrLineBuffer.split('\n');
        stderrLineBuffer = lines.pop() || '';
        for (const line of lines) onStderrLine(line);
      }
    });

    child.on('error', (error) => {
      reject(
        new ExternalToolError(`${bin} 执行失败：${error.message}`, {
          command: [bin, ...args],
          stderr,
          stdout,
        }),
      );
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new ExternalToolError(`${bin} 退出码 ${code}`, {
          command: [bin, ...args],
          exitCode: code,
          stderr,
          stdout,
        }),
      );
    });
  });
}

export async function runFfmpeg(args, hooks) {
  return spawnProcess(FFMPEG, args, hooks);
}

export async function runFfprobe(args, hooks) {
  return spawnProcess(FFPROBE, args, hooks);
}

/** ffprobe 的 JSON 结果；文件不存在 / 不是媒体时抛 ExternalToolError。 */
export async function probeMedia(filePath) {
  const { stdout } = await runFfprobe([
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (error) {
    throw new ExternalToolError(`无法解析 ffprobe 输出：${error.message}`);
  }
  return normalizeProbe(data);
}

function toNumberOrNull(value) {
  if (value == null || value === 'N/A') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function lowerTags(tags) {
  const result = {};
  if (!tags) return result;
  for (const [key, value] of Object.entries(tags)) {
    result[String(key).toLowerCase()] = value;
  }
  return result;
}

export function normalizeProbe(data) {
  const format = data.format || {};
  const tags = lowerTags(format.tags);
  const streams = (data.streams || []).map((stream) => {
    const streamTags = lowerTags(stream.tags);
    return {
      index: stream.index,
      codecType: stream.codec_type,
      codecName: stream.codec_name || '',
      codecLongName: stream.codec_long_name || '',
      profile: stream.profile || '',
      width: stream.width || null,
      height: stream.height || null,
      sampleRate: toNumberOrNull(stream.sample_rate),
      channels: toNumberOrNull(stream.channels),
      channelLayout: stream.channel_layout || '',
      duration: toNumberOrNull(stream.duration),
      startTime: toNumberOrNull(stream.start_time),
      bitRate: toNumberOrNull(stream.bit_rate),
      language: streamTags.language || '',
      title: streamTags.title || '',
      tags: streamTags,
      disposition: {
        default: Number(stream.disposition?.default || 0) === 1,
        forced: Number(stream.disposition?.forced || 0) === 1,
        hearingImpaired: Number(stream.disposition?.hearing_impaired || 0) === 1,
      },
    };
  });

  return {
    formatName: format.format_name || '',
    formatLongName: format.format_long_name || '',
    duration: toNumberOrNull(format.duration),
    size: toNumberOrNull(format.size),
    bitRate: toNumberOrNull(format.bit_rate),
    tags,
    streams,
    raw: data,
  };
}

let capabilityCache = null;

const ENCODER_RE = /^\s*([A-Z.]{6})\s+(\S+)\s+(.*)$/;

/** 探测本机 ffmpeg 的编码器 / muxer / 滤镜，结果进程内缓存。 */
export async function probeCapabilities({ refresh = false } = {}) {
  if (capabilityCache && !refresh) return capabilityCache;

  const [versionResult, encoderResult, muxerResult, filterResult] = await Promise.all([
    runFfmpeg(['-hide_banner', '-version']).catch((error) => ({ stdout: error.stdout || '', stderr: error.stderr || '' })),
    runFfmpeg(['-hide_banner', '-encoders']).catch((error) => ({ stdout: error.stdout || '', stderr: error.stderr || '' })),
    runFfmpeg(['-hide_banner', '-muxers']).catch((error) => ({ stdout: error.stdout || '', stderr: error.stderr || '' })),
    runFfmpeg(['-hide_banner', '-filters']).catch((error) => ({ stdout: error.stdout || '', stderr: error.stderr || '' })),
  ]);

  const versionText = `${versionResult.stdout}${versionResult.stderr}`;
  const versionLine = versionText.split('\n').find((line) => line.includes('ffmpeg version')) || '';

  const encoders = new Map();
  for (const line of `${encoderResult.stdout}`.split('\n')) {
    const match = line.match(ENCODER_RE);
    if (match) encoders.set(match[2], { flags: match[1], description: match[3].trim() });
  }

  const muxers = new Map();
  for (const line of `${muxerResult.stdout}`.split('\n')) {
    // muxer 列表的旗标是两列（D / E），且一行可能是 "matroska,webm" 这种合并名。
    const match = line.match(/^\s*([DE ])([DE ])\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    for (const name of match[3].split(',')) {
      muxers.set(name.trim(), match[4].trim());
    }
  }

  const filters = new Set();
  for (const line of `${filterResult.stdout}`.split('\n')) {
    const match = line.match(/^\s*[TSC.]{3}\s+(\S+)\s+/);
    if (match) filters.add(match[1]);
  }

  capabilityCache = {
    available: Boolean(versionLine),
    versionLine,
    encoders,
    muxers,
    filters,
    hasEncoder: (name) => encoders.has(name),
    hasMuxer: (name) => muxers.has(name),
    hasFilter: (name) => filters.has(name),
    pickAudioEncoder() {
      for (const candidate of ['aac', 'libopus', 'libmp3lame']) {
        if (encoders.has(candidate)) return candidate;
      }
      return null;
    },
    pickVideoEncoder() {
      for (const candidate of ['libx264', 'h264_videotoolbox', 'mpeg4']) {
        if (encoders.has(candidate)) return candidate;
      }
      return null;
    },
  };

  if (!capabilityCache.available) {
    throw new ExternalToolError('找不到可用的 ffmpeg，请先安装并确保 PATH 中可访问', { command: [FFMPEG] });
  }

  return capabilityCache;
}

export function ffmpegPath() {
  return FFMPEG;
}

export function ffprobePath() {
  return FFPROBE;
}
