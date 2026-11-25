// 列主序 4x4 矩阵(与 WebGL uniform 布局一致),全部纯函数、无隐藏状态。
// 所有矩阵都由"帧号派生参数"构造,同一帧号 => 同一矩阵,保证重跑可比对。

export function mat4Identity() {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

export function mat4Multiply(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

// 透视投影;jitterX/jitterY 为 NDC 空间的亚像素偏移(无抖动时传 0)。
export function mat4Perspective(fovyRad, aspect, near, far, jitterX = 0, jitterY = 0) {
  const f = 1 / Math.tan(fovyRad / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    jitterX, jitterY, 2 * far * near * nf, 0,
  ]);
}

export function vec3Sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function mat4LookAt(eye, center, up = [0, 1, 0]) {
  const z = normalize(vec3Sub(eye, center));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

export function mat4Translation(x, y, z) {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ]);
}

export function mat4Scale(sx, sy, sz) {
  return new Float32Array([
    sx, 0, 0, 0,
    0, sy, 0, 0,
    0, 0, sz, 0,
    0, 0, 0, 1,
  ]);
}

// 绕 Y 轴旋转(栅栏滑动时带一点转向,让速度向量不只沿屏幕 X)。
export function mat4RotY(rad) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return new Float32Array([
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    0, 0, 0, 1,
  ]);
}

export function mat4Compose(translation, rotY, scale) {
  const t = mat4Translation(...translation);
  const r = mat4RotY(rotY);
  const s = mat4Scale(...scale);
  return mat4Multiply(t, mat4Multiply(r, s));
}

// 0..1 平滑阶跃
export function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// 环形缓冲式线性扫描:在 [min,max] 内以给定周期往复,相位完全由 t 决定。
export function pingPong(t, period, min, max) {
  const phase = (t % period) / period; // 0..1
  const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2; // 0..1..0
  return min + (max - min) * tri;
}
