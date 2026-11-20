import type { Vec3 } from '../math/vec3.js';
import { add, normalize, scale } from '../math/vec3.js';

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface LayoutObject {
  id: string;
  shape: 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'octahedron';
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  color: string;
  roughness: number;
  emissive: number;
  role: 'decor' | 'target';
  motion: null | {
    kind: 'orbit';
    center: Vec3;
    radiusX: number;
    radiusZ: number;
    height: number;
    speed: number;
    phase: number;
    bob: number;
  };
}

const PALETTE = ['#f2a65a', '#7fb2e5', '#9de2a8', '#e58aa0', '#c9a7f0', '#f0d78a', '#8fd6d0'];

function pointOnCircle(center: Vec3, radius: number, angle: number, height: number): Vec3 {
  return [center[0] + Math.cos(angle) * radius, height, center[2] + Math.sin(angle) * radius];
}

/**
 * Generates a deterministic set of geometry primitives around the camera path
 * so the sample scene always looks the same after reload.
 */
export function generateSceneForPath(positions: Vec3[], seed = 1337, density = 1): LayoutObject[] {
  const rng = mulberry32(seed);
  const objects: LayoutObject[] = [];
  if (positions.length === 0) return objects;

  const cx = positions.reduce((a, p) => a + p[0], 0) / positions.length;
  const cz = positions.reduce((a, p) => a + p[2], 0) / positions.length;
  const center: Vec3 = [cx, 0, cz];

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of positions) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
  }
  const span = Math.max(maxX - minX, maxZ - minZ, 10);
  const radius = span * 0.78;

  // Ground ring of blocks (city-like skyline) around the path.
  const total = Math.round(26 * density);
  for (let i = 0; i < total; i++) {
    const angle = (i / total) * Math.PI * 2 + rng() * 0.08;
    const jitter = 0.82 + rng() * 0.42;
    const p = pointOnCircle(center, radius * jitter, angle, 0);
    const w = 0.8 + rng() * 2.2;
    const h = 1.2 + rng() * 7.5;
    const d = 0.8 + rng() * 2.2;
    objects.push({
      id: `skyline-${i + 1}`,
      shape: rng() > 0.85 ? 'cylinder' : 'box',
      position: [p[0], h / 2, p[2]],
      rotation: [0, rng() * Math.PI * 2, 0],
      scale: [w, h, d],
      color: PALETTE[i % PALETTE.length],
      roughness: 0.75,
      emissive: 0.04,
      role: 'decor',
      motion: null,
    });
  }

  // Pillars just inside the curve; they give parallax and speed cues.
  const inner = Math.round(14 * density);
  for (let i = 0; i < inner; i++) {
    const angle = (i / inner) * Math.PI * 2 + 0.4;
    const p = pointOnCircle(center, radius * (0.38 + rng() * 0.18), angle, 0);
    const h = 2 + rng() * 6;
    objects.push({
      id: `pillar-${i + 1}`,
      shape: rng() > 0.6 ? 'octahedron' : 'cylinder',
      position: [p[0], h / 2, p[2]],
      rotation: [0, rng() * 6.28, 0],
      scale: [0.7 + rng() * 0.7, h, 0.7 + rng() * 0.7],
      color: PALETTE[(i + 3) % PALETTE.length],
      roughness: 0.5,
      emissive: 0.08,
      role: 'decor',
      motion: null,
    });
  }

  // Floating markers hovering above the path to read vertical motion.
  const floaters = Math.round(10 * density);
  for (let i = 0; i < floaters; i++) {
    const angle = (i / floaters) * Math.PI * 2 + 1.1;
    const rad = radius * (0.5 + rng() * 0.3);
    objects.push({
      id: `floater-${i + 1}`,
      shape: rng() > 0.5 ? 'torus' : 'octahedron',
      position: [cx + Math.cos(angle) * rad, 4 + rng() * 9, cz + Math.sin(angle) * rad],
      rotation: [rng() * 3, rng() * 3, rng() * 3],
      scale: [0.55, 0.55, 0.55].map((v) => v * (0.7 + rng() * 0.8)) as Vec3,
      color: '#ffffff',
      roughness: 0.25,
      emissive: 0.35,
      role: 'decor',
      motion: null,
    });
  }

  return objects;
}

/** Center + extents used by the orbit camera framing. */
export function pathFocus(positions: Vec3[]): { center: Vec3; radius: number } {
  if (positions.length === 0) return { center: [0, 0, 0], radius: 20 };
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of positions) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i]);
      max[i] = Math.max(max[i], p[i]);
    }
  }
  const center = scale(add(min, max), 0.5);
  const radius = Math.max(8, 0.6 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
  return { center, radius };
}

export function direction3(from: Vec3, to: Vec3): Vec3 {
  return normalize([to[0] - from[0], to[1] - from[1], to[2] - from[2]]);
}
