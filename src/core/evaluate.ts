import type { CameraSample, Evaluation, Project } from './types.js';
import type { PathSpline } from './curve.js';
import type { Timeline } from './timeline.js';
import { findTarget } from './motion.js';
import { targetOrientation, frameFieldFor, rollOrientation } from './frames.js';
import { fovFromFocal } from './camera.js';
import { clamp, normalize } from '../math/vec3.js';
import type { Vec3 } from '../math/vec3.js';
import type { Quat } from '../math/quat.js';
import { quatSlerp, quatNormalize } from '../math/quat.js';

export interface EvaluationContext {
  project: Project;
  spline: PathSpline;
  timeline: Timeline;
}

function smoothstep(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Pure, deterministic evaluation of the full camera pose at a given time.
 *
 * - Position comes from the arc-length-parameterized spline.
 * - Orientation comes from a parallel-transported frame field (flip-free even
 *   for vertical tangents), blended with a look-at-target orientation using a
 *   quaternion slerp.
 * - FOV comes from the focal length and frame aspect.
 *
 * Nothing here depends on playback order, so scrubbing always reproduces the
 * exact same pose.
 */
export function evaluateCamera(
  ctx: EvaluationContext,
  time: number,
  opts: { aimMix?: number } = {},
): Evaluation {
  const { project, spline, timeline } = ctx;
  const state = timeline.evaluate(time);
  const sample = spline.sampleAt(state.s);
  const field = frameFieldFor(spline);

  const rollRad = (project.camera.aim.rollDeg * Math.PI) / 180;
  // Roll is applied to the transported base frame first, so both aim modes and
  // the blend between them share the same up direction.
  const baseQuat = rollOrientation(field.quaternionAt(state.s), rollRad);
  const mix = clamp(opts.aimMix ?? (project.camera.aim.mode === 'target' ? 1 : 0), 0, 1);

  let rotation: Quat = baseQuat;
  let target: Vec3 | null = null;

  if (mix > 0) {
    target = findTarget(project, state.time);
    if (target) {
      const lookQuat = targetOrientation(baseQuat, sample.position, target);
      if (lookQuat) {
        const m = smoothstep(mix);
        rotation = m <= 1e-6 ? baseQuat : m >= 1 - 1e-6 ? lookQuat : quatSlerp(baseQuat, lookQuat, m);
      }
    }
  }

  const { fovY, fovX } = fovFromFocal(
    project.camera.focalLengthMm,
    project.camera.sensorHeightMm,
    project.composition.aspect,
  );

  return {
    time: state.time,
    s: state.s,
    position: sample.position,
    rotation: quatNormalize(rotation),
    fovY,
    fovX,
    focalLengthMm: project.camera.focalLengthMm,
    target,
    keyIndex: state.keyIndex,
    segmentIndex: state.segmentIndex,
    phase: state.phase,
    aimMix: mix,
    tangent: normalize(sample.tangent, [0, 0, 1]),
  };
}

/** Same as evaluateCamera but ignores any UI preview blending. */
export function evaluateStatic(ctx: EvaluationContext, time: number): Evaluation {
  return evaluateCamera(ctx, time, { aimMix: ctx.project.camera.aim.mode === 'target' ? 1 : 0 });
}

export interface FrameRange {
  fps: number;
  frameCount: number;
  duration: number;
}

export function frameRange(project: Project, duration: number): FrameRange {
  const fps = project.timeline.fps;
  const frameCount = Math.max(1, Math.round(duration * fps));
  return { fps, frameCount, duration };
}

function round(n: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function roundVec(v: Vec3, digits = 4): Vec3 {
  return [round(v[0], digits), round(v[1], digits), round(v[2], digits)];
}

/** Builds a plain JSON payload games can consume directly. */
export function buildCameraSamples(
  ctx: EvaluationContext,
  opts: { fps?: number; aimMix?: number } = {},
): CameraSample[] {
  const fps = Math.max(1, Math.round(opts.fps ?? ctx.project.timeline.fps));
  const duration = ctx.timeline.duration;
  const frameCount = Math.max(0, Math.round(duration * fps));
  const samples: CameraSample[] = [];
  for (let frame = 0; frame <= frameCount; frame++) {
    const t = frameCount === 0 ? 0 : Math.min(duration, frame / fps);
    const ev = evaluateCamera(ctx, t, {
      aimMix: opts.aimMix ?? (ctx.project.camera.aim.mode === 'target' ? 1 : 0),
    });
    const rotation = quatNormalize(ev.rotation);
    const roundedRotation: [number, number, number, number] = [
      round(rotation[0], 6),
      round(rotation[1], 6),
      round(rotation[2], 6),
      round(rotation[3], 6),
    ];
    samples.push({
      frame,
      t: round(t, 4),
      s: round(ev.s, 6),
      position: roundVec(ev.position),
      rotation: roundedRotation,
      fovY: round(ev.fovY, 6),
      fovX: round(ev.fovX, 6),
      focalLengthMm: round(ev.focalLengthMm, 3),
      target: ev.target ? roundVec(ev.target) : null,
    });
  }
  return samples;
}

export interface ExportPayload {
  format: 'camera-path-samples';
  formatVersion: 1;
  name: string;
  fps: number;
  duration: number;
  frameCount: number;
  aspect: number;
  pathClosed: boolean;
  coordinateSystem: {
    up: '+Y';
    forward: '+Z';
    handedness: 'right';
    rotationFormat: 'quaternion-xyzw';
  };
  camera: {
    focalLengthMm: number;
    sensorHeightMm: number;
    near: number;
    far: number;
  };
  samples: CameraSample[];
}

export function buildExportPayload(ctx: EvaluationContext, name?: string): ExportPayload {
  const samples = buildCameraSamples(ctx);
  return {
    format: 'camera-path-samples',
    formatVersion: 1,
    name: name ?? ctx.project.name,
    fps: ctx.project.timeline.fps,
    duration: round(ctx.timeline.duration, 4),
    frameCount: samples.length > 0 ? samples[samples.length - 1].frame : 0,
    aspect: round(ctx.project.composition.aspect, 4),
    pathClosed: ctx.project.path.closed,
    coordinateSystem: {
      up: '+Y',
      forward: '+Z',
      handedness: 'right',
      rotationFormat: 'quaternion-xyzw',
    },
    camera: {
      focalLengthMm: ctx.project.camera.focalLengthMm,
      sensorHeightMm: ctx.project.camera.sensorHeightMm,
      near: ctx.project.camera.near,
      far: ctx.project.camera.far,
    },
    samples,
  };
}

/** Composition guides in normalized frame coordinates (0..1, origin top-left). */
export interface GuideRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: 'action' | 'title';
}

export function safeAreaRect(pct: number): { x0: number; y0: number; x1: number; y1: number } {
  const half = clamp(pct, 1, 100) / 200;
  return { x0: 0.5 - half, y0: 0.5 - half, x1: 0.5 + half, y1: 0.5 + half };
}

export function compositionGuides(comp: {
  showActionSafe: boolean;
  showTitleSafe: boolean;
  actionSafePct: number;
  titleSafePct: number;
}): GuideRect[] {
  const out: GuideRect[] = [];
  if (comp.showActionSafe) out.push({ ...safeAreaRect(comp.actionSafePct), kind: 'action' });
  if (comp.showTitleSafe) out.push({ ...safeAreaRect(comp.titleSafePct), kind: 'title' });
  return out;
}

export function aspectToCss(aspect: number): string {
  return `${aspect} / 1`;
}

export { round, roundVec };
