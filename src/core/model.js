// 工程数据模型与时间线计算（纯函数，不碰 DOM）。
//
// 工程结构：
// project = {
//   sources: [{ id, name, path, kind: 'video'|'audio', duration, fps, offset, hasAudio }],
//   cuts:    [{ id, time, sourceId }]   // 按 time 升序；cuts[i] 是第 i 段的起点与机位
// }
// 第 i 段覆盖 [cuts[i].time, cuts[i+1].time)，最后一段到时间线末尾。

import { parseFps, snapToFrame, clamp } from './time.js';

let counter = 0;
export function uid(prefix = 'id') {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function createProject() {
  return { version: 1, sources: [], cuts: [] };
}

export function getSource(project, sourceId) {
  return project.sources.find((s) => s.id === sourceId) || null;
}

/** 时间线整体范围：由各素材 offset..offset+duration 的并集决定，支持负偏移。 */
export function timelineBounds(project) {
  if (project.sources.length === 0) return { min: 0, max: 0, duration: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const s of project.sources) {
    min = Math.min(min, s.offset);
    max = Math.max(max, s.offset + s.duration);
  }
  return { min, max, duration: max - min };
}

/** 把切点整理成段落，返回带起止时间的段列表。 */
export function buildSegments(project) {
  const bounds = timelineBounds(project);
  return project.cuts.map((cut, i) => ({
    cutIndex: i,
    start: cut.time,
    end: i + 1 < project.cuts.length ? project.cuts[i + 1].time : bounds.max,
    sourceId: cut.sourceId,
    cutId: cut.id,
  }));
}

/** 时间线时间 t 所在的段（无切点时为 null）。 */
export function segmentAt(project, t) {
  const segs = buildSegments(project);
  let found = null;
  for (const seg of segs) {
    if (t >= seg.start && t < seg.end) {
      found = seg;
      break;
    }
  }
  return found;
}

/**
 * 某素材在时间线 t 处的覆盖情况。
 * status:
 *   ok      素材范围内，sourceT 为对应素材内时间
 *   before  早于素材开头（素材还没开始）
 *   after   晚于素材结尾（素材已结束）
 *   gap     工程里没有该素材（引用丢失）
 */
export function coverageAt(project, sourceId, t) {
  const src = getSource(project, sourceId);
  if (!src) {
    return { status: 'gap', sourceT: null, frame: null, frameCount: null, source: null };
  }
  const sourceT = t - src.offset;
  const fps = parseFps(src.fps);
  if (sourceT < 0) {
    return { status: 'before', sourceT, frame: null, frameCount: null, source: src };
  }
  if (sourceT >= src.duration) {
    return {
      status: 'after',
      sourceT,
      frame: Math.round(src.duration * fps),
      frameCount: Math.round(src.duration * fps),
      source: src,
    };
  }
  return {
    status: 'ok',
    sourceT,
    frame: Math.round(sourceT * fps),
    frameCount: Math.round(src.duration * fps),
    source: src,
  };
}

/** 在 (lo, hi) 范围内找最接近 t 的帧网格时间；范围太窄时退化为 lo。 */
function nearestGridInRange(t, fps, lo, hi) {
  const snapped = snapToFrame(t, fps);
  if (snapped > lo && snapped < hi) return snapped;
  const step = 1 / fps;
  const candidates = [lo + step, hi - step, lo, hi].filter((v) => v > lo && v < hi);
  if (candidates.length === 0) return lo;
  return candidates.reduce((best, v) => (Math.abs(v - t) < Math.abs(best - t) ? v : best));
}

function normalizeOrder(project) {
  project.cuts.sort((a, b) => a.time - b.time);
}

/**
 * 在 time 处插入切点，新机位默认沿用当前段的机位。
 * 时间吸附到该机位的帧网格。
 */
export function addCut(project, time, sourceId = null) {
  const current = segmentAt(project, time);
  const camId = sourceId || current?.sourceId || project.cuts[project.cuts.length - 1]?.sourceId;
  if (!camId) return null;
  const src = getSource(project, camId);
  const snapped = src && src.kind === 'video' ? snapToFrame(time, parseFps(src.fps)) : time;
  // 已存在同一时刻的切点：直接返回它，避免产生零时长段落
  const existing = project.cuts.findIndex((c) => Math.abs(c.time - snapped) < 1e-6);
  if (existing >= 0) return existing;
  const cut = { id: uid('cut'), time: snapped, sourceId: camId };
  project.cuts.push(cut);
  normalizeOrder(project);
  return project.cuts.indexOf(cut);
}

export function removeCut(project, cutIndex) {
  if (cutIndex <= 0 || cutIndex >= project.cuts.length) return false; // 第 0 个切点是时间线起点，不可删
  project.cuts.splice(cutIndex, 1);
  return true;
}

/** 拖动切点：吸附到该切点「切入机位」的帧网格，并保持段落顺序。 */
export function moveCut(project, cutIndex, newTime) {
  const cut = project.cuts[cutIndex];
  if (!cut) return;
  const src = getSource(project, cut.sourceId);
  const lo = cutIndex > 0 ? project.cuts[cutIndex - 1].time : -Infinity;
  const hi = cutIndex + 1 < project.cuts.length ? project.cuts[cutIndex + 1].time : Infinity;
  const t = clamp(newTime, lo, hi);
  cut.time =
    src && src.kind === 'video'
      ? nearestGridInRange(t, parseFps(src.fps), lo, hi)
      : t;
  normalizeOrder(project);
}

/**
 * 切换某段的机位。该段的起止切点都要吸附到新机位的帧网格，
 * 同时不破坏与相邻段的时间顺序。
 */
export function setSegmentCamera(project, cutIndex, sourceId) {
  const cut = project.cuts[cutIndex];
  const src = getSource(project, sourceId);
  if (!cut || !src) return;
  cut.sourceId = sourceId;
  if (src.kind !== 'video') return;
  const fps = parseFps(src.fps);
  const prevTime = cutIndex > 0 ? project.cuts[cutIndex - 1].time : -Infinity;
  const nextTime = cutIndex + 1 < project.cuts.length ? project.cuts[cutIndex + 1].time : Infinity;
  cut.time = nearestGridInRange(cut.time, fps, prevTime, nextTime);
  if (cutIndex + 1 < project.cuts.length) {
    const endCut = project.cuts[cutIndex + 1];
    const afterNext = cutIndex + 2 < project.cuts.length ? project.cuts[cutIndex + 2].time : Infinity;
    endCut.time = nearestGridInRange(endCut.time, fps, cut.time, afterNext);
  }
  normalizeOrder(project);
}

/**
 * 修改素材偏移（手动校正或同步结果）。
 * 只重算「切入该机位」的切点（cut.sourceId === sourceId），其余切点时间不变。
 * 切点是它所开启段落的属性：某段机位的覆盖变化只影响该段自己的起点，
 * 相邻段的起点归相邻机位所有，因此不会被误动。
 * 每个被重算的切点先平移 delta，再吸附到该素材的帧网格。
 */
export function setSourceOffset(project, sourceId, newOffset) {
  const src = getSource(project, sourceId);
  if (!src) return;
  const delta = newOffset - src.offset;
  src.offset = newOffset;
  const fps = parseFps(src.fps);
  for (let i = 0; i < project.cuts.length; i++) {
    const cut = project.cuts[i];
    if (cut.sourceId !== sourceId) continue;
    if (src.kind === 'video') {
      const lo = i > 0 ? project.cuts[i - 1].time : -Infinity;
      const hi = i + 1 < project.cuts.length ? project.cuts[i + 1].time : Infinity;
      cut.time = nearestGridInRange(cut.time + delta, fps, lo, hi);
    } else {
      cut.time += delta;
    }
  }
  normalizeOrder(project);
}

/** 对比两份工程，返回发生变化的切点（用于偏移修改前后的预览比较）。 */
export function diffCuts(beforeProject, afterProject) {
  const before = new Map(beforeProject.cuts.map((c) => [c.id, c]));
  const after = new Map(afterProject.cuts.map((c) => [c.id, c]));
  const changes = [];
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a) {
      changes.push({ cutId: id, kind: 'removed', beforeTime: b.time, afterTime: null });
    } else if (Math.abs(a.time - b.time) > 1e-6 || a.sourceId !== b.sourceId) {
      changes.push({
        cutId: id,
        kind: 'moved',
        beforeTime: b.time,
        afterTime: a.time,
        delta: a.time - b.time,
        sourceChanged: a.sourceId !== b.sourceId,
      });
    }
  }
  for (const [id, a] of after) {
    if (!before.has(id)) {
      changes.push({ cutId: id, kind: 'added', beforeTime: null, afterTime: a.time });
    }
  }
  return changes;
}

/** 对比两份工程的素材偏移。 */
export function diffOffsets(beforeProject, afterProject) {
  const before = new Map(beforeProject.sources.map((s) => [s.id, s]));
  const changes = [];
  for (const a of afterProject.sources) {
    const b = before.get(a.id);
    if (b && Math.abs(a.offset - b.offset) > 1e-9) {
      changes.push({ sourceId: a.id, name: a.name, before: b.offset, after: a.offset });
    }
  }
  return changes;
}
