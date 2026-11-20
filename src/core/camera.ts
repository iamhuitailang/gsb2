import type { AimMode } from './types.js';
import type { Vec3 } from '../math/vec3.js';
import { dot, normalize, sub, length, clamp } from '../math/vec3.js';
import type { Quat } from '../math/quat.js';
import {
  quatFromTwoVectors,
  quatFromAxisAngle,
  quatMultiply,
  quatSlerp,
  quatNormalize,
  quatRotateVec,
  quatToEulerDegrees,
} from '../math/quat.js';

const WORLD_UP: Vec3 = [0, 1, 0];
const LOCAL_FORWARD: Vec3 = [0, 0, 1];
const DEG = Math.PI / 180;

/** Quaternion that rotates local axes onto the given basis (right, up, forward). */
export function quatFromBasis(right: Vec3, up: Vec3, forward: Vec3): Quat {
  // Rotation matrix columns: right, up, forward.
  const m00 = right[0], m10 = right[1], m20 = right[2];
  const m01 = up[0], m11 = up[1], m21 = up[2];
  const m02 = forward[0], m12 = forward[1], m22 = forward[2];
  const trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return quatNormalize([x, y, z, w]);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function mixScalar(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Up hint derived from a camera quaternion (world-up projected through the
 * camera's local +Y). Used for diagnostics only; the actual path orientation
 * comes from the parallel-transported frame field.
 */
export function stabilizedUp(forward: Vec3): Vec3 {
  const q = orientationFromForward(forward, 0);
  return quatRotateVec(q, WORLD_UP) as Vec3;
}

/**
 * Minimal-rotation orientation that points local +Z along `forward`.
 *
 * The rotation from a fixed base (+Z) is continuous everywhere except exactly
 * backwards, so paths that pass through the vertical never cause a roll flip.
 * This is used as the seed for the parallel-transported frame field and by the
 * aim-blending helpers.
 */
export function orientationFromForward(forward: Vec3, rollRad: number): Quat {
  const f = normalize(forward, LOCAL_FORWARD);
  const align = quatFromTwoVectors(LOCAL_FORWARD, f);
  if (Math.abs(rollRad) < 1e-9) return align;
  return quatNormalize(quatMultiply(align, quatFromAxisAngle(LOCAL_FORWARD, rollRad)));
}

/** Forward direction implied by a camera rotation quaternion (local +Z). */
export function forwardFromQuat(q: Quat): Vec3 {
  return quatRotateVec(q, LOCAL_FORWARD) as Vec3;
}

export function rollOfQuat(q: Quat): number {
  const right = quatRotateVec(q, [1, 0, 0]);
  const up = quatRotateVec(q, [0, 1, 0]);
  return Math.atan2(dot(right, WORLD_UP), dot(up, WORLD_UP));
}

export interface AimInput {
  position: Vec3;
  tangent: Vec3;
  targetPosition: Vec3 | null;
  rollDeg: number;
}

export interface AimFrame {
  /** Blended orientation. */
  quaternion: Quat;
  /** Pure follow-target orientation (for previews). */
  targetQuaternion: Quat | null;
  tangentQuaternion: Quat;
  /** Point the camera is looking at, if any. */
  lookAt: Vec3 | null;
}

/**
 * Blends a tangent-following orientation towards a target-following one.
 * Slerp takes the shortest arc, so a mode switch never causes a flip.
 * `mix` is 0 (tangent) .. 1 (target); intermediate values interpolate.
 */
export function blendAim(input: AimInput, mix: number): AimFrame {
  const roll = input.rollDeg * DEG;
  const tangentQuat = orientationFromForward(input.tangent, roll);

  if (!input.targetPosition) {
    return { quaternion: tangentQuat, targetQuaternion: null, tangentQuaternion: tangentQuat, lookAt: null };
  }

  const toTarget = sub(input.targetPosition, input.position);
  const targetQuat = length(toTarget) > 1e-5
    ? orientationFromForward(toTarget, roll)
    : tangentQuat;
  const m = smoothstep(0, 1, clamp(mix, 0, 1));
  const quaternion = m <= 1e-6 ? tangentQuat : m >= 1 - 1e-6 ? targetQuat : quatSlerp(tangentQuat, targetQuat, m);
  return {
    quaternion,
    targetQuaternion: targetQuat,
    tangentQuaternion: tangentQuat,
    lookAt: input.targetPosition,
  };
}

/** Focal length / sensor height -> vertical and horizontal FOV (radians). */
export function fovFromFocal(focalLengthMm: number, sensorHeightMm: number, aspect: number): { fovY: number; fovX: number } {
  const f = Math.max(1, focalLengthMm);
  const sensorH = Math.max(1, sensorHeightMm);
  const fovY = 2 * Math.atan(sensorH / (2 * f));
  // Horizontal FOV derived from the frame aspect (width / height).
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * Math.max(0.05, aspect));
  return { fovY, fovX };
}

export function focalFromFovY(fovY: number, sensorHeightMm: number): number {
  return Math.max(1, sensorHeightMm / (2 * Math.tan(fovY / 2)));
}

/**
 * Smoothly animates the aim blend factor when switching between tangent and
 * target modes. Scrubbing snaps to the settled value so arbitrary time lookups
 * remain deterministic.
 */
export class AimBlender {
  mode: AimMode = 'tangent';
  private value = 0;
  private from = 0;
  private to = 0;
  private startedAt = 0;
  private duration = 0.45;
  private animating = false;

  setMode(mode: AimMode, now: number, animate = true): void {
    const target = mode === 'target' ? 1 : 0;
    if (!animate) {
      this.mode = mode;
      this.value = target;
      this.from = target;
      this.to = target;
      this.animating = false;
      return;
    }
    if (mode === this.mode && !this.animating && Math.abs(this.value - target) < 1e-6) return;
    this.mode = mode;
    this.from = this.value;
    this.to = target;
    this.startedAt = now;
    this.animating = Math.abs(target - this.value) > 1e-6;
    if (!this.animating) this.value = target;
  }

  snapToMode(mode: AimMode): void {
    this.mode = mode;
    this.value = mode === 'target' ? 1 : 0;
    this.from = this.value;
    this.to = this.value;
    this.animating = false;
  }

  update(now: number): number {
    if (this.animating) {
      const t = clamp((now - this.startedAt) / this.duration, 0, 1);
      if (t >= 1) {
        this.value = this.to;
        this.animating = false;
      } else {
        this.value = mixScalar(this.from, this.to, smoothstep(0, 1, t));
      }
    }
    return this.value;
  }

  get mix(): number {
    return this.value;
  }

  get isAnimating(): boolean {
    return this.animating;
  }
}

/** Debug helper: yaw/pitch/roll in degrees from a quaternion. */
export function eulerDegrees(q: Quat): [number, number, number] {
  return quatToEulerDegrees(q);
}
