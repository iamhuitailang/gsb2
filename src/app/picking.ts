import type { OrbitCamera } from '../webgl/renderer.js';
import { clamp } from '../math/vec3.js';
import type { Vec3 } from '../math/vec3.js';

export type DragMode = 'point' | 'target' | 'object';

export interface PointerContext {
  orbit: OrbitCamera;
  /** CSS pixel position inside the canvas. */
  px: number;
  py: number;
}

export interface DragState {
  mode: DragMode;
  /** For point/object modes. */
  index: number;
  /** World-space plane the drag happens on. */
  planeY: number;
  /** Offset from hit point to gizmo origin. */
  grabOffset: Vec3;
  startX: number;
  startY: number;
  moved: boolean;
}

export interface RayHit {
  point: Vec3;
  distance: number;
}

/** Intersect a ray with a horizontal plane (y = planeY). */
export function intersectPlaneY(origin: Vec3, dir: Vec3, planeY: number): Vec3 | null {
  if (Math.abs(dir[1]) < 1e-6) return null;
  const t = (planeY - origin[1]) / dir[1];
  if (t < 0) return null;
  return [origin[0] + dir[0] * t, planeY, origin[2] + dir[2] * t];
}

/** Ray-sphere intersection; returns the nearest positive hit. */
export function intersectSphere(origin: Vec3, dir: Vec3, center: Vec3, radius: number): RayHit | null {
  const ox = origin[0] - center[0];
  const oy = origin[1] - center[1];
  const oz = origin[2] - center[2];
  const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sqrt = Math.sqrt(disc);
  let t = -b - sqrt;
  if (t < 0) t = -b + sqrt;
  if (t < 0) return null;
  return { point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t], distance: t };
}

/** Distance from a point to a ray (used for gizmo picking). */
export function distanceToRay(origin: Vec3, dir: Vec3, point: Vec3): number {
  const vx = point[0] - origin[0];
  const vy = point[1] - origin[1];
  const vz = point[2] - origin[2];
  const t = Math.max(0, vx * dir[0] + vy * dir[1] + vz * dir[2]);
  const cx = origin[0] + dir[0] * t - point[0];
  const cy = origin[1] + dir[1] * t - point[1];
  const cz = origin[2] + dir[2] * t - point[2];
  return Math.hypot(cx, cy, cz);
}

export function clampOrbit(orbit: OrbitCamera): OrbitCamera {
  return {
    ...orbit,
    pitch: clamp(orbit.pitch, -1.45, 1.45),
    distance: clamp(orbit.distance, 3, 400),
  };
}
