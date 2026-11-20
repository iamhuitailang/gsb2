// 场景辅助对象：笔刷光圈、遮罩热力预览、分块边界线框。

import * as THREE from 'three';
import { CHUNK_SIZE } from '../core/constants.js';

export class BrushCursor {
  constructor() {
    const geo = new THREE.RingGeometry(0.96, 1, 64);
    geo.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthTest: false,
      }),
    );
    this.ring.renderOrder = 999;
    this.ring.visible = false;

    const fillGeo = new THREE.CircleGeometry(1, 48);
    fillGeo.rotateX(-Math.PI / 2);
    this.fill = new THREE.Mesh(
      fillGeo,
      new THREE.MeshBasicMaterial({
        color: 0x66ccff,
        transparent: true,
        opacity: 0.12,
        depthTest: false,
      }),
    );
    this.fill.renderOrder = 998;
    this.fill.visible = false;
  }

  get objects() {
    return [this.ring, this.fill];
  }

  show(x, y, z, radius, color) {
    for (const o of this.objects) o.visible = true;
    this.ring.position.set(x, y + 0.15, z);
    this.fill.position.set(x, y + 0.12, z);
    this.ring.scale.setScalar(radius);
    this.fill.scale.setScalar(radius);
    if (color !== undefined) {
      this.ring.material.color.set(color);
    }
  }

  hide() {
    for (const o of this.objects) o.visible = false;
  }
}

/** 遮罩热力图：半透明平面贴在地形上方，红通道表示遮罩强度。 */
export class MaskOverlay {
  /**
   * @param {import('../core/mask.js').PaintMask} mask
   * @param {import('../core/terrain.js').Terrain} terrain
   */
  constructor(mask, terrain) {
    this.mask = mask;
    this.terrain = terrain;
    const geo = new THREE.PlaneGeometry(mask.width, mask.depth, mask.nx - 1, mask.nz - 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        vertexColors: true,
      }),
    );
    this.mesh.visible = false;
    this.update();
  }

  update() {
    const { nx, nz } = this.mask;
    const colors = new Float32Array(nx * nz * 3);
    const positions = this.mesh.geometry.attributes.position;
    const cold = new THREE.Color(0x1e5fa8);
    const hot = new THREE.Color(0xff8a3d);
    const c = new THREE.Color();
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const v = this.mask.values[iz * nx + ix];
        const x = this.mask.minX + ix * this.mask.cellSize;
        const z = this.mask.minZ + iz * this.mask.cellSize;
        const idx = iz * nx + ix;
        positions.setY(idx, this.terrain.heightAt(x, z) + 0.1);
        c.copy(cold).lerp(hot, v);
        // 强度为 0 的格子完全透明：用颜色压暗 + 材质整体透明度近似
        colors[idx * 3] = c.r * (0.15 + 0.85 * v);
        colors[idx * 3 + 1] = c.g * (0.15 + 0.85 * v);
        colors[idx * 3 + 2] = c.b * (0.15 + 0.85 * v);
      }
    }
    this.mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }

  setVisible(v) {
    this.mesh.visible = v;
  }
}

/** 分块边界线框，用于直观验证分块显示与编辑。 */
export class ChunkGrid {
  constructor(terrain) {
    const points = [];
    const minX = terrain.minX;
    const minZ = terrain.minZ;
    const maxX = -minX;
    const maxZ = -minZ;
    for (let x = Math.ceil(minX / CHUNK_SIZE) * CHUNK_SIZE; x <= maxX; x += CHUNK_SIZE) {
      points.push(new THREE.Vector3(x, 0.2, minZ), new THREE.Vector3(x, 0.2, maxZ));
    }
    for (let z = Math.ceil(minZ / CHUNK_SIZE) * CHUNK_SIZE; z <= maxZ; z += CHUNK_SIZE) {
      points.push(new THREE.Vector3(minX, 0.2, z), new THREE.Vector3(maxX, 0.2, z));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    this.lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18 }),
    );
    this.lines.visible = false;
  }

  setVisible(v) {
    this.lines.visible = v;
  }
}
