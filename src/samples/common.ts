import type {
  CameraData,
  CompositionData,
  Project,
  SceneObjectData,
  TimelineData,
} from '../core/types.js';
import type { Vec3 } from '../math/vec3.js';
import { generateSceneForPath } from '../core/layout.js';

export const DEFAULT_CAMERA: CameraData = {
  focalLengthMm: 35,
  sensorHeightMm: 24,
  near: 0.1,
  far: 1200,
  aim: {
    mode: 'tangent',
    mix: 0,
    targetObjectId: null,
    targetPoint: [0, 2, 0],
    targetOffset: [0, 0, 0],
    rollDeg: 0,
  },
};

export const DEFAULT_COMPOSITION: CompositionData = {
  aspect: 16 / 9,
  showThirds: true,
  showCenter: true,
  showActionSafe: true,
  showTitleSafe: false,
  actionSafePct: 90,
  titleSafePct: 80,
};

export interface SampleObjectSpec {
  id: string;
  name: string;
  shape: SceneObjectData['shape'];
  position: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  color: string;
  roughness?: number;
  emissive?: number;
  role?: SceneObjectData['role'];
  motion?: SceneObjectData['motion'];
}

export function makeObject(spec: SampleObjectSpec): SceneObjectData {
  return {
    id: spec.id,
    name: spec.name,
    shape: spec.shape,
    position: spec.position,
    rotation: spec.rotation ?? [0, 0, 0],
    scale: spec.scale ?? [1, 1, 1],
    color: spec.color,
    roughness: spec.roughness ?? 0.6,
    emissive: spec.emissive ?? 0,
    role: spec.role ?? 'decor',
    motion: spec.motion ?? null,
  };
}

export function decorFromPath(points: Vec3[], seed: number, heroes: SceneObjectData[]): SceneObjectData[] {
  const generated = generateSceneForPath(points, seed, 1).map((o) => ({
    ...o,
    name: o.role === 'target' ? 'Target' : 'Decor',
  })) as SceneObjectData[];
  return [...heroes, ...generated];
}

export function makeProject(args: {
  name: string;
  points: Vec3[];
  closed: boolean;
  keys: TimelineData['keys'];
  camera?: Partial<CameraData>;
  aim?: Partial<CameraData['aim']>;
  composition?: Partial<CompositionData>;
  timeline?: Partial<TimelineData>;
  objects: SceneObjectData[];
}): Project {
  return {
    version: 1,
    name: args.name,
    path: {
      closed: args.closed,
      points: args.points.map((position, i) => ({ id: `pt-${i + 1}`, position })),
    },
    camera: {
      ...DEFAULT_CAMERA,
      ...args.camera,
      aim: { ...DEFAULT_CAMERA.aim, ...args.aim },
    },
    timeline: {
      fps: 30,
      loop: args.closed,
      baseSpeed: 6,
      keys: args.keys,
      ...args.timeline,
    },
    objects: args.objects,
    composition: { ...DEFAULT_COMPOSITION, ...args.composition },
  };
}
