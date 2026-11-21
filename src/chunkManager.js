// 管理每个区块对应的 Three.js 对象:
// 实心表面网格 + 体素轮廓网格线 + 区块边界盒;
// 只重建被标记的区块, 远处未变动的区块对象原样保留。

import * as THREE from 'three';
import { CHUNK, chunkKey, parseChunkKey } from './world.js';
import { buildChunkMesh } from './mesher.js';

const BOUNDARY_COLOR = 0x4aa3ff;
const HIGHLIGHT_COLOR = 0xffc83d;
const HIGHLIGHT_DURATION = 1.6; // 秒

export class ChunkManager {
  constructor(world, scene) {
    this.world = world;
    this.scene = scene;
    this.groups = new Map(); // key -> THREE.Group
    this.highlightUntil = new Map(); // key -> 时间戳(秒)
    this.showBoundaries = true;
    this.showGrid = true;

    this.solidMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.02,
      // 把表面深度往后推一点, 让共面的轮廓线稳定显示在上面
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.gridMaterial = new THREE.LineBasicMaterial({
      color: 0x111418,
      transparent: true,
      opacity: 0.35,
    });
    this.boundaryMaterial = new THREE.LineBasicMaterial({
      color: BOUNDARY_COLOR,
      transparent: true,
      opacity: 0.5,
    });

    this._boxTemplate = this._makeChunkBox();
  }

  _makeChunkBox() {
    const box = new THREE.BoxGeometry(CHUNK, CHUNK, CHUNK);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    return edges;
  }

  /** 重建一组区块; 已删空的区块会被整体移除, 不会残留旧表面。 */
  remesh(keys, now) {
    const stats = { rebuilt: 0, removed: 0 };
    for (const key of keys) {
      const existed = this.groups.has(key);
      this._disposeGroup(key);
      const [cx, cy, cz] = parseChunkKey(key);
      const chunk = this.world.getChunk(cx, cy, cz);
      if (!chunk) {
        // 只统计场景里确实存在、此刻被销毁的旧网格(本来就没建过网格的空区块不算)
        if (existed) stats.removed++;
        continue;
      }
      const data = buildChunkMesh(chunk, this.world);
      const group = new THREE.Group();
      group.name = `chunk-${key}`;
      group.userData.rawFaceCount = data.rawFaceCount;
      group.userData.quadCount = data.quadCount;

      if (data.indices.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
        geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, this.solidMaterial);
        mesh.name = 'solid';
        group.add(mesh);

        if (data.gridPositions.length > 0) {
          const lineGeo = new THREE.BufferGeometry();
          lineGeo.setAttribute(
            'position',
            new THREE.BufferAttribute(data.gridPositions, 3)
          );
          const lines = new THREE.LineSegments(lineGeo, this.gridMaterial);
          lines.name = 'grid';
          lines.visible = this.showGrid;
          group.add(lines);
        }
      }

      // 每区块独立材质, 高亮衰减动画互不影响
      const boundary = new THREE.LineSegments(
        this._boxTemplate,
        this.boundaryMaterial.clone()
      );
      boundary.name = 'boundary';
      boundary.position.set(
        cx * CHUNK + CHUNK / 2,
        cy * CHUNK + CHUNK / 2,
        cz * CHUNK + CHUNK / 2
      );
      boundary.visible = this.showBoundaries;
      group.add(boundary);

      this.groups.set(key, group);
      this.scene.add(group);
      this.highlightUntil.set(key, (now ?? performance.now() / 1000) + HIGHLIGHT_DURATION);
      stats.rebuilt++;
    }
    return stats;
  }

  /** 载入新工程时替换世界引用并清掉旧对象。 */
  setWorld(world) {
    for (const key of [...this.groups.keys()]) this._disposeGroup(key);
    this.groups.clear();
    this.highlightUntil.clear();
    this.world = world;
  }

  /** 全量重建(载入工程/样例时用)。 */
  rebuildAll(now) {
    for (const key of this.groups.keys()) this._disposeGroup(key);
    this.groups.clear();
    this.highlightUntil.clear();
    return this.remesh([...this.world.chunks.keys()], now);
  }

  _disposeGroup(key) {
    const group = this.groups.get(key);
    if (!group) return;
    this.scene.remove(group);
    group.traverse((obj) => {
      if (obj.geometry && obj.geometry !== this._boxTemplate) obj.geometry.dispose();
      if (obj.material && obj.material !== this.boundaryMaterial &&
          obj.material !== this.gridMaterial && obj.material !== this.solidMaterial) {
        obj.material.dispose();
      }
    });
    this.groups.delete(key);
    this.highlightUntil.delete(key);
  }

  setShowBoundaries(on) {
    this.showBoundaries = on;
    for (const group of this.groups.values()) {
      const b = group.getObjectByName('boundary');
      if (b) b.visible = on;
    }
  }

  setShowGrid(on) {
    this.showGrid = on;
    for (const group of this.groups.values()) {
      const g = group.getObjectByName('grid');
      if (g) g.visible = on;
    }
  }

  /** 高亮衰减动画, 每帧调用。 */
  tick(now) {
    const normal = new THREE.Color(BOUNDARY_COLOR);
    const hot = new THREE.Color(HIGHLIGHT_COLOR);
    for (const [key, until] of this.highlightUntil) {
      const group = this.groups.get(key);
      if (!group) continue;
      const boundary = group.getObjectByName('boundary');
      if (!boundary) continue;
      const remain = until - now;
      if (remain <= 0) {
        boundary.material.color.copy(normal);
        boundary.material.opacity = 0.5;
        this.highlightUntil.delete(key);
      } else {
        const k = Math.min(1, remain / HIGHLIGHT_DURATION);
        boundary.material.color.copy(normal).lerp(hot, k);
        boundary.material.opacity = 0.5 + 0.45 * k;
      }
    }
  }

  /** 当前场景内表面统计(按实际存在的区块网格累加)。 */
  stats() {
    let rawFaceCount = 0;
    let quadCount = 0;
    for (const group of this.groups.values()) {
      rawFaceCount += group.userData.rawFaceCount || 0;
      quadCount += group.userData.quadCount || 0;
    }
    return {
      chunkCount: this.groups.size,
      voxelCount: this.world.voxelCount(),
      rawFaceCount,
      quadCount,
      triangleCount: quadCount * 2,
    };
  }

  /**
   * 收集仅含非辅助实心表面的导出组(不含边界盒/轮廓线/高亮),
   * 尺寸与顶点颜色与预览中的实心部分完全一致。
   */
  collectExportGroup() {
    const exportGroup = new THREE.Group();
    exportGroup.name = 'voxel-export';
    for (const group of this.groups.values()) {
      const solid = group.getObjectByName('solid');
      if (solid) {
        const clone = new THREE.Mesh(solid.geometry, this.solidMaterial);
        exportGroup.add(clone);
      }
    }
    return exportGroup;
  }

  dispose() {
    for (const key of [...this.groups.keys()]) this._disposeGroup(key);
    this._boxTemplate.dispose();
    this.solidMaterial.dispose();
    this.gridMaterial.dispose();
    this.boundaryMaterial.dispose();
  }
}
