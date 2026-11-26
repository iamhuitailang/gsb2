import { ease, lerp } from '../core/easing';
import { DEFAULT_PARAMS } from '../core/defaults';
import type { Bounds3D, CameraParams, CameraZone, EasingName, Vec3Tuple } from '../core/types';

export function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}

/** 世界点 → 区域盒体局部坐标 */
export function zoneLocalPoint(zone: CameraZone, p: { x: number; y: number; z: number }) {
  const dx = p.x - zone.center[0];
  const dy = p.y - zone.center[1];
  const dz = p.z - zone.center[2];
  const r = degToRad(zone.rotationY);
  const c = Math.cos(r);
  const s = Math.sin(r);
  // R^-1，绕 Y
  return { x: c * dx - s * dz, y: dy, z: s * dx + c * dz };
}

export function zoneContains(
  zone: CameraZone,
  p: { x: number; y: number; z: number },
  expand = 0,
): boolean {
  const l = zoneLocalPoint(zone, p);
  // 1e-4 的容差避免目标 y=0 正好压在区域下边界时被浮点误差判到外面
  const e = expand + 1e-4;
  const hx = zone.size[0] / 2 + e;
  const hy = zone.size[1] / 2 + e;
  const hz = zone.size[2] / 2 + e;
  return Math.abs(l.x) <= hx && Math.abs(l.y) <= hy && Math.abs(l.z) <= hz;
}

export interface ZoneSelection {
  active: CameraZone | null;
  /** 严格包含目标点的所有区域（优先级排序） */
  overlapping: CameraZone[];
  /** 因滞回而保留的旧区域 */
  hysteresisKept: boolean;
}

/**
 * 选择当前区域。
 * 滞回规则：当前区域只要目标点还在「盒体 + hysteresis」内，就仍有候选资格，
 * 但优先级更高的新区域会立即接管。
 */
export function selectZone(
  zones: CameraZone[],
  p: { x: number; y: number; z: number },
  currentZoneId: string | null,
): ZoneSelection {
  const strict = zones
    .filter((z) => zoneContains(z, p, 0))
    .sort((a, b) => b.priority - a.priority || zoneVolume(a) - zoneVolume(b));

  const candidates = strict.slice();
  let hysteresisKept = false;
  const current = currentZoneId ? zones.find((z) => z.id === currentZoneId) : undefined;
  if (current && !candidates.includes(current) && zoneContains(current, p, current.hysteresis)) {
    candidates.push(current);
    hysteresisKept = true;
  }

  candidates.sort((a, b) => b.priority - a.priority || zoneVolume(a) - zoneVolume(b));
  return {
    active: candidates[0] ?? null,
    overlapping: strict,
    hysteresisKept,
  };
}

function zoneVolume(z: CameraZone): number {
  return z.size[0] * z.size[1] * z.size[2];
}

export function cloneParams(p: CameraParams): CameraParams {
  return { ...p };
}

export function cloneBounds(b: Bounds3D): Bounds3D {
  return { enabled: b.enabled, min: [...b.min] as Vec3Tuple, max: [...b.max] as Vec3Tuple };
}

export function lerpParams(a: CameraParams, b: CameraParams, t: number): CameraParams {
  return {
    distance: lerp(a.distance, b.distance, t),
    height: lerp(a.height, b.height, t),
    shoulder: lerp(a.shoulder, b.shoulder, t),
    yawOffset: lerp(a.yawOffset, b.yawOffset, t),
    pitch: lerp(a.pitch, b.pitch, t),
    lookAhead: lerp(a.lookAhead, b.lookAhead, t),
    targetHeight: lerp(a.targetHeight, b.targetHeight, t),
    fov: lerp(a.fov, b.fov, t),
  };
}

export function lerpBounds(a: Bounds3D, b: Bounds3D, t: number): Bounds3D {
  const mix = (x: Vec3Tuple, y: Vec3Tuple): Vec3Tuple => [
    lerp(x[0], y[0], t),
    lerp(x[1], y[1], t),
    lerp(x[2], y[2], t),
  ];
  return { enabled: t < 1 ? a.enabled : b.enabled, min: mix(a.min, b.min), max: mix(a.max, b.max) };
}

export interface TransitionTarget {
  params: CameraParams;
  bounds: Bounds3D;
  transitionTime: number;
  easing: EasingName;
  zoneName: string | null;
}

/**
 * 参数缓动混合器。
 * 关键保证：任何时刻切换目标（包括缓动途中反向穿过边界），
 * 都以「当前已经混合出来的参数」作为新过渡的起点，因此不会跳变。
 */
export class ParamBlender {
  currentParams: CameraParams = cloneParams(DEFAULT_PARAMS);
  currentBounds: Bounds3D = {
    enabled: false,
    min: [-Infinity, -Infinity, -Infinity],
    max: [Infinity, Infinity, Infinity],
  };

  private fromParams: CameraParams = cloneParams(DEFAULT_PARAMS);
  private toParams: CameraParams = cloneParams(DEFAULT_PARAMS);
  private fromBounds: Bounds3D = cloneBounds(this.currentBounds);
  private toBounds: Bounds3D = cloneBounds(this.currentBounds);

  elapsed = 0;
  duration = 0;
  easing: EasingName = 'smoothstep';
  fromZoneName: string | null = null;
  toZoneName: string | null = null;

  /** 直接跳到某个目标（初始化 / 时间轴 seek 时使用） */
  snap(target: TransitionTarget): void {
    this.currentParams = cloneParams(target.params);
    this.toParams = cloneParams(target.params);
    this.fromParams = cloneParams(target.params);
    this.currentBounds = cloneBounds(target.bounds);
    this.toBounds = cloneBounds(target.bounds);
    this.fromBounds = cloneBounds(target.bounds);
    this.duration = 0;
    this.elapsed = 0;
    this.easing = target.easing;
    this.toZoneName = target.zoneName;
    this.fromZoneName = target.zoneName;
  }

  /** 开始一段过渡；若正在过渡中，从当前混合值重新定向 */
  retarget(target: TransitionTarget): void {
    // 已经是同一个完成态目标时不重启
    this.fromParams = cloneParams(this.currentParams);
    this.fromBounds = cloneBounds(this.currentBounds);
    this.toParams = cloneParams(target.params);
    this.toBounds = cloneBounds(target.bounds);
    this.fromZoneName = this.toZoneName;
    this.toZoneName = target.zoneName;
    this.easing = target.easing;
    this.elapsed = 0;
    this.duration = Math.max(0, target.transitionTime);
    if (this.duration === 0) {
      this.currentParams = cloneParams(this.toParams);
      this.currentBounds = cloneBounds(this.toBounds);
    }
  }

  /** UI 实时编辑当前区域参数时，同步目标值；若过渡已结束则直接生效 */
  patchTarget(params: CameraParams, bounds: Bounds3D): void {
    this.toParams = cloneParams(params);
    this.toBounds = cloneBounds(bounds);
    if (!this.isTransitioning()) {
      this.currentParams = cloneParams(params);
      this.currentBounds = cloneBounds(bounds);
      this.fromParams = cloneParams(params);
      this.fromBounds = cloneBounds(bounds);
    }
  }

  isTransitioning(): boolean {
    return this.duration > 0 && this.elapsed < this.duration;
  }

  get rawT(): number {
    return this.duration <= 0 ? 1 : Math.min(1, this.elapsed / this.duration);
  }

  update(dt: number): void {
    if (this.duration <= 0) return;
    this.elapsed = Math.min(this.duration, this.elapsed + dt);
    const t = ease(this.easing, this.elapsed / this.duration);
    this.currentParams = lerpParams(this.fromParams, this.toParams, t);
    this.currentBounds = lerpBounds(this.fromBounds, this.toBounds, t);
    if (this.elapsed >= this.duration) {
      this.currentParams = cloneParams(this.toParams);
      this.currentBounds = cloneBounds(this.toBounds);
    }
  }
}
