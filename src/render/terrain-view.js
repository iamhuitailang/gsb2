// 地形网格渲染：把高度场转成 BufferGeometry，按高度/坡度着色，带光照阴影。

import * as THREE from 'three';
import { Terrain } from '../core/terrain.js';

/**
 * @param {Terrain} terrain
 * @returns {THREE.Mesh}
 */
export function createTerrainMesh(terrain) {
  const N = terrain.resolution;
  const positions = new Float32Array(N * N * 3);
  const colors = new Float32Array(N * N * 3);
  const uvs = new Float32Array(N * N * 2);
  const indices = [];

  const low = new THREE.Color(0x8a7a52); // 低海拔沙土
  const mid = new THREE.Color(0x5e8c46); // 草地
  const high = new THREE.Color(0x9c9587); // 高海拔岩石
  const c = new THREE.Color();

  let k = 0;
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const x = terrain.minX + (ix / (N - 1)) * terrain.width;
      const z = terrain.minZ + (iz / (N - 1)) * terrain.depth;
      const y = terrain.heights[iz * N + ix];
      positions[k * 3] = x;
      positions[k * 3 + 1] = y;
      positions[k * 3 + 2] = z;
      uvs[k * 2] = ix / (N - 1);
      uvs[k * 2 + 1] = iz / (N - 1);

      // 高度 + 坡度混合着色
      const t = THREE.MathUtils.clamp((y + 8) / 20, 0, 1);
      c.copy(low).lerp(mid, Math.min(1, t * 1.4));
      if (t > 0.65) c.lerp(high, (t - 0.65) / 0.35);
      colors[k * 3] = c.r;
      colors[k * 3 + 1] = c.g;
      colors[k * 3 + 2] = c.b;
      k++;
    }
  }

  for (let iz = 0; iz < N - 1; iz++) {
    for (let ix = 0; ix < N - 1; ix++) {
      const a = iz * N + ix;
      const b = a + 1;
      const d = a + N;
      const e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}
