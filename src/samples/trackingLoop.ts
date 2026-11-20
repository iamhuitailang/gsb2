import type { Project } from '../core/types.js';
import type { Vec3 } from '../math/vec3.js';
import { decorFromPath, makeObject, makeProject } from './common.js';

/**
 * Sample 3 — "追焦环线" (Tracking Loop).
 * The first half follows the path tangent, the second half keeps a moving
 * target framed. The target is an orbiting emissive beacon, so the aim mix
 * between tangent and target is visible in both modes.
 */
export function buildTrackingLoop(): Project {
  const points: Vec3[] = [
    [-30, 7, 4],
    [-22, 9, -18],
    [-2, 12, -26],
    [18, 8, -18],
    [30, 6, 2],
    [20, 9, 20],
    [0, 11, 26],
    [-20, 8, 18],
  ];

  const target = makeObject({
    id: 'target-drone',
    name: '移动目标 · Drone',
    shape: 'octahedron',
    position: [0, 9, 0],
    scale: [2.2, 2.2, 2.2],
    color: '#ff8f6b',
    roughness: 0.2,
    emissive: 1.2,
    role: 'target',
    motion: {
      kind: 'orbit',
      center: [0, 0, 0],
      radiusX: 9,
      radiusZ: 7,
      height: 9,
      speed: 0.55,
      phase: 0,
      bob: 1.6,
    },
  });

  const beacons = [0, 1, 2, 3, 4, 5].map((i) => {
    const a = (i / 6) * Math.PI * 2;
    return makeObject({
      id: `beacon-${i + 1}`,
      name: `信标 ${i + 1}`,
      shape: 'cone' as const,
      position: [Math.cos(a) * 22, 3.5, Math.sin(a) * 22] as Vec3,
      scale: [1.5, 7, 1.5] as Vec3,
      color: '#8fd6d0',
      roughness: 0.4,
      emissive: 0.15,
    });
  });

  return makeProject({
    name: '追焦环线 · Tracking Loop',
    points,
    closed: true,
    keys: [
      { id: 'key-1', s: 0, hold: 1.2, speed: 1.0, ease: 'easeInOut' },
      { id: 'key-2', s: 0.2, hold: 0.8, speed: 1.2, ease: 'easeInOut' },
      { id: 'key-3', s: 0.42, hold: 2.0, speed: 0.7, ease: 'easeInOut' },
      { id: 'key-4', s: 0.64, hold: 0.6, speed: 1.4, ease: 'easeOut' },
      { id: 'key-5', s: 0.84, hold: 1.8, speed: 0.9, ease: 'easeIn' },
    ],
    camera: { focalLengthMm: 40, sensorHeightMm: 24, near: 0.1, far: 2000 },
    aim: {
      mode: 'target',
      targetObjectId: 'target-drone',
      targetOffset: [0, 0.6, 0],
      rollDeg: 0,
    },
    composition: { aspect: 16 / 9, showThirds: true, showActionSafe: true },
    timeline: { fps: 30, loop: true, baseSpeed: 8 },
    objects: decorFromPath(points, 3303, [target, ...beacons]),
  });
}
