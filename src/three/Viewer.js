import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const BONE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#6250d6'];
const WEIGHT_STOPS = [
  [0, '#eef2f7'],
  [0.18, '#cde2fb'],
  [0.42, '#6da7ec'],
  [0.7, '#2a78d6'],
  [1, '#0d366b'],
];
const DIFF_STOPS = [
  [0, '#fff7ec'],
  [0.25, '#fdd0a2'],
  [0.55, '#f16913'],
  [1, '#8c2d04'],
];

function rampColor(stops, value) {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  let left = stops[0];
  let right = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i += 1) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      left = stops[i];
      right = stops[i + 1];
      break;
    }
  }
  const local = (t - left[0]) / Math.max(1e-6, right[0] - left[0]);
  return new THREE.Color(left[1]).lerp(new THREE.Color(right[1]), local);
}

export class WeightViewer {
  constructor(container, handlers = {}) {
    this.container = container;
    this.handlers = handlers;
    this.project = null;
    this.selectedVertexId = null;
    this.diagnosticMarkers = [];
    this.boneMeshes = [];

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#e9eef4');

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
    this.camera.position.set(2.35, 1.35, 3.25);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0.05, 0.35, 0);
    this.controls.update();

    const hemi = new THREE.HemisphereLight(0xffffff, 0x667085, 1.65);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(3.5, 5, 4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xcde2fb, 0.8);
    fill.position.set(-4, 2, -3);
    this.scene.add(fill);

    this.grid = new THREE.GridHelper(7, 28, 0xb8c0cc, 0xd2d8e0);
    this.grid.position.y = -0.52;
    this.scene.add(this.grid);

    this.armGroup = new THREE.Group();
    this.scene.add(this.armGroup);
    this.markerGroup = new THREE.Group();
    this.scene.add(this.markerGroup);
    this.skeletonGroup = new THREE.Group();
    this.scene.add(this.skeletonGroup);
    this.diagnosticGroup = new THREE.Group();
    this.scene.add(this.diagnosticGroup);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Points.threshold = 0.045;
    this.pointer = new THREE.Vector2();
    this.downPoint = null;

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.animate();
  }

  loadProject(project) {
    this.project = project;
    this.disposeArm();

    const count = project.mesh.vertices.length;
    this.geometry = new THREE.BufferGeometry();
    this.positionArray = new Float32Array(count * 3);
    this.colorArray = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const p = project.mesh.restPositions[i] ?? project.mesh.vertices[i].position;
      this.positionArray[i * 3] = p[0];
      this.positionArray[i * 3 + 1] = p[1];
      this.positionArray[i * 3 + 2] = p[2];
      const c = new THREE.Color('#eef2f7');
      this.colorArray[i * 3] = c.r;
      this.colorArray[i * 3 + 1] = c.g;
      this.colorArray[i * 3 + 2] = c.b;
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positionArray, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colorArray, 3));
    if (project.mesh.indices?.length) this.geometry.setIndex(project.mesh.indices);
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.72,
      metalness: 0.02,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.userData.kind = 'mesh';
    this.armGroup.add(this.mesh);

    this.wire = new THREE.Mesh(
      this.geometry,
      new THREE.MeshBasicMaterial({ color: '#1f2937', wireframe: true, transparent: true, opacity: 0.13 }),
    );
    this.armGroup.add(this.wire);

    this.points = new THREE.Points(
      this.geometry,
      new THREE.PointsMaterial({
        size: 0.045,
        vertexColors: true,
        sizeAttenuation: true,
        depthWrite: false,
      }),
    );
    this.points.userData.kind = 'points';
    this.armGroup.add(this.points);

    // Orange wireframe used for cap-2 shape comparison.
    this.ghostGeometry = new THREE.BufferGeometry();
    this.ghostArray = new Float32Array(count * 3);
    this.ghostGeometry.setAttribute('position', new THREE.BufferAttribute(this.ghostArray, 3));
    if (project.mesh.indices?.length) this.ghostGeometry.setIndex(project.mesh.indices);
    this.ghost = new THREE.Mesh(
      this.ghostGeometry,
      new THREE.MeshBasicMaterial({ color: '#eb6834', wireframe: true, transparent: true, opacity: 0.42, depthTest: false }),
    );
    this.ghost.visible = false;
    this.ghost.renderOrder = 20;
    this.armGroup.add(this.ghost);

    this.createMarkers();
    this.camera.position.set(2.35, 1.35, 3.25);
    this.controls.target.set(0.05, 0.35, 0);
    this.controls.update();
  }

  disposeArm() {
    for (const child of [...this.armGroup.children]) {
      this.armGroup.remove(child);
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
      else child.material?.dispose?.();
    }
    this.geometry = null;
    this.mesh = null;
    this.points = null;
    this.ghost = null;
  }

  createMarkers() {
    for (const child of [...this.markerGroup.children]) this.disposeObject3D(child);
    this.markerGroup.clear();
    const selectedMat = new THREE.MeshBasicMaterial({ color: '#ffbf00', depthTest: false });
    this.selectedMarker = new THREE.Mesh(new THREE.SphereGeometry(0.045, 18, 12), selectedMat);
    this.selectedMarker.renderOrder = 100;
    this.markerGroup.add(this.selectedMarker);

    const restMat = new THREE.MeshBasicMaterial({ color: '#fcfcfb', depthTest: false });
    this.restMarker = new THREE.Mesh(new THREE.SphereGeometry(0.027, 14, 10), restMat);
    this.restMarker.renderOrder = 99;
    this.markerGroup.add(this.restMarker);

    const pairMat = new THREE.MeshBasicMaterial({ color: '#1baf7a', depthTest: false });
    this.pairMarkers = [
      new THREE.Mesh(new THREE.SphereGeometry(0.034, 14, 10), pairMat),
      new THREE.Mesh(new THREE.SphereGeometry(0.034, 14, 10), pairMat.clone()),
    ];
    this.pairMarkers.forEach((m) => {
      m.renderOrder = 98;
      this.markerGroup.add(m);
    });

    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.deltaLine = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color: '#111827', transparent: true, opacity: 0.72, depthTest: false }),
    );
    this.deltaLine.renderOrder = 97;
    this.markerGroup.add(this.deltaLine);
  }

  setDiagnostics(diagnostics, project) {
    for (const child of [...this.diagnosticGroup.children]) this.disposeObject3D(child);
    this.diagnosticGroup.clear();
    this.diagnosticsProject = project;
    this.diagnosticMarkers = [];
    for (const d of diagnostics) {
      const color = d.category === 'invalid' ? '#d03b3b' : d.category === 'zero' ? '#7c3aed' : '#d89000';
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.032, 12, 8),
        new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }),
      );
      marker.userData = { kind: 'diagnostic', vertexId: d.vertexId };
      marker.renderOrder = 90;
      this.diagnosticGroup.add(marker);
      this.diagnosticMarkers.push(marker);
    }
    this.updateDiagnosticPositions();
  }

  updateDiagnosticPositions() {
    if (!this.lastPositions) return;
    for (const marker of this.diagnosticMarkers) {
      const id = marker.userData.vertexId;
      marker.position.fromArray(this.lastPositions, id * 3);
    }
  }

  setSkeletonVisible(visible) {
    this.skeletonGroup.visible = visible;
  }

  disposeObject3D(object) {
    object.traverse?.((child) => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
      else child.material?.dispose?.();
    });
  }

  updateSkeleton(matrices) {
    for (const child of [...this.skeletonGroup.children]) this.disposeObject3D(child);
    this.skeletonGroup.clear();
    this.boneMeshes = [];
    if (!this.project || !matrices) return;

    this.project.skeleton.forEach((bone, index) => {
      const m = matrices[index];
      const applySkin = (value) => {
        const x = value[0];
        const y = value[1];
        const z = value[2] ?? 0;
        return new THREE.Vector3(
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        );
      };
      const start = applySkin(bone.restStart);
      const end = applySkin(bone.restEnd);
      const dir = end.clone().sub(start);
      const length = Math.max(dir.length(), 0.001);
      const color = BONE_COLORS[index % BONE_COLORS.length];
      const cylinder = new THREE.Mesh(
        new THREE.CylinderGeometry(0.026, 0.032, length, 10),
        new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 }),
      );
      cylinder.position.copy(start).add(end).multiplyScalar(0.5);
      cylinder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      cylinder.userData = { kind: 'bone', boneIndex: index };
      this.skeletonGroup.add(cylinder);
      this.boneMeshes.push(cylinder);

      const joint = new THREE.Mesh(
        new THREE.SphereGeometry(0.043, 14, 10),
        new THREE.MeshStandardMaterial({ color: '#202938', roughness: 0.4 }),
      );
      joint.position.copy(start);
      this.skeletonGroup.add(joint);
    });
  }

  updateDeformed(deformed) {
    if (!this.geometry || !deformed?.positions) return;
    this.lastPositions = deformed.positions;
    this.positionArray.set(deformed.positions);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
    this.updateSkeleton(deformed.matrices);
    this.updateMarkers();
    this.updateDiagnosticPositions();
  }

  updateGhost(positions) {
    if (!this.ghost || !positions) {
      if (this.ghost) this.ghost.visible = false;
      return;
    }
    this.ghostArray.set(positions);
    this.ghostGeometry.attributes.position.needsUpdate = true;
    this.ghostGeometry.computeBoundingSphere();
    this.ghost.visible = true;
  }

  setWeightColors(boneIndex) {
    if (!this.project || !this.geometry) return;
    const color = new THREE.Color();
    this.project.mesh.vertices.forEach((vertex, id) => {
      const inf = vertex.influences.find((x) => Number(x.bone) === Number(boneIndex));
      const w = inf ? Math.max(0, Number(inf.weight) || 0) : 0;
      color.copy(rampColor(WEIGHT_STOPS, w));
      this.colorArray[id * 3] = color.r;
      this.colorArray[id * 3 + 1] = color.g;
      this.colorArray[id * 3 + 2] = color.b;
    });
    this.geometry.attributes.color.needsUpdate = true;
  }

  setDifferenceColors(differenceById, maxDifference) {
    if (!this.project || !this.geometry) return;
    const color = new THREE.Color();
    this.project.mesh.vertices.forEach((_, id) => {
      const d = differenceById[id] ?? 0;
      color.copy(rampColor(DIFF_STOPS, maxDifference > 1e-8 ? d / maxDifference : 0));
      this.colorArray[id * 3] = color.r;
      this.colorArray[id * 3 + 1] = color.g;
      this.colorArray[id * 3 + 2] = color.b;
    });
    this.geometry.attributes.color.needsUpdate = true;
  }

  setNeutralColors(hex = '#dce3ec') {
    if (!this.geometry) return;
    const color = new THREE.Color(hex);
    for (let id = 0; id < this.project.mesh.vertices.length; id += 1) {
      this.colorArray[id * 3] = color.r;
      this.colorArray[id * 3 + 1] = color.g;
      this.colorArray[id * 3 + 2] = color.b;
    }
    this.geometry.attributes.color.needsUpdate = true;
  }

  setSelectedVertex(vertexId, coLocatedIds = []) {
    this.selectedVertexId = vertexId;
    this.coLocatedIds = coLocatedIds;
    this.updateMarkers();
  }

  updateMarkers() {
    if (!this.project || this.selectedVertexId == null || !this.lastPositions) return;
    const id = this.selectedVertexId;
    const posed = new THREE.Vector3().fromArray(this.lastPositions, id * 3);
    const rest = new THREE.Vector3(...(this.project.mesh.restPositions[id] ?? this.project.mesh.vertices[id].position));
    this.selectedMarker.position.copy(posed);
    this.restMarker.position.copy(rest);

    const pos = this.deltaLine.geometry.attributes.position;
    pos.setXYZ(0, rest.x, rest.y, rest.z);
    pos.setXYZ(1, posed.x, posed.y, posed.z);
    pos.needsUpdate = true;
    this.deltaLine.geometry.computeBoundingSphere();

    const others = (this.coLocatedIds ?? []).filter((x) => x !== id);
    this.pairMarkers.forEach((marker, i) => {
      const otherId = others[i];
      marker.visible = otherId != null;
      if (otherId != null) marker.position.fromArray(this.lastPositions, otherId * 3);
    });
  }

  focusVertex(vertexId) {
    if (!this.lastPositions || vertexId == null) return;
    const target = new THREE.Vector3().fromArray(this.lastPositions, vertexId * 3);
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(offset.length() > 0.5 ? offset : new THREE.Vector3(1.4, 0.9, 1.8));
    this.controls.update();
  }

  resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  getPointerHit(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const pickables = [this.points, this.mesh, ...this.boneMeshes, ...this.diagnosticMarkers].filter(Boolean);
    const hits = this.raycaster.intersectObjects(pickables, false);
    const first = hits[0] ?? null;
    if (first?.object === this.mesh && first.face) {
      const candidates = [first.face.a, first.face.b, first.face.c].filter(Number.isInteger);
      let bestIndex = candidates[0] ?? null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const vertexIndex of candidates) {
        const vertex = new THREE.Vector3().fromArray(this.positionArray, vertexIndex * 3);
        const distance = vertex.distanceToSquared(first.point);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = vertexIndex;
        }
      }
      return { ...first, index: bestIndex };
    }
    return first;
  }

  onPointerDown = (event) => {
    this.downPoint = { x: event.clientX, y: event.clientY, t: performance.now() };
  };

  onPointerUp = (event) => {
    if (!this.downPoint) return;
    const dx = event.clientX - this.downPoint.x;
    const dy = event.clientY - this.downPoint.y;
    const dt = performance.now() - this.downPoint.t;
    this.downPoint = null;
    if (Math.hypot(dx, dy) > 6 || dt > 650) return;

    const hit = this.getPointerHit(event);
    if (!hit) return;
    const data = hit.object.userData;
    if (data?.kind === 'bone') this.handlers.onSelectBone?.(data.boneIndex);
    else if (data?.kind === 'diagnostic') this.handlers.onSelectVertex?.(data.vertexId, { focus: false });
    else if (hit.index != null) this.handlers.onSelectVertex?.(hit.index, { focus: false });
  };

  onPointerMove = (event) => {
    if (event.buttons) return;
    const hit = this.getPointerHit(event);
    this.renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
  };

  animate = () => {
    this.frame = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
