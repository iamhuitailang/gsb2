/**
 * 三维场景视图：管理 three 渲染器、对象、材质纹理、表面拾取与笔画交互。
 */
import * as THREE from 'three';
import { PaintEngine, BrushSettings, StrokePoint } from '../core/paint-engine.js';
import { PaintMesh } from '../core/mesh.js';
import { Vec3 } from '../core/math3d.js';
import { OrbitController } from './orbit-controls.js';
import { compositeLayers, TextureLayer } from '../core/texture-layer.js';
import { uploadLayerToTexture } from './geometry-bridge.js';

export interface PaintableObject {
  id: string;
  name: string;
  format: 'obj' | 'gltf' | 'glb';
  root: THREE.Group;
  meshes: THREE.Mesh[];
  paintMesh: PaintMesh;
  engine: PaintEngine;
  materialNames: string[];
  /** 局部空间单位 -> 屏幕投影尺寸的换算半径（笔刷 UI 映射用） */
  worldRadius: number;
  textures: Map<string, THREE.DataTexture>;
  seamOverlay: THREE.LineSegments | null;
  files: Map<string, Uint8Array>;
}

export interface PointerHit {
  objectId: string;
  materialName: string;
  point: Vec3;
  triangle: number;
}

const SEAM_COLOR = 0xffa000;

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitController;

  private objects = new Map<string, PaintableObject>();
  private cursor: THREE.Mesh;
  private raf = 0;
  private disposed = false;

  /** 当前笔画状态 */
  private stroke: {
    object: PaintableObject;
    materialName: string;
  } | null = null;

  onStrokeEnd: (() => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x1e2126, 1);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
    this.camera.position.set(2, 2, 3);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.5);
    fill.position.set(-4, -2, -3);
    this.scene.add(fill);

    this.orbit = new OrbitController(this.camera, canvas);

    this.cursor = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.35,
        depthTest: true,
      }),
    );
    this.cursor.visible = false;
    this.scene.add(this.cursor);

    this.handleResize();
    window.addEventListener('resize', this.handleResize);
    this.loop();
  }

  listObjects(): PaintableObject[] {
    return [...this.objects.values()];
  }

  getObject(id: string): PaintableObject | undefined {
    return this.objects.get(id);
  }

  addObject(obj: PaintableObject, frame = true): void {
    this.objects.set(obj.id, obj);
    this.scene.add(obj.root);
    this.refreshAllTextures(obj);
    if (frame) this.frameObject(obj);
  }

  removeObject(id: string): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    this.scene.remove(obj.root);
    for (const tex of obj.textures.values()) tex.dispose();
    this.objects.delete(id);
  }

  frameObject(obj: PaintableObject): void {
    const box = new THREE.Box3().setFromObject(obj.root);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    this.orbit.frameObject(sphere.center, sphere.radius);
  }

  /** 高亮当前选中对象，其余对象压暗 */
  setHighlight(selectedId: string | null): void {
    for (const obj of this.objects.values()) {
      const selected = obj.id === selectedId;
      for (const mesh of obj.meshes) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const std = m as THREE.MeshStandardMaterial;
          if (std.color) std.color.setScalar(selected ? 1 : 0.62);
        }
      }
    }
  }

  // ---------- 纹理 ----------

  refreshAllTextures(obj: PaintableObject): void {
    for (const name of obj.materialNames) {
      this.refreshTexture(obj, name);
    }
  }

  refreshTexture(obj: PaintableObject, materialName: string): void {
    const state = obj.engine.getMaterialState(materialName);
    if (!state) return;
    const composited = new TextureLayer(
      state.resolution,
      state.resolution,
    );
    composited.data.set(compositeLayers(state.base, state.paint));
    const existing = obj.textures.get(materialName) ?? null;
    const tex = uploadLayerToTexture(composited, existing);
    obj.textures.set(materialName, tex);

    for (const mesh of obj.meshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const std = m as THREE.MeshStandardMaterial;
        // 加载时已将材质按名称挂好；这里把同名纹理贴上
        if (m.name === materialName || mats.length === 1) {
          std.map = tex;
          std.needsUpdate = true;
        }
      }
    }
  }

  /** 仅显示绘画层（调试图） */
  setPaintOnly(obj: PaintableObject, enabled: boolean): void {
    for (const name of obj.materialNames) {
      const state = obj.engine.getMaterialState(name);
      if (!state) continue;
      const layer = enabled ? state.paint : (() => {
        const c = new TextureLayer(state.resolution, state.resolution);
        c.data.set(compositeLayers(state.base, state.paint));
        return c;
      })();
      const tex = uploadLayerToTexture(layer, obj.textures.get(name) ?? null);
      obj.textures.set(name, tex);
      for (const mesh of obj.meshes) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          if (m.name === name || mats.length === 1) {
            (m as THREE.MeshStandardMaterial).map = tex;
          }
        }
      }
    }
  }

  // ---------- 接缝叠加 ----------

  buildSeamOverlay(obj: PaintableObject): void {
    this.removeSeamOverlay(obj);
    const edges = obj.paintMesh.detectSeam3DEdges();
    if (!edges.length) return;
    const positions = new Float32Array(edges.length * 6);
    edges.forEach(([a, b], i) => {
      positions.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: SEAM_COLOR });
    const lines = new THREE.LineSegments(geo, mat);
    obj.seamOverlay = lines;
    obj.root.add(lines);
  }

  removeSeamOverlay(obj: PaintableObject): void {
    if (obj.seamOverlay) {
      obj.root.remove(obj.seamOverlay);
      obj.seamOverlay.geometry.dispose();
      (obj.seamOverlay.material as THREE.Material).dispose();
      obj.seamOverlay = null;
    }
  }

  setSeamVisible(obj: PaintableObject, visible: boolean): void {
    if (!obj.seamOverlay && visible) this.buildSeamOverlay(obj);
    if (obj.seamOverlay) obj.seamOverlay.visible = visible;
  }

  // ---------- 拾取与绘制 ----------

  /**
   * 屏幕坐标 -> 命中对象表面（只在指定对象 / 材质上拾取）。
   */
  pick(
    clientX: number,
    clientY: number,
    target: PaintableObject,
    materialName: string,
  ): PointerHit | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);

    target.root.updateMatrixWorld(true);
    const inv = target.root.matrixWorld.clone().invert();
    const originLocal = raycaster.ray.origin.clone().applyMatrix4(inv);
    const dirLocal = raycaster.ray.direction
      .clone()
      .transformDirection(inv)
      .normalize();

    const hit = target.engine.raycast(
      { x: originLocal.x, y: originLocal.y, z: originLocal.z },
      { x: dirLocal.x, y: dirLocal.y, z: dirLocal.z },
      materialName,
    );
    if (!hit) return null;
    return {
      objectId: target.id,
      materialName,
      point: hit.point,
      triangle: hit.triangle,
    };
  }

  /** UI 的笔刷半径（相对模型尺寸 0..1 档）-> 局部空间半径 */
  localRadius(obj: PaintableObject, uiRadius: number): number {
    return uiRadius * obj.worldRadius;
  }

  beginPaint(
    obj: PaintableObject,
    materialName: string,
    brush: BrushSettings,
    hit: PointerHit,
    resolution: number,
  ): void {
    obj.engine.beginStroke(materialName, brush, resolution);
    this.stroke = { object: obj, materialName };
    this.applyStrokePoint(hit);
  }

  applyStrokePoint(hit: PointerHit): void {
    if (!this.stroke) return;
    const point: StrokePoint = { point: hit.point, triangle: hit.triangle };
    this.stroke.object.engine.addStrokePoint(point);
  }

  endPaint(): void {
    if (!this.stroke) return;
    const { object, materialName } = this.stroke;
    this.stroke = null;
    object.engine.endStroke();
    this.refreshTexture(object, materialName);
    this.onStrokeEnd?.();
  }

  get isPainting(): boolean {
    return this.stroke !== null;
  }

  /** 更新笔刷光标（局部点 + 局部半径） */
  updateCursor(
    obj: PaintableObject | null,
    localPoint: Vec3 | null,
    localRadius: number,
    eraser: boolean,
  ): void {
    if (!obj || !localPoint) {
      this.cursor.visible = false;
      return;
    }
    this.cursor.visible = true;
    const world = new THREE.Vector3(
      localPoint.x,
      localPoint.y,
      localPoint.z,
    ).applyMatrix4(obj.root.matrixWorld);
    this.cursor.position.copy(world);
    const worldScale = obj.root.getWorldScale(new THREE.Vector3());
    const s = localRadius * Math.max(worldScale.x, worldScale.y, worldScale.z);
    this.cursor.scale.setScalar(s);
    (this.cursor.material as THREE.MeshBasicMaterial).color.set(
      eraser ? 0x40c4ff : 0xffffff,
    );
  }

  hideCursor(): void {
    this.cursor.visible = false;
  }

  // ---------- 渲染循环 ----------

  private handleResize = (): void => {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.handleResize);
    this.orbit.dispose();
    for (const id of [...this.objects.keys()]) this.removeObject(id);
    this.renderer.dispose();
  }
}
