import { MIN_REGION_SECONDS } from './time.js';

/** 贪心排布重叠区间：重叠的区间占用不同泳道，互不重叠的尽量复用泳道。 */
export function assignLanes(regions) {
  const sorted = [...regions].sort((a, b) => a.start - b.start || a.end - b.end || String(a.id).localeCompare(String(b.id)));
  const laneEnds = [];
  const laneById = new Map();
  for (const region of sorted) {
    let lane = laneEnds.findIndex((end) => region.start >= end - 1e-6);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(region.end);
    } else {
      laneEnds[lane] = Math.max(laneEnds[lane], region.end);
    }
    laneById.set(region.id, lane);
  }
  return { laneById, laneCount: Math.max(1, laneEnds.length) };
}

/** 找出时间点命中的所有区间（重叠时可能多个）。 */
export function regionsAt(regions, time) {
  return regions.filter((r) => time >= r.start - 1e-6 && time < r.end - 1e-6);
}

/** 合并后的覆盖时长、重叠时长与空白区间。 */
export function coverageStats(regions, duration) {
  const span = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const valid = regions
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  let covered = 0;
  let overlap = 0;
  let cursor = 0;
  let overlapCount = 0;
  const gaps = [];
  for (const region of valid) {
    const start = Math.max(0, region.start);
    const end = span > 0 ? Math.min(span, region.end) : region.end;
    if (end <= start) continue;
    if (start > cursor + 1e-6) gaps.push({ start: cursor, end: start });
    if (start < cursor - 1e-6) {
      overlap += Math.min(end, cursor) - start;
      overlapCount += 1;
    }
    covered += Math.max(0, end - Math.max(start, cursor));
    cursor = Math.max(cursor, end);
  }
  if (span > 0 && cursor < span - 1e-6) gaps.push({ start: cursor, end: span });
  return {
    regionCount: regions.length,
    covered,
    overlap,
    overlapCount,
    blank: span > 0 ? Math.max(0, span - covered) : 0,
    gaps,
  };
}

/** 用于「在播放头分割」：时间不在区间内部时返回 null。 */
export function splitRegion(region, time, makeId) {
  if (!(time > region.start + MIN_REGION_SECONDS) || !(time < region.end - MIN_REGION_SECONDS)) return null;
  const left = { ...region, id: makeId(), end: time, updatedAt: Date.now() };
  const right = { ...region, id: makeId(), start: time, createdAt: Date.now(), updatedAt: Date.now() };
  return [left, right];
}
