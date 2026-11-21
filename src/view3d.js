/* Three.js 立体路面视图：路面/路肩分组、网格线、道路线、问题位置标记 */
(function (root) {
  'use strict';

  function View3D(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10141b);

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 500;
    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 5000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    // 灯光
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(120, 160, 200);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0x9fc4ff, 0.35);
    dir2.position.set(-150, -80, 120);
    this.scene.add(dir2);

    // 地面参考网格
    this.gridHelper = new THREE.GridHelper(400, 40, 0x3a4452, 0x232a34);
    this.gridHelper.position.z = -0.02;
    this.scene.add(this.gridHelper);

    this.roadGroup = new THREE.Group();
    this.lineGroup = new THREE.Group();
    this.markerGroup = new THREE.Group();
    this.scene.add(this.roadGroup, this.lineGroup, this.markerGroup);

    this._raf = null;
    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    this.animate = this.animate.bind(this);
    this.animate();
  }

  View3D.prototype.resize = function () {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  View3D.prototype.animate = function () {
    this._raf = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  function clearGroup(g) {
    while (g.children.length) {
      const c = g.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose && c.material.dispose();
    }
  }

  function toBuffer(vertices, normals, indices) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(vertices.length * 3);
    const nor = new Float32Array(vertices.length * 3);
    vertices.forEach((v, i) => { pos[i * 3] = v[0]; pos[i * 3 + 1] = v[1]; pos[i * 3 + 2] = v[2]; });
    (normals || vertices).forEach((n, i) => { nor[i * 3] = n[0]; nor[i * 3 + 1] = n[1]; nor[i * 3 + 2] = n[2]; });
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(indices);
    return geo;
  }

  /** 折线 LineSegments（成对顶点） */
  function lineSegments(pairs, color, opacity = 1) {
    const arr = new Float32Array(pairs.length * 3);
    pairs.forEach((p, i) => { arr[i * 3] = p[0]; arr[i * 3 + 1] = p[1]; arr[i * 3 + 2] = p[2]; });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
    return new THREE.LineSegments(geo, mat);
  }

  /**
   * 刷新道路
   * @param road Road.buildRoad 结果
   * @param flags {showGrid, showCenter, showShL, showShR}
   * @param issues 诊断问题（用于标记位置）
   */
  View3D.prototype.update = function (road, flags, issues) {
    clearGroup(this.roadGroup);
    clearGroup(this.lineGroup);
    clearGroup(this.markerGroup);

    // 路面
    const pavementMat = new THREE.MeshStandardMaterial({
      color: 0x5a6472, roughness: 0.92, metalness: 0.05,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    const pavement = new THREE.Mesh(toBuffer(road.vertices, road.normals, road.indices), pavementMat);
    this.roadGroup.add(pavement);

    // 路肩（独立 mesh，可单独显隐）
    const shColors = { left: 0xc95c5c, right: 0xe8e8e8 };
    ['left', 'right'].forEach((side) => {
      const sh = road.shoulders[side];
      if (!sh) return;
      const mesh = new THREE.Mesh(
        toBuffer(sh.vertices, sh.normals, sh.indices),
        new THREE.MeshStandardMaterial({ color: shColors[side], roughness: 0.85, side: THREE.DoubleSide })
      );
      mesh.visible = side === 'left' ? flags.showShL : flags.showShR;
      mesh.name = 'shoulder-' + side;
      this.roadGroup.add(mesh);
    });

    // 网格线：每个环一条横向线（按实际里程分布），再加两条纵向边缘线
    if (flags.showGrid) {
      const cross = [];
      road.rings.forEach((ring) => {
        const Lp = RoadNS.sectionPoint(ring.frame, 1);
        const Rp = RoadNS.sectionPoint(ring.frame, -1);
        cross.push(Lp, Rp);
      });
      this.lineGroup.add(lineSegments(cross, 0xbfe0ff, 0.55));

      const edge = [];
      for (let i = 0; i < road.edges.left.length - 1; i++) {
        edge.push(road.edges.left[i], road.edges.left[i + 1]);
        edge.push(road.edges.right[i], road.edges.right[i + 1]);
      }
      this.lineGroup.add(lineSegments(edge, 0x9fd0ff, 0.8));
    }

    // 道路线：中心线（白色虚线感用连续亮线）+ 里程刻度
    if (flags.showCenter) {
      const center = [];
      for (let i = 0; i < road.edges.center.length - 1; i++) {
        center.push(road.edges.center[i], road.edges.center[i + 1]);
      }
      this.lineGroup.add(lineSegments(center, 0xfff2c0, 0.95));

      // 每 10m 一个里程小刻度
      const ticks = [];
      const L = road.spline.totalLength;
      for (let s = 0; s <= L; s += 10) {
        const st = road.spline.sampleAtDistance(s);
        const p = road.sampler.at(st.s >= L ? 0 : st.s);
        const fr = RoadNS.frameAt(st, p);
        ticks.push(RoadNS.sectionPoint(fr, 0), RoadNS.sectionPoint(fr, 0.18));
      }
      this.lineGroup.add(lineSegments(ticks, 0xf5b945, 0.9));
    }

    // 问题标记：折叠/自交用红色球，警告用黄色
    (issues || []).forEach((iss) => {
      const pt = iss.point || (iss.station !== undefined ? this._stationPoint(road, iss.station) : null);
      if (!pt) return;
      const isErr = iss.type === 'inner-edge-fold' || iss.type === 'surface-self-intersection' ||
        iss.type === 'centerline-crossing' || iss.type === 'overslope';
      const color = isErr ? 0xff4d4d : 0xf5b945;
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(isErr ? 1.4 : 1.0, 16, 16),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 })
      );
      sphere.position.set(pt[0], pt[1], (pt[2] || 0) + 2);
      this.markerGroup.add(sphere);
    });
  };

  View3D.prototype._stationPoint = function (road, s) {
    const L = road.spline.totalLength;
    const st = road.spline.sampleAtDistance(Math.min(s, L));
    const p = road.sampler.at(st.s >= L ? 0 : st.s);
    return RoadNS.frameAt(st, p).center;
  };

  /** 自动取景到道路包围盒 */
  View3D.prototype.frameAll = function (road) {
    const box = new THREE.Box3();
    road.vertices.forEach((v) => box.expandByPoint(new THREE.Vector3(v[0], v[1], v[2])));
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 1.15;
    this.camera.position.set(center.x + dist * 0.55, center.y - dist * 0.85, center.z + dist * 0.9);
    this.camera.near = maxDim / 200; this.camera.far = maxDim * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.gridHelper.position.set(center.x, center.y, -0.02);
  };

  View3D.prototype.dispose = function () {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._resize);
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  };

  // road.js 在浏览器里挂到 window.RoadMesh，这里取别名
  const RoadNS = root.RoadMesh;
  root.RoadView3D = View3D;
})(window);
