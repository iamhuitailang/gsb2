import { formatTimecode, parseTimeInput, roundSeconds, TIME_UNIT } from './time.js';
import { CONFIDENCE_LEVELS, PROJECT_FORMAT, PROJECT_VERSION, normalizeDocument } from './model.js';

export const CSV_HEADERS = [
  'id',
  'start_seconds',
  'end_seconds',
  'duration_seconds',
  'start_timecode',
  'end_timecode',
  'label',
  'speaker',
  'confidence',
  'note',
];

function confidenceLabel(value) {
  return CONFIDENCE_LEVELS.find((level) => level.value === value)?.label ?? value;
}

/** 导出时按开始时间排序，便于人工核对。 */
export function regionsInOrder(store) {
  return store.sortedRegions().map((region) => ({
    region,
    label: store.regionLabel(region),
    speaker: store.regionSpeaker(region),
  }));
}

export function buildExportDocument(store, { exportedAt = new Date() } = {}) {
  const doc = store.doc;
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    kind: 'annotation-export',
    timeUnit: TIME_UNIT,
    exportedAt: exportedAt.toISOString(),
    project: {
      id: doc.id,
      name: doc.name,
      durationSeconds: roundSeconds(store.duration),
      duration: roundSeconds(store.duration),
      timeUnit: TIME_UNIT,
    },
    audio: doc.audio
      ? {
          fileName: doc.audio.fileName,
          duration: roundSeconds(doc.audio.duration),
          sampleRate: doc.audio.sampleRate,
          channels: doc.audio.channels,
          source: doc.audio.source,
          sampleId: doc.audio.sampleId,
        }
      : null,
    labels: doc.labels.map(({ id, name, color }) => ({ id, name, color })),
    speakers: doc.speakers.map(({ id, name, color }) => ({ id, name, color })),
    annotations: regionsInOrder(store).map(({ region, label, speaker }) => ({
      id: region.id,
      start: roundSeconds(region.start),
      end: roundSeconds(region.end),
      startSeconds: roundSeconds(region.start),
      endSeconds: roundSeconds(region.end),
      durationSeconds: roundSeconds(region.end - region.start),
      startTimecode: formatTimecode(region.start),
      endTimecode: formatTimecode(region.end),
      labelId: region.labelId,
      label: label?.name ?? '',
      speakerId: region.speakerId,
      speaker: speaker?.name ?? '',
      confidence: region.confidence,
      confidenceLabel: confidenceLabel(region.confidence),
      note: region.note ?? '',
    })),
  };
}

export function toJsonString(store, options) {
  return `${JSON.stringify(buildExportDocument(store, options), null, 2)}\n`;
}

export function escapeCsvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text) || /^\s|\s$/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsvString(store) {
  const lines = [CSV_HEADERS.join(',')];
  for (const { region, label, speaker } of regionsInOrder(store)) {
    lines.push(
      [
        region.id,
        roundSeconds(region.start).toFixed(3),
        roundSeconds(region.end).toFixed(3),
        roundSeconds(region.end - region.start).toFixed(3),
        formatTimecode(region.start),
        formatTimecode(region.end),
        label?.name ?? '',
        speaker?.name ?? '',
        region.confidence,
        region.note ?? '',
      ]
        .map(escapeCsvField)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** 极简 CSV 解析器，支持引号、转义引号、CRLF。 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const input = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/**
 * 从 JSON 导出或工程文件恢复出一个工程文档。
 * 顶层 `annotations` 是导出格式，`regions` 是工程格式，两者都接受。
 */
export function documentFromJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 解析失败：${error.message}`);
  }
  if (!data || typeof data !== 'object') throw new Error('JSON 内容不是对象');
  const project = data.project ?? {};
  const audio = data.audio ? { ...data.audio, duration: data.audio.duration ?? data.audio.durationSeconds ?? project.durationSeconds } : null;
  const regions = Array.isArray(data.annotations) ? data.annotations : data.regions;
  const doc = normalizeDocument({
    id: project.id ?? data.id,
    name: project.name ?? data.name,
    audio,
    labels: data.labels,
    speakers: data.speakers,
    regions,
    view: data.view,
  });
  return doc;
}

/**
 * CSV 导入：按表头匹配字段（中英文表头都支持），缺少标签/说话人时自动补建。
 * 返回可直接交给 store.replaceDocument 的文档。
 */
export function documentFromCsv(text, { name = 'CSV 导入', audio = null } = {}) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('CSV 文件为空');
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const aliases = {
    start: ['start_seconds', 'start', 'startsecond', '开始', '开始时间', '开始秒'],
    end: ['end_seconds', 'end', 'endsecond', '结束', '结束时间', '结束秒'],
    startTimecode: ['start_timecode', '开始时间码'],
    endTimecode: ['end_timecode', '结束时间码'],
    label: ['label', 'labelname', '类型', '标签', '标注类型'],
    speaker: ['speaker', 'speakername', '说话人'],
    confidence: ['confidence', '置信', '置信状态', '状态'],
    note: ['note', 'remark', '备注'],
    id: ['id', '标识'],
  };
  const index = {};
  for (const [key, names] of Object.entries(aliases)) {
    index[key] = header.findIndex((cell) => names.includes(cell));
  }
  const hasStart = index.start >= 0 || index.startTimecode >= 0;
  const hasEnd = index.end >= 0 || index.endTimecode >= 0;
  if (!hasStart || !hasEnd) {
    throw new Error('CSV 缺少开始/结束时间列');
  }
  const labels = [];
  const speakers = [];
  const labelId = (value) => {
    const label = String(value ?? '').trim() || '未标注';
    let found = labels.find((item) => item.name === label);
    if (!found) {
      found = { id: `label_${labels.length + 1}`, name: label, color: ['#f0b35a', '#a78bfa', '#fb7185', '#7dd3fc'][labels.length % 4] };
      labels.push(found);
    }
    return found.id;
  };
  const speakerId = (value) => {
    const speaker = String(value ?? '').trim();
    if (!speaker) return null;
    let found = speakers.find((item) => item.name === speaker);
    if (!found) {
      found = { id: `spk_${speakers.length + 1}`, name: speaker, color: ['#60a5fa', '#34d399', '#c084fc', '#f472b6'][speakers.length % 4] };
      speakers.push(found);
    }
    return found.id;
  };
  const confidenceValue = (value) => {
    const textValue = String(value ?? '').trim();
    if (!textValue) return 'certain';
    const level = CONFIDENCE_LEVELS.find((item) => item.value === textValue || item.label === textValue);
    return level?.value ?? 'certain';
  };
  const regions = [];
  for (const row of rows.slice(1)) {
    // 优先按秒列读取；缺失时退回时间码列（mm:ss.mmm），再不行尝试解析文本
    const start = parseSecondsCell(row[index.start]) ?? parseSecondsCell(index.startTimecode >= 0 ? row[index.startTimecode] : undefined);
    const end = parseSecondsCell(row[index.end]) ?? parseSecondsCell(index.endTimecode >= 0 ? row[index.endTimecode] : undefined);
    if (start === null || end === null || end <= start) continue;
    regions.push({
      id: index.id >= 0 ? row[index.id] : undefined,
      start,
      end,
      labelId: labelId(index.label >= 0 ? row[index.label] : ''),
      speakerId: speakerId(index.speaker >= 0 ? row[index.speaker] : ''),
      confidence: confidenceValue(index.confidence >= 0 ? row[index.confidence] : ''),
      note: index.note >= 0 ? row[index.note] : '',
    });
  }
  if (!regions.length) throw new Error('CSV 中没有有效的时间区间');
  return normalizeDocument({
    name,
    audio,
    labels,
    speakers,
    regions,
  });
}

/** 解析一个时间单元格：支持纯秒数、`mm:ss.mmm` 与带单位的文本。 */
function parseSecondsCell(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const plain = Number(text);
  if (Number.isFinite(plain)) return roundSeconds(plain);
  const parsed = parseTimeInput(text);
  return parsed === null ? null : roundSeconds(parsed);
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFileStem(name) {
  const stem = String(name ?? 'annotations')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return stem || 'annotations';
}

export { confidenceLabel };
