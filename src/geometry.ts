// 共享网格：一个单位立方体（half-extent = 0.5），所有实例复用同一份 VBO/IBO

export interface PackedMesh {
  positions: Float32Array;
  normals: Float32Array;
  triIndices: Uint16Array;
  lineIndices: Uint16Array;
  vertexCount: number;
}

interface FaceDef {
  normal: [number, number, number];
  corners: [number, number, number][];
}

// 每个面 4 个顶点，绕序按外向法线为逆时针
const FACES: FaceDef[] = [
  {
    normal: [1, 0, 0],
    corners: [
      [0.5, -0.5, -0.5],
      [0.5, 0.5, -0.5],
      [0.5, 0.5, 0.5],
      [0.5, -0.5, 0.5],
    ],
  },
  {
    normal: [-1, 0, 0],
    corners: [
      [-0.5, -0.5, 0.5],
      [-0.5, 0.5, 0.5],
      [-0.5, 0.5, -0.5],
      [-0.5, -0.5, -0.5],
    ],
  },
  {
    normal: [0, 1, 0],
    corners: [
      [-0.5, 0.5, -0.5],
      [-0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.5, 0.5, -0.5],
    ],
  },
  {
    normal: [0, -1, 0],
    corners: [
      [-0.5, -0.5, 0.5],
      [-0.5, -0.5, -0.5],
      [0.5, -0.5, -0.5],
      [0.5, -0.5, 0.5],
    ],
  },
  {
    normal: [0, 0, 1],
    corners: [
      [-0.5, -0.5, 0.5],
      [0.5, -0.5, 0.5],
      [0.5, 0.5, 0.5],
      [-0.5, 0.5, 0.5],
    ],
  },
  {
    normal: [0, 0, -1],
    corners: [
      [0.5, -0.5, -0.5],
      [-0.5, -0.5, -0.5],
      [-0.5, 0.5, -0.5],
      [0.5, 0.5, -0.5],
    ],
  },
];

export function createBoxMesh(): PackedMesh {
  const vertexCount = FACES.length * 4;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const triIndices = new Uint16Array(FACES.length * 6);
  const lineIndices = new Uint16Array(FACES.length * 8);

  FACES.forEach((face, fi) => {
    const base = fi * 4;
    face.corners.forEach((c, ci) => {
      positions[(base + ci) * 3 + 0] = c[0];
      positions[(base + ci) * 3 + 1] = c[1];
      positions[(base + ci) * 3 + 2] = c[2];
      normals[(base + ci) * 3 + 0] = face.normal[0];
      normals[(base + ci) * 3 + 1] = face.normal[1];
      normals[(base + ci) * 3 + 2] = face.normal[2];
    });
    // 两个三角形
    triIndices.set([base, base + 1, base + 2, base, base + 2, base + 3], fi * 6);
    // 面的四条边（线框）
    lineIndices.set(
      [base, base + 1, base + 1, base + 2, base + 2, base + 3, base + 3, base],
      fi * 8,
    );
  });

  return { positions, normals, triIndices, lineIndices, vertexCount };
}
