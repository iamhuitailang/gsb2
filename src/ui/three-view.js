// Three.js 3D 视图：轨道控制、射线选面、选中/切缝高亮。
// 选区是面索引集合，存在应用状态里，相机怎么旋转都不会丢失。

import * as THREE from 'three';

const HIGHLIGHT_COLOR = new THREE.Color(0x4ea1ff);
const SEAM_COLOR = new THREE.Color(0xff6b6b);

export class ThreeView {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.cb = callbacks;
    this.faceSet = new Set();
    this.seamSet = new Set();
    this.mode = 'select';

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x17191e);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 500);
    this.target = new THREE.Vector3();
    this.sphere = { radius: 4, theta: Math.PI * 0.25, phi: Math.PI * 0.35 };
    this._updateCamera();

    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2d33, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(5, 8, 6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    fill.position.set(-6, -3, -4);
    this.scene.add(fill);

    this.meshGroup = new THREE.Group();
    this.scene.add(this.meshGroup);
    this.grid = new THREE.GridHelper(10, 20, 0x3a404b, 0x2a2e35);
    this.grid.position.y = -1.01;
    this.scene.add(this.grid);

    this._bindControls();
    this._onResize = () => this.resize();
    new ResizeObserver(this._onResize).observe(canvas.parentElement);
    this.resize();
    this._loop();
  }

  /** 载入/替换网格。 */
  setMesh(mesh) {
    this.mesh = mesh;
    this.meshGroup.clear();
    const geo = new THREE.BufferGeometry();
    const pos = [];
    for (const f of mesh.faces) for (const vi of f) pos.push(...mesh.positions[vi]);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();

    // 按面材质着色（非索引几何，逐面设置颜色）
    const colors = new Float32Array(pos.length);
    const color = new THREE.Color();
    for (let f = 0; f < mesh.faces.length; f++) {
      const matName = mesh.faceMaterials[f] ?? 'default';
      const diffuse = mesh.materials[matName]?.diffuse ?? [0.6, 0.6, 0.6];
      color.setRGB(diffuse[0], diffuse[1], diffuse[2]);
      for (let k = 0; k < 3; k++) {
        colors[(f * 3 + k) * 3] = color.r;
        colors[(f * 3 + k) * 3 + 1] = color.g;
        colors[(f * 3 + k) * 3 + 2] = color.b;
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, side: THREE.DoubleSide, flatShading: true,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    this.meshObj = new THREE.Mesh(geo, mat);
    this.meshGroup.add(this.meshObj);

    // 线框
    const edges = new THREE.EdgesGeometry(geo, 30);
    this.edgeLines = new THREE.LineSegments(
      edges, new THREE.LineBasicMaterial({ color: 0x111318, transparent: true, opacity: 0.9 }));
    this.meshGroup.add(this.edgeLines);

    // 高亮覆盖层（选中面）
    this.highlightGeo = new THREE.BufferGeometry();
    this.highlightMesh = new THREE.Mesh(
      this.highlightGeo,
      new THREE.MeshBasicMaterial({ color: HIGHLIGHT_COLOR, transparent: true, opacity: 0.45, side: THREE.DoubleSide }));
    this.meshGroup.add(this.highlightMesh);

    // 切缝线
    this.seamGeo = new THREE.BufferGeometry();
    this.seamLines = new THREE.LineSegments(
      this.seamGeo, new THREE.LineBasicMaterial({ color: SEAM_COLOR, linewidth: 2 }));
    this.meshGroup.add(this.seamLines);

    this._frameMesh();
    this.refreshHighlights();
  }

  _frameMesh() {
    const box = new THREE.Box3().setFromObject(this.meshObj);
    box.getCenter(this.target);
    const size = box.getSize(new THREE.Vector3());
    this.sphere.radius = Math.max(size.x, size.y, size.z) * 2.1;
    this.grid.position.y = box.min.y - 0.02;
    this._updateCamera();
  }

  _updateCamera() {
    const { radius, theta, phi } = this.sphere;
    this.camera.position.set(
      this.target.x + radius * Math.sin(phi) * Math.cos(theta),
      this.target.y + radius * Math.cos(phi),
      this.target.z + radius * Math.sin(phi) * Math.sin(theta),
    );
    this.camera.lookAt(this.target);
  }

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------- 轨道控制 ----------
  _bindControls() {
    const el = this.canvas;
    let drag = null;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      drag = {
        x: e.clientX, y: e.clientY,
        button: e.button, moved: false,
        cam: { ...this.sphere, tx: this.target.x, ty: this.target.y, tz: this.target.z },
      };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.button === 0) {
        this.sphere.theta = drag.cam.theta - dx * 0.01;
        this.sphere.phi = Math.min(Math.PI - 0.05, Math.max(0.05, drag.cam.phi - dy * 0.01));
      } else if (drag.button === 2) {
        const pan = this.sphere.radius * 0.0016;
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
        this.target.copy(new THREE.Vector3(drag.cam.tx, drag.cam.ty, drag.cam.tz)
          .addScaledVector(right, -dx * pan)
          .addScaledVector(up, dy * pan));
      }
      this._updateCamera();
    });
    el.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved && drag.button === 0) this._pick(e);
      drag = null;
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.sphere.radius = Math.max(0.2, this.sphere.radius * (1 + Math.sign(e.deltaY) * 0.08));
      this._updateCamera();
    }, { passive: false });
  }

  _pick(event) {
    if (!this.meshObj) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObject(this.meshObj);
    if (!hits.length) {
      this.cb.onPickEmpty?.();
      return;
    }
    const face = Math.floor(hits[0].faceIndex);
    if (this.mode === 'seam') this.cb.onPickSeam?.(face, hits[0].point);
    else this.cb.onPickFace?.(face, event.shiftKey);
  }

  // ---------- 高亮 ----------
  setSelection(faceSet) {
    this.faceSet = faceSet;
    this.refreshHighlights();
  }

  setSeams(seamSet) {
    this.seamSet = seamSet;
    this.refreshHighlights();
  }

  setMode(mode) { this.mode = mode; }

  refreshHighlights() {
    if (!this.mesh) return;
    // 选中面覆盖
    const pos = [];
    for (const f of this.faceSet) {
      for (const vi of this.mesh.faces[f]) pos.push(...this.mesh.positions[vi]);
    }
    this.highlightGeo.dispose();
    this.highlightGeo = new THREE.BufferGeometry();
    this.highlightGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.highlightMesh.geometry = this.highlightGeo;

    // 切缝线：遍历所有有向半边，命中切缝集合就画一条（去重）
    const lines = [];
    const drawn = new Set();
    const { faces, positions, topology, seams } = this.mesh;
    for (const [key, c] of topology.halfedges) {
      const [a, b] = key.split('_').map(Number);
      const uk = a < b ? `${a}_${b}` : `${b}_${a}`;
      const isBoundary = topology.opposite[c] < 0;
      if (isBoundary || !seams.has(uk) || drawn.has(uk)) continue;
      drawn.add(uk);
      lines.push(...positions[a], ...positions[b]);
    }
    this.seamGeo.dispose();
    this.seamGeo = new THREE.BufferGeometry();
    this.seamGeo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    this.seamLines.geometry = this.seamGeo;
  }

  getViewState() {
    return {
      sphere: { ...this.sphere },
      target: [this.target.x, this.target.y, this.target.z],
    };
  }

  setViewState(vs) {
    if (!vs) return;
    if (vs.sphere) this.sphere = { ...vs.sphere };
    if (vs.target) this.target.set(...vs.target);
    this._updateCamera();
  }

  _loop() {
    requestAnimationFrame(() => this._loop());
    this.renderer.render(this.scene, this.camera);
  }
}
