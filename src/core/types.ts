import type { Vec3 } from '../math/vec3.js';

export type { Vec3 };

export type AimMode = 'tangent' | 'target';
export type EaseKind = 'linear' | 'easeInOut' | 'easeIn' | 'easeOut';
export type ObjectShape = 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'octahedron';
export type ObjectRole = 'decor' | 'target';

export interface ControlPoint {
  id: string;
  position: Vec3;
}

export interface PathData {
  closed: boolean;
  points: ControlPoint[];
}

export interface OrbitMotion {
  kind: 'orbit';
  center: Vec3;
  radiusX: number;
  radiusZ: number;
  height: number;
  /** Radians per second. */
  speed: number;
  /** Radians. */
  phase: number;
  /** Vertical bob amplitude in world units. */
  bob: number;
}

export interface SceneObjectData {
  id: string;
  name: string;
  shape: ObjectShape;
  position: Vec3;
  /** Euler angles in degrees, applied X then Y then Z. */
  rotation: Vec3;
  scale: Vec3;
  /** sRGB hex color, e.g. #ffb454. */
  color: string;
  roughness: number;
  emissive: number;
  role: ObjectRole;
  motion: OrbitMotion | null;
}

export interface TimelineKey {
  id: string;
  /** Normalized position along the path, 0..1. */
  s: number;
  /** Seconds the camera rests at this key before departing. */
  hold: number;
  /** Speed multiplier for the outgoing segment (1 = project base speed). */
  speed: number;
  ease: EaseKind;
}

export interface TimelineData {
  fps: number;
  loop: boolean;
  /** World units per second at speed 1. */
  baseSpeed: number;
  keys: TimelineKey[];
}

export interface AimData {
  mode: AimMode;
  /** 0 = follow path tangent, 1 = follow target. Animated when modes switch. */
  mix: number;
  targetObjectId: string | null;
  targetPoint: Vec3;
  targetOffset: Vec3;
  rollDeg: number;
}

export interface CameraData {
  focalLengthMm: number;
  sensorHeightMm: number;
  near: number;
  far: number;
  aim: AimData;
}

export interface CompositionData {
  aspect: number;
  showThirds: boolean;
  showCenter: boolean;
  showActionSafe: boolean;
  showTitleSafe: boolean;
  actionSafePct: number;
  titleSafePct: number;
}

export interface Project {
  version: 1;
  name: string;
  path: PathData;
  camera: CameraData;
  timeline: TimelineData;
  objects: SceneObjectData[];
  composition: CompositionData;
}

export interface ProjectFile {
  format: 'camera-path-editor-project';
  formatVersion: 1;
  savedAt: string;
  project: Project;
}

export interface CameraSample {
  frame: number;
  t: number;
  s: number;
  position: Vec3;
  /** Quaternion [x, y, z, w]; local +X right, +Y up, +Z forward. */
  rotation: [number, number, number, number];
  fovY: number;
  fovX: number;
  focalLengthMm: number;
  target: Vec3 | null;
}

export interface Evaluation {
  time: number;
  s: number;
  position: Vec3;
  rotation: [number, number, number, number];
  fovY: number;
  fovX: number;
  focalLengthMm: number;
  target: Vec3 | null;
  keyIndex: number;
  segmentIndex: number;
  phase: 'hold' | 'travel' | 'end';
  aimMix: number;
  tangent: Vec3;
}

export const SHAPES: ObjectShape[] = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'octahedron'];
export const EASES: EaseKind[] = ['linear', 'easeInOut', 'easeIn', 'easeOut'];
