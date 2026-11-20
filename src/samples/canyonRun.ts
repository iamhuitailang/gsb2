import type { Project } from '../core/types.js';
import type { Vec3 } from '../math/vec3.js';
import { decorFromPath, makeObject, makeProject } from './common.js';

/**
 * Sample 1 — "峡谷弯道" (Canyon Run).
 * A fast sweeping S-curve with an elevated chicane. Tangent-following camera,
 * generous holds at the apex so the animator can inspect the composition.
 */
export function buildCanyonRun(): Project {
  const points: Vec3[] = [
    [-26, 6, 18],
    [-14, 8, 6],
    [-6, 12, -6],
    [4, 9, -14],
    [14, 13, -4],
    [22, 8, 8],
    [10, 6, 18],
    [-2, 7, 12],
  ];

  const heroes = [
    makeObject({
      id: 'hero-arch',
      name: '峡谷门架',
      shape: 'torus',
      position: [-6, 9, -7],
      rotation: [Math.PI / 2, 0, 0.2],
      scale: [5.5, 5.5, 1.1],
      color: '#f2a65a',
      roughness: 0.35,
      emissive: 0.12,
    }),
    makeObject({
      id: 'hero-monolith',
      name: '高原石碑',
      shape: 'box',
      position: [16, 7, -3],
      rotation: [0, 0.6, 0],
      scale: [2.4, 14, 2.4],
      color: '#7fb2e5',
      roughness: 0.6,
    }),
    makeObject({
      id: 'hero-pylon',
      name: '路标塔',
      shape: 'cylinder',
      position: [4, 5.5, 14],
      scale: [1.6, 11, 1.6],
      color: '#9de2a8',
      roughness: 0.5,
      emissive: 0.05,
    }),
  ];

  return makeProject({
    name: '峡谷弯道 · Canyon Run',
    points,
    closed: false,
    keys: [
      { id: 'key-1', s: 0, hold: 0.8, speed: 1.0, ease: 'easeInOut' },
      { id: 'key-2', s: 0.22, hold: 0.5, speed: 1.35, ease: 'easeIn' },
      { id: 'key-3', s: 0.47, hold: 1.4, speed: 0.8, ease: 'easeInOut' },
      { id: 'key-4', s: 0.72, hold: 0.4, speed: 1.5, ease: 'easeOut' },
      { id: 'key-5', s: 1, hold: 1.0, speed: 1.0, ease: 'easeInOut' },
    ],
    camera: { focalLengthMm: 30, sensorHeightMm: 24, near: 0.1, far: 1500 },
    aim: { mode: 'tangent', rollDeg: 0 },
    composition: { aspect: 16 / 9, showThirds: true, showActionSafe: true },
    timeline: { fps: 30, loop: false, baseSpeed: 9 },
    objects: decorFromPath(points, 1101, heroes),
  });
}
