import { clamp, MIN_REGION_SECONDS, roundSeconds } from './time.js';

/**
 * 视图几何：把「秒」映射到像素。所有持久化数据都只存秒，
 * 像素坐标只在渲染/交互时临时计算，因此缩放、滚动不会改变标注时间。
 *
 * view = { start: 视口左边缘对应的秒, pxPerSecond: 每秒像素数 }
 */

export const MIN_PX_PER_SECOND = 0.25;
/** 高倍缩放上限：44.1 kHz 下约 0.9 像素/采样，可看清单个采样点。 */
export const MAX_PX_PER_SECOND = 40000;
export const MIN_VIEW_SPAN = MIN_REGION_SECONDS;

export function createView({ start = 0, pxPerSecond = 80 } = {}) {
  return {
    start: Math.max(0, Number(start) || 0),
    pxPerSecond: clamp(Number(pxPerSecond) || 80, MIN_PX_PER_SECOND, MAX_PX_PER_SECOND),
  };
}

export function timeToX(time, view) {
  return (time - view.start) * view.pxPerSecond;
}

export function xToTime(x, view) {
  return view.start + x / view.pxPerSecond;
}

export function visibleRange(view, width) {
  const span = width / view.pxPerSecond;
  return { start: view.start, end: view.start + span, span };
}

/** 把视图限制在音频范围内；音频比视口短时贴左显示。 */
export function clampView(view, duration, width, { minPxPerSecond = MIN_PX_PER_SECOND } = {}) {
  const safeDuration = Math.max(duration || 0, MIN_REGION_SECONDS);
  const fitPps = width > 0 ? width / safeDuration : 80;
  const pps = clamp(view.pxPerSecond, Math.min(minPxPerSecond, fitPps), MAX_PX_PER_SECOND);
  const start = clamp(view.start, 0, Math.max(0, safeDuration - width / pps));
  return { start, pxPerSecond: pps };
}

/** 以 anchorX 处的时刻为锚点缩放，保证光标下的声音不移动。 */
export function zoomAt(view, anchorX, factor, duration, width, options = {}) {
  const anchorTime = xToTime(anchorX, view);
  const targetPps = clamp(
    view.pxPerSecond * factor,
    options.minPxPerSecond ?? MIN_PX_PER_SECOND,
    options.maxPxPerSecond ?? MAX_PX_PER_SECOND,
  );
  const start = anchorTime - anchorX / targetPps;
  return clampView({ start, pxPerSecond: targetPps }, duration, width, options);
}

export function fitView(duration, width) {
  const safeDuration = Math.max(duration || 0, MIN_REGION_SECONDS);
  return {
    start: 0,
    pxPerSecond: width > 0 ? clamp(width / safeDuration, MIN_PX_PER_SECOND, MAX_PX_PER_SECOND) : 80,
  };
}

/** 让区间在视口中可见；返回新的视图起点（不改变缩放）。 */
export function scrollToInclude(view, startTime, endTime, width, duration, padding = 40) {
  const left = timeToX(startTime, view);
  const right = timeToX(endTime, view);
  let nextStart = view.start;
  if (left < padding) {
    nextStart = startTime - padding / view.pxPerSecond;
  } else if (right > width - padding) {
    nextStart = endTime - (width - padding) / view.pxPerSecond;
  }
  return clampView({ start: nextStart, pxPerSecond: view.pxPerSecond }, duration, width);
}

/** 缩放后取整到毫秒，避免界面显示与实际存盘出现尾差。 */
export function regionRect(region, lane, view, geometry) {
  const x = timeToX(region.start, view);
  const w = Math.max(1, (region.end - region.start) * view.pxPerSecond);
  const y = geometry.lanesTop + lane * geometry.laneStride + geometry.lanePadding;
  return { x, y, w, h: geometry.laneHeight };
}

export function secondsToSamples(seconds, sampleRate) {
  return Math.round(roundSeconds(seconds) * sampleRate);
}

/** 视口跨度（秒），用于判断缩放级别是否过大/过小。 */
export function viewSpan(view, width) {
  return width / Math.max(1e-9, view.pxPerSecond);
}
