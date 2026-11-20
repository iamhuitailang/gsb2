export type Quat = [number, number, number, number]; // x, y, z, w

export function quatIdentity(): Quat {
  return [0, 0, 0, 1];
}

export function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (len < 1e-12) return quatIdentity();
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

export function quatDot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let x = b[0], y = b[1], z = b[2], w = b[3];
  let cos = quatDot(a, b);
  if (cos < 0) {
    cos = -cos;
    x = -x; y = -y; z = -z; w = -w;
  }
  if (cos > 0.9995) {
    return quatNormalize([
      a[0] + (x - a[0]) * t,
      a[1] + (y - a[1]) * t,
      a[2] + (z - a[2]) * t,
      a[3] + (w - a[3]) * t,
    ]);
  }
  const theta = Math.acos(cos);
  const sinTheta = Math.sin(theta);
  const s0 = Math.sin((1 - t) * theta) / sinTheta;
  const s1 = Math.sin(t * theta) / sinTheta;
  return quatNormalize([
    a[0] * s0 + x * s1,
    a[1] * s0 + y * s1,
    a[2] * s0 + z * s1,
    a[3] * s0 + w * s1,
  ]);
}

export function quatFromTwoVectors(fromDir: readonly number[], toDir: readonly number[]): Quat {
  const a = normalize3(fromDir);
  const b = normalize3(toDir);
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d > 0.999999) return quatIdentity();
  if (d < -0.999999) {
    // 180deg: choose any perpendicular axis.
    let axis: [number, number, number] = [1, 0, 0];
    if (Math.abs(a[0]) > 0.9) axis = [0, 1, 0];
    const [ax, ay, az] = normalize3(cross3(a, axis));
    return [ax, ay, az, 0];
  }
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return quatNormalize([cx, cy, cz, 1 + d]);
}

export function quatFromAxisAngle(axis: readonly number[], angle: number): Quat {
  const a = normalize3(axis);
  const half = angle / 2;
  const s = Math.sin(half);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(half)];
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatRotateVec(q: Quat, v: readonly number[]): [number, number, number] {
  const [x, y, z, w] = q;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** Yaw-pitch-roll (degrees), ZYX intrinsic, used only for the inspector's debug readout. */
export function quatToEulerDegrees(q: Quat): [number, number, number] {
  const [x, y, z, w] = q;
  const sinrCosp = 2 * (w * x + y * z);
  const cosrCosp = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinrCosp, cosrCosp);
  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? (Math.sign(sinp) * Math.PI) / 2 : Math.asin(sinp);
  const sinyCosp = 2 * (w * z + x * y);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(sinyCosp, cosyCosp);
  const r = Math.PI / 180;
  return [yaw / r, pitch / r, roll / r];
}

function normalize3(v: readonly number[]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-12) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross3(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
