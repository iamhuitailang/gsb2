/**
 * Three.js BufferGeometry -> 核心 PaintMesh 转换，以及反向的纹理上传。
 */
import * as THREE from 'three';
import { PaintMesh, MaterialSlot } from '../core/mesh.js';
import { TextureLayer } from '../core/texture-layer.js';

export interface ConvertedMesh {
  paintMesh: PaintMesh;
  /** 三角面序号 -> three 几何组索引（材质槽） */
  groupOfTriangle: number[];
}

/**
 * 把 three 几何（position/uv/index/groups）转成可绘制网格。
 * 保持 three 的顶点拆分方式（接缝处位置相同、UV 不同的顶点本来就独立），
 * 因此 UV 接缝信息完整保留。
 */
export function convertGeometry(
  name: string,
  geometry: THREE.BufferGeometry,
): ConvertedMesh {
  const posAttr = geometry.getAttribute('position');
  const uvAttr = geometry.getAttribute('uv');
  if (!posAttr) throw new Error('几何缺少 position 属性');
  if (!uvAttr) throw new Error('几何缺少 UV：无法进行纹理绘制');

  const positions = new Float32Array(posAttr.array as Float32Array);
  const uvs = new Float32Array(uvAttr.array as Float32Array);

  let indices: Uint32Array;
  if (geometry.getIndex()) {
    const src = geometry.getIndex()!.array;
    indices = new Uint32Array(src.length);
    indices.set(src as ArrayLike<number>);
  } else {
    indices = new Uint32Array(posAttr.count);
    for (let i = 0; i < posAttr.count; i++) indices[i] = i;
  }

  const groups = geometry.groups.length ? geometry.groups : [
    { start: 0, count: indices.length, materialIndex: 0 },
  ];
  const slots: MaterialSlot[] = groups.map((g, i) => ({
    name: `material_${i}`,
    startTriangle: Math.floor(g.start / 3),
    triangleCount: Math.floor(g.count / 3),
  }));

  const paintMesh = new PaintMesh(name, positions, uvs, indices, slots);
  const groupOfTriangle: number[] = new Array(paintMesh.triangleCount);
  for (const g of groups) {
    const start = Math.floor(g.start / 3);
    const count = Math.floor(g.count / 3);
    const matIdx = g.materialIndex ?? 0;
    for (let t = start; t < start + count; t++) groupOfTriangle[t] = matIdx;
  }
  return { paintMesh, groupOfTriangle };
}

/**
 * 用材质名列表重写槽位名（加载器拿到真实材质名后调用）。
 */
export function renameMaterialSlots(
  mesh: PaintMesh,
  names: string[],
  groupOfTriangle: number[],
): void {
  const used = new Map<number, string>();
  mesh.materials.forEach((slot, i) => {
    const groupIndex = groupOfTriangle[slot.startTriangle] ?? i;
    used.set(groupIndex, names[groupIndex] ?? `material_${groupIndex}`);
  });
  mesh.materials.forEach((slot, i) => {
    const groupIndex = groupOfTriangle[slot.startTriangle] ?? i;
    slot.name = names[groupIndex] ?? `material_${groupIndex}`;
  });
}

/**
 * 把核心纹理像素上传为 three 纹理（flipY=false：我们已按图像行序存储）。
 */
export function uploadLayerToTexture(
  layer: TextureLayer,
  texture: THREE.DataTexture | null,
): THREE.DataTexture {
  if (texture && texture.image.width === layer.width) {
    texture.image.data.set(layer.data);
    texture.needsUpdate = true;
    return texture;
  }
  texture?.dispose();
  const tex = new THREE.DataTexture(
    new Uint8Array(layer.data),
    layer.width,
    layer.height,
    THREE.RGBAFormat,
  );
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
