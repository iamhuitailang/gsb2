/**
 * 导出：把选中的音频与字幕后合成一个 MKV。
 *
 * 为什么是 MKV：一个文件里可以同时放多条音轨、多条文本字幕，
 * 并且每条都能写 language 标记和 default 标记，MP4 对多字幕轨支持有限。
 *
 * 对齐规则与预览一致：
 *   正偏移 → adelay 补静音
 *   负偏移 → atrim 裁掉源开头
 *   短于视频 → apad 补静音
 *   超出视频 → atrim 截断
 * 字幕先按同一规则平移 / 裁剪，再写成 SRT 后封装。
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runFfmpeg, probeCapabilities } from './ffmpeg.js';
import { shiftAndClipCues, serializeSrt, subtitleDuration } from '../public/shared/subtitles.js';
import { roundSeconds } from '../public/shared/timeline.js';
import { buildAudioFilter, trackTitle } from '../public/shared/alignment.js';
import { languageTag } from '../public/shared/languages.js';
import { buildPlan, hydrateProject, toEditableConfig } from './project.js';
import { verifyOutput } from './verify.js';

export class ExportError extends Error {
  constructor(message, { code = 'export-failed', details = null } = {}) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.details = details;
  }
}

const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs() {
  return [...jobs.values()].map((job) => ({ ...job, emitter: undefined }));
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      jobs.delete(id);
      job.listeners.clear();
    }
  }
}

function createJob() {
  pruneJobs();
  const job = {
    id: randomUUID().slice(0, 12),
    status: 'queued',
    phase: 'queued',
    progress: 0,
    message: '排队中',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    warnings: [],
    result: null,
    error: null,
    listeners: new Set(),
  };
  jobs.set(job.id, job);
  return job;
}

function emit(job, patch = {}) {
  Object.assign(job, patch);
  const payload = {
    id: job.id,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    message: job.message,
    warnings: job.warnings,
    result: job.result,
    error: job.error,
  };
  for (const listener of job.listeners) {
    try {
      listener(payload);
    } catch {
      /* 单个 SSE 连接断开不影响导出 */
    }
  }
  return payload;
}

export function subscribe(job, listener) {
  job.listeners.add(listener);
  listener({
    id: job.id,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    message: job.message,
    warnings: job.warnings,
    result: job.result,
    error: job.error,
  });
  return () => job.listeners.delete(listener);
}

function quoteFilterValue(value) {
  // 滤镜里的标题不参与计算，音频链路只用数字，无需转义文本。
  return value;
}

/**
 * 组装 ffmpeg 参数。
 * 输入顺序：视频 0、每条启用音轨 1..n、每条启用字幕 1..n 之后。
 */
function buildArgs({ hydrated, plan, srtFiles, outputPath, capabilities, subtitleCodec }) {
  const args = ['-hide_banner', '-nostdin', '-y'];

  args.push('-i', hydrated.video.path);

  const enabledAudio = plan.audioTracks.filter((track) => track.enabled && track.supported);
  const enabledSubs = plan.subtitleTracks.filter((track) => track.enabled && track.supported);

  const audioInputIndex = new Map();
  let inputCursor = 1;
  for (const track of enabledAudio) {
    const record = hydrated.audioTracks.find((item) => item.id === track.id);
    args.push('-i', record.path);
    audioInputIndex.set(track.id, inputCursor);
    inputCursor += 1;
  }

  const subtitleInputIndex = new Map();
  for (const track of enabledSubs) {
    args.push('-i', srtFiles.get(track.id));
    subtitleInputIndex.set(track.id, inputCursor);
    inputCursor += 1;
  }

  if (enabledAudio.length) {
    const chains = enabledAudio.map((track, index) => {
      const index_ = audioInputIndex.get(track.id);
      return buildAudioFilter({
        offset: track.offset,
        videoDuration: hydrated.video.duration,
        inputLabel: `[${index_}:a:0]`,
        outputLabel: `[aout${index}]`,
      });
    });
    args.push('-filter_complex', chains.join(';'));
  }

  args.push('-map', '0:v:0');
  enabledAudio.forEach((_, index) => {
    args.push('-map', `[aout${index}]`);
  });
  enabledSubs.forEach((track, index) => {
    args.push('-map', `${subtitleInputIndex.get(track.id)}:s:0`);
    void index;
  });

  args.push('-c:v', 'copy');
  if (enabledAudio.length) {
    args.push('-c:a', capabilities.pickAudioEncoder() || 'aac', '-b:a', '192k');
  }
  if (enabledSubs.length) {
    args.push('-c:s', subtitleCodec);
  }

  args.push('-map_metadata', '-1');
  args.push('-map_chapters', '-1');

  args.push('-metadata', `title=${plan.name}`);
  args.push('-metadata', `comment=trackweave ${plan.rule}`);

  enabledAudio.forEach((track, index) => {
    args.push('-metadata:s:a:' + index, `language=${languageTag(track.language)}`);
    args.push('-metadata:s:a:' + index, `title=${trackTitle(track)}`);
    args.push('-disposition:a:' + index, track.default ? 'default' : '0');
  });

  enabledSubs.forEach((track, index) => {
    args.push('-metadata:s:s:' + index, `language=${languageTag(track.language)}`);
    args.push('-metadata:s:s:' + index, `title=${trackTitle(track)}`);
    args.push('-disposition:s:' + index, track.default ? 'default' : '0');
  });

  args.push('-metadata:s:v:0', 'title=video');
  args.push('-disposition:v:0', 'default');

  args.push('-t', String(roundSeconds(hydrated.video.duration, 3)));
  args.push('-progress', 'pipe:1');
  args.push('-nostats');
  args.push('-f', 'matroska');
  args.push(outputPath);
  return args;
}

function parseProgressLine(line, job) {
  const match = line.match(/^(\w+)=(.*)$/);
  if (!match) return;
  const [, key, value] = match;
  if (key === 'out_time_us' || key === 'out_time_ms') {
    const seconds = Number(value) / 1_000_000;
    if (Number.isFinite(seconds) && job.duration > 0) {
      const ratio = Math.min(0.99, Math.max(0, seconds / job.duration));
      const progress = Math.round(ratio * 100);
      if (progress !== job.progress) {
        emit(job, {
          progress,
          message: `正在封装 ${Math.min(100, progress)}%（${seconds.toFixed(1)} / ${job.duration.toFixed(1)}s）`,
        });
      }
    }
  } else if (key === 'progress' && value === 'end') {
    emit(job, { progress: 99, message: '正在收尾…' });
  }
}

export function prepareSubtitles(hydrated, plan, tempDir) {
  const files = new Map();
  const expected = new Map();
  const videoDuration = hydrated.video.duration;

  for (const track of plan.subtitleTracks) {
    if (!track.enabled || !track.supported) continue;
    const source = hydrated.subtitleTracks.find((item) => item.id === track.id);
    const clipped = shiftAndClipCues(source.cues, { offset: track.offset, videoDuration });
    const content = serializeSrt(clipped.cues);
    const file = path.join(tempDir, `${track.id}.srt`);
    writeFileSync(file, content, 'utf8');
    files.set(track.id, file);
    expected.set(track.id, {
      cues: clipped.cues,
      count: clipped.cues.length,
      duration: subtitleDuration(clipped.cues),
    });
  }
  return { files, expected };
}

export function makeDefaultOutputPath(hydrated, requested) {
  const ensureMkv = (filePath) =>
    /\.mkv$/i.test(filePath) ? filePath : `${filePath.replace(/\.[^./\\]+$/, '')}.mkv`;

  if (typeof requested === 'string' && requested.trim()) {
    return ensureMkv(path.resolve(requested.trim()));
  }
  const dir = path.dirname(hydrated.video.path);
  const base = hydrated.video.name.replace(/\.[^.]+$/, '');
  return path.join(dir, `${base}.trackweave.mkv`);
}

export async function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new ExportError(`无法创建输出目录：${error.message}`, { code: 'output-dir' });
  }
}

export async function startExport(input, { outputPath } = {}) {
  const job = createJob();
  const id = job.id;

  runExport(job, input, outputPath).catch((error) => {
    emit(job, {
      status: 'failed',
      phase: 'failed',
      message: error.message,
      error: {
        code: error.code || 'export-failed',
        message: error.message,
        details: error.details || null,
      },
      finishedAt: Date.now(),
    });
  });

  return id;
}

async function runExport(job, input, requestedOutput) {
  const started = Date.now();
  emit(job, { status: 'running', phase: 'prepare', progress: 0, message: '正在读取素材信息…', startedAt: started });

  const capabilities = await probeCapabilities();
  if (!capabilities.hasMuxer('matroska')) {
    throw new ExportError('本机 ffmpeg 不支持 matroska 封装', { code: 'no-matroska' });
  }
  if (!capabilities.pickAudioEncoder()) {
    throw new ExportError('本机 ffmpeg 没有可用的音频编码器（aac / libopus / libmp3lame）', {
      code: 'no-audio-encoder',
    });
  }

  const hydrated = await hydrateProject(input);
  const plan = buildPlan(hydrated);
  job.duration = hydrated.video.duration;

  emit(job, {
    phase: 'validate',
    progress: 2,
    message: '正在检查轨道…',
    warnings: plan.warnings,
  });

  if (!plan.ready) {
    throw new ExportError('项目尚未就绪：' + plan.errors.map((error) => error.message).join('；'), {
      code: 'not-ready',
      details: { errors: plan.errors },
    });
  }

  const subtitleCodec = capabilities.hasEncoder('srt') ? 'srt' : capabilities.hasEncoder('mov_text') ? 'mov_text' : 'srt';
  if (plan.subtitleTracks.some((track) => track.enabled && !track.supported)) {
    throw new ExportError('有已启用的字幕格式不受支持，请先停用或转换', {
      code: 'unsupported-subtitle',
      details: {
        tracks: plan.subtitleTracks.filter((track) => track.enabled && !track.supported),
      },
    });
  }

  const outputPath = makeDefaultOutputPath(hydrated, requestedOutput);
  if (path.resolve(outputPath) === path.resolve(hydrated.video.path)) {
    throw new ExportError('输出路径不能与源视频相同', { code: 'same-path' });
  }
  await ensureParentDir(outputPath);

  const tempDir = mkdtempSync(path.join(tmpdir(), 'trackweave-'));
  const partialPath = `${outputPath}.part-${job.id}.mkv`;
  const configPath = outputPath.replace(/\.[^.]+$/, '') + '.tracks.json';

  try {
    emit(job, { phase: 'subtitles', progress: 5, message: '正在生成对齐后的字幕…' });
    const { files, expected } = prepareSubtitles(hydrated, plan, tempDir);

    emit(job, { phase: 'mux', progress: 8, message: '正在封装音轨与字幕…' });
    const args = buildArgs({
      hydrated,
      plan,
      srtFiles: files,
      outputPath: partialPath,
      capabilities,
      subtitleCodec,
    });
    job.command = args;

    await runFfmpeg(args, {
      onStdoutLine: (line) => parseProgressLine(line, job),
    });

    emit(job, { phase: 'verify', progress: 99, message: '正在读回导出文件…' });

    if (statSync(partialPath).size === 0) {
      throw new ExportError('导出的文件是空的', { code: 'empty-output' });
    }
    renameSync(partialPath, outputPath);

    const config = toEditableConfig(hydrated, plan);
    config.output = {
      path: outputPath,
      container: 'matroska',
      videoDuration: hydrated.video.duration,
      defaultAudioId: plan.defaults.audioId,
      defaultSubtitleId: plan.defaults.subtitleId,
      audio: plan.audioTracks
        .filter((track) => track.enabled && track.supported)
        .map((track) => ({
          id: track.id,
          name: track.name,
          language: track.language,
          languageTag: track.languageTag,
          offset: track.offset,
          default: track.default,
        })),
      subtitles: plan.subtitleTracks
        .filter((track) => track.enabled && track.supported)
        .map((track) => ({
          id: track.id,
          name: track.name,
          language: track.language,
          languageTag: track.languageTag,
          offset: track.offset,
          default: track.default,
        })),
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const verification = await verifyOutput({
      outputPath,
      configPath,
      config,
      plan,
      hydrated,
      expected,
    });

    // 如果用的是内置示例音轨，再做一次“音调起音 vs 偏移”的客观核对。
    let sampleAlignment = null;
    const enabledAudioForSample = plan.audioTracks.filter((track) => track.enabled && track.supported);
    if (enabledAudioForSample.some((track) => track.id.startsWith('sample-audio'))) {
      try {
        const { verifySampleAudioAlignment, SAMPLE_DIR: dir } = await import('../scripts/samples.js');
        sampleAlignment = await verifySampleAudioAlignment({
          outputPath,
          tracks: enabledAudioForSample.map((track) => ({
            name: track.name,
            language: track.language,
            offset: track.offset,
            videoDuration: hydrated.video.duration,
            sampleFile:
              hydrated.audioTracks.find((item) => item.id === track.id)?.path?.startsWith(dir)
                ? hydrated.audioTracks.find((item) => item.id === track.id).path
                : null,
          })),
        });
      } catch (error) {
        sampleAlignment = [{ ok: false, name: '示例音调核对', reason: error.message }];
      }
    }

    const result = {
      outputPath,
      configPath,
      size: statSync(outputPath).size,
      duration: hydrated.video.duration,
      elapsedMs: Date.now() - started,
      audioCount: plan.audioTracks.filter((track) => track.enabled && track.supported).length,
      subtitleCount: plan.subtitleTracks.filter((track) => track.enabled && track.supported).length,
      verification,
      sampleAlignment,
      warnings: plan.warnings,
      rule: plan.rule,
    };

    emit(job, {
      status: 'done',
      phase: 'done',
      progress: 100,
      message: verification.ok ? '导出完成，读回校验通过' : '导出完成，但读回校验发现问题',
      result,
      finishedAt: Date.now(),
    });
  } finally {
    try {
      rmSync(partialPath, { force: true });
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export { buildArgs, parseProgressLine, quoteFilterValue };
