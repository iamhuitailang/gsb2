/*
 * viewer.js — Three.js 渲染层
 *  - 点云以 THREE.Points 渲染,按 renderCap 自动 LOD 抽样,大数据量也保持可操作
 *  - 两种布局: overlay(单视口叠加) / split(左右独立相机视口,各自 OrbitControls)
 *  - 屏幕矩形框选: 用投影矩阵构造 Frustum,数学方式求交,不依赖渲染回读
 */
(function (root) {
  'use strict';

  const DEFAULT_CAP = 250000;      // 每个视口每片点云的渲染上限
  const DEFAULT_POINT_SIZE = 2.0;

  function Viewer(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x101418, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    this.scene = new THREE.Scene();
    this.views = [
      makeView(container, this.renderer.domElement),
      makeView(container, this.renderer.domElement)
    ];
    this.layout = 'overlay';        // 'overlay' | 'split'
    this.pointSize = DEFAULT_POINT_SIZE;
    this.renderCap = DEFAULT_CAP;
    this.scanObjects = new Map();   // scanId -> {points, geometry, material, scan}
    this.helpers = new Map();       // scanId -> THREE.Box3Helper
    this.selectionBox = null;       // 当前裁剪框 THREE.Box3
    this.selectionHelper = null;
    this._onResize = this.resize.bind(this);
    window.addEventListener('resize', this._onResize);

    // split 布局下两个 OrbitControls 共用一个 canvas,
    // 按指针落点只启用对应视口的 controls,避免两个相机同时旋转
    this._pointerRouter = function (ev) {
      if (this.externallyDisabled) {
        this.views.forEach(function (v) { v.controls.enabled = false; });
        return;
      }
      if (this.layout !== 'split') {
        this.views[0].controls.enabled = true;
        this.views[1].controls.enabled = false;
        return;
      }
      const rect = this.renderer.domElement.getBoundingClientRect();
      const inRight = (ev.clientX - rect.left) > rect.width / 2;
      this.views[0].controls.enabled = !inRight;
      this.views[1].controls.enabled = inRight;
    }.bind(this);
    this.renderer.domElement.addEventListener('pointerdown', this._pointerRouter, true);
    // 外部(框选模式)可整体禁用 controls,用这个标记区分
    this.externallyDisabled = false;

    this.resize();
    this.views[0].controls.enabled = true;
    this.views[1].controls.enabled = false;
    this._renderLoop = this._renderFrame.bind(this);
    this._running = true;
    requestAnimationFrame(this._renderLoop);
  }

  // 框选模式整体接管鼠标;恢复后重新按布局计算可用 controls
  Viewer.prototype.setInteractionEnabled = function (on) {
    this.externallyDisabled = !on;
    if (!on) {
      this.views.forEach(function (v) { v.controls.enabled = false; });
    } else {
      this.views[0].controls.enabled = this.layout !== 'split';
      this.views[1].controls.enabled = this.layout === 'split';
    }
  };

  function makeView(container, dom) {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 10000);
    camera.position.set(5, 4, 6);
    const controls = new THREE.OrbitControls(camera, dom);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.target.set(0, 0, 0);
    return {
      camera: camera,
      controls: controls,
      rect: { x: 0, y: 0, w: 1, h: 1 },
      label: ''
    };
  }

  Viewer.prototype.resize = function () {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    this.renderer.setSize(w, h, false);
    if (this.layout === 'split') {
      this.views[0].rect = { x: 0, y: 0, w: 0.5, h: 1 };
      this.views[1].rect = { x: 0.5, y: 0, w: 0.5, h: 1 };
    } else {
      this.views[0].rect = { x: 0, y: 0, w: 1, h: 1 };
    }
    this.views.forEach(function (v) {
      v.camera.aspect = (w * v.rect.w) / (h * v.rect.h);
      v.camera.updateProjectionMatrix();
    });
  };

  Viewer.prototype.setLayout = function (layout) {
    this.layout = layout;
    this.resize();
    this.setInteractionEnabled(!this.externallyDisabled);
  };

  Viewer.prototype.dispose = function () {
    this._running = false;
    window.removeEventListener('resize', this._onResize);
    this.renderer.domElement.removeEventListener('pointerdown', this._pointerRouter, true);
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  };

  // ---- 点云对象 ----
  Viewer.prototype.addScan = function (scan) {
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.PointsMaterial({
      size: this.pointSize,
      vertexColors: !!scan.colors,
      sizeAttenuation: true
    });
    const points = new THREE.Points(geometry, material);
    this.scene.add(points);
    const boxHelper = new THREE.Box3Helper(new THREE.Box3(), 0x4488ff);
    boxHelper.visible = false;
    this.scene.add(boxHelper);
    this.helpers.set(scan.id, boxHelper);
    const obj = { scan: scan, points: points, geometry: geometry,
      material: material, renderedCount: 0, highlight: false };
    this.scanObjects.set(scan.id, obj);
    this.updateScan(scan);
    this.frameScan(scan);
    return obj;
  };

  Viewer.prototype.removeScan = function (scanId) {
    const obj = this.scanObjects.get(scanId);
    if (obj) {
      this.scene.remove(obj.points);
      obj.geometry.dispose();
      obj.material.dispose();
      this.scanObjects.delete(scanId);
    }
    const helper = this.helpers.get(scanId);
    if (helper) { this.scene.remove(helper); this.helpers.delete(scanId); }
  };

  // 重建 BufferAttribute(可见索引变化 / 变换变化 / 高亮变化时调用)
  Viewer.prototype.updateScan = function (scan, highlightSet) {
    const obj = this.scanObjects.get(scan.id);
    if (!obj) return;
    const idx = scan.activeIndices;
    const total = idx ? idx.length : scan.points.length;
    const cap = this.renderCap;
    const stride = total > cap ? Math.ceil(total / cap) : 1;
    const renderN = Math.ceil(total / stride);
    const positions = new Float32Array(renderN * 3);
    const colors = new Float32Array(renderN * 3);
    const m = scan.matrix();
    const hasColor = !!scan.colors;
    for (let out = 0, i = 0; i < total; i += stride, out++) {
      const oi = idx ? idx[i] : i;
      const p = scan.points[oi];
      const x = p[0], y = p[1], z = p[2];
      positions[out * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      positions[out * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      positions[out * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      let r = 0.72, g = 0.72, b = 0.72;
      if (hasColor) {
        const c = scan.colors[oi];
        r = c[0] / 255; g = c[1] / 255; b = c[2] / 255;
      }
      if (highlightSet && highlightSet.has(oi)) { r = 1.0; g = 0.85; b = 0.2; }
      colors[out * 3] = r; colors[out * 3 + 1] = g; colors[out * 3 + 2] = b;
    }
    obj.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    obj.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    obj.geometry.computeBoundingSphere();
    obj.renderedCount = renderN;
    obj.stride = stride;
  };

  Viewer.prototype.setPointSize = function (size) {
    this.pointSize = size;
    this.scanObjects.forEach(function (obj) { obj.material.size = size; });
  };

  Viewer.prototype.setRenderCap = function (cap) {
    this.renderCap = cap;
    const self = this;
    this.scanObjects.forEach(function (obj) { self.updateScan(obj.scan); });
  };

  Viewer.prototype.setHelperVisible = function (scanId, visible) {
    const helper = this.helpers.get(scanId);
    if (!helper) return;
    const obj = this.scanObjects.get(scanId);
    if (!obj) return;
    obj.geometry.computeBoundingBox();
    helper.box.copy(obj.geometry.boundingBox);
    helper.userData.forcedVisible = visible;
    helper.visible = visible;
  };

  // 相机对准某片点云
  Viewer.prototype.frameScan = function (scan) {
    const obj = this.scanObjects.get(scan.id);
    if (!obj) return;
    obj.geometry.computeBoundingSphere();
    const sphere = obj.geometry.boundingSphere;
    if (!sphere) return;
    this.views.forEach(function (v) {
      v.controls.target.copy(sphere.center);
      const dist = sphere.radius * 2.2;
      v.camera.position.set(
        sphere.center.x + dist * 0.7,
        sphere.center.y + dist * 0.55,
        sphere.center.z + dist
      );
      v.camera.near = Math.max(0.001, sphere.radius / 1000);
      v.camera.far = sphere.radius * 100;
      v.camera.updateProjectionMatrix();
      v.controls.update();
    });
  };

  Viewer.prototype.frameAll = function () {
    let sphere = null;
    this.scanObjects.forEach(function (obj) {
      obj.geometry.computeBoundingSphere();
      const s = obj.geometry.boundingSphere;
      if (!s) return;
      sphere = sphere ? unionSphere(sphere, s) : s.clone();
    });
    if (!sphere) return;
    this.views.forEach(function (v) {
      v.controls.target.copy(sphere.center);
      const dist = sphere.radius * 2.2;
      v.camera.position.set(
        sphere.center.x + dist * 0.7,
        sphere.center.y + dist * 0.55,
        sphere.center.z + dist
      );
      v.camera.near = Math.max(0.001, sphere.radius / 1000);
      v.camera.far = sphere.radius * 100;
      v.camera.updateProjectionMatrix();
      v.controls.update();
    });
  };

  function unionSphere(a, b) {
    const center = a.center.clone().add(b.center).multiplyScalar(0.5);
    const radius = Math.max(a.distanceToPoint ? 0 : 0,
      a.center.distanceTo(center) + a.radius,
      b.center.distanceTo(center) + b.radius);
    return new THREE.Sphere(center, radius);
  }

  // ---- 屏幕框选 ----
  // ndcRect: {x0,y0,x1,y1} 归一化设备坐标;viewIndex: 哪个视口
  // 返回当前活动扫描中落在框选视锥内的原始点索引集合
  Viewer.prototype.pickInRect = function (scan, ndcRect, viewIndex) {
    const obj = this.scanObjects.get(scan.id);
    if (!obj) return new Set();
    const view = this.views[Math.min(viewIndex || 0, this.views.length - 1)];
    const camera = view.camera;

    // 构造一个只覆盖屏幕矩形子区域的透视相机,
    // 再用 projectionMatrix * matrixWorldInverse 提取视锥平面
    const sub = new THREE.PerspectiveCamera();
    sub.matrixWorld.copy(camera.matrixWorld);
    sub.matrixWorldInverse.copy(camera.matrixWorldInverse);
    sub.projectionMatrix.copy(makeSubFrustumProjection(camera, ndcRect));
    sub.projectionMatrixInverse.copy(sub.projectionMatrix).invert();
    const frustum = new THREE.Frustum();
    frustum.setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(sub.projectionMatrix, sub.matrixWorldInverse));

    // 在渲染用(已变换)坐标上判定,再映射回原始索引
    const posAttr = obj.geometry.getAttribute('position');
    const idx = scan.activeIndices;
    const stride = obj.stride || 1;
    const hit = new Set();
    const v = new THREE.Vector3();
    let out = 0;
    const total = idx ? idx.length : scan.points.length;
    for (let i = 0; i < total; i += stride, out++) {
      v.fromBufferAttribute(posAttr, out);
      if (frustum.containsPoint(v)) hit.add(idx ? idx[i] : i);
    }
    return hit;
  };

  // 由原相机投影矩阵与 NDC 子矩形,推导子视锥投影矩阵(列主序)
  // 标准透视投影元素: P[0]=2n/(r-l), P[5]=2n/(t-b),
  // P[8]=(r+l)/(r-l), P[9]=(t+b)/(t-b), P[10]=-(f+n)/(f-n), P[11]=-1, P[14]=-2fn/(f-n)
  function makeSubFrustumProjection(camera, rect) {
    const p = camera.projectionMatrix.elements;
    const x0 = rect.x0, x1 = rect.x1, y0 = rect.y1, y1 = rect.y0; // NDC y 向上
    const m = new Float32Array(16);
    m[0] = p[0] * 2 / (x1 - x0);
    m[5] = p[5] * 2 / (y1 - y0);
    m[8] = p[8] - p[0] * (x1 + x0) / (x1 - x0);
    m[9] = p[9] - p[5] * (y1 + y0) / (y1 - y0);
    m[10] = p[10];
    m[11] = -1;
    m[14] = p[14];
    m[15] = 0;
    // r147 的 Matrix4.elements 是普通数组,逐元素拷贝(兼容 TypedArray 入参)
    const out = new THREE.Matrix4();
    for (let i = 0; i < 16; i++) out.elements[i] = m[i];
    return out;
  }

  // 框选结果转世界坐标 AABB(用于裁剪与持久化)
  Viewer.prototype.selectionToBox = function (scan, selectedSet) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const m = scan.matrix();
    selectedSet.forEach(function (oi) {
      const p = scan.points[oi];
      const x = p[0], y = p[1], z = p[2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (wx < min[0]) min[0] = wx;
      if (wy < min[1]) min[1] = wy;
      if (wz < min[2]) min[2] = wz;
      if (wx > max[0]) max[0] = wx;
      if (wy > max[1]) max[1] = wy;
      if (wz > max[2]) max[2] = wz;
    });
    if (!Number.isFinite(min[0])) return null;
    return new THREE.Box3(
      new THREE.Vector3(min[0], min[1], min[2]),
      new THREE.Vector3(max[0], max[1], max[2])
    );
  };

  Viewer.prototype.showSelectionBox = function (box3, viewIndex) {
    this.clearSelectionBox();
    if (!box3) return;
    const helper = new THREE.Box3Helper(box3, 0xffaa22);
    this.scene.add(helper);
    this.selectionHelper = helper;
    this.selectionBox = box3;
    this._selectionViewIndex = viewIndex || 0;
  };
  Viewer.prototype.clearSelectionBox = function () {
    if (this.selectionHelper) {
      this.scene.remove(this.selectionHelper);
      this.selectionHelper = null;
      this.selectionBox = null;
    }
  };

  // ---- 渲染循环 ----
  Viewer.prototype._renderFrame = function () {
    if (!this._running) return;
    requestAnimationFrame(this._renderLoop);
    this.views.forEach(function (v) { v.controls.update(); });
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    if (this.layout === 'overlay') {
      this.setSplitVisibility(null); // 全部可见
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, w, h);
      this.renderer.clear();
      this.renderer.render(this.scene, this.views[0].camera);
    } else {
      this.renderer.setScissorTest(true);
      for (let i = 0; i < 2; i++) {
        const v = this.views[i];
        this.setSplitVisibility(i); // 左视口只看第 0 片,右视口只看第 1 片
        const px = Math.floor(v.rect.x * w);
        const py = Math.floor(v.rect.y * h);
        const pw = Math.floor(v.rect.w * w);
        const ph = Math.floor(v.rect.h * h);
        this.renderer.setViewport(px, py, pw, ph);
        this.renderer.setScissor(px, py, pw, ph);
        this.renderer.clear();
        this.renderer.render(this.scene, v.camera);
      }
      this.renderer.setScissorTest(false);
      this.setSplitVisibility(null);
    }
  };

  // viewIndex=null: 所有点云可见; 0/1: 仅对应序号的扫描可见(split 并排)
  Viewer.prototype.setSplitVisibility = function (viewIndex) {
    const ids = Array.from(this.scanObjects.keys());
    const self = this;
    ids.forEach(function (id, i) {
      const obj = self.scanObjects.get(id);
      obj.points.visible = viewIndex === null || i === viewIndex;
      const helper = self.helpers.get(id);
      if (helper) helper.visible = helper.userData.forcedVisible &&
        (viewIndex === null || i === viewIndex);
    });
    if (this.selectionHelper) {
      this.selectionHelper.visible = viewIndex === null ||
        this._selectionViewIndex === viewIndex;
    }
  };

  root.PCViewer = Viewer;
})(typeof self !== 'undefined' ? self : this);
