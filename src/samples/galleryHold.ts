import type { Project } from '../core/types.js';
import type { Vec3 } from '../math/vec3.js';
import { decorFromPath, makeObject, makeProject } from './common.js';

/**
 * Sample 2 — "停留长廊" (Gallery Hold).
 * A closed loop through a colonnade with four long dwells and strong speed
 * changes between them, so the timeline's holds/speed lanes are easy to read.
 */
export function buildGalleryHold(): Project {
  const points: Vec3[] = [
    [-22, 4.5, -22],
    [-2, 5.5, -26],
    [20, 4.5, -18],
    [26, 6.5, 2],
    [12, 5, 20],
    [-8, 6.5, 24],
    [-24, 5, 8],
  ];

  const cols: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    cols.push([Math.cos(a) * 11, 6, Math.sin(a) * 11]);
  }

  const heroes = cols.map((p, i) =>
    makeObject({
      id: `colonnade-${i + 1}`,
      name: `廊柱 ${i + 1}`,
      shape: 'cylinder',
      position: p,
      scale: [1.2, 12, 1.2],
      color: i % 2 === 0 ? '#e8e2d4' : '#cfc6b4',
      roughness: 0.85,
    }),
  );

  heroes.push(
    makeObject({
      id: 'hero-ledger',
      name: '主展台',
      shape: 'octahedron',
      position: [0, 4.2, 0],
      rotation: [0, 0.5, 0],
      scale: [3.2, 3.2, 3.2],
      color: '#f2a65a',
      roughness: 0.2,
      emissive: 0.35,
    }),
    makeObject({
      id: 'hero-banner',
      name: '垂挂展旗',
      shape: 'box',
      position: [-14, 8, 14],
      rotation: [0, -0.7, 0],
      scale: [0.4, 9, 4],
      color: '#7fb2e5',
      roughness: 0.7,
    }),
  );

  return makeProject({
    name: '停留长廊 · Gallery Hold',
    points,
    closed: true,
    keys: [
      { id: 'key-1', s: 0, hold: 2.2, speed: 1.0, ease: 'easeInOut' },
      { id: 'key-2', s: 0.25, hold: 1.6, speed: 0.55, ease: 'linear' },
      { id: 'key-3', s: 0.5, hold: 2.8, speed: 1.8, ease: 'easeIn' },
      { id: 'key-4', s: 0.75, hold: 1.2, speed: 0.9, ease: 'easeOut' },
    ],
    camera: { focalLengthMm: 50, sensorHeightMm: 24, near: 0.1, far: 1200 },
    aim: { mode: 'tangent', rollDeg: 0 },
    composition: { aspect: 2.39, showThirds: true, showActionSafe: true, showTitleSafe: true },
    timeline: { fps: 24, loop: true, baseSpeed: 6 },
    objects: decorFromPath(points, 2202, heroes),
  });
}
