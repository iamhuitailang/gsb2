/**
 * 字幕解析 / 平移 / 裁剪。前端预览、服务端导出、测试共用同一套实现，
 * 这样“预览里看到的时间”和“导出文件里的时间”不会出现两套规则。
 *
 * 支持 SRT、WebVTT、ASS/SSA（ASS 仅保留文本与时间，样式会丢失）。
 * 图片字幕（PGS / VobSub 等）无法转成文本，由调用方标记为不支持。
 */

export const SUBTITLE_EXTENSIONS = ['srt', 'vtt', 'ass', 'ssa'];
export const IMAGE_SUBTITLE_EXTENSIONS = ['sup', 'pgs', 'idx', 'sub', 'vob', 'dvb', 'mks'];

const TIMESTAMP_RE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/;
const EPSILON = 0.0005;

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 解析 00:01:02,500 / 1:02.500 / 0:00:02.50 等写法，返回秒；失败返回 null。 */
export function parseTimestamp(raw) {
  if (raw == null) return null;
  const match = String(raw).trim().match(TIMESTAMP_RE);
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number((match[4] || '0').padEnd(3, '0').slice(0, 3));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

export function formatSubtitleTime(seconds, { comma = true } = {}) {
  const total = Math.max(0, finite(seconds));
  const whole = Math.floor(total);
  const millis = Math.round((total - whole) * 1000);
  let s = whole;
  let ms = millis;
  if (ms >= 1000) {
    s += 1;
    ms -= 1000;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sec)}${comma ? ',' : '.'}${pad(ms, 3)}`;
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

const HTML_TAG_RE = /<\/?[a-z][^>]{0,80}>/gi;

function cleanCueText(text, { ass = false, html = true } = {}) {
  let value = String(text ?? '');
  if (ass) {
    value = value
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, '\n')
      .replace(/\\n/gi, '\n')
      .replace(/\\h/gi, ' ');
  }
  if (html) {
    value = value.replace(/<br\s*\/?>/gi, '\n');
    value = value.replace(HTML_TAG_RE, '');
  }
  value = decodeEntities(value);
  return value
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
    .trim();
}

function splitAssFields(line, fieldCount) {
  const values = [];
  let cursor = 0;
  for (let i = 0; i < fieldCount - 1; i += 1) {
    const next = line.indexOf(',', cursor);
    if (next === -1) break;
    values.push(line.slice(cursor, next));
    cursor = next + 1;
  }
  values.push(line.slice(cursor));
  return values;
}

function pushCue(cues, start, end, text, warnings, meta = '') {
  if (start == null || end == null) {
    warnings.push({ code: 'bad-time', message: `时间无法解析${meta}` });
    return;
  }
  if (end < start) [start, end] = [end, start];
  const cleaned = cleanCueText(text, meta === 'ass' ? { ass: true, html: false } : {});
  if (!cleaned) return;
  cues.push({ start, end, text: cleaned });
}

function parseSrtLike(text, { format }) {
  const cues = [];
  const warnings = [];
  const blocks = String(text || '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/);

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const lines = blocks[blockIndex].split('\n').map((line) => line.trim());
    if (!lines.some(Boolean)) continue;
    if (lines[0].toUpperCase() === 'WEBVTT') continue;
    if (/^(NOTE|STYLE|REGION)\b/i.test(lines[0])) continue;

    const arrowIndex = lines.findIndex((line) => line.includes('-->'));
    if (arrowIndex === -1) {
      warnings.push({ code: 'bad-block', message: `第 ${blockIndex + 1} 块缺少时间轴` });
      continue;
    }
    const [startRaw, endRawWithSettings] = lines[arrowIndex].split('-->');
    const endRaw = String(endRawWithSettings || '').trim().split(/\s+/)[0];
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw);
    const body = lines.slice(arrowIndex + 1).join('\n');
    pushCue(cues, start, end, body, warnings, format);
  }
  return { cues, warnings };
}

function parseAss(text) {
  const cues = [];
  const warnings = [];
  const lines = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  let inEvents = false;
  let formatFields = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^\[events\]$/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (/^\[.+\]$/.test(line)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) {
      formatFields = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((field) => field.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line) || !formatFields) continue;

    const payload = line.slice(line.indexOf(':') + 1);
    const values = splitAssFields(payload, formatFields.length);
    const record = {};
    formatFields.forEach((field, i) => {
      record[field] = (values[i] ?? '').trim();
    });
    const start = parseTimestamp(record.start);
    const end = parseTimestamp(record.end);
    const text = record.text ?? '';
    pushCue(cues, start, end, text, warnings, 'ass');
  }
  return { cues, warnings };
}

export function detectSubtitleFormat(fileName = '', text = '') {
  const ext = String(fileName).toLowerCase().split('.').pop();
  if (SUBTITLE_EXTENSIONS.includes(ext)) return ext;
  const body = String(text || '').replace(/^﻿/, '').trimStart();
  if (/^WEBVTT/i.test(body)) return 'vtt';
  if (/\[Events\]/i.test(body) && /^Dialogue\s*:/im.test(body)) return 'ass';
  if (/-->/m.test(body)) return /-->\s*\d+:\d+:\d+,\d+/.test(body) ? 'srt' : 'vtt';
  return null;
}

/**
 * 解析字幕文本。返回 {format, cues, warnings, styleLost}。
 * 完全没有可识别字幕时抛出 Error(code='no-cues')。
 */
export function parseSubtitles(text, { fileName = '', format } = {}) {
  const detected = format || detectSubtitleFormat(fileName, text);
  const normalized = ['ass', 'ssa'].includes(detected) ? 'ass' : detected;
  if (!normalized) {
    const error = new Error('无法识别字幕格式（支持 SRT / VTT / ASS / SSA）');
    error.code = 'no-cues';
    throw error;
  }

  const result =
    normalized === 'ass'
      ? parseAss(text)
      : parseSrtLike(text, { format: normalized });

  if (!result.cues.length) {
    const error = new Error('没有解析到任何字幕条目');
    error.code = 'no-cues';
    throw error;
  }

  result.cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return {
    format: normalized,
    cues: result.cues,
    warnings: result.warnings,
    styleLost: ['ass', 'ssa'].includes(detected),
  };
}

export function serializeSrt(cues) {
  return cues
    .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
    .map((cue, index) => {
      const body = String(cue.text || '').replace(/\r\n?/g, '\n');
      return `${index + 1}\n${formatSubtitleTime(cue.start)} --> ${formatSubtitleTime(cue.end)}\n${body}`;
    })
    .join('\n\n')
    .concat('\n');
}

export function subtitleDuration(cues) {
  return cues.reduce((max, cue) => Math.max(max, finite(cue.end)), 0);
}

/**
 * 按 offset 平移并裁剪到 [0, videoDuration]。
 * offset 与音轨完全同义：正值整体后移，负值裁掉开头。
 * 返回的 warnings 逐条记录被裁头 / 超出末尾 / 完全落在视频外的字幕。
 */
export function shiftAndClipCues(cues, { offset = 0, videoDuration = null } = {}) {
  const shift = Number.isFinite(Number(offset)) ? Number(offset) : 0;
  const limit = Number.isFinite(Number(videoDuration)) && Number(videoDuration) > 0
    ? Number(videoDuration)
    : null;
  const shifted = [];
  const warnings = [];
  const summary = { clippedHead: 0, clippedTail: 0, droppedBefore: 0, droppedAfter: 0 };

  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const rawStart = cue.start + shift;
    const rawEnd = cue.end + shift;

    if (rawEnd <= EPSILON) {
      summary.droppedBefore += 1;
      warnings.push({
        code: 'cue-dropped-before',
        cueIndex: index,
        text: cue.text,
        seconds: -rawEnd,
        message: `字幕「${snippet(cue.text)}」完全位于视频开头之前，已丢弃`,
      });
      continue;
    }
    if (limit != null && rawStart >= limit - EPSILON) {
      summary.droppedAfter += 1;
      warnings.push({
        code: 'cue-dropped-after',
        cueIndex: index,
        text: cue.text,
        seconds: rawStart - limit,
        message: `字幕「${snippet(cue.text)}」开始于视频末尾之后，已丢弃`,
      });
      continue;
    }

    const start = Math.max(0, rawStart);
    let end = rawEnd;
    let clippedHead = false;
    let clippedTail = false;

    if (rawStart < -EPSILON) {
      clippedHead = true;
      summary.clippedHead += 1;
      warnings.push({
        code: 'cue-clipped-head',
        cueIndex: index,
        text: cue.text,
        seconds: -rawStart,
        message: `字幕「${snippet(cue.text)}」开头 ${fmt(-rawStart)} 秒在视频之前，预览与导出都会裁掉`,
      });
    }
    if (limit != null && rawEnd > limit + EPSILON) {
      end = limit;
      clippedTail = true;
      summary.clippedTail += 1;
      warnings.push({
        code: 'cue-clipped-tail',
        cueIndex: index,
        text: cue.text,
        seconds: rawEnd - limit,
        message: `字幕「${snippet(cue.text)}」末尾 ${fmt(rawEnd - limit)} 秒超出视频，预览与导出都会截断`,
      });
    }

    if (end - start <= EPSILON) {
      summary.droppedAfter += 1;
      warnings.push({
        code: 'cue-empty',
        cueIndex: index,
        text: cue.text,
        seconds: 0,
        message: `字幕「${snippet(cue.text)}」平移后时长为零，已丢弃`,
      });
      continue;
    }

    shifted.push({
      start,
      end,
      text: cue.text,
      sourceIndex: index,
      sourceStart: cue.start,
      sourceEnd: cue.end,
      clippedHead,
      clippedTail,
    });
  }

  return { cues: shifted, warnings, summary };
}

export function activeCues(cues, time) {
  if (!Number.isFinite(time)) return [];
  return cues.filter((cue) => time >= cue.start - EPSILON && time < cue.end - EPSILON);
}

/**
 * 一站式分析：解析 → 平移裁剪 → 汇总警告。服务端导出和前端预览都走这里。
 */
export function analyzeSubtitleText(text, { fileName = '', format, offset = 0, videoDuration = null } = {}) {
  const parsed = parseSubtitles(text, { fileName, format });
  const shifted = shiftAndClipCues(parsed.cues, { offset, videoDuration });
  const sourceDuration = subtitleDuration(parsed.cues);
  return {
    format: parsed.format,
    styleLost: parsed.styleLost,
    parseWarnings: parsed.warnings,
    sourceDuration,
    cues: shifted.cues,
    warnings: shifted.warnings,
    summary: shifted.summary,
    effectiveDuration: shifted.cues.length ? subtitleDuration(shifted.cues) : 0,
  };
}

function snippet(text, length = 14) {
  const single = String(text || '').replace(/\s+/g, ' ').trim();
  return single.length > length ? `${single.slice(0, length)}…` : single;
}

function fmt(value) {
  return Math.abs(value).toFixed(2);
}

export const SUBTITLE_FORMAT_LABELS = {
  srt: 'SRT',
  vtt: 'WebVTT',
  ass: 'ASS/SSA',
};
