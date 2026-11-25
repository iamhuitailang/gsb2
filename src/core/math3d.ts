/**
 * 通用三维数学工具 —— 不依赖 three.js，方便在 Node 下单测核心绘制逻辑。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  return len > 1e-12 ? scale(a, 1 / len) : v3();
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Möller–Trumbore 射线与三角形求交。
 * rayOrigin/rayDir 为物体局部空间，rayDir 无需归一化（归一化时 t 为距离）。
 * 命中返回沿射线的距离 t，未命中返回 null。
 */
export function rayTriangle(
  origin: Vec3,
  dir: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): number | null {
  const EPS = 1e-9;
  const edge1 = sub(b, a);
  const edge2 = sub(c, a);
  const h = cross(dir, edge2);
  const det = dot(edge1, h);
  if (Math.abs(det) < EPS) return null;
  const invDet = 1 / det;
  const s = sub(origin, a);
  const u = invDet * dot(s, h);
  if (u < 0 || u > 1) return null;
  const q = cross(s, edge1);
  const vv = invDet * dot(dir, q);
  if (vv < 0 || u + vv > 1) return null;
  const t = invDet * dot(edge2, q);
  return t > EPS ? t : null;
}

/**
 * 重心坐标（在三角形平面上对三维点 p 插值用）。
 */
export function barycentric(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const v0 = sub(b, a);
  const v1 = sub(c, a);
  const v2 = sub(p, a);
  const d00 = dot(v0, v0);
  const d01 = dot(v0, v1);
  const d11 = dot(v1, v1);
  const d20 = dot(v2, v0);
  const d21 = dot(v2, v1);
  const denom = d00 * d11 - d01 * d01;
  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  const u = 1 - v - w;
  return { x: u, y: v, z: w };
}

/** 点到线段的最近距离 */
export function pointSegmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const lenSq = dot(ab, ab);
  if (lenSq < 1e-12) return distance(p, a);
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / lenSq));
  const closest = add(a, scale(ab, t));
  return distance(p, closest);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** AABB */
export interface BBox {
  min: Vec3;
  max: Vec3;
}

export function bboxFromPositions(positions: Float32Array): BBox {
  const min = v3(Infinity, Infinity, Infinity);
  const max = v3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < positions.length; i += 3) {
    min.x = Math.min(min.x, positions[i]);
    min.y = Math.min(min.y, positions[i + 1]);
    min.z = Math.min(min.z, positions[i + 2]);
    max.x = Math.max(max.x, positions[i]);
    max.y = Math.max(max.y, positions[i + 1]);
    max.z = Math.max(max.z, positions[i + 2]);
  }
  return { min, max };
}

export function bboxCenter(box: BBox): Vec3 {
  return scale(add(box.min, box.max), 0.5);
}

export function bboxSize(box: BBox): Vec3 {
  return sub(box.max, box.min);
}
