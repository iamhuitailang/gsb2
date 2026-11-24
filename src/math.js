// Small column-major matrix / projection helpers used by both WebGL and the
// pure portal-culling math. Keeping projection math here lets Node scripts
// verify fixed camera positions without a browser.

export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export const lerp = (a, b, t) => a + (b - a) * t;

export function perspective(fovyRadians, aspect, near, far) {
  const f = 1 / Math.tan(fovyRadians / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, (2 * far * near) * nf, 0,
  ]);
}

export function lookAt(eye, center, up = [0, 1, 0]) {
  let zx = eye[0] - center[0];
  let zy = eye[1] - center[1];
  let zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

export function multiplyMat4(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

export function composeViewProjection(camera, aspect, near = 0.05, far = 80) {
  const cp = Math.cos(camera.pitch || 0);
  const forward = [
    Math.sin(camera.yaw || 0) * cp,
    Math.sin(camera.pitch || 0),
    -Math.cos(camera.yaw || 0) * cp,
  ];
  const eye = camera.position;
  const center = [
    eye[0] + forward[0],
    eye[1] + forward[1],
    eye[2] + forward[2],
  ];
  const view = lookAt(eye, center);
  const proj = perspective(camera.fovY ?? Math.PI / 180 * 68, aspect, near, far);
  return { view, proj, viewProj: multiplyMat4(proj, view), forward };
}

export function transformVec4(m, v) {
  const [x, y, z, w = 1] = v;
  return {
    x: m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    y: m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    z: m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    w: m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  };
}

export function trs({ position = [0, 0, 0], rotationY = 0, offset = [0, 0, 0], scale = [1, 1, 1] }) {
  const c = Math.cos(rotationY);
  const s = Math.sin(rotationY);
  const [sx, sy, sz] = scale;
  const [ox, oy, oz] = offset;

  // T(position) * Ry(rotationY) * T(offset) * S(scale), column-major.
  // Rotation is the standard right-handed Y matrix.
  return new Float32Array([
    c * sx, 0, -s * sx, 0,
    0, sy, 0, 0,
    s * sz, 0, c * sz, 0,
    position[0] + c * ox + s * oz,
    position[1] + oy,
    position[2] - s * ox + c * oz,
    1,
  ]);
}

export function horizontalAngle(camera, x, z) {
  const dx = x - camera.position[0];
  const dz = z - camera.position[2];
  // yaw=0 looks toward -Z. Positive returned angles are to the right.
  return Math.atan2(dx, -dz) - (camera.yaw || 0);
}

export function shortestAngleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
