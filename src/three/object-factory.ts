/**
 * 把 LoadedObject 包装成 PaintableObject：
 * 合并几何、建立 PaintEngine、按材质名重建 three 材质并准备纹理槽。
 */
import * as THREE from 'three';
import { PaintEngine } from '../core/paint-engine.js';
import { LoadedObject } from './model-loader.js';
import { mergeObjectMeshes } from './merge-objects.js';
import { PaintableObject } from './scene-view.js';
import { readTextureToTextureLayerSafe } from './texture-io.js';

let idCounter = 0;

export async function createPaintableObject(
  loaded: LoadedObject,
  defaultResolution: number,
): Promise<PaintableObject> {
  const fallbackNames = new Map<THREE.Mesh, string[]>();
  for (const m of loaded.meshes) {
    fallbackNames.set(m.mesh, m.materialNames);
  }

  const { paintMesh, materialNames } = mergeObjectMeshes(
    loaded.name,
    loaded.root,
    loaded.meshes.map((m) => m.mesh),
    fallbackNames,
  );

  const engine = new PaintEngine(paintMesh);
  for (const name of materialNames) {
    engine.ensureMaterial(name, defaultResolution);
  }

  // three 侧：统一材质名，确保每个网格的材质数组与 group 对齐
  for (const entry of loaded.meshes) {
    const geometry = entry.mesh.geometry as THREE.BufferGeometry;
    const groups = geometry.groups.length
      ? geometry.groups
      : [{ materialIndex: 0 }];
    const oldMats = Array.isArray(entry.mesh.material)
      ? entry.mesh.material
      : [entry.mesh.material];
    const newMats = groups.map((g) => {
      const materialIndex = g.materialIndex ?? 0;
      const name = entry.materialNames[materialIndex] ?? oldMats[materialIndex]?.name ?? `material_${materialIndex}`;
      const mat = new THREE.MeshStandardMaterial({
        name,
        color: 0xffffff,
        roughness: 0.85,
        metalness: 0,
      });
      return mat;
    });
    entry.mesh.material = newMats.length === 1 ? newMats[0] : newMats;
  }

  // 模型自带贴图 -> 基础纹理层
  for (const name of materialNames) {
    const tex = loaded.embeddedTextures.get(name);
    if (!tex) continue;
    const state = engine.getMaterialState(name)!;
    const layer = await readTextureToTextureLayerSafe(tex, state.resolution);
    if (layer) engine.setBaseTexture(name, layer);
  }

  // 局部空间包围球半径
  const box = paintMesh.bbox;
  const size = {
    x: box.max.x - box.min.x,
    y: box.max.y - box.min.y,
    z: box.max.z - box.min.z,
  };
  const worldRadius = Math.max(size.x, size.y, size.z) / 2 || 1;

  return {
    id: `obj_${++idCounter}`,
    name: loaded.name,
    format: loaded.format,
    root: loaded.root,
    meshes: loaded.meshes.map((m) => m.mesh),
    paintMesh,
    engine,
    materialNames,
    worldRadius,
    textures: new Map(),
    seamOverlay: null,
    files: loaded.files,
  };
}
