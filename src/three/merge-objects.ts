/**
 * 把加载得到的一个对象（可能由多个 Mesh 组成）合并为单个可绘制网格，
 * 所有顶点变换到对象根节点的局部空间，材质按名称去重。
 */
import * as THREE from 'three';
import { MaterialSlot, PaintMesh } from '../core/mesh.js';

export interface MergedObject {
  paintMesh: PaintMesh;
  /** 去重后的材质名（顺序即 geometry group 顺序） */
  materialNames: string[];
}

export function mergeObjectMeshes(
  name: string,
  root: THREE.Object3D,
  meshes: THREE.Mesh[],
  fallbackMaterialNames: Map<THREE.Mesh, string[]>,
): MergedObject {
  root.updateMatrixWorld(true);
  const invRoot = root.matrixWorld.clone().invert();

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const materialNames: string[] = [];
  const slots: MaterialSlot[] = [];
  const nameIndex = new Map<string, number>();

  let vertexOffset = 0;
  let triangleOffset = 0;

  for (const mesh of meshes) {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
    if (!posAttr || !uvAttr) continue;

    // mesh 世界坐标 -> 根节点局部
    const toRoot = mesh.matrixWorld.clone().multiply(invRoot);
    const v = new THREE.Vector3();
    const vertexCount = posAttr.count;
    const localIndex: number[] = new Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(toRoot);
      positions.push(v.x, v.y, v.z);
      uvs.push(uvAttr.getX(i), uvAttr.getY(i));
      localIndex[i] = vertexOffset + i;
    }

    const srcIndex = geometry.getIndex();
    const groups = geometry.groups.length
      ? geometry.groups
      : [{ start: 0, count: srcIndex ? srcIndex.count : vertexCount, materialIndex: 0 }];

    const fallback = fallbackMaterialNames.get(mesh) ?? [];
    // 该 mesh 各 group 对应的全局材质序号
    const groupGlobalIndex = groups.map((g) => {
      const materialIndex = g.materialIndex ?? 0;
      const matName = fallback[materialIndex] || `material_${materialIndex}`;
      let gi = nameIndex.get(matName);
      if (gi === undefined) {
        gi = materialNames.length;
        nameIndex.set(matName, gi);
        materialNames.push(matName);
      }
      return gi;
    });

    for (const g of groups) {
      const triCount = g.count / 3;
      slots.push({
        name: materialNames[groupGlobalIndex[g.materialIndex ?? 0]],
        startTriangle: triangleOffset,
        triangleCount: triCount,
      });
      for (let k = 0; k < g.count; k++) {
        const src = srcIndex ? srcIndex.getX(g.start + k) : g.start + k;
        indices.push(localIndex[src]);
      }
      triangleOffset += triCount;
    }
    vertexOffset += vertexCount;
  }

  // 同材质的 slot 在 PaintMesh 构造后保持原样（queryTrianglesInSphere 按名称过滤即可）
  const paintMesh = new PaintMesh(
    name,
    Float32Array.from(positions),
    Float32Array.from(uvs),
    Uint32Array.from(indices),
    slots,
  );
  return { paintMesh, materialNames };
}
