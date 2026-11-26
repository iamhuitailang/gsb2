import * as THREE from 'three';
import type { CameraZone, ProjectData, ResolvedCameraState } from '../core/types';
import { samplePath } from '../route/RouteTimeline';
import { makeTextSprite } from './buildWorld';

interface ZoneHelper {
  root: THREE.Group;
  fill: THREE.Mesh;
  edges: THREE.LineSegments;
  label: THREE.Sprite;
  bounds: THREE.LineSegments;
  boundsFill: THREE.Mesh;
}

/** 所有编辑器可视化辅助物；项目数据变化时按组重建 */
export class Gizmos {
  readonly root = new THREE.Group();
  private zoneHelpers = new Map<string, ZoneHelper>();

  readonly zonesGroup = new THREE.Group();
  readonly boundsGroup = new THREE.Group();
  readonly routeGroup = new THREE.Group();
  readonly occluderHelperGroup = new THREE.Group();
  readonly debugGroup = new THREE.Group();

  waypointMarkers: THREE.Mesh[] = [];

  private rayLine: THREE.Line;
  private aimLine: THREE.Line;
  private hitMarker: THREE.Mesh;
  private desiredMarker: THREE.Mesh;
  private pivotMarker: THREE.Mesh;
  private attemptPoints: THREE.Points;
  private cameraHelper: THREE.CameraHelper;

  constructor(private gameCamera: THREE.PerspectiveCamera) {
    this.root.add(this.zonesGroup, this.boundsGroup, this.routeGroup);
    this.root.add(this.occluderHelperGroup, this.debugGroup);

    this.cameraHelper = new THREE.CameraHelper(gameCamera);
    (this.cameraHelper.material as THREE.Material).depthTest = false;
    this.cameraHelper.renderOrder = 30;
    this.debugGroup.add(this.cameraHelper);

    this.rayLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.rayLine.renderOrder = 31;
    this.debugGroup.add(this.rayLine);

    this.aimLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.55 }),
    );
    this.debugGroup.add(this.aimLine);

    this.hitMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xef4444, depthTest: false }),
    );
    this.hitMarker.renderOrder = 32;
    this.hitMarker.visible = false;
    this.debugGroup.add(this.hitMarker);

    this.desiredMarker = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.28),
      new THREE.MeshBasicMaterial({ color: 0xfde047, wireframe: true, depthTest: false }),
    );
    this.desiredMarker.renderOrder = 32;
    this.debugGroup.add(this.desiredMarker);

    this.pivotMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee, depthTest: false }),
    );
    this.debugGroup.add(this.pivotMarker);

    this.attemptPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 0.22, vertexColors: true, depthTest: false, sizeAttenuation: true }),
    );
    this.attemptPoints.renderOrder = 31;
    this.attemptPoints.visible = false;
    this.debugGroup.add(this.attemptPoints);
  }

  setVisibility(key: 'zones' | 'bounds' | 'route' | 'occluders' | 'rays', visible: boolean) {
    if (key === 'zones') this.zonesGroup.visible = visible;
    if (key === 'bounds') this.boundsGroup.visible = visible;
    if (key === 'route') this.routeGroup.visible = visible;
    if (key === 'occluders') this.occluderHelperGroup.visible = visible;
    if (key === 'rays') {
      this.debugGroup.visible = visible;
    }
  }

  /** 碰撞体包围盒辅助 */
  rebuildColliderHelpers(colliders: THREE.Object3D[]) {
    disposeGroup(this.occluderHelperGroup);
    for (const c of colliders) {
      const helper = new THREE.BoxHelper(c as THREE.Mesh, 0x2dd4bf);
      (helper.material as THREE.LineBasicMaterial).transparent = true;
      (helper.material as THREE.LineBasicMaterial).opacity = 0.5;
      this.occluderHelperGroup.add(helper);
    }
  }

  rebuildZones(zones: CameraZone[]) {
    disposeGroup(this.zonesGroup);
    disposeGroup(this.boundsGroup);
    this.zoneHelpers.clear();

    for (const z of zones) {
      const root = new THREE.Group();
      root.position.set(...z.center);
      root.rotation.y = THREE.MathUtils.degToRad(z.rotationY);

      const geo = new THREE.BoxGeometry(...z.size);
      const fill = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(z.color),
          transparent: true,
          opacity: 0.07,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: new THREE.Color(z.color), transparent: true, opacity: 0.95 }),
      );
      root.add(fill, edges);

      const label = makeTextSprite(z.name, hexToRgba(z.color, 0.82));
      label.position.set(0, z.size[1] / 2 + 0.55, 0);
      label.scale.multiplyScalar(0.9);
      root.add(label);

      this.zonesGroup.add(root);

      // 边界盒（世界 AABB，不随区域旋转）
      const size = [
        z.bounds.max[0] - z.bounds.min[0],
        z.bounds.max[1] - z.bounds.min[1],
        z.bounds.max[2] - z.bounds.min[2],
      ] as [number, number, number];
      const center = [
        (z.bounds.min[0] + z.bounds.max[0]) / 2,
        (z.bounds.min[1] + z.bounds.max[1]) / 2,
        (z.bounds.min[2] + z.bounds.max[2]) / 2,
      ] as [number, number, number];
      const bGeo = new THREE.BoxGeometry(...size);
      const bounds = new THREE.LineSegments(
        new THREE.EdgesGeometry(bGeo),
        new THREE.LineDashedMaterial({ color: 0x4ade80, dashSize: 0.35, gapSize: 0.22, transparent: true, opacity: 0.9 }),
      );
      bounds.position.set(...center);
      bounds.computeLineDistances();
      bounds.visible = z.bounds.enabled;
      this.boundsGroup.add(bounds);

      const boundsFill = new THREE.Mesh(
        bGeo,
        new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.045, depthWrite: false }),
      );
      boundsFill.position.copy(bounds.position);
      boundsFill.visible = z.bounds.enabled;
      this.boundsGroup.add(boundsFill);

      this.zoneHelpers.set(z.id, { root, fill, edges, label, bounds, boundsFill });
    }
  }

  /** 选中区域高亮 */
  setSelectedZone(id: string | null) {
    for (const [zid, h] of this.zoneHelpers) {
      const selected = zid === id;
      (h.fill.material as THREE.MeshBasicMaterial).opacity = selected ? 0.16 : 0.07;
      (h.edges.material as THREE.LineBasicMaterial).linewidth = selected ? 3 : 1;
    }
  }

  setBoundsVisibleForZones(zones: CameraZone[]) {
    zones.forEach((z) => {
      const h = this.zoneHelpers.get(z.id);
      if (h) {
        h.bounds.visible = z.bounds.enabled && this.boundsGroup.visible;
        h.boundsFill.visible = z.bounds.enabled && this.boundsGroup.visible;
      }
    });
  }

  rebuildRoute(project: ProjectData) {
    disposeGroup(this.routeGroup);
    this.waypointMarkers = [];
    const wps = project.route.waypoints;
    if (wps.length === 0) return;

    // 平滑路线
    const points: THREE.Vector3[] = [];
    if (wps.length === 1) {
      points.push(new THREE.Vector3(wps[0].x, wps[0].y + 0.12, wps[0].z));
    } else {
      const segs = wps.length - 1;
      for (let i = 0; i < segs; i++) {
        for (let k = 0; k <= 28; k++) {
          const p = samplePath(wps, i, k / 28);
          points.push(new THREE.Vector3(p.x, p.y + 0.12, p.z));
        }
      }
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.85 }),
    );
    this.routeGroup.add(line);

    wps.forEach((w, i) => {
      const isFirst = i === 0;
      const isLast = i === wps.length - 1;
      const color = isFirst ? 0x4ade80 : isLast ? 0xf87171 : 0x38bdf8;
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.26, 18, 14),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35 }),
      );
      marker.position.set(w.x, w.y + 0.35, w.z);
      marker.userData.wpId = w.id;
      this.waypointMarkers.push(marker);
      this.routeGroup.add(marker);

      const num = makeTextSprite(String(i + 1), 'rgba(8,47,73,0.85)');
      num.position.set(w.x, w.y + 0.95, w.z);
      num.scale.multiplyScalar(0.42);
      this.routeGroup.add(num);
    });
  }

  /** 每帧刷新调试元素 */
  updateDebug(state: ResolvedCameraState) {
    const pivot = new THREE.Vector3(...state.target).add(new THREE.Vector3(0, state.params.targetHeight, 0));
    this.pivotMarker.position.copy(pivot);

    const desired = new THREE.Vector3(...state.desiredPosition);
    this.desiredMarker.position.copy(desired);

    // 原始遮挡查询射线 pivot -> desired
    const positions = this.rayLine.geometry.attributes.position as THREE.BufferAttribute;
    positions.setXYZ(0, pivot.x, pivot.y, pivot.z);
    positions.setXYZ(1, desired.x, desired.y, desired.z);
    positions.needsUpdate = true;
    this.rayLine.geometry.computeBoundingSphere();
    (this.rayLine.material as THREE.LineBasicMaterial).color.set(
      state.occlusion.kind === 'clear' ? 0xa3e635 : 0xfacc15,
    );

    if (state.occlusion.hitPoint) {
      this.hitMarker.visible = true;
      this.hitMarker.position.set(...state.occlusion.hitPoint);
    } else {
      this.hitMarker.visible = false;
    }

    const finalPos = new THREE.Vector3(...state.finalPosition);
    const look = new THREE.Vector3(...state.lookAt);
    const aimPos = this.aimLine.geometry.attributes.position as THREE.BufferAttribute;
    aimPos.setXYZ(0, finalPos.x, finalPos.y, finalPos.z);
    aimPos.setXYZ(1, look.x, look.y, look.z);
    aimPos.needsUpdate = true;
    this.aimLine.geometry.computeBoundingSphere();

    // 候选点
    const attempts = state.occlusion.attempts;
    if (attempts.length > 0) {
      const arr = new Float32Array(attempts.length * 3);
      const colors = new Float32Array(attempts.length * 3);
      const cClear = new THREE.Color(0x4ade80);
      const cBlock = new THREE.Color(0xf87171);
      attempts.forEach((a, i) => {
        arr[i * 3] = a.position[0];
        arr[i * 3 + 1] = a.position[1];
        arr[i * 3 + 2] = a.position[2];
        const c = a.clear ? cClear : cBlock;
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      });
      this.attemptPoints.geometry.dispose();
      this.attemptPoints.geometry = new THREE.BufferGeometry();
      this.attemptPoints.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      this.attemptPoints.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      this.attemptPoints.visible = true;
    } else {
      this.attemptPoints.visible = false;
    }

    this.gameCamera.updateMatrixWorld();
    this.cameraHelper.update();
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const c = new THREE.Color(hex);
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${alpha})`;
}

function disposeGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    child.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    group.remove(child);
  }
}
