/**
 * 纯几何工具。
 *
 * 所有标注坐标都是“图像像素坐标”：原点在图片左上角，x 向右，y 向下，
 * 取值恒在 [0, imageWidth] × [0, imageHeight] 内。该模块不依赖 DOM，
 * 可以直接在 Node 中单元测试。
 */

export const MIN_RECT_SIZE = 2;
export const HIT_TOLERANCE_PX = 7;

export function clamp(value, min, max) {
  const v = Number(value);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

export function roundTo(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function roundPoint(point, digits = 2) {
  return [roundTo(point[0], digits), roundTo(point[1], digits)];
}

/** 把点限制在图像范围内；图片边缘不会产生越界坐标。 */
export function clampPoint(point, width, height) {
  return [clamp(point?.[0], 0, width), clamp(point?.[1], 0, height)];
}

export function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function pointsBounds(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 矩形转四个角点，顺序固定为左上→右上→右下→左下。 */
export function rectToPoints(rect) {
  const { x, y, width, height } = rect;
  return [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ];
}

/** 由拖拽的起点/终点得到规范化矩形，两端都会夹到图像内。 */
export function normalizeRect(start, end, width, height) {
  const a = clampPoint(start, width, height);
  const b = clampPoint(end, width, height);
  return {
    x: roundTo(Math.min(a[0], b[0])),
    y: roundTo(Math.min(a[1], b[1])),
    width: roundTo(Math.abs(b[0] - a[0])),
    height: roundTo(Math.abs(b[1] - a[1])),
  };
}

export function clampRect(rect, width, height) {
  const x = clamp(rect.x, 0, width);
  const y = clamp(rect.y, 0, height);
  return {
    x,
    y,
    width: clamp(rect.width, 0, width - x),
    height: clamp(rect.height, 0, height - y),
  };
}

/** 把浮点坐标吸附到图像范围内的两位小数，便于序列化。 */
export function normalizePoint(point, width, height) {
  const [x, y] = clampPoint(point, width, height);
  return [roundTo(x), roundTo(y)];
}

/** 射线法判断点是否在多边形内部。 */
export function pointInPolygon(point, points) {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersect = yi > py !== yj > py
      && px < ((xj - xi) * (py - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(point, a, b) {
  const [px, py] = point;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(point, a);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function polygonEdges(points, closed = true) {
  const edges = [];
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i += 1) {
    edges.push([points[i], points[(i + 1) % points.length]]);
  }
  return edges;
}

/**
 * 命中检测。query 使用图像坐标，tolerance 是图像坐标下的容差。
 * 返回 { part: 'vertex'|'edge'|'inside', index } 或 null。
 */
export function hitTestPolygon(point, points, tolerance) {
  let best = null;
  for (let i = 0; i < points.length; i += 1) {
    const d = distance(point, points[i]);
    if (d <= tolerance && (!best || d < best.distance)) {
      best = { part: 'vertex', index: i, distance: d };
    }
  }
  if (best) return best;

  const edges = polygonEdges(points, true);
  for (let i = 0; i < edges.length; i += 1) {
    const d = distanceToSegment(point, edges[i][0], edges[i][1]);
    if (d <= tolerance && (!best || d < best.distance)) {
      best = { part: 'edge', index: i, distance: d };
    }
  }
  if (best) return best;

  if (points.length >= 3 && pointInPolygon(point, points)) {
    return { part: 'inside', index: -1, distance: 0 };
  }
  return null;
}

export function hitTestRect(point, rect, tolerance) {
  const handles = rectHandles(rect);
  let best = null;
  for (const handle of handles) {
    const d = distance(point, handle.point);
    if (d <= tolerance && (!best || d < best.distance)) {
      best = { part: 'handle', handle: handle.name, index: -1, distance: d };
    }
  }
  if (best) return best;

  const { x, y, width, height } = rect;
  if (point[0] >= x && point[0] <= x + width && point[1] >= y && point[1] <= y + height) {
    return { part: 'inside', index: -1, distance: 0 };
  }
  return null;
}

/** 8 个矩形控制点，name 使用 nw/n/ne/e/se/s/sw/w。 */
export function rectHandles(rect) {
  const { x, y, width, height } = rect;
  const cx = x + width / 2;
  const cy = y + height / 2;
  return [
    { name: 'nw', point: [x, y] },
    { name: 'n', point: [cx, y] },
    { name: 'ne', point: [x + width, y] },
    { name: 'e', point: [x + width, cy] },
    { name: 'se', point: [x + width, y + height] },
    { name: 's', point: [cx, y + height] },
    { name: 'sw', point: [x, y + height] },
    { name: 'w', point: [x, cy] },
  ];
}

export const HANDLE_CURSORS = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

/**
 * 拖动矩形控制点。point 为图像坐标，会夹到图像内并保证最小尺寸，
 * 因此任何方向拖到图像外都不会生成越界坐标。
 */
export function moveRectHandle(rect, handle, point, width, height, minSize = MIN_RECT_SIZE) {
  const p = clampPoint(point, width, height);
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;

  if (handle.includes('w')) left = Math.min(p[0], right - minSize);
  if (handle.includes('e')) right = Math.max(p[0], left + minSize);
  if (handle.includes('n')) top = Math.min(p[1], bottom - minSize);
  if (handle.includes('s')) bottom = Math.max(p[1], top + minSize);

  left = clamp(left, 0, width);
  top = clamp(top, 0, height);
  right = clamp(right, 0, width);
  bottom = clamp(bottom, 0, height);

  return {
    x: roundTo(left),
    y: roundTo(top),
    width: roundTo(Math.max(0, right - left)),
    height: roundTo(Math.max(0, bottom - top)),
  };
}

/**
 * 视图变换：屏幕坐标 ↔ 图像坐标。
 * tx/ty 是图像原点在画布内的 CSS 像素偏移，scale 是缩放倍数。
 */
export function screenToImage(screen, view) {
  return [
    (screen[0] - view.tx) / view.scale,
    (screen[1] - view.ty) / view.scale,
  ];
}

export function imageToScreen(point, view) {
  return [point[0] * view.scale + view.tx, point[1] * view.scale + view.ty];
}

/** 以某个屏幕点为锚点缩放：缩放前后该点下的图像坐标不变。 */
export function zoomViewAt(view, screenAnchor, nextScale, minScale = 0.02, maxScale = 64) {
  const scale = clamp(nextScale, minScale, maxScale);
  const imageAnchor = screenToImage(screenAnchor, view);
  return {
    scale,
    tx: screenAnchor[0] - imageAnchor[0] * scale,
    ty: screenAnchor[1] - imageAnchor[1] * scale,
  };
}

/** 适配画布尺寸，图片居中；留出少量内边距。 */
export function fitView(imageWidth, imageHeight, canvasWidth, canvasHeight, padding = 32) {
  const availableW = Math.max(1, canvasWidth - padding * 2);
  const availableH = Math.max(1, canvasHeight - padding * 2);
  const scale = Math.min(availableW / imageWidth, availableH / imageHeight);
  return {
    scale,
    tx: (canvasWidth - imageWidth * scale) / 2,
    ty: (canvasHeight - imageHeight * scale) / 2,
  };
}

/** 平移后至少保留一部分图片可见，避免“把图拖丢”。 */
export function clampView(view, imageWidth, imageHeight, canvasWidth, canvasHeight) {
  const scaledW = imageWidth * view.scale;
  const scaledH = imageHeight * view.scale;
  const marginX = Math.max(24, Math.min(canvasWidth, scaledW) * 0.25);
  const marginY = Math.max(24, Math.min(canvasHeight, scaledH) * 0.25);
  return {
    scale: view.scale,
    tx: clamp(view.tx, marginX - scaledW, canvasWidth - marginX),
    ty: clamp(view.ty, marginY - scaledH, canvasHeight - marginY),
  };
}

/** 屏幕像素容差换算成图像坐标容差。 */
export function screenTolerance(view, pixels = HIT_TOLERANCE_PX) {
  return pixels / view.scale;
}
