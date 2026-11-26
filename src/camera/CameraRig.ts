import * as THREE from 'three';
import type { ProjectData, ResolvedCameraState, Bounds3D, OcclusionReport } from '../core/types';
import type { RouteSample } from '../route/RouteTimeline';
import { clamp, dampAlpha, lerpAngle } from '../core/easing';
import {
  ParamBlender,
  cloneBounds,
  cloneParams,
  degToRad,
  selectZone,
  type TransitionTarget,
} from './zones';
import { solveOcclusion } from './occlusion';

const UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_TRANSITION = 0.6;

const UNBOUNDED: Bounds3D = {
  enabled: false,
  min: [-1e7, -1e7, -1e7],
  max: [1e7, 1e7, 1e7],
};

/**
 * 第三人称镜头总装：区域选择 → 参数缓动 → 期望机位 → 遮挡避让 → 边界 clamp → 平滑。
 * 每帧产出一份 ResolvedCameraState 给检查器 / HUD / 调试可视化。
 */
export class CameraRig {
  readonly blender = new ParamBlender();
  currentZoneId: string | null = null;

  private smoothPos = new THREE.Vector3();
  private smoothLook = new THREE.Vector3();
  private smoothFov = 55;
  private smoothMoveYaw: number | null = null;
  private initialized = false;

  lastState: ResolvedCameraState | null = null;

  /** 时间轴 seek / 切换项目后调用：下一帧直接落到精确结果，不做平滑 */
  snapNext = false;

  snapNow(): void {
    this.snapNext = true;
  }

  private targetFor(project: ProjectData, zoneId: string | null): TransitionTarget {
    const zone = zoneId ? project.zones.find((z) => z.id === zoneId) : undefined;
    if (zone) {
      return {
        params: zone.params,
        bounds: zone.bounds,
        transitionTime: zone.transitionTime,
        easing: zone.easing,
        zoneName: zone.name,
      };
    }
    return {
      params: project.defaultParams,
      bounds: UNBOUNDED,
      transitionTime: FALLBACK_TRANSITION,
      easing: 'easeInOutCubic',
      zoneName: null,
    };
  }

  update(
    dt: number,
    project: ProjectData,
    sample: RouteSample,
    colliders: THREE.Object3D[],
    camera: THREE.PerspectiveCamera,
  ): ResolvedCameraState {
    const targetPos = new THREE.Vector3(sample.position.x, sample.position.y, sample.position.z);

    // 1) 区域选择（带滞回）
    const selection = selectZone(project.zones, targetPos, this.currentZoneId);
    const nextZoneId = selection.active?.id ?? null;
    const zoneChanged = nextZoneId !== this.currentZoneId;
    this.currentZoneId = nextZoneId;

    const target = this.targetFor(project, nextZoneId);

    if (this.snapNext) {
      this.blender.snap(target);
    } else if (zoneChanged) {
      // 关键：retarget 内部以「当前混合值」为起点，反向穿界也不会跳
      this.blender.retarget(target);
    } else {
      // UI 实时调参 / 每帧同步目标值（不会重启过渡）
      this.blender.patchTarget(target.params, target.bounds);
    }

    this.blender.update(this.snapNext ? 10 : dt);
    const params = this.blender.currentParams;
    const bounds = this.blender.currentBounds;

    // 2) 角色移动朝向（往返时反向），角度做最短弧平滑；镜头再叠加 yawOffset
    const desiredMoveYaw = sample.yaw + (sample.forwardTime ? 0 : Math.PI);
    if (this.smoothMoveYaw === null || this.snapNext) {
      this.smoothMoveYaw = desiredMoveYaw;
    } else {
      this.smoothMoveYaw = lerpAngle(this.smoothMoveYaw, desiredMoveYaw, dampAlpha(dt, 0.12));
    }
    const moveYaw = this.smoothMoveYaw;
    const yaw = moveYaw + degToRad(params.yawOffset);

    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const right = new THREE.Vector3().crossVectors(UP, forward).normalize(); // yaw=0 → +X

    // 3) 期望机位
    const pivot = targetPos.clone().add(new THREE.Vector3(0, params.targetHeight, 0));
    const pitch = degToRad(params.pitch);
    const horiz = params.distance * Math.cos(pitch);
    const vert = params.distance * Math.sin(pitch);
    const desired = pivot
      .clone()
      .addScaledVector(forward, -horiz)
      .addScaledVector(UP, vert)
      .addScaledVector(UP, params.height)
      .addScaledVector(right, params.shoulder);

    // 4) 遮挡避让
    const occ = solveOcclusion({
      pivot,
      desired,
      right,
      up: UP,
      colliders: project.occlusion.enabled ? colliders : [],
      config: project.occlusion,
    });
    let camPos = occ.position;
    let report: OcclusionReport = occ.report;

    // 5) 镜头边界 clamp
    let boundsActive = bounds.enabled;
    let boundsClamped = false;
    if (bounds.enabled) {
      const clamped = new THREE.Vector3(
        clamp(camPos.x, bounds.min[0], bounds.max[0]),
        clamp(camPos.y, bounds.min[1], bounds.max[1]),
        clamp(camPos.z, bounds.min[2], bounds.max[2]),
      );
      if (clamped.distanceToSquared(camPos) > 1e-8) boundsClamped = true;
      camPos = clamped;

      // clamp 后可能重新贴进遮挡物：再做一次回收
      if (project.occlusion.enabled) {
        const rehit = this.pullOutOfGeometry(pivot, camPos, colliders, project.occlusion.skin);
        if (rehit) {
          camPos = rehit;
          if (bounds.enabled) {
            camPos = new THREE.Vector3(
              clamp(camPos.x, bounds.min[0], bounds.max[0]),
              clamp(camPos.y, bounds.min[1], bounds.max[1]),
              clamp(camPos.z, bounds.min[2], bounds.max[2]),
            );
          }
        }
      }
    }

    const lookAt = pivot.clone().addScaledVector(forward, params.lookAhead);

    // 6) 位置 / 注视 / FOV 平滑（seek 时直接吸附）
    if (!this.initialized || this.snapNext) {
      this.smoothPos.copy(camPos);
      this.smoothLook.copy(lookAt);
      this.smoothFov = params.fov;
      this.initialized = true;
    } else {
      const posTime = report.kind === 'clear' ? 0.1 : project.occlusion.smoothing;
      const aPos = dampAlpha(dt, Math.max(0.02, posTime));
      const aLook = dampAlpha(dt, 0.08);
      this.smoothPos.lerp(camPos, aPos);
      this.smoothLook.lerp(lookAt, aLook);
      this.smoothFov += (params.fov - this.smoothFov) * dampAlpha(dt, 0.12);
    }
    this.snapNext = false;

    camera.position.copy(this.smoothPos);
    camera.lookAt(this.smoothLook);
    if (Math.abs(camera.fov - this.smoothFov) > 0.01) {
      camera.fov = this.smoothFov;
      camera.updateProjectionMatrix();
    }

    const state: ResolvedCameraState = {
      zoneId: this.currentZoneId,
      zoneName: target.zoneName ?? '默认参数（无区域）',
      overlappingZoneIds: selection.overlapping.map((z) => z.id),
      hysteresisKept: selection.hysteresisKept,
      fromZoneName: this.blender.fromZoneName,
      transition: {
        active: this.blender.isTransitioning(),
        elapsed: this.blender.elapsed,
        duration: this.blender.duration,
        t: this.blender.rawT,
        easing: this.blender.easing,
      },
      params: cloneParams(params),
      boundsActive,
      boundsClamped,
      target: [targetPos.x, targetPos.y, targetPos.z],
      targetYaw: moveYaw,
      desiredPosition: [desired.x, desired.y, desired.z],
      finalPosition: [this.smoothPos.x, this.smoothPos.y, this.smoothPos.z],
      lookAt: [this.smoothLook.x, this.smoothLook.y, this.smoothLook.z],
      fov: this.smoothFov,
      occlusion: report,
    };
    this.lastState = state;
    return state;
  }

  /** clamp 后二次遮挡回收 */
  private pullOutOfGeometry(
    pivot: THREE.Vector3,
    pos: THREE.Vector3,
    colliders: THREE.Object3D[],
    skin: number,
  ): THREE.Vector3 | null {
    const dir = new THREE.Vector3().subVectors(pos, pivot);
    const dist = dir.length();
    if (dist < 1e-4) return null;
    dir.multiplyScalar(1 / dist);
    const ray = new THREE.Raycaster(pivot, dir, 0, dist);
    const hits = ray.intersectObjects(colliders, false);
    if (hits.length === 0) return null;
    const safe = Math.max(0.45, hits[0].distance - skin);
    return pivot.clone().addScaledVector(dir, safe);
  }
}
