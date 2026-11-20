import type { TerrainModel } from "../core/TerrainModel";

export interface ChunkMeshData {
  cx: number;
  cy: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  wireIndices: Uint32Array;
  /** 区块四条边界的线框顶点（沿世界 +Y 抬高少许）。 */
  borderPositions: Float32Array;
}

/**
 * 区块网格构建。
 *
 * 每个区块覆盖 chunkSize×chunkSize 个格、(chunkSize+1)² 个顶点，
 * 边界顶点直接引用全局合成高度数组中的同一元素——相邻区块因此共享
 * 边界位置，裂缝在数据层面不可能发生。法线由整张合成高度场统一
 * 用中央差分计算，边界两侧得到的法线也完全一致。
 */
export function buildChunkMesh(model: TerrainModel, cx: number, cy: number): ChunkMeshData {
  const N = model.vertexCount;
  const cs = model.chunkSize;
  const spacing = model.spacing;
  const x0 = cx * cs;
  const z0 = cy * cs;
  const side = cs + 1;
  const vertexCount = side * side;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 4);
  const indices = new Uint32Array(cs * cs * 6);
  const wireIndices = new Uint32Array(cs * cs * 8);

  const half = ((N - 1) * spacing) / 2;

  // 顶点属性
  for (let lz = 0; lz < side; lz++) {
    for (let lx = 0; lx < side; lx++) {
      const gx = x0 + lx;
      const gz = z0 + lz;
      const vi = lz * side + lx;
      const gi = gz * N + gx;
      const wx = gx * spacing - half;
      const wz = gz * spacing - half;
      const h = model.compositeHeights[gi];
      positions[vi * 3] = wx;
      positions[vi * 3 + 1] = h;
      positions[vi * 3 + 2] = wz;

      const n = computeNormal(model, gx, gz);
      normals[vi * 3] = n[0];
      normals[vi * 3 + 1] = n[1];
      normals[vi * 3 + 2] = n[2];

      colors[vi * 4] = model.compositeColors[gi * 4];
      colors[vi * 4 + 1] = model.compositeColors[gi * 4 + 1];
      colors[vi * 4 + 2] = model.compositeColors[gi * 4 + 2];
      colors[vi * 4 + 3] = model.compositeColors[gi * 4 + 3];
    }
  }

  // 三角形索引（CCW，法线朝上）与线框索引
  let ti = 0;
  let wi = 0;
  for (let lz = 0; lz < cs; lz++) {
    for (let lx = 0; lx < cs; lx++) {
      const a = lz * side + lx;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      indices[ti++] = a;
      indices[ti++] = c;
      indices[ti++] = b;
      indices[ti++] = b;
      indices[ti++] = c;
      indices[ti++] = d;

      wireIndices[wi++] = a;
      wireIndices[wi++] = b;
      wireIndices[wi++] = b;
      wireIndices[wi++] = d;
      wireIndices[wi++] = d;
      wireIndices[wi++] = c;
      wireIndices[wi++] = c;
      wireIndices[wi++] = a;
    }
  }

  // 区块边界线：仅四条周边的线段对（沿世界 +Y 抬高少许避免 z-fighting）
  const border: number[] = [];
  const lift = 0.15;
  const pushBorder = (gx: number, gz: number) => {
    const gi = gz * N + gx;
    border.push(gx * spacing - half, model.compositeHeights[gi] + lift, gz * spacing - half);
  };
  const seg = (ax: number, az: number, bx: number, bz: number) => {
    pushBorder(ax, az);
    pushBorder(bx, bz);
  };
  for (let k = 0; k < cs; k++) {
    seg(x0 + k, z0, x0 + k + 1, z0); // 上边
    seg(x0 + k, z0 + cs, x0 + k + 1, z0 + cs); // 下边
    seg(x0, z0 + k, x0, z0 + k + 1); // 左边
    seg(x0 + cs, z0 + k, x0 + cs, z0 + k + 1); // 右边
  }

  return {
    cx,
    cy,
    positions,
    normals,
    colors,
    indices,
    wireIndices,
    borderPositions: new Float32Array(border),
  };
}

/** 全局高度场中央差分法线，保证区块两侧法线一致。 */
function computeNormal(model: TerrainModel, gx: number, gz: number): [number, number, number] {
  const N = model.vertexCount;
  const s = model.spacing;
  const xl = Math.max(0, gx - 1);
  const xr = Math.min(N - 1, gx + 1);
  const zl = Math.max(0, gz - 1);
  const zr = Math.min(N - 1, gz + 1);
  const hl = model.compositeHeights[gz * N + xl];
  const hr = model.compositeHeights[gz * N + xr];
  const hd = model.compositeHeights[zl * N + gx];
  const hu = model.compositeHeights[zr * N + gx];
  const sx = (xr - xl) * s;
  const sz = (zr - zl) * s;
  // 高度场 y = h(x,z) 的法线
  const nx = (hl - hr) / sx;
  const nz = (hd - hu) / sz;
  const len = Math.hypot(nx, 1, nz) || 1;
  return [nx / len, 1 / len, nz / len];
}
