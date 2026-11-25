/**
 * 带 UV 接缝的测试网格构造工具。
 */
import { PaintMesh, MaterialSlot } from '../src/core/mesh.js';

/**
 * 构造一个立方体：每条三维边两侧的顶点都是独立复制的，
 * 且各面 UV 摊平到 [0,1] 内不同的岛上 —— 与真实 DCC 导出的接缝一致。
 * 六个面各自给一个材质槽（也可合并）。
 */
export function buildSeamedCube(
  size = 1,
  multiMaterial = true,
): { mesh: PaintMesh; materials: MaterialSlot[] } {
  const h = size / 2;
  // 每面 4 个顶点（独立复制 => 接缝），面局部 (u,v) 映射到 0..1
  const faceDefs: Array<{
    name: string;
    corners: Array<[number, number, number]>;
  }> = [
    { name: 'px', corners: [[h, -h, -h], [h, h, -h], [h, h, h], [h, -h, h]] },
    { name: 'nx', corners: [[-h, -h, h], [-h, h, h], [-h, h, -h], [-h, -h, -h]] },
    { name: 'py', corners: [[-h, h, -h], [-h, h, h], [h, h, h], [h, h, -h]] },
    { name: 'ny', corners: [[-h, -h, h], [-h, -h, -h], [h, -h, -h], [h, -h, h]] },
    { name: 'pz', corners: [[h, -h, h], [h, h, h], [-h, h, h], [-h, -h, h]] },
    { name: 'nz', corners: [[-h, -h, -h], [-h, h, -h], [h, h, -h], [h, -h, -h]] },
  ];

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const materials: MaterialSlot[] = [];
  // 每面在 UV 画布上占 1/3 x 1/2 的岛
  const layout: Record<string, [number, number]> = {
    pz: [0, 0], nz: [2, 0],
    px: [1, 0], nx: [1, 1],
    py: [0, 1], ny: [2, 1],
  };

  let vertexBase = 0;
  let triBase = 0;
  for (const face of faceDefs) {
    const [ix, iy] = layout[face.name];
    const uvCoords: Array<[number, number]> = [
      [ix / 3, iy / 2],
      [ix / 3, (iy + 1) / 2],
      [(ix + 1) / 3, (iy + 1) / 2],
      [(ix + 1) / 3, iy / 2],
    ];
    for (let i = 0; i < 4; i++) {
      positions.push(...face.corners[i]);
      uvs.push(uvCoords[i][0] + 0.002, uvCoords[i][1] + 0.002);
    }
    indices.push(
      vertexBase, vertexBase + 1, vertexBase + 2,
      vertexBase, vertexBase + 2, vertexBase + 3,
    );
    materials.push({
      name: multiMaterial ? face.name : 'cube',
      startTriangle: triBase,
      triangleCount: 2,
    });
    vertexBase += 4;
    triBase += 2;
  }

  const mesh = new PaintMesh(
    'seamedCube',
    Float32Array.from(positions),
    Float32Array.from(uvs),
    Uint32Array.from(indices),
    multiMaterial ? materials : [
      { name: 'cube', startTriangle: 0, triangleCount: indices.length / 3 },
    ],
  );
  return { mesh, materials };
}
