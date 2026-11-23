/**
 * 项目模型：把浏览器传来的 {token, offset, language, order, default...}
 * 与磁盘上的真实文件、ffprobe 结果、字幕解析结果合并成一份可信的计划。
 *
 * 关键约束：
 *   - 浏览器给什么 token 就读什么文件，其他路径一概不认。
 *   - 时长、编码、字幕条目数一律以服务端探测为准，避免前端缓存过期。
 *   - 默认轨每个类型只能有一条；这里会自动纠正并在 notes 里说明。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { findToken, guessKindFromPath, isImageSubtitle, isSupportedTextSubtitle } from './media.js';
import { probeMedia } from './ffmpeg.js';
import { normalizeLanguage, languageTag, languageLabel } from '../public/shared/languages.js';
import { parseSubtitles, shiftAndClipCues, subtitleDuration } from '../public/shared/subtitles.js';
import { resolveAudioTimeline, resolveSubtitleTimeline, roundSeconds } from '../public/shared/timeline.js';

const probeCache = new Map(); // `${token}:${mtimeMs}:${size}` -> normalized probe
const subtitleCache = new Map(); // `${token}:${mtimeMs}` -> parsed

export function clearProbeCache() {
  probeCache.clear();
  subtitleCache.clear();
}

export async function inspectRecord(record, { refresh = false } = {}) {
  const key = `${record.token}:${record.mtimeMs}:${record.size}`;
  if (!refresh && probeCache.has(key)) return probeCache.get(key);

  const probe = await probeMedia(record.path);
  const info = {
    ...probe,
    extension: record.extension,
    kind: guessKindFromPath(record.path),
    videoStreams: probe.streams.filter((stream) => stream.codecType === 'video'),
    audioStreams: probe.streams.filter((stream) => stream.codecType === 'audio'),
    subtitleStreams: probe.streams.filter((stream) => stream.codecType === 'subtitle'),
  };
  probeCache.set(key, info);
  return info;
}

function fileDuration(probe) {
  if (probe.duration != null && probe.duration > 0) return probe.duration;
  let max = 0;
  for (const stream of probe.streams) {
    if (stream.duration != null) max = Math.max(max, stream.duration);
  }
  return max;
}

function sanitizeOffset(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return roundSeconds(Math.max(-36000, Math.min(36000, n)), 3);
}

function ensureId(value, prefix) {
  if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value)) return value;
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function readSubtitleRecord(record, { refresh = false } = {}) {
  const key = `${record.token}:${record.mtimeMs}`;
  if (!refresh && subtitleCache.has(key)) return subtitleCache.get(key);

  let text;
  try {
    text = readFileSync(record.path, 'utf8');
  } catch (error) {
    const failure = {
      ok: false,
      reason: `无法读取字幕文件：${error.message}`,
      format: null,
      cues: [],
      warnings: [],
    };
    subtitleCache.set(key, failure);
    return failure;
  }

  try {
    const parsed = parseSubtitles(text, { fileName: record.name });
    const result = {
      ok: true,
      format: parsed.format,
      styleLost: parsed.styleLost,
      cues: parsed.cues,
      sourceDuration: subtitleDuration(parsed.cues),
      warnings: parsed.warnings,
      textLength: text.length,
    };
    subtitleCache.set(key, result);
    return result;
  } catch (error) {
    const failure = {
      ok: false,
      reason: error.code === 'no-cues' ? '没有解析到任何字幕条目，请检查文件内容' : error.message,
      format: null,
      cues: [],
      warnings: [],
    };
    subtitleCache.set(key, failure);
    return failure;
  }
}

/** 浏览器端可安全展示的探测摘要（不含完整 raw）。 */
function summarizeAudioStream(stream) {
  return {
    codec: stream.codecName,
    codecLongName: stream.codecLongName,
    sampleRate: stream.sampleRate,
    channels: stream.channels,
    channelLayout: stream.channelLayout,
    bitRate: stream.bitRate,
    language: stream.language,
    title: stream.title,
    duration: stream.duration,
  };
}

function summarizeVideoStream(stream) {
  return {
    codec: stream.codecName,
    codecLongName: stream.codecLongName,
    width: stream.width,
    height: stream.height,
    bitRate: stream.bitRate,
    duration: stream.duration,
    frameRate: null,
  };
}

function requireRecord(token, label) {
  const record = token ? findToken(token) : null;
  if (!record) {
    const error = new Error(`${label}已失效，请重新添加文件`);
    error.code = 'stale-token';
    throw error;
  }
  if (!statSync(record.path).isFile()) {
    const error = new Error(`${label}已不存在：${record.name}`);
    error.code = 'missing-file';
    throw error;
  }
  return record;
}

/**
 * 合并前端项目与真实文件。返回 hydratedProject。
 * 任何一条素材失效都会抛出带 code 的错误，由路由层转成 400。
 */
export async function hydrateProject(input = {}) {
  const videoToken = input.video?.token;
  const videoRecord = requireRecord(videoToken, '视频');
  const videoProbe = await inspectRecord(videoRecord);
  const videoStream = videoProbe.videoStreams[0];
  if (!videoStream) {
    const error = new Error(`「${videoRecord.name}」里没有视频流`);
    error.code = 'no-video-stream';
    throw error;
  }
  const duration = fileDuration(videoProbe);
  if (!(duration > 0)) {
    const error = new Error(`无法读取「${videoRecord.name}」的时长`);
    error.code = 'no-duration';
    throw error;
  }

  const video = {
    token: videoRecord.token,
    name: videoRecord.name,
    path: videoRecord.path,
    duration: roundSeconds(duration),
    width: videoStream.width,
    height: videoStream.height,
    codec: videoStream.codecName,
    formatName: videoProbe.formatName,
    hasAudio: videoProbe.audioStreams.length > 0,
    hasEmbeddedSubtitles: videoProbe.subtitleStreams.length > 0,
  };

  const audioInputs = Array.isArray(input.audioTracks) ? input.audioTracks : [];
  const subtitleInputs = Array.isArray(input.subtitleTracks) ? input.subtitleTracks : [];

  const audioTracks = [];
  for (let i = 0; i < audioInputs.length; i += 1) {
    const raw = audioInputs[i] || {};
    const record = requireRecord(raw.token, `音轨「${raw.name || i + 1}」`);
    const probe = await inspectRecord(record);
    const stream = probe.audioStreams[0];
    const supported = Boolean(stream);
    const sourceDuration = stream?.duration ?? fileDuration(probe);
    audioTracks.push({
      id: ensureId(raw.id, 'audio'),
      kind: 'audio',
      order: i,
      token: record.token,
      name: record.name,
      path: record.path,
      language: normalizeLanguage(raw.language || stream?.language || record.name),
      offset: sanitizeOffset(raw.offset),
      enabled: raw.enabled !== false,
      default: Boolean(raw.default),
      sourceDuration: roundSeconds(sourceDuration || 0),
      supported,
      supportIssue: supported ? null : '文件中没有可解码的音频流',
      codec: stream?.codecName || '',
      codecLongName: stream?.codecLongName || '',
      sampleRate: stream?.sampleRate ?? null,
      channels: stream?.channels ?? null,
      channelLayout: stream?.channelLayout || '',
      bitRate: stream?.bitRate ?? null,
      formatName: probe.formatName,
      streams: probe.audioStreams.map(summarizeAudioStream),
    });
  }

  const subtitleTracks = [];
  for (let i = 0; i < subtitleInputs.length; i += 1) {
    const raw = subtitleInputs[i] || {};
    const record = requireRecord(raw.token, `字幕「${raw.name || i + 1}」`);
    const imageSubtitle = isImageSubtitle(record.path);
    const textSubtitle = isSupportedTextSubtitle(record.path);

    if (imageSubtitle || !textSubtitle) {
      subtitleTracks.push({
        id: ensureId(raw.id, 'sub'),
        kind: 'subtitle',
        order: i,
        token: record.token,
        name: record.name,
        path: record.path,
        language: normalizeLanguage(raw.language || record.name),
        offset: sanitizeOffset(raw.offset),
        enabled: raw.enabled !== false,
        default: Boolean(raw.default),
        sourceDuration: 0,
        cueCount: 0,
        format: record.extension,
        supported: false,
        supportIssue: imageSubtitle
          ? '位图字幕（PGS / VobSub）不能平移、预览或转成文本字幕，请先导出为 SRT'
          : `不支持的字幕格式 .${record.extension}（支持 SRT / VTT / ASS / SSA）`,
        styleLost: false,
        cues: [],
        warnings: [],
      });
      continue;
    }

    const parsed = readSubtitleRecord(record);
    if (!parsed.ok) {
      subtitleTracks.push({
        id: ensureId(raw.id, 'sub'),
        kind: 'subtitle',
        order: i,
        token: record.token,
        name: record.name,
        path: record.path,
        language: normalizeLanguage(raw.language || record.name),
        offset: sanitizeOffset(raw.offset),
        enabled: raw.enabled !== false,
        default: Boolean(raw.default),
        sourceDuration: 0,
        cueCount: 0,
        format: parsed.format,
        supported: false,
        supportIssue: parsed.reason,
        styleLost: false,
        cues: [],
        warnings: [],
      });
      continue;
    }

    subtitleTracks.push({
      id: ensureId(raw.id, 'sub'),
      kind: 'subtitle',
      order: i,
      token: record.token,
      name: record.name,
      path: record.path,
      language: normalizeLanguage(raw.language || record.name),
      offset: sanitizeOffset(raw.offset),
      enabled: raw.enabled !== false,
      default: Boolean(raw.default),
      sourceDuration: roundSeconds(parsed.sourceDuration),
      cueCount: parsed.cues.length,
      format: parsed.format,
      styleLost: parsed.styleLost,
      supported: true,
      supportIssue: parsed.styleLost ? 'ASS/SSA 的样式与定位无法保留，导出时会转为纯文本字幕' : null,
      parseWarnings: parsed.warnings,
      cues: parsed.cues,
      warnings: [],
    });
  }

  return {
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : '未命名项目',
    video,
    audioTracks,
    subtitleTracks,
    notes: [],
  };
}

/** 每个类型只能有一条 default；不合法时自动纠正并记录。 */
export function normalizeDefaults(tracks, kindLabel) {
  const enabled = tracks.filter((track) => track.enabled && track.supported);
  const explicitlyDefault = enabled.filter((track) => track.default);
  const notes = [];

  let defaultId = null;
  if (explicitlyDefault.length === 1) {
    defaultId = explicitlyDefault[0].id;
  } else if (explicitlyDefault.length > 1) {
    defaultId = explicitlyDefault[0].id;
    notes.push({
      code: 'multiple-defaults',
      severity: 'info',
      message: `${kindLabel}有多条默认轨，已保留「${explicitlyDefault[0].name}」，其余取消默认`,
    });
  } else if (enabled.length > 0) {
    defaultId = enabled[0].id;
    notes.push({
      code: 'default-fallback',
      severity: 'info',
      message: `${kindLabel}没有指定默认轨，已使用「${enabled[0].name}」`,
    });
  }

  for (const track of tracks) {
    track.default = track.id === defaultId;
  }
  if (!defaultId && tracks.every((track) => !track.enabled)) {
    notes.push({
      code: 'no-enabled',
      severity: 'warning',
      message: `没有启用的${kindLabel}`,
    });
  }
  return notes;
}

/**
 * 生成对齐计划。hydrated 来自 hydrateProject；返回可直接给前端的计划，
 * 以及导出器需要的 shift 后字幕条目。
 */
export function buildPlan(hydrated) {
  const videoDuration = hydrated.video.duration;
  const notes = [];
  const warnings = [];
  const audioPlans = [];
  const subtitlePlans = [];

  for (const track of hydrated.audioTracks) {
    const timeline = track.supported
      ? resolveAudioTimeline({
          offset: track.offset,
          sourceDuration: track.sourceDuration,
          videoDuration,
        })
      : null;
    const trackWarnings = [];
    if (!track.supported) {
      trackWarnings.push({
        code: 'unsupported',
        severity: 'error',
        message: track.supportIssue,
      });
    }
    if (timeline) trackWarnings.push(...timeline.warnings);

    const plan = {
      id: track.id,
      kind: 'audio',
      name: track.name,
      language: track.language,
      languageLabel: languageLabel(track.language),
      languageTag: languageTag(track.language),
      offset: track.offset,
      enabled: track.enabled,
      default: track.default,
      order: track.order,
      sourceDuration: track.sourceDuration,
      codec: track.codec,
      sampleRate: track.sampleRate,
      channels: track.channels,
      supported: track.supported,
      supportIssue: track.supportIssue,
      timeline,
      warnings: trackWarnings,
    };
    audioPlans.push(plan);
    for (const warning of trackWarnings) {
      warnings.push({ ...warning, trackId: track.id, trackName: track.name, kind: 'audio' });
    }
  }

  for (const track of hydrated.subtitleTracks) {
    if (!track.supported) {
      const trackWarnings = [
        { code: 'unsupported', severity: 'error', message: track.supportIssue },
      ];
      subtitlePlans.push({
        id: track.id,
        kind: 'subtitle',
        name: track.name,
        language: track.language,
        languageLabel: languageLabel(track.language),
        languageTag: languageTag(track.language),
        offset: track.offset,
        enabled: track.enabled,
        default: track.default,
        order: track.order,
        sourceDuration: track.sourceDuration,
        format: track.format,
        cueCount: 0,
        supported: false,
        supportIssue: track.supportIssue,
        cues: [],
        timeline: null,
        warnings: trackWarnings,
      });
      for (const warning of trackWarnings) {
        warnings.push({ ...warning, trackId: track.id, trackName: track.name, kind: 'subtitle' });
      }
      continue;
    }

    const shifted = shiftAndClipCues(track.cues, { offset: track.offset, videoDuration });
    const timeline = resolveSubtitleTimeline({
      offset: track.offset,
      cues: track.cues,
      sourceDuration: track.sourceDuration,
      videoDuration,
    });
    const trackWarnings = [...timeline.warnings, ...shifted.warnings];
    if (track.styleLost) {
      trackWarnings.unshift({
        code: 'style-lost',
        severity: 'info',
        message: 'ASS/SSA 样式不会保留，导出为纯文本字幕',
      });
    }
    if (!shifted.cues.length) {
      trackWarnings.push({
        code: 'no-cues-after-align',
        severity: 'error',
        message: '按当前偏移，所有字幕都落在视频范围外，导出会失败',
      });
    }

    const plan = {
      id: track.id,
      kind: 'subtitle',
      name: track.name,
      language: track.language,
      languageLabel: languageLabel(track.language),
      languageTag: languageTag(track.language),
      offset: track.offset,
      enabled: track.enabled,
      default: track.default,
      order: track.order,
      sourceDuration: track.sourceDuration,
      format: track.format,
      cueCount: shifted.cues.length,
      sourceCueCount: track.cueCount,
      supported: true,
      supportIssue: track.supportIssue,
      styleLost: track.styleLost,
      cues: shifted.cues,
      timeline,
      warnings: trackWarnings,
      summary: shifted.summary,
    };
    subtitlePlans.push(plan);
    for (const warning of trackWarnings) {
      warnings.push({ ...warning, trackId: track.id, trackName: track.name, kind: 'subtitle' });
    }
  }

  notes.push(...normalizeDefaults(hydrated.audioTracks, '音轨'));
  notes.push(...normalizeDefaults(hydrated.subtitleTracks, '字幕'));

  // defaults 可能刚被纠正，同步到计划副本
  const audioDefaultId = hydrated.audioTracks.find((track) => track.default)?.id || null;
  const subtitleDefaultId = hydrated.subtitleTracks.find((track) => track.default)?.id || null;
  for (const plan of audioPlans) plan.default = plan.id === audioDefaultId;
  for (const plan of subtitlePlans) plan.default = plan.id === subtitleDefaultId;

  const enabledAudio = audioPlans.filter((plan) => plan.enabled && plan.supported);
  const enabledSubtitles = subtitlePlans.filter((plan) => plan.enabled && plan.supported);
  const unsupportedEnabled = [...audioPlans, ...subtitlePlans].filter(
    (plan) => plan.enabled && !plan.supported,
  );

  const errors = [];
  if (unsupportedEnabled.length) {
    for (const plan of unsupportedEnabled) {
      errors.push({
        code: 'unsupported-track',
        trackId: plan.id,
        trackName: plan.name,
        kind: plan.kind,
        message: `「${plan.name}」：${plan.supportIssue}`,
      });
    }
  }
  if (!enabledAudio.length) {
    errors.push({
      code: 'no-audio',
      trackId: null,
      kind: 'audio',
      message: '至少要启用一条音轨才能导出',
    });
  }
  if (!enabledSubtitles.length) {
    errors.push({
      code: 'no-subtitle',
      trackId: null,
      kind: 'subtitle',
      message: '至少要启用一条字幕才能导出',
    });
  }
  for (const plan of enabledAudio) {
    if (plan.timeline?.fullyOutside) {
      errors.push({
        code: 'track-outside',
        trackId: plan.id,
        trackName: plan.name,
        kind: 'audio',
        message: `「${plan.name}」按当前偏移没有任何内容落在视频内`,
      });
    }
  }
  for (const plan of enabledSubtitles) {
    if (plan.supported && !plan.cues.length) {
      errors.push({
        code: 'empty-subtitle',
        trackId: plan.id,
        trackName: plan.name,
        kind: 'subtitle',
        message: `「${plan.name}」按当前偏移没有剩余字幕`,
      });
    }
  }
  for (const note of notes) {
    warnings.push({ ...note, trackId: null, trackName: null, kind: 'project' });
  }

  const counts = { info: 0, warning: 0, error: 0 };
  for (const warning of warnings) {
    const severity = warning.severity || 'info';
    counts[severity] = (counts[severity] || 0) + 1;
  }

  return {
    name: hydrated.name,
    video: hydrated.video,
    audioTracks: audioPlans,
    subtitleTracks: subtitlePlans,
    defaults: { audioId: audioDefaultId, subtitleId: subtitleDefaultId },
    warnings,
    warningCounts: counts,
    errors,
    ready: errors.length === 0,
    rule: 'trim-head-pad-tail@1',
  };
}

/** 生成可继续编辑的轨道配置。路径是可移植的绝对路径。 */
export function toEditableConfig(hydrated, plan) {
  return {
    format: 'trackweave-project',
    version: 1,
    generatedAt: new Date().toISOString(),
    projectName: hydrated.name,
    alignmentRule: 'trim-head-pad-tail@1',
    video: {
      path: hydrated.video.path,
      name: hydrated.video.name,
      duration: hydrated.video.duration,
      width: hydrated.video.width,
      height: hydrated.video.height,
      codec: hydrated.video.codec,
    },
    audioTracks: plan.audioTracks.map((track) => ({
      id: track.id,
      path: hydrated.audioTracks.find((item) => item.id === track.id)?.path || null,
      name: track.name,
      language: track.language,
      languageTag: track.languageTag,
      offset: track.offset,
      enabled: track.enabled,
      default: track.default,
      sourceDuration: track.sourceDuration,
      codec: track.codec,
    })),
    subtitleTracks: plan.subtitleTracks.map((track) => ({
      id: track.id,
      path: hydrated.subtitleTracks.find((item) => item.id === track.id)?.path || null,
      name: track.name,
      language: track.language,
      languageTag: track.languageTag,
      offset: track.offset,
      enabled: track.enabled,
      default: track.default,
      sourceDuration: track.sourceDuration,
      format: track.format,
      cueCount: track.sourceCueCount ?? track.cueCount,
    })),
    output: {
      defaultAudioId: plan.defaults.audioId,
      defaultSubtitleId: plan.defaults.subtitleId,
    },
  };
}

export { fileDuration };
