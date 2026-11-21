// 导出表面网格。只包含实心体素表面(不含区块边界、轮廓线等辅助对象),
// 顶点位置就是世界坐标(单位=1 格), 顶点颜色与预览一致。

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 导出 OBJ(含顶点颜色, 用 v x y z r g b 扩展格式, Blender/meshlab 可识别)。
 * 非索引展开, 每个面 3 个顶点, 保证颜色逐顶点正确。
 */
export function exportOBJ(group, filename = 'voxel-surface.obj') {
  const lines = ['# voxel surface export'];
  let vertexOffset = 0;

  group.updateMatrixWorld(true);
  group.traverse((mesh) => {
    if (!mesh.isMesh || mesh.geometry.getAttribute('position') === undefined) return;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const col = geo.getAttribute('color');
    const idx = geo.getIndex();

    const p = new THREE.Vector3();
    const writeVertex = (i) => {
      p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const r = col ? col.getX(i) : 1;
      const g = col ? col.getY(i) : 1;
      const b = col ? col.getZ(i) : 1;
      lines.push(
        `v ${p.x.toFixed(4)} ${p.y.toFixed(4)} ${p.z.toFixed(4)} ` +
          `${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}`
      );
    };

    lines.push(`g ${mesh.name || 'voxel'}`);
    if (idx) {
      for (let i = 0; i < idx.count; i++) writeVertex(idx.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) writeVertex(i);
    }
    for (let i = 0; i < (idx ? idx.count : pos.count); i += 3) {
      // OBJ 索引从 1 开始, winding 保持与 three 一致
      lines.push(`f ${vertexOffset + i + 1} ${vertexOffset + i + 2} ${vertexOffset + i + 3}`);
    }
    vertexOffset += idx ? idx.count : pos.count;
  });

  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
  downloadBlob(blob, filename);
}

export function exportGLB(group, filename = 'voxel-surface.glb') {
  const exporter = new GLTFExporter();
  exporter.parse(
    group,
    (result) => {
      downloadBlob(new Blob([result], { type: 'model/gltf-binary' }), filename);
    },
    (err) => console.error('GLB 导出失败', err),
    { binary: true }
  );
}

// ---- 工程文件存取(JSON) ----

export function downloadProject(world, filename = 'voxel-project.json') {
  const blob = new Blob([JSON.stringify(world.serialize(), null, 2)], {
    type: 'application/json',
  });
  downloadBlob(blob, filename);
}

export function pickProjectFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('未选择文件'));
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(reader.result));
        } catch (e) {
          reject(new Error('JSON 解析失败: ' + e.message));
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    };
    input.click();
  });
}
