/** 网格几何：XZ 平面上的细分网格，带位置 / 法线 / UV 三套属性 */

export interface Geometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
}

export function createGridGeometry(segments = 32, size = 2): Geometry {
  const vertsPerSide = segments + 1;
  const vertexCount = vertsPerSide * vertsPerSide;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const half = size / 2;

  let p = 0, n = 0, t = 0;
  for (let iz = 0; iz <= segments; iz++) {
    for (let ix = 0; ix <= segments; ix++) {
      const fx = ix / segments;
      const fz = iz / segments;
      positions[p++] = -half + fx * size;
      positions[p++] = 0;
      positions[p++] = -half + fz * size;
      normals[n++] = 0;
      normals[n++] = 1;
      normals[n++] = 0;
      uvs[t++] = fx;
      uvs[t++] = 1 - fz;
    }
  }

  const indices = new Uint16Array(segments * segments * 6);
  let k = 0;
  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = iz * vertsPerSide + ix;
      const b = a + 1;
      const c = a + vertsPerSide;
      const d = c + 1;
      indices[k++] = a; indices[k++] = c; indices[k++] = b;
      indices[k++] = b; indices[k++] = c; indices[k++] = d;
    }
  }

  return { positions, normals, uvs, indices };
}
