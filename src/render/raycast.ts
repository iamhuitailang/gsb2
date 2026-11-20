import type { TerrainModel } from "../core/TerrainModel";
import type { Vec3 } from "../core/math";

/**
 * 射线与合成高度场求交。
 *
 * 做法：先与覆盖地形范围的竖直包围盒求交得到参数区间 [t0,t1]，
 * 再沿射线按“半格”步长行进，用双线性采样的高度场与射线高度比较，
 * 发现穿越后二分若干次收敛到交点。这样无论相机如何缩放/旋转，
 * 笔刷圆心始终落在当前模型表面的真实位置上。
 */
export interface RayHit {
  point: Vec3;
  gridX: number;
  gridZ: number;
}

export function raycastTerrain(
  model: TerrainModel,
  origin: Vec3,
  dir: Vec3
): RayHit | null {
  const half = model.worldSize / 2;
  // 估计高度范围，给竖直方向留出充足余量
  let hMin = Infinity;
  let hMax = -Infinity;
  const h = model.compositeHeights;
  const stride = Math.max(1, Math.floor(h.length / 4096));
  for (let i = 0; i < h.length; i += stride) {
    if (h[i] < hMin) hMin = h[i];
    if (h[i] > hMax) hMax = h[i];
  }
  hMin = Math.min(hMin, 0) - 50;
  hMax = Math.max(hMax, 0) + 50;

  // 与 AABB 求交（slab 法）
  let t0 = 0;
  let t1 = Infinity;
  const bounds: Array<[number, number, number]> = [
    [origin[0], dir[0], half],
    [origin[1], dir[1], 0],
    [origin[2], dir[2], half],
  ];
  for (const [o, d, center] of bounds) {
    const lo = center === 0 ? hMin : -half;
    const hi = center === 0 ? hMax : half;
    if (Math.abs(d) < 1e-8) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let ta = (lo - o) / d;
    let tb = (hi - o) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }

  const stepLen = model.spacing * 0.45;
  const segLen = (dir[0] ** 2 + dir[2] ** 2) * stepLen * stepLen;
  const dt = segLen > 1e-12 ? stepLen / Math.hypot(dir[0], dir[2]) : stepLen;

  const pointAt = (t: number): Vec3 => [
    origin[0] + dir[0] * t,
    origin[1] + dir[1] * t,
    origin[2] + dir[2] * t,
  ];

  let prevT = t0;
  let prev = pointAt(t0);
  let prevDelta = prev[1] - model.sampleHeightWorld(prev[0], prev[2]);

  for (let t = t0 + dt; t <= t1 + dt; t += dt) {
    const tc = Math.min(t, t1);
    const p = pointAt(tc);
    const inside =
      Math.abs(p[0]) <= half + model.spacing &&
      Math.abs(p[2]) <= half + model.spacing;
    if (!inside) {
      prevT = tc;
      prev = p;
      prevDelta = p[1] - model.sampleHeightWorld(p[0], p[2]);
      continue;
    }
    const delta = p[1] - model.sampleHeightWorld(p[0], p[2]);
    if (prevDelta > 0 && delta <= 0) {
      // 二分收敛
      let lo = prevT;
      let hi = tc;
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        const mp = pointAt(mid);
        const md = mp[1] - model.sampleHeightWorld(mp[0], mp[2]);
        if (md > 0) lo = mid;
        else hi = mid;
      }
      const hit = pointAt((lo + hi) / 2);
      const [gx, gz] = model.worldToGrid(hit[0], hit[2]);
      return { point: hit, gridX: gx, gridZ: gz };
    }
    prevT = tc;
    prev = p;
    prevDelta = delta;
  }
  return null;
}
