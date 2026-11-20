import type { Vec3 } from '../math/vec3.js';
import { normalize } from '../math/vec3.js';
import type { Quat } from '../math/quat.js';
import {
  quatFromTwoVectors,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  quatRotateVec,
  quatSlerp,
} from '../math/quat.js';
import type { PathSpline } from './curve.js';
import { orientationFromForward } from './camera.js';

const LOCAL_FORWARD: Vec3 = [0, 0, 1];

function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/**
 * A smooth, flip-free field of camera orientations along a path.
 *
 * Frames are parallel-transported: each step applies the minimal rotation that
 * takes the previous tangent onto the next one. Unlike projecting a fixed
 * world-up vector, this has no singularity when the tangent passes through
 * vertical, so a camera can loop straight up without snapping.
 *
 * For closed paths the residual "holonomy" twist accumulated over the loop is
 * distributed evenly over all samples, so s = 0 and s = 1 meet with an
 * identical frame (no visible roll seam).
 */
export class CameraFrameField {
  readonly spline: PathSpline;
  readonly closed: boolean;
  readonly count: number;
  readonly quaternions: Quat[];

  constructor(spline: PathSpline) {
    this.spline = spline;
    this.closed = spline.closed;
    const count = Math.max(96, Math.min(4096, spline.segmentCount * 24));
    this.count = count;

    const tangents: Vec3[] = [];
    for (let i = 0; i <= count; i++) {
      const s = this.closed && i === count ? 0 : i / count;
      tangents.push(normalize(spline.tangentAt(s), [0, 0, 1]));
    }

    const quats: Quat[] = new Array(count + 1);
    quats[0] = orientationFromForward(tangents[0], 0);
    for (let i = 1; i <= count; i++) {
      const delta = quatFromTwoVectors(tangents[i - 1], tangents[i]);
      quats[i] = quatNormalize(quatMultiply(delta, quats[i - 1]));
    }

    if (this.closed && count > 0) {
      // Relative rotation from the first frame to the transported end frame.
      let rel = quatNormalize(quatMultiply(quatConjugate(quats[0]), quats[count]));
      if (rel[3] < 0) rel = [-rel[0], -rel[1], -rel[2], -rel[3]];
      // Twist about the local forward axis (local +Z).
      const twist = 2 * Math.atan2(rel[2], rel[3]);
      if (Math.abs(twist) > 1e-6) {
        for (let i = 0; i <= count; i++) {
          const angle = (-twist * i) / count;
          quats[i] = quatNormalize(quatMultiply(quats[i], quatFromAxisAngle(LOCAL_FORWARD, angle)));
        }
      }
      quats[count] = quats[0];
    }

    this.quaternions = quats;
  }

  /** Interpolated camera frame at a normalized arc-length parameter. */
  quaternionAt(s: number): Quat {
    const n = this.count;
    if (n <= 0) return [0, 0, 0, 1];
    let wrapped = this.closed ? ((s % 1) + 1) % 1 : Math.max(0, Math.min(1, s));
    if (!this.closed && wrapped === 1) return this.quaternions[n];
    const indexFloat = wrapped * n;
    const i0 = Math.max(0, Math.min(n - 1, Math.floor(indexFloat)));
    const frac = indexFloat - i0;
    const a = this.quaternions[i0];
    const b = this.quaternions[Math.min(n, i0 + 1)];
    if (frac <= 1e-9) return a;
    return quatSlerp(a, b, frac);
  }

  forwardAt(s: number): Vec3 {
    return quatRotateVec(this.quaternionAt(s), LOCAL_FORWARD) as Vec3;
  }
}

const FIELDS = new WeakMap<PathSpline, CameraFrameField>();

/** Cached per spline instance; rebuilding the spline invalidates it. */
export function frameFieldFor(spline: PathSpline): CameraFrameField {
  let field = FIELDS.get(spline);
  if (!field) {
    field = new CameraFrameField(spline);
    FIELDS.set(spline, field);
  }
  return field;
}

/** Re-aims an existing camera frame at a target with the minimal rotation. */
export function targetOrientation(
  frameQuaternion: Quat,
  fromPosition: Vec3,
  targetPosition: Vec3,
): Quat | null {
  const dx = targetPosition[0] - fromPosition[0];
  const dy = targetPosition[1] - fromPosition[1];
  const dz = targetPosition[2] - fromPosition[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-5) return null;
  const dir: Vec3 = [dx / len, dy / len, dz / len];
  const forward = quatRotateVec(frameQuaternion, LOCAL_FORWARD);
  const delta = quatFromTwoVectors(forward, dir);
  return quatNormalize(quatMultiply(delta, frameQuaternion));
}

/** Applies a roll about the camera's local forward (+Z) axis. */
export function rollOrientation(q: Quat, rollRad: number): Quat {
  if (Math.abs(rollRad) < 1e-9) return q;
  return quatNormalize(quatMultiply(q, quatFromAxisAngle(LOCAL_FORWARD, rollRad)));
}
