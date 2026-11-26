// 机位切换清单（EDL）导出。
// 所有时间同时给出「时间线时间」和「原素材时间」，重新打开工程或交给
// 其它剪辑软件时都能定位回原始素材。

import { buildSegments, timelineBounds, getSource } from './model.js';
import { formatTimecode, timeToFrame } from './time.js';

/**
 * 生成结构化 EDL（普通对象，可直接 JSON.stringify）。
 * 每段包含：
 *  - timelineStart/End        时间线上的起止秒
 *  - sourceStart/End          对应原素材内的起止秒（超范围时为 null）
 *  - sourceStartFrame/EndFrame 素材内帧号
 *  - status                   ok / out-of-range（越界分段标注，不做黑帧填充）
 */
export function buildEDL(project) {
  const segs = buildSegments(project);
  const entries = segs.map((seg, i) => {
    const src = getSource(project, seg.sourceId);
    const fps = src ? src.fps : 30;
    const startInSource = src ? seg.start - src.offset : null;
    const endInSource = src ? seg.end - src.offset : null;
    const outOfRange = !src
      ? ['source-missing']
      : [
          startInSource < 0 ? 'before-source-start' : null,
          endInSource > src.duration ? 'after-source-end' : null,
        ].filter(Boolean);
    // 帧号/素材时间只在落在素材有效范围 [0, duration] 内时给出，
    // 越界位置对应不到真实帧，返回 null 而不是伪造一个超出总帧数的编号。
    const startValid = src && startInSource >= 0 && startInSource <= src.duration;
    const endValid = src && endInSource >= 0 && endInSource <= src.duration;
    return {
      index: i + 1,
      sourceId: seg.sourceId,
      sourceName: src ? src.name : '(素材缺失)',
      kind: src ? src.kind : 'unknown',
      fps,
      timelineStart: round3(seg.start),
      timelineEnd: round3(seg.end),
      timelineDuration: round3(seg.end - seg.start),
      sourceStart: startValid ? round3(startInSource) : null,
      sourceEnd: endValid ? round3(endInSource) : null,
      sourceStartFrame: startValid ? timeToFrame(startInSource, fps) : null,
      sourceEndFrame: endValid ? timeToFrame(endInSource, fps) : null,
      timecodeStart: formatTimecode(seg.start, fps),
      status: outOfRange.length ? `out-of-range:${outOfRange.join(',')}` : 'ok',
    };
  });
  const bounds = timelineBounds(project);
  return {
    format: 'multicam-edl',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    timeline: {
      start: round3(bounds.min),
      end: round3(bounds.max),
      duration: round3(bounds.duration),
    },
    sources: project.sources.map((s) => ({
      sourceId: s.id,
      name: s.name,
      kind: s.kind,
      fps: s.fps,
      duration: round3(s.duration),
      offset: round3(s.offset),
      timelineStart: round3(s.offset),
      timelineEnd: round3(s.offset + s.duration),
    })),
    cuts: entries,
  };
}

function round3(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? v : Math.round(v * 1000) / 1000;
}

/** CSV 列定义（同时也是 README 里说明的字段）。 */
export const CSV_COLUMNS = [
  'index',
  'sourceName',
  'kind',
  'fps',
  'timelineStart',
  'timelineEnd',
  'timelineDuration',
  'sourceStart',
  'sourceStartFrame',
  'sourceEnd',
  'sourceEndFrame',
  'timecodeStart',
  'status',
];

export function edlToCsv(edl) {
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of edl.cuts) {
    lines.push(CSV_COLUMNS.map((col) => escape(row[col])).join(','));
  }
  return lines.join('\n') + '\n';
}
