// 最小向量/矩阵工具集（列主序 mat4，与 WebGL 一致）。
// 全部为纯函数，方便在 Node 单测中直接使用。

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];
export type Mat4 = Float32Array;

export const v3 = {
  add(a: Vec3, b: Vec3): Vec3 {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  },
  sub(a: Vec3, b: Vec3): Vec3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  },
  scale(a: Vec3, s: number): Vec3 {
    return [a[0] * s, a[1] * s, a[2] * s];
  },
  dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  },
  cross(a: Vec3, b: Vec3): Vec3 {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  },
  len(a: Vec3): number {
    return Math.hypot(a[0], a[1], a[2]);
  },
  normalize(a: Vec3): Vec3 {
    const l = v3.len(a);
    if (l < 1e-12) return [0, 0, 0];
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  neg(a: Vec3): Vec3 {
    return [-a[0], -a[1], -a[2]];
  },
  lerp(a: Vec3, b: Vec3, t: number): Vec3 {
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
  },
  /** 逐分量乘 */
  mul(a: Vec3, b: Vec3): Vec3 {
    return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
  },
  fromArray(a: ArrayLike<number>, offset = 0): Vec3 {
    return [a[offset], a[offset + 1], a[offset + 2]];
  },
};

export function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  // 返回 a * b
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[col * 4 + k];
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export function mat4Translation(t: Vec3): Mat4 {
  const m = mat4Identity();
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  return m;
}

export function mat4Scale(s: Vec3): Mat4 {
  const m = mat4Identity();
  m[0] = s[0];
  m[5] = s[1];
  m[10] = s[2];
  return m;
}

export function mat4RotationX(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = mat4Identity();
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

export function mat4RotationY(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = mat4Identity();
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

export function mat4RotationZ(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = mat4Identity();
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

/** 模型矩阵：T * Rz * Ry * Rx * S，旋转顺序 XYZ（外旋） */
export function buildModelMatrix(
  translation: Vec3,
  rotationEuler: Vec3,
  scale: Vec3,
): Mat4 {
  let m = mat4Translation(translation);
  m = mat4Multiply(m, mat4RotationZ(rotationEuler[2]));
  m = mat4Multiply(m, mat4RotationY(rotationEuler[1]));
  m = mat4Multiply(m, mat4RotationX(rotationEuler[0]));
  m = mat4Multiply(m, mat4Scale(scale));
  return m;
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const invW = w === 0 ? 1 : 1 / w;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) * invW,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) * invW,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) * invW,
  ];
}

/** 方向向量（忽略平移） */
export function transformDir(m: Mat4, d: Vec3): Vec3 {
  const x = d[0];
  const y = d[1];
  const z = d[2];
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
}

/** 法线矩阵 = inverse(transpose(模型矩阵)) 的 3x3 部分；各轴缩放不同/翻转时必须用它变换法线与切向 */
export function normalMatrix3(m: Mat4): Mat4 {
  // 对 4x4 求逆再转置（仿射矩阵足够通用，含负缩放）
  const inv = mat4Invert(m);
  if (!inv) {
    return mat4Identity();
  }
  const out = mat4Identity();
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] = inv[row * 4 + col];
    }
  }
  return out;
}

/** 4x4 求逆（Gauss-Jordan），奇异时返回 null */
export function mat4Invert(a: Mat4): Mat4 | null {
  const m = new Float32Array(16);
  m.set(a);
  const inv = mat4Identity();
  for (let i = 0; i < 4; i++) {
    let pivot = -1;
    let best = 1e-12;
    for (let r = i; r < 4; r++) {
      const v = Math.abs(m[r * 4 + i]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (pivot < 0) return null;
    if (pivot !== i) {
      for (let c = 0; c < 4; c++) {
        const t = m[i * 4 + c];
        m[i * 4 + c] = m[pivot * 4 + c];
        m[pivot * 4 + c] = t;
        const ti = inv[i * 4 + c];
        inv[i * 4 + c] = inv[pivot * 4 + c];
        inv[pivot * 4 + c] = ti;
      }
    }
    const piv = m[i * 4 + i];
    for (let c = 0; c < 4; c++) {
      m[i * 4 + c] /= piv;
      inv[i * 4 + c] /= piv;
    }
    for (let r = 0; r < 4; r++) {
      if (r === i) continue;
      const f = m[r * 4 + i];
      if (f === 0) continue;
      for (let c = 0; c < 4; c++) {
        m[r * 4 + c] -= f * m[i * 4 + c];
        inv[r * 4 + c] -= f * inv[i * 4 + c];
      }
    }
  }
  return inv;
}

/** 透视投影矩阵 */
export function mat4Perspective(fovyRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovyRad / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

export function mat4LookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  const z = v3.normalize(v3.sub(eye, center));
  const x = v3.normalize(v3.cross(up, z));
  const y = v3.cross(z, x);
  const m = mat4Identity();
  m[0] = x[0];
  m[1] = y[0];
  m[2] = z[0];
  m[4] = x[1];
  m[5] = y[1];
  m[6] = z[1];
  m[8] = x[2];
  m[9] = y[2];
  m[10] = z[2];
  m[12] = -v3.dot(x, eye);
  m[13] = -v3.dot(y, eye);
  m[14] = -v3.dot(z, eye);
  return m;
}

export function mat4MultiplyVec4(m: Mat4, v: [number, number, number, number]): [number, number, number, number] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}
