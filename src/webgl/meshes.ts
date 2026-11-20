import type { Vec3 } from '../math/vec3.js';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array;
}

export type MeshName = 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'octahedron' | 'plane';

function pushTriangle(
  normals: number[],
  indices: number[],
  a: Vec3,
  b: Vec3,
  c: Vec3,
): void {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Vec3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  // 6 floats per vertex (position + normal), so the vertex base is length / 6.
  const base = normals.length / 6;
  for (const v of [a, b, c]) {
    normals.push(v[0], v[1], v[2], n[0] / len, n[1] / len, n[2] / len);
  }
  indices.push(base, base + 1, base + 2);
}

function box(): MeshData {
  // Unit cube centered at the origin, flat-shaded faces.
  const corners: Vec3[] = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
  ];
  const faces: [number, number, number, number][] = [
    [0, 1, 2, 3], // -Z
    [5, 4, 7, 6], // +Z
    [4, 0, 3, 7], // -X
    [1, 5, 6, 2], // +X
    [3, 2, 6, 7], // +Y
    [4, 5, 1, 0], // -Y
  ];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const [a, b, c, d] of faces) {
    pushQuad(normals, indices, corners[a], corners[b], corners[c], corners[d]);
  }
  return pack(normals, indices);
}

function octahedron(): MeshData {
  const v: Vec3[] = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ].map((p) => p as Vec3);
  const faces: [number, number, number][] = [
    [0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0],
    [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5],
  ];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const [a, b, c] of faces) pushTriangle(normals, indices, v[a], v[b], v[c]);
  return pack(normals, indices);
}

function sphere(segments = 24, rings = 16): MeshData {
  const normals: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y <= rings; y++) {
    const v = y / rings;
    const phi = v * Math.PI;
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const theta = u * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi) * Math.sin(theta);
      normals.push(nx * 0.5, ny * 0.5, nz * 0.5, nx, ny, nz);
    }
  }
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < segments; x++) {
      const a = y * (segments + 1) + x;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return pack(normals, indices);
}

function cylinder(segments = 24): MeshData {
  const normals: number[] = [];
  const indices: number[] = [];
  const r = 0.5;
  const h = 0.5;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // Side quad (two vertices).
    normals.push(c * r, -h, s * r, c, 0, s);
    normals.push(c * r, h, s * r, c, 0, s);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  // Caps (flat normals, triangle fans).
  for (const [y, ny] of [[h, 1], [-h, -1]] as const) {
    const base = normals.length / 6;
    normals.push(0, y, 0, 0, ny, 0);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const c = Math.cos(a) * r;
      const s = Math.sin(a) * r;
      normals.push(c, y, s, 0, ny, 0);
    }
    for (let i = 1; i <= segments; i++) {
      if (ny > 0) indices.push(base, base + i, base + i + 1);
      else indices.push(base, base + i + 1, base + i);
    }
  }
  return pack(normals, indices);
}

function cone(segments = 24): MeshData {
  const normals: number[] = [];
  const indices: number[] = [];
  const r = 0.5;
  const h = 0.5;
  const base = normals.length / 6;
  normals.push(0, h, 0, 0, 1, 0);
  const slope = Math.atan2(r, h);
  const ny = Math.cos(slope);
  const nr = Math.sin(slope);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    normals.push(c * r, -h, s * r, c * nr, ny, s * nr);
  }
  for (let i = 1; i <= segments; i++) {
    indices.push(base, base + i + 1, base + i);
  }
  // Base cap.
  const capBase = normals.length / 6;
  normals.push(0, -h, 0, 0, -1, 0);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    normals.push(Math.cos(a) * r, -h, Math.sin(a) * r, 0, -1, 0);
  }
  for (let i = 1; i <= segments; i++) {
    indices.push(capBase, capBase + i, capBase + i + 1);
  }
  return pack(normals, indices);
}

function torus(segments = 32, sides = 14): MeshData {
  const normals: number[] = [];
  const indices: number[] = [];
  const R = 0.38;
  const r = 0.14;
  for (let i = 0; i <= segments; i++) {
    const u = (i / segments) * Math.PI * 2;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    for (let j = 0; j <= sides; j++) {
      const v = (j / sides) * Math.PI * 2;
      const cv = Math.cos(v);
      const sv = Math.sin(v);
      const nx = cv * cu;
      const ny = sv;
      const nz = cv * su;
      normals.push((R + r * cv) * cu, r * sv, (R + r * cv) * su, nx, ny, nz);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * (sides + 1) + j;
      const b = a + sides + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return pack(normals, indices);
}

function plane(): MeshData {
  const normals = [
    -0.5, 0, -0.5, 0, 1, 0,
    0.5, 0, -0.5, 0, 1, 0,
    0.5, 0, 0.5, 0, 1, 0,
    -0.5, 0, 0.5, 0, 1, 0,
  ];
  return pack(normals, [0, 2, 1, 0, 3, 2]);
}

function pushQuad(normals: number[], indices: number[], a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Vec3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const base = normals.length / 6;
  for (const v of [a, b, c, d]) {
    normals.push(v[0], v[1], v[2], n[0] / len, n[1] / len, n[2] / len);
  }
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function pack(interleaved: number[], indices: number[]): MeshData {
  const vertexCount = interleaved.length / 6;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = interleaved[i * 6];
    positions[i * 3 + 1] = interleaved[i * 6 + 1];
    positions[i * 3 + 2] = interleaved[i * 6 + 2];
    normals[i * 3] = interleaved[i * 6 + 3];
    normals[i * 3 + 1] = interleaved[i * 6 + 4];
    normals[i * 3 + 2] = interleaved[i * 6 + 5];
  }
  return { positions, normals, indices: new Uint16Array(indices) };
}

export const MESH_BUILDERS: Record<MeshName, () => MeshData> = {
  box,
  sphere,
  cylinder,
  cone,
  torus,
  octahedron,
  plane,
};
