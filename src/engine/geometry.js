// 纯几何：圆 / 矩形 / 简单多边形的包含判定与线段穿越判定。
// 坐标均为世界坐标，单位 px；时间单位 ms。
// 边界采用“闭区间”约定：点恰落在边上算在区内（EPS 容差）。

export const EPS = 1e-9;

function sqr(x) {
  return x * x;
}

function dist2(a, b) {
  return sqr(a.x - b.x) + sqr(a.y - b.y);
}

// 点 P 到线段 AB 的最短距离平方
export function pointSegmentDist2(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return dist2(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist2(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function pointInCircle(p, z) {
  return dist2(p, z.center) <= sqr(z.radius) + EPS;
}

function pointInRect(p, z) {
  return (
    p.x >= z.rect.x - EPS &&
    p.x <= z.rect.x + z.rect.w + EPS &&
    p.y >= z.rect.y - EPS &&
    p.y <= z.rect.y + z.rect.h + EPS
  );
}

// 射线法；边上点由 EPS 容差兜底，约定边界属于内部
function pointInPolygon(p, z) {
  const pts = z.points;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j];
    const b = pts[i];
    const intersect =
      b.y > p.y !== a.y > p.y &&
      p.x < ((a.x - b.x) * (p.y - b.y)) / (a.y - b.y) + b.x;
    if (intersect) inside = !inside;
    if (pointSegmentDist2(p, a, b) <= EPS) return true; // 边上
  }
  return inside;
}

export function pointInZone(p, zone) {
  if (zone.shape === 'circle') return pointInCircle(p, zone);
  if (zone.shape === 'rect') return pointInRect(p, zone);
  if (zone.shape === 'polygon') return pointInPolygon(p, zone);
  throw new Error(`未知区域形状: ${zone.shape}`);
}

// 线段 AB 与圆相交（含相切、端点在圆上）
function segmentIntersectsCircle(a, b, z) {
  const c = z.center;
  if (pointInCircle(a, z) || pointInCircle(b, z)) return true;
  return pointSegmentDist2(c, a, b) <= sqr(z.radius) + EPS;
}

// 线段与轴对齐矩形相交：任一端点在内，或与四条边之一相交
function segmentIntersectsRect(a, b, z) {
  if (pointInRect(a, z) || pointInRect(b, z)) return true;
  const { x, y, w, h } = z.rect;
  const corners = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  for (let i = 0; i < 4; i++) {
    if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

// 两线段相交（含共线重叠与端点相接）
export function segmentsIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < EPS) {
    // 平行：共线时检查端点落在线段上
    if (pointSegmentDist2(p3, p1, p2) <= EPS || pointSegmentDist2(p4, p1, p2) <= EPS) {
      return (
        pointSegmentDist2(p3, p1, p2) <= EPS ||
        pointSegmentDist2(p4, p1, p2) <= EPS ||
        pointSegmentDist2(p1, p3, p4) <= EPS
      );
    }
    return false;
  }
  const u = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const v = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return u >= -EPS && u <= 1 + EPS && v >= -EPS && v <= 1 + EPS;
}

function segmentIntersectsPolygon(a, b, z) {
  const pts = z.points;
  if (pointInPolygon(a, z) || pointInPolygon(b, z)) return true;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if (segmentsIntersect(a, b, pts[j], pts[i])) return true;
  }
  return false;
}

export function segmentIntersectsZone(a, b, zone) {
  if (zone.shape === 'circle') return segmentIntersectsCircle(a, b, zone);
  if (zone.shape === 'rect') return segmentIntersectsRect(a, b, zone);
  if (zone.shape === 'polygon') return segmentIntersectsPolygon(a, b, zone);
  throw new Error(`未知区域形状: ${zone.shape}`);
}

// 沿 A->B 按固定步长采样（含两端），用于高速穿越的逐点判定
export function sampleSegment(a, b, stepPx) {
  const d = Math.sqrt(dist2(a, b));
  const n = Math.max(1, Math.ceil(d / stepPx));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return pts;
}
