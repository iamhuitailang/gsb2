import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CameraData, NodeData } from '../core/types';
import type { DocChange, SceneDocument } from '../core/document';
import { createGeometry, createMaterial } from './geometry';

export interface PickHit {
  nodeId: string;
  distance: number;
}

/**
 * 渲染器：把 SceneDocument（数据源）投影到 three.js 场景。
 *
 * 同步策略（小型场景，追求简单可靠）：
 * - structure / load：整体重建 three 场景树
 * - transform：只更新对应对象的局部 TRS
 * - visibility：重算全部对象的有效可见性（父隐藏会连带子对象不可拾取）
 */
export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;
  readonly raycaster = new THREE.Raycaster();

  private objects = new Map<string, THREE.Object3D>();
  private outline: THREE.BoxHelper;
  private resizeObserver: ResizeObserver;
  private docUnsubscribe: () => void;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private doc: SceneDocument,
    initialCamera: CameraData,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(0x1e2430);

    this.camera = new THREE.PerspectiveCamera(
      initialCamera.fov,
      1,
      initialCamera.near,
      initialCamera.far,
    );
    this.applyCameraData(initialCamera);

    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.target.set(...initialCamera.target);
    this.orbit.update();

    this.setupLightsAndGrid();

    this.outline = new THREE.BoxHelper(new THREE.Object3D(), 0xffd54a);
    this.outline.visible = false;
    (this.outline.material as THREE.LineBasicMaterial).depthTest = false;
    this.outline.renderOrder = 999;
    this.scene.add(this.outline);

    this.rebuildAll();
    this.docUnsubscribe = doc.subscribe((change) => this.onDocChange(change));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  private setupLightsAndGrid(): void {
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x3a3326, 0.85);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(6, 10, 4);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.left = -12;
    dir.shadow.camera.right = 12;
    dir.shadow.camera.top = 12;
    dir.shadow.camera.bottom = -12;
    dir.shadow.camera.near = 0.5;
    dir.shadow.camera.far = 40;
    this.scene.add(dir);

    const ambient = new THREE.AmbientLight(0xffffff, 0.25);
    this.scene.add(ambient);

    const grid = new THREE.GridHelper(30, 30, 0x4a5568, 0x333c4b);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    this.scene.add(grid);

    const axes = new THREE.AxesHelper(1.6);
    axes.position.set(0, 0.001, 0);
    this.scene.add(axes);
  }

  // ---------- 文档 -> 渲染同步 ----------

  private onDocChange(change: DocChange): void {
    switch (change.type) {
      case 'structure':
      case 'load':
        this.rebuildAll();
        break;
      case 'transform':
        if (change.nodeIds) for (const id of change.nodeIds) this.updateObjectTRS(id);
        break;
      case 'visibility':
        this.refreshEffectiveVisibility();
        break;
      case 'rename':
      case 'selection':
        break; // 渲染不关心
    }
  }

  private rebuildAll(): void {
    // 移除旧对象（保留灯光/网格/gizmo 占位之外的所有节点对象）
    for (const obj of this.objects.values()) {
      obj.parent?.remove(obj);
      this.disposeObject(obj);
    }
    this.objects.clear();

    const build = (node: NodeData): THREE.Object3D => {
      const obj = this.createObject(node);
      this.writeTRS(obj, node);
      this.objects.set(node.id, obj);
      for (const childId of this.doc.getChildren(node.id)) {
        const childNode = this.doc.getNode(childId);
        if (childNode) obj.add(build(childNode));
      }
      return obj;
    };

    for (const rootId of this.doc.getChildren(null)) {
      const rootNode = this.doc.getNode(rootId);
      if (rootNode) this.scene.add(build(rootNode));
    }
    this.refreshEffectiveVisibility();
  }

  private createObject(node: NodeData): THREE.Object3D {
    if (!node.geometry) {
      const group = new THREE.Group();
      group.name = node.name;
      group.userData.nodeId = node.id;
      return group;
    }
    const mesh = new THREE.Mesh(
      createGeometry(node.geometry),
      node.material ? createMaterial(node.material) : createMaterial({ color: 0x9aa7bd }),
    );
    mesh.name = node.name;
    mesh.userData.nodeId = node.id;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private writeTRS(obj: THREE.Object3D, node: NodeData): void {
    obj.position.set(...node.position);
    obj.rotation.set(node.rotation[0], node.rotation[1], node.rotation[2], 'XYZ');
    obj.scale.set(...node.scale);
    obj.updateMatrix();
  }

  private updateObjectTRS(id: string): void {
    const obj = this.objects.get(id);
    const node = this.doc.getNode(id);
    if (!obj || !node) return;
    this.writeTRS(obj, node);
  }

  /** 有效可见性 = 自身可见且所有祖先可见 */
  private refreshEffectiveVisibility(): void {
    for (const [id, obj] of this.objects) {
      let visible = true;
      let cur: string | null = id;
      const guard = new Set<string>();
      while (cur !== null) {
        const node = this.doc.getNode(cur);
        if (!node || guard.has(cur)) {
          visible = false;
          break;
        }
        guard.add(cur);
        if (!node.visible) {
          visible = false;
          break;
        }
        cur = node.parentId;
      }
      obj.visible = visible;
    }
  }

  getObject(id: string): THREE.Object3D | undefined {
    return this.objects.get(id);
  }

  // ---------- 选择高亮 ----------

  setHighlight(id: string | null): void {
    if (!id) {
      this.outline.visible = false;
      return;
    }
    const obj = this.objects.get(id);
    if (!obj) {
      this.outline.visible = false;
      return;
    }
    this.outline.setFromObject(obj);
    this.outline.visible = true;
  }

  // ---------- 拾取 ----------

  /**
   * 屏幕坐标（CSS 像素）拾取，返回从前到后的命中节点。
   * 隐藏对象（含祖先被隐藏）在 three 射线检测中直接跳过，不会挡住后面的对象。
   */
  pick(clientX: number, clientY: number): PickHit[] {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);

    const roots = this.doc
      .getChildren(null)
      .map((id) => this.objects.get(id))
      .filter((o): o is THREE.Object3D => Boolean(o));
    const intersections = this.raycaster.intersectObjects(roots, true);

    const seen = new Set<string>();
    const hits: PickHit[] = [];
    for (const hit of intersections) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj && obj.userData.nodeId === undefined) obj = obj.parent;
      if (!obj) continue;
      const nodeId = obj.userData.nodeId as string;
      const node = this.doc.getNode(nodeId);
      // 双保险：three 已跳过 visible=false，这里再按文档有效可见性过滤
      if (!node || !this.isEffectivelyVisible(nodeId)) continue;
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      hits.push({ nodeId, distance: hit.distance });
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  isEffectivelyVisible(id: string): boolean {
    let cur: string | null = id;
    const guard = new Set<string>();
    while (cur !== null) {
      const node = this.doc.getNode(cur);
      if (!node || guard.has(cur)) return false;
      guard.add(cur);
      if (!node.visible) return false;
      cur = node.parentId;
    }
    return true;
  }

  // ---------- 相机 ----------

  getCameraData(): CameraData {
    const up = this.camera.up;
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.orbit.target.x, this.orbit.target.y, this.orbit.target.z],
      up: [up.x, up.y, up.z],
      fov: this.camera.fov,
      near: this.camera.near,
      far: this.camera.far,
    };
  }

  applyCameraData(data: CameraData): void {
    this.camera.position.set(...data.position);
    this.camera.up.set(...data.up);
    this.camera.fov = data.fov;
    this.camera.near = data.near;
    this.camera.far = data.far;
    this.camera.updateProjectionMatrix();
    if (this.orbit) {
      this.orbit.target.set(...data.target);
      this.orbit.update();
    }
  }

  // ---------- 渲染循环与尺寸 ----------

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 每帧调用；outline 跟随可能正在变换的对象更新 */
  renderFrame(): void {
    this.orbit.update();
    if (this.outline.visible) this.outline.update();
    this.renderer.render(this.scene, this.camera);
  }

  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
  }

  dispose(): void {
    this.docUnsubscribe();
    this.resizeObserver.disconnect();
    this.orbit.dispose();
    for (const obj of this.objects.values()) this.disposeObject(obj);
    this.outline.geometry.dispose();
    (this.outline.material as THREE.Material).dispose();
    this.renderer.dispose();
  }
}
