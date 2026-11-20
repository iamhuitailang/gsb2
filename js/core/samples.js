// 程序化示例模型：
//  1. 规则模型 subdividedCube：每面独立细分、角点不共享 —— 天然带重复顶点，
//     用于体检/焊接功能的对照演示；
//  2. 细节模型 detailedIcosphere：icosphere 细分后做 fbm 噪声位移，高面数、
//     轮廓与表面细节丰富，用于观察不同 LOD 的细节损失。
// 另附带一个由两个互不接触小块组成的模型，验证“不相连对象不会被错误焊接”。

import { Mesh, computeVertexNormals } from './mesh.js';

// ---- 确定性 value noise（无外部依赖）----
function makeNoise3D(seed = 7) {
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  let s = seed >>> 0;
  const rand = () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = (t) => t * t * (3 - 2 * t);
  const grad = (h, x, y, z) => {
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  };
  return (x, y, z) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);
    const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
    const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;
    const lerp = (t, a, b) => a + t * (b - a);
    return lerp(w,
      lerp(v,
        lerp(u, grad(perm[AA] & 15, x, y, z), grad(perm[BA] & 15, x - 1, y, z)),
        lerp(u, grad(perm[AB] & 15, x, y - 1, z), grad(perm[BB] & 15, x - 1, y - 1, z))),
      lerp(v,
        lerp(u, grad(perm[AA + 1] & 15, x, y, z - 1), grad(perm[BA + 1] & 15, x - 1, y, z - 1)),
        lerp(u, grad(perm[AB + 1] & 15, x, y - 1, z - 1), grad(perm[BB + 1] & 15, x - 1, y - 1, z - 1))));
  };
}

/**
 * 规则细分立方体：6 面 × seg×seg 个四边形，角点与棱点按面重复存储
 * （共 6*(seg+1)^2 个顶点）—— 天然带重复顶点，用于体检/焊接演示。
 * 六面参数化保证共享棱上的采样坐标逐点重合，默认容差即可检出重复。
 */
export function subdividedCube(seg = 12, size = 2) {
  const positions = [];
  const indices = [];
  const half = size / 2;
  // u: -half→half（i 方向），v: -half→half（j 方向），绕序保证法线朝外
  const faces = [
    { n: [1, 0, 0], p: (u, v) => [half, v, u] },
    { n: [-1, 0, 0], p: (u, v) => [-half, v, -u] },
    { n: [0, 1, 0], p: (u, v) => [u, half, v] },
    { n: [0, -1, 0], p: (u, v) => [u, -half, -v] },
    { n: [0, 0, 1], p: (u, v) => [u, v, half] },
    { n: [0, 0, -1], p: (u, v) => [-u, v, -half] },
  ];
  for (const face of faces) {
    const base = positions.length / 3;
    for (let j = 0; j <= seg; j++) {
      for (let i = 0; i <= seg; i++) {
        const u = -half + size * (i / seg);
        const v = -half + size * (j / seg);
        positions.push(...face.p(u, v));
      }
    }
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = base + j * (seg + 1) + i;
        const b = a + 1;
        const c = a + (seg + 1);
        const d = c + 1;
        // 朝外绕序
        indices.push(a, b, c, b, d, c);
      }
    }
  }
  const mesh = new Mesh({ positions, indices: Uint32Array.from(indices), name: '规则立方体(细分)' });
  computeVertexNormals(mesh);
  return mesh;
}

function icosphereBase() {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => {
    const l = Math.hypot(...v);
    return v.map((c) => c / l);
  });
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return { verts, faces };
}

/** 细分 icosphere 后做 fbm 位移，得到高细节不规则表面。 */
export function detailedIcosphere(subdivisions = 4, radius = 1.4, amplitude = 0.22, seed = 11) {
  let { verts, faces } = icosphereBase();
  const midpointCache = new Map();
  const midpoint = (a, b) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (midpointCache.has(key)) return midpointCache.get(key);
    const m = [
      (verts[a][0] + verts[b][0]) / 2,
      (verts[a][1] + verts[b][1]) / 2,
      (verts[a][2] + verts[b][2]) / 2,
    ];
    verts.push(m);
    const idx = verts.length - 1;
    midpointCache.set(key, idx);
    return idx;
  };
  for (let s = 0; s < subdivisions; s++) {
    const next = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  // 归一化到球面
  verts = verts.map((v) => {
    const l = Math.hypot(...v) || 1;
    return v.map((c) => c / l);
  });

  const noise = makeNoise3D(seed);
  const fbm = (x, y, z) => {
    let value = 0, amp = 1, freq = 1.6, norm = 0;
    for (let o = 0; o < 4; o++) {
      value += amp * noise(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2.1;
    }
    return value / norm;
  };

  const positions = [];
  for (const [x, y, z] of verts) {
    const r = radius * (1 + amplitude * fbm(x, y, z));
    positions.push(x * r, y * r, z * r);
  }
  const indices = [];
  for (const f of faces) indices.push(...f);
  const mesh = new Mesh({ positions, indices: Uint32Array.from(indices), name: '细节球(fbm噪声)' });
  computeVertexNormals(mesh);
  return mesh;
}

/** 实体立方体：8 个共享角点 + 12 个三角面（闭合流形，无重复点）。 */
export function solidBox(size = 1) {
  const h = size / 2;
  const positions = [
    -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h,
    -h, -h, h, h, -h, h, h, h, h, -h, h, h,
  ];
  const indices = [
    0, 2, 1, 0, 3, 2, // -Z
    4, 5, 6, 4, 6, 7, // +Z
    0, 1, 5, 0, 5, 4, // -Y
    3, 7, 6, 3, 6, 2, // +Y
    0, 4, 7, 0, 7, 3, // -X
    1, 2, 6, 1, 6, 5, // +X
  ];
  const mesh = new Mesh({ positions: Float32Array.from(positions), indices: Uint32Array.from(indices), name: '实体立方体' });
  computeVertexNormals(mesh);
  return mesh;
}

/** 两个互不接触的小块，中间留空隙 —— 验证多分量独立简化与焊接安全。 */
export function twoDisconnectedParts(seg = 8) {
  const a = solidBox(1);
  const offset = (mesh, dx, dy, dz) => {
    for (let i = 0; i < mesh.positions.length; i += 3) {
      mesh.positions[i] += dx; mesh.positions[i + 1] += dy; mesh.positions[i + 2] += dz;
    }
  };
  offset(a, -1.6, 0, 0);
  const b = solidBox(1);
  offset(b, 1.6, 0, 0);
  const shift = a.vertexCount;
  const positions = new Float32Array(a.vertexCount * 3 + b.vertexCount * 3);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.vertexCount * 3);
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices, 0);
  for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i] + shift;
  const mesh = new Mesh({ positions, indices, name: '双分离立方体' });
  computeVertexNormals(mesh);
  return mesh;
}
