// 最小三维数学库：Vec3 / 4x4 矩阵 / 包围盒，全部列主序以匹配 WebGL uniformMatrix4fv

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
/** 列主序 4x4 矩阵 */
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
  length(a: Vec3): number {
    return Math.hypot(a[0], a[1], a[2]);
  },
  normalize(a: Vec3): Vec3 {
    const len = Math.hypot(a[0], a[1], a[2]);
    return len > 1e-12 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 0];
  },
  lerp(a: Vec3, b: Vec3, t: number): Vec3 {
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
  },
};

export interface BBox {
  min: Vec3;
  max: Vec3;
}

export const bbox = {
  empty(): BBox {
    return {
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
    };
  },
  isEmpty(b: BBox): boolean {
    return !Number.isFinite(b.min[0]);
  },
  expandPoint(b: BBox, p: Vec3): void {
    for (let i = 0; i < 3; i++) {
      if (p[i] < b.min[i]) b.min[i] = p[i];
      if (p[i] > b.max[i]) b.max[i] = p[i];
    }
  },
  union(a: BBox, b: BBox): BBox {
    if (bbox.isEmpty(a)) return { min: [...b.min] as Vec3, max: [...b.max] as Vec3 };
    if (bbox.isEmpty(b)) return { min: [...a.min] as Vec3, max: [...a.max] as Vec3 };
    return {
      min: [
        Math.min(a.min[0], b.min[0]),
        Math.min(a.min[1], b.min[1]),
        Math.min(a.min[2], b.min[2]),
      ],
      max: [
        Math.max(a.max[0], b.max[0]),
        Math.max(a.max[1], b.max[1]),
        Math.max(a.max[2], b.max[2]),
      ],
    };
  },
  center(b: BBox): Vec3 {
    return v3.scale(v3.add(b.min, b.max), 0.5);
  },
  size(b: BBox): Vec3 {
    return v3.sub(b.max, b.min);
  },
  radius(b: BBox): number {
    return bbox.isEmpty(b) ? 0 : 0.5 * v3.length(v3.sub(b.max, b.min));
  },
};

export const mat4 = {
  identity(): Mat4 {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },

  multiply(a: Mat4, b: Mat4): Mat4 {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[0 * 4 + r] * b[c * 4 + 0] +
          a[1 * 4 + r] * b[c * 4 + 1] +
          a[2 * 4 + r] * b[c * 4 + 2] +
          a[3 * 4 + r] * b[c * 4 + 3];
      }
    }
    return out;
  },

  perspective(fovyRad: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1 / Math.tan(fovyRad / 2);
    const nf = 1 / (near - far);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) * nf;
    m[11] = -1;
    m[14] = 2 * far * near * nf;
    return m;
  },

  lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
    const z = v3.normalize(v3.sub(eye, target));
    const x = v3.normalize(v3.cross(up, z));
    const y = v3.cross(z, x);
    const m = new Float32Array(16);
    m[0] = x[0];
    m[1] = y[0];
    m[2] = z[0];
    m[3] = 0;
    m[4] = x[1];
    m[5] = y[1];
    m[6] = z[1];
    m[7] = 0;
    m[8] = x[2];
    m[9] = y[2];
    m[10] = z[2];
    m[11] = 0;
    m[12] = -v3.dot(x, eye);
    m[13] = -v3.dot(y, eye);
    m[14] = -v3.dot(z, eye);
    m[15] = 1;
    return m;
  },
};
