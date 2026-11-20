// Three.js 三维视图：自定义轨道控制、原始/候选叠加与分屏、
// 偏差热力图、区域拾取（返回简化网格顶点标记）。
import * as THREE from '../../vendor/three.module.js';
import { Mesh as CoreMesh } from '../core/mesh.js';

// 偏差热力配色：蓝(小) → 青 → 绿 → 黄 → 红(大)
const HEAT_STOPS = [
  [0.0, [0.13, 0.45, 0.85]],
  [0.25, [0.10, 0.75, 0.80]],
  [0.5, [0.30, 0.78, 0.35]],
  [0.75, [0.95, 0.75, 0.20]],
  [1.0, [0.90, 0.20, 0.20]],
];

function heatColor(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < HEAT_STOPS.length - 1; i++) {
    const [t0, c0] = HEAT_STOPS[i];
    const [t1, c1] = HEAT_STOPS[i + 1];
    if (t <= t1) {
      const k = (t - t0) / (t1 - t0);
      return [
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k,
      ];
    }
  }
  return HEAT_STOPS.at(-1)[1];
}

function coreToThree(mesh) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.positions), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
  if (mesh.normals) {
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(mesh.normals), 3));
  } else {
    geometry.computeVertexNormals();
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

// 轻量轨道控制（旋转 / 平移 / 缩放），不依赖 examples/jsm
class OrbitController {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.target = new THREE.Vector3(0, 0, 0);
    this.spherical = new THREE.Spherical();
    this.minDistance = 0.05;
    this.maxDistance = 200;
    this.state = null;
    this.last = { x: 0, y: 0 };
    this.onPick = null; // 单击无拖拽时触发

    dom.addEventListener('pointerdown', (e) => this._down(e));
    window.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', (e) => this._up(e));
    dom.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    this.syncFromCamera();
  }
  syncFromCamera() {
    const offset = this.camera.position.clone().sub(this.target);
    this.spherical.setFromVector3(offset);
  }
  fit(box) {
    const center = box.getCenter(new THREE.Vector3());
    const sizeVec = box.getSize(new THREE.Vector3());
    const size = sizeVec.length();
    this.target.copy(center);
    const dir = new THREE.Vector3(1, 0.7, 1).normalize();
    // 垂直方向可视高度 = 2d·tan(fov/2)；水平方向再乘 aspect。取两者约束的较大距离。
    const vFov = (this.camera.fov * Math.PI) / 180;
    const aspect = Math.max(0.2, this.camera.aspect);
    const distByHeight = size / (2 * Math.tan(vFov / 2));
    const distByWidth = size / (2 * Math.tan(vFov / 2) * aspect);
    const dist = Math.max(distByHeight, distByWidth) * 1.3 || 2;
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 1000, 1e-4);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(center);
    this.syncFromCamera();
  }
  _down(e) {
    this.state = e.button === 2 || e.shiftKey ? 'pan' : 'rotate';
    this.last = { x: e.clientX, y: e.clientY };
    this.downPos = { x: e.clientX, y: e.clientY };
    this.dom.setPointerCapture?.(e.pointerId);
  }
  _move(e) {
    if (!this.state) return;
    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    this.last = { x: e.clientX, y: e.clientY };
    if (this.state === 'rotate') {
      this.spherical.theta -= dx * 0.008;
      this.spherical.phi -= dy * 0.008;
      this.spherical.phi = Math.max(0.02, Math.min(Math.PI - 0.02, this.spherical.phi));
    } else {
      const scale = this.spherical.radius * 0.0016;
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
      this.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
    }
    this._apply();
  }
  _up(e) {
    const moved = this.downPos ? Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) : 0;
    this.state = null;
    if (moved < 4 && e.button === 0 && this.onPick) this.onPick(e);
  }
  _wheel(e) {
    e.preventDefault();
    this.spherical.radius *= Math.exp(e.deltaY * 0.0012);
    this.spherical.radius = Math.max(this.minDistance, Math.min(this.maxDistance, this.spherical.radius));
    this._apply();
  }
  _apply() {
    const offset = new THREE.Vector3().setFromSpherical(this.spherical).add(this.target);
    this.camera.position.copy(offset);
    this.camera.lookAt(this.target);
  }
}

export class Viewer {
  constructor(container) {
    this.container = container;
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(0x14171c, 1);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 500);
    this.camera.position.set(2.5, 1.8, 2.5);

    // 分屏时用两个独立相机，左相机驱动控制，右相机同步姿态
    this.cameraB = new THREE.PerspectiveCamera(50, width / height, 0.01, 500);

    this.controller = new OrbitController(this.camera, this.renderer.domElement);
    this.controller._apply = this.controller._apply.bind(this.controller);
    const origApply = this.controller._apply;
    this.controller._apply = () => { origApply(); this._syncCameraB(); };

    // 灯光
    const hemi = new THREE.HemisphereLight(0xffffff, 0x3a4150, 1.1);
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(3, 5, 4);
    this.scene.add(hemi, dir);

    // 地面网格默认隐藏：程序化模型常偏离原点，固定网格反而误导；需要时可在控制台开启
    const grid = new THREE.GridHelper(10, 20, 0x3a4150, 0x23272e);
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    grid.visible = false;
    this.scene.add(grid);
    this.gridHelper = grid;

    this.originalObject = null;
    this.candidateObject = null;
    this.regionMarker = null;
    this.mode = 'overlay';
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.onRegionPicked = null;

    this.controller.onPick = (e) => this._handlePick(e);
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(container);
    this._loop();
  }

  _syncCameraB() {
    this.cameraB.position.copy(this.camera.position);
    this.cameraB.quaternion.copy(this.camera.quaternion);
    this.cameraB.near = this.camera.near;
    this.cameraB.far = this.camera.far;
    this.cameraB.projectionMatrix.copy(this.camera.projectionMatrix);
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.cameraB.aspect = w / h;
    this.cameraB.updateProjectionMatrix();
  }

  /**
   * 更新显示内容。
   * @param {CoreMesh|null} originalMesh
   * @param {CoreMesh|null} candidateMesh
   * @param {object} settings
   */
  setContent(originalMesh, candidateMesh, settings) {
    this._disposeObject(this.originalObject);
    this._disposeObject(this.candidateObject);
    this.originalObject = null;
    this.candidateObject = null;
    this.regionMarker = null;
    this.settings = settings;
    this.mode = settings.mode;

    let box = null;
    if (originalMesh) {
      this.originalObject = this._buildObject(originalMesh, {
        color: 0x4fa3ff,
        opacity: settings.originalOpacity,
        wireframe: settings.showWireframe,
      });
      this.originalObject.userData.role = 'original';
      this.scene.add(this.originalObject);
      box = this.originalObject.userData.solid.geometry.boundingBox.clone();
    }
    if (candidateMesh) {
      this.candidateObject = this._buildObject(candidateMesh, {
        color: 0xff8c42,
        opacity: 0.95,
        wireframe: settings.showWireframe,
      });
      this.candidateObject.userData.role = 'candidate';
      this.candidateObject.userData.coreMesh = candidateMesh;
      this.scene.add(this.candidateObject);
      const cBox = this.candidateObject.userData.solid.geometry.boundingBox;
      box = box ? box.union(cBox) : cBox.clone();
      if (settings.showHeatmap) this.applyHeatmap(candidateMesh, this._lastDeviation || null);
    }

    if (box && box.isBox3) {
      const size = box.getSize(new THREE.Vector3()).length();
      this.gridHelper.scale.setScalar(Math.max(1, size / 5));
      this.controller.fit(box);
      this._syncCameraB();
    }
  }

  /** 保存偏差数组，供热力图与拾取复用。 */
  setDeviation(perVertexBackward) {
    this._lastDeviation = perVertexBackward;
  }

  applyHeatmap(candidateMesh, perVertexBackward) {
    if (!this.candidateObject || !perVertexBackward) return;
    const solid = this.candidateObject.userData.solid;
    const geo = solid.geometry;
    const n = candidateMesh.vertexCount;
    let max = 1e-12;
    for (const d of perVertexBackward) if (d > max) max = d;
    const colors = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) {
      const [r, g, b] = heatColor(perVertexBackward[v] / max);
      colors[v * 3] = r; colors[v * 3 + 1] = g; colors[v * 3 + 2] = b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    solid.material.vertexColors = true;
    solid.material.needsUpdate = true;
  }

  clearHeatmap() {
    if (!this.candidateObject) return;
    const solid = this.candidateObject.userData.solid;
    solid.geometry.deleteAttribute('color');
    solid.material.vertexColors = false;
    solid.material.needsUpdate = true;
  }

  _buildObject(coreMesh, { color, opacity, wireframe }) {
    const geometry = coreToThree(coreMesh);
    const material = new THREE.MeshStandardMaterial({
      color,
      transparent: opacity < 1,
      opacity,
      side: THREE.DoubleSide,
      roughness: 0.75,
      metalness: 0.05,
      depthWrite: opacity >= 0.9,
    });
    const group = new THREE.Group();
    const solid = new THREE.Mesh(geometry, material);
    group.add(solid);
    if (wireframe) {
      const wire = new THREE.LineSegments(
        new THREE.WireframeGeometry(geometry),
        new THREE.LineBasicMaterial({ color: 0x101318, transparent: true, opacity: 0.45 })
      );
      group.add(wire);
      group.userData.wireframe = wire;
    }
    group.userData.solid = solid;
    return group;
  }

  toggleOriginal(visible) {
    if (this.originalObject) this.originalObject.visible = visible;
  }

  setOriginalOpacity(opacity) {
    if (this.originalObject) {
      const mat = this.originalObject.userData.solid.material;
      mat.opacity = opacity;
      mat.transparent = opacity < 1;
      mat.depthWrite = opacity >= 0.9;
      mat.needsUpdate = true;
    }
  }

  toggleWireframe(on) {
    for (const obj of [this.originalObject, this.candidateObject]) {
      if (!obj) continue;
      const wire = obj.userData.wireframe;
      if (wire) wire.visible = on;
    }
  }

  setSplitMode(mode) {
    this.mode = mode;
    if (mode === 'split') {
      if (this.originalObject) this.originalObject.position.x = -1.25;
      if (this.candidateObject) this.candidateObject.position.x = 1.25;
      if (this.originalObject) this.originalObject.visible = true;
      if (this.candidateObject) this.candidateObject.visible = true;
    } else {
      if (this.originalObject) this.originalObject.position.set(0, 0, 0);
      if (this.candidateObject) this.candidateObject.position.set(0, 0, 0);
    }
  }

  _handlePick(event) {
    if (!this.candidateObject || !this.onRegionPicked) return;
    if (this.mode === 'split') {
      // 分屏时候选只渲染在右视口，拾取语义不直观，交由叠加模式处理
      this.onRegionPicked({ unsupported: true });
      return;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.mode === 'split' ? this.cameraB : this.camera);
    const solid = this.candidateObject.userData.solid;
    const hits = this.raycaster.intersectObject(solid, false);
    if (!hits.length) {
      this.onRegionPicked(null);
      return;
    }
    const hit = hits[0];
    const coreMesh = this.candidateObject.userData.coreMesh;
    // 命中面的三个顶点为种子，沿邻接关系扩展为一块区域
    const faceIndex = hit.face.materialIndex !== undefined ? hit.faceIndex : hit.faceIndex;
    const region = this._growRegion(coreMesh, hit.faceIndex, 12);
    this._showMarker(hit.point);
    this.onRegionPicked({ region, point: [hit.point.x, hit.point.y, hit.point.z], faceIndex });
  }

  /** 从种子面出发，按邻接面数上限扩展，输出顶点 0/1 标记。 */
  _growRegion(coreMesh, seedFace, maxRingFaces) {
    const n = coreMesh.vertexCount;
    const idx = coreMesh.indices;
    const edgeToFaces = new Map();
    for (let f = 0; f < coreMesh.faceCount; f++) {
      const tri = [idx[f * 3], idx[f * 3 + 1], idx[f * 3 + 2]];
      const edges = [[tri[0], tri[1]], [tri[1], tri[2]], [tri[0], tri[2]]];
      for (const [a, b] of edges) {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (!edgeToFaces.has(key)) edgeToFaces.set(key, []);
        edgeToFaces.get(key).push(f);
      }
    }
    const faceMark = new Uint8Array(coreMesh.faceCount);
    const queue = [seedFace];
    faceMark[seedFace] = 1;
    let taken = 0;
    while (queue.length && taken < maxRingFaces) {
      const f = queue.shift();
      taken++;
      const tri = [idx[f * 3], idx[f * 3 + 1], idx[f * 3 + 2]];
      for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[0], tri[2]]]) {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        for (const nf of edgeToFaces.get(key) || []) {
          if (!faceMark[nf]) { faceMark[nf] = 1; queue.push(nf); }
        }
      }
    }
    const region = new Uint8Array(n);
    for (let f = 0; f < coreMesh.faceCount; f++) {
      if (!faceMark[f]) continue;
      region[idx[f * 3]] = 1;
      region[idx[f * 3 + 1]] = 1;
      region[idx[f * 3 + 2]] = 1;
    }
    return region;
  }

  _showMarker(point) {
    if (this.regionMarker) this.scene.remove(this.regionMarker);
    const geo = new THREE.SphereGeometry(0.03, 16, 12);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffe14d });
    this.regionMarker = new THREE.Mesh(geo, mat);
    this.regionMarker.position.copy(point);
    this.scene.add(this.regionMarker);
  }

  clearRegion() {
    if (this.regionMarker) {
      this.scene.remove(this.regionMarker);
      this.regionMarker.geometry.dispose();
      this.regionMarker.material.dispose();
      this.regionMarker = null;
    }
  }

  _disposeObject(obj) {
    if (!obj) return;
    this.scene.remove(obj);
    obj.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => m.dispose());
      }
    });
  }

  _loop() {
    requestAnimationFrame(() => this._loop());
    if (!this.renderer) return;
    if (this.mode === 'split' && this.originalObject && this.candidateObject) {
      const w = this.container.clientWidth, h = this.container.clientHeight;
      this.renderer.setScissorTest(true);
      // 左：原始
      this.renderer.setViewport(0, 0, w / 2, h);
      this.renderer.setScissor(0, 0, w / 2, h);
      this.camera.aspect = (w / 2) / h;
      this.camera.updateProjectionMatrix();
      this.candidateObject.visible = false;
      this.renderer.render(this.scene, this.camera);
      // 右：候选
      this.renderer.setViewport(w / 2, 0, w / 2, h);
      this.renderer.setScissor(w / 2, 0, w / 2, h);
      this.cameraB.aspect = (w / 2) / h;
      this.cameraB.updateProjectionMatrix();
      this.originalObject.visible = false;
      this.candidateObject.visible = true;
      this.renderer.render(this.scene, this.cameraB);
      // 还原可见性
      this.originalObject.visible = this.settings?.showOriginal !== false;
      this.candidateObject.visible = true;
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, w, h);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}
