/**
 * 对齐模型：一条音轨 / 字幕轨相对视频的偏移、空白与溢出，全部由这里计算。
 *
 * 规则（预览与导出共用，不存在第二套实现）：
 *   offset > 0  轨道整体后移；视频开头这段空白补静音（字幕则无显示）
 *   offset < 0  轨道整体前移；源文件开头多出来的部分裁掉
 *   轨道比视频短  末尾补静音（字幕则无显示）到视频结束
 *   轨道比视频长  末尾超出部分在预览中静音、导出时截断，并给出提醒
 *
 * 设 v 为视频时间、s 为源文件时间，则 s = v - offset。
 */

export const ALIGNMENT_RULE = {
  id: 'trim-head-pad-tail@1',
  label: '头部裁切 / 尾部补齐',
  description:
    '正偏移 = 轨道后移，开头补静音（字幕无显示）；负偏移 = 轨道前移，裁掉源开头。' +
    '轨道短于视频时末尾补齐；长于视频时超出部分在预览中静音并在导出时截断。',
};

const EPSILON = 0.0005;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function roundSeconds(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(num(value) * factor) / factor;
}

export function formatClock(seconds, { millis = false } = {}) {
  const total = Math.max(0, num(seconds));
  let whole = Math.floor(total);
  let ms = Math.round((total - whole) * 1000);
  if (ms >= 1000) {
    whole += 1;
    ms -= 1000;
  }
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const base =
    h > 0
      ? `${h}:${pad2(m)}:${pad2(s)}`
      : `${m}:${pad2(s)}`;
  return millis ? `${base}.${String(ms).padStart(3, '0')}` : base;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function formatSigned(seconds, digits = 2) {
  const value = num(seconds);
  const text = Math.abs(value).toFixed(digits);
  if (value > 0) return `+${text}s`;
  if (value < 0) return `−${text}s`;
  return `${text}s`;
}

/**
 * 音轨时间线。sourceDuration / videoDuration 都是秒。
 * 返回的字段可直接用于预览调度和 ffmpeg 滤镜参数。
 */
export function resolveAudioTimeline({
  offset = 0,
  sourceDuration = 0,
  videoDuration = 0,
} = {}) {
  const off = num(offset);
  const src = Math.max(0, num(sourceDuration));
  const video = Math.max(0, num(videoDuration));
  // 0 视为“时长未知”（部分容器不报音频时长），按覆盖整个视频处理，
  // 否则会被错误判成“完全在视频外”。
  const srcKnown = src > 0;
  const srcEffective = srcKnown ? src : Math.max(0, video - Math.max(0, off));

  const headSilence = Math.max(0, off);
  const headTrim = srcKnown ? Math.min(srcEffective, Math.max(0, -off)) : Math.max(0, -off);
  const sourceUsable = Math.max(0, srcEffective - headTrim);
  const placedEnd = off + srcEffective;
  const effectiveEnd = Math.max(0, Math.min(video, placedEnd));
  const effectiveDuration = Math.max(0, effectiveEnd - headSilence);
  const tailSilence = Math.max(0, video - placedEnd);
  const overflow = srcKnown ? Math.max(0, placedEnd - video) : 0;
  const fullyOutside = video > 0 && (sourceUsable <= EPSILON || effectiveDuration <= EPSILON);

  const warnings = [];
  if (headSilence > EPSILON) {
    warnings.push({
      code: 'late-start',
      severity: 'info',
      seconds: roundSeconds(headSilence),
      message: `晚开始 ${headSilence.toFixed(2)} 秒，视频开头补静音`,
    });
  }
  if (headTrim > EPSILON) {
    warnings.push({
      code: 'trimmed-head',
      severity: 'info',
      seconds: roundSeconds(headTrim),
      message: `早于视频开头 ${headTrim.toFixed(2)} 秒，源开头裁掉`,
    });
  }
  if (tailSilence > EPSILON && !fullyOutside) {
    warnings.push({
      code: 'early-end',
      severity: 'info',
      seconds: roundSeconds(tailSilence),
      message: `早结束 ${tailSilence.toFixed(2)} 秒，末尾补静音`,
    });
  }
  if (overflow > EPSILON) {
    warnings.push({
      code: 'overflow-tail',
      severity: 'warning',
      seconds: roundSeconds(overflow),
      message: `超出视频末尾 ${overflow.toFixed(2)} 秒，预览中静音、导出时截断`,
    });
  }
  if (fullyOutside) {
    warnings.push({
      code: 'fully-outside',
      severity: 'error',
      seconds: 0,
      message: '按当前偏移，该轨没有任何内容落在视频范围内',
    });
  }

  return {
    kind: 'audio',
    offset: roundSeconds(off),
    sourceDuration: roundSeconds(src),
    sourceDurationKnown: srcKnown,
    videoDuration: roundSeconds(video),
    headSilence: roundSeconds(headSilence),
    headTrim: roundSeconds(headTrim),
    tailSilence: roundSeconds(tailSilence),
    overflow: roundSeconds(overflow),
    placedStart: roundSeconds(headSilence),
    placedEnd: roundSeconds(placedEnd),
    effectiveStart: roundSeconds(headSilence),
    effectiveEnd: roundSeconds(effectiveEnd),
    effectiveDuration: roundSeconds(effectiveDuration),
    fullyOutside,
    warnings,
  };
}

/**
 * 字幕轨时间线。cues 必须是原始（未平移）字幕条目。
 * 内部复用 shiftAndClipCues 的时间语义；这里只给轨道级汇总。
 */
export function resolveSubtitleTimeline({
  offset = 0,
  cues = [],
  sourceDuration = null,
  videoDuration = 0,
} = {}) {
  const off = num(offset);
  const video = Math.max(0, num(videoDuration));
  const src =
    sourceDuration != null
      ? Math.max(0, num(sourceDuration))
      : cues.reduce((max, cue) => Math.max(max, num(cue.end)), 0);

  const shifted = cues
    .map((cue) => ({ start: num(cue.start) + off, end: num(cue.end) + off, text: cue.text }))
    .filter((cue) => cue.end > EPSILON && (video <= 0 || cue.start < video - EPSILON))
    .map((cue) => ({
      start: Math.max(0, cue.start),
      end: video > 0 ? Math.min(video, cue.end) : cue.end,
      text: cue.text,
    }))
    .filter((cue) => cue.end - cue.start > EPSILON);

  const firstStart = shifted.length ? Math.min(...shifted.map((cue) => cue.start)) : null;
  const lastEnd = shifted.length ? Math.max(...shifted.map((cue) => cue.end)) : null;

  const warnings = [];
  if (video > 0 && lastEnd != null && lastEnd < video - EPSILON) {
    warnings.push({
      code: 'early-end',
      severity: 'info',
      seconds: roundSeconds(video - lastEnd),
      message: `最后一条字幕早于视频结束 ${(video - lastEnd).toFixed(2)} 秒，其后无字幕显示`,
    });
  }
  if (off > EPSILON && firstStart != null && firstStart > EPSILON) {
    warnings.push({
      code: 'late-start',
      severity: 'info',
      seconds: roundSeconds(firstStart),
      message: `首条字幕晚于视频开头 ${firstStart.toFixed(2)} 秒，开头无字幕显示`,
    });
  }

  return {
    kind: 'subtitle',
    offset: roundSeconds(off),
    sourceDuration: roundSeconds(src),
    videoDuration: roundSeconds(video),
    cues: shifted,
    cueCount: shifted.length,
    droppedCueCount: cues.length - shifted.length,
    effectiveStart: firstStart == null ? null : roundSeconds(firstStart),
    effectiveEnd: lastEnd == null ? null : roundSeconds(lastEnd),
    effectiveDuration:
      firstStart == null ? 0 : roundSeconds(Math.max(0, lastEnd - firstStart)),
    fullyOutside: cues.length > 0 && shifted.length === 0,
    warnings,
  };
}

/** 视频时间 → 源文件时间；不在源范围内返回 null（应输出空白 / 静音）。 */
export function videoTimeToSourceTime(videoTime, timeline) {
  const v = num(videoTime);
  const s = v - num(timeline.offset);
  if (s < -EPSILON || s >= num(timeline.sourceDuration) - EPSILON) return null;
  return Math.max(0, s);
}

export function summarizeWarnings(warnings = []) {
  const counts = { info: 0, warning: 0, error: 0 };
  for (const item of warnings) {
    const severity = item.severity || 'info';
    counts[severity] = (counts[severity] || 0) + 1;
  }
  return counts;
}
