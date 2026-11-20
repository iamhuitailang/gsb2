import type { CameraData, CompositionData, EaseKind, ObjectShape, Project, SceneObjectData, TimelineData } from './types.js';
import { EASES, SHAPES } from './types.js';
import { clamp, isFiniteVec3 } from '../math/vec3.js';
import { sortKeys } from './timeline.js';

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

function asNumber(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, min, max);
}

function asVec3(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (Array.isArray(value)) {
    const v: [number, number, number] = [
      asNumber(value[0], fallback[0]),
      asNumber(value[1], fallback[1]),
      asNumber(value[2], fallback[2]),
    ];
    return v;
  }
  return [...fallback];
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asShape(value: unknown): ObjectShape {
  return SHAPES.includes(value as ObjectShape) ? (value as ObjectShape) : 'box';
}

function asEase(value: unknown): EaseKind {
  return EASES.includes(value as EaseKind) ? (value as EaseKind) : 'linear';
}

/** Validates untrusted data (file imports) and returns a normalized project. */
export function normalizeProject(raw: unknown): Project {
  if (!raw || typeof raw !== 'object') throw new ProjectValidationError('项目数据不是对象');
  const obj = raw as Record<string, unknown>;
  const pathRaw = obj.path as Record<string, unknown> | undefined;
  if (!pathRaw || !Array.isArray(pathRaw.points)) throw new ProjectValidationError('缺少路径控制点');
  const points = (pathRaw.points as unknown[])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p, i) => ({
      id: asString(p.id, `pt-${i + 1}`),
      position: asVec3(p.position, [0, 0, 0]),
    }))
    .filter((p) => isFiniteVec3(p.position));
  if (points.length < 2) throw new ProjectValidationError('路径至少需要两个控制点');

  const cameraRaw = (obj.camera as Record<string, unknown>) || {};
  const aimRaw = (cameraRaw.aim as Record<string, unknown>) || {};
  const camera: CameraData = {
    focalLengthMm: asNumber(cameraRaw.focalLengthMm, 35, 8, 400),
    sensorHeightMm: asNumber(cameraRaw.sensorHeightMm, 24, 4, 70),
    near: asNumber(cameraRaw.near, 0.1, 0.01, 10),
    far: asNumber(cameraRaw.far, 800, 20, 20000),
    aim: {
      mode: aimRaw.mode === 'target' ? 'target' : 'tangent',
      mix: asNumber(aimRaw.mix, aimRaw.mode === 'target' ? 1 : 0, 0, 1),
      targetObjectId: typeof aimRaw.targetObjectId === 'string' ? aimRaw.targetObjectId : null,
      targetPoint: asVec3(aimRaw.targetPoint, [0, 2, 0]),
      targetOffset: asVec3(aimRaw.targetOffset, [0, 0, 0]),
      rollDeg: asNumber(aimRaw.rollDeg, 0, -180, 180),
    },
  };

  const timelineRaw = (obj.timeline as Record<string, unknown>) || {};
  const keysRaw = Array.isArray(timelineRaw.keys) ? (timelineRaw.keys as unknown[]) : [];
  const keys = keysRaw
    .filter((k): k is Record<string, unknown> => !!k && typeof k === 'object')
    .map((k, i) => ({
      id: asString(k.id, `key-${i + 1}`),
      s: asNumber(k.s, i / Math.max(1, keysRaw.length), 0, 1),
      hold: asNumber(k.hold, 0, 0, 120),
      speed: asNumber(k.speed, 1, 0.05, 20),
      ease: asEase(k.ease),
    }));
  const timeline: TimelineData = {
    fps: Math.round(asNumber(timelineRaw.fps, 30, 1, 120)),
    loop: asBool(timelineRaw.loop, true),
    baseSpeed: asNumber(timelineRaw.baseSpeed, 6, 0.1, 200),
    keys: keys.length > 0 ? sortKeys(keys) : [{ id: 'key-1', s: 0, hold: 0, speed: 1, ease: 'easeInOut' }],
  };

  const objectsRaw = Array.isArray(obj.objects) ? (obj.objects as unknown[]) : [];
  const objects: SceneObjectData[] = objectsRaw
    .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
    .map((o, i) => {
      const motionRaw = (o.motion as Record<string, unknown> | null | undefined) || null;
      const motion = motionRaw && motionRaw.kind === 'orbit'
        ? {
            kind: 'orbit' as const,
            center: asVec3(motionRaw.center, [0, 0, 0]),
            radiusX: asNumber(motionRaw.radiusX, 4, 0.1, 200),
            radiusZ: asNumber(motionRaw.radiusZ, 4, 0.1, 200),
            height: asNumber(motionRaw.height, 2, -50, 100),
            speed: asNumber(motionRaw.speed, 0.3, -5, 5),
            phase: asNumber(motionRaw.phase, 0, -Math.PI * 4, Math.PI * 4),
            bob: asNumber(motionRaw.bob, 0, 0, 20),
          }
        : null;
      return {
        id: asString(o.id, `obj-${i + 1}`),
        name: asString(o.name, `Object ${i + 1}`),
        shape: asShape(o.shape),
        position: asVec3(o.position, [0, 1, 0]),
        rotation: asVec3(o.rotation, [0, 0, 0]),
        scale: asVec3(o.scale, [1, 1, 1]),
        color: asString(o.color, '#8fa6c4'),
        roughness: asNumber(o.roughness, 0.6, 0, 1),
        emissive: asNumber(o.emissive, 0, 0, 2),
        role: o.role === 'target' ? 'target' : 'decor',
        motion,
      };
    });

  const compRaw = (obj.composition as Record<string, unknown>) || {};
  const composition: CompositionData = {
    aspect: asNumber(compRaw.aspect, 16 / 9, 0.5, 3),
    showThirds: asBool(compRaw.showThirds, true),
    showCenter: asBool(compRaw.showCenter, true),
    showActionSafe: asBool(compRaw.showActionSafe, true),
    showTitleSafe: asBool(compRaw.showTitleSafe, false),
    actionSafePct: asNumber(compRaw.actionSafePct, 90, 50, 100),
    titleSafePct: asNumber(compRaw.titleSafePct, 80, 30, 100),
  };

  return {
    version: 1,
    name: asString(obj.name, '未命名镜头'),
    path: { closed: asBool(pathRaw.closed, false), points },
    camera,
    timeline,
    objects,
    composition,
  };
}

export function cloneProject(project: Project): Project {
  return structuredClone(project);
}
