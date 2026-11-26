// 所有可序列化数据结构。项目文件 / 运行时导出都基于这些类型。

export type Vec3Tuple = [number, number, number];

export type EasingName =
  | 'linear'
  | 'smoothstep'
  | 'easeOutCubic'
  | 'easeInOutCubic'
  | 'easeInOutQuad'
  | 'easeOutBack';

/** 一组完整的第三人称镜头参数（区域可以整体覆盖） */
export interface CameraParams {
  /** 跟随距离（目标枢轴到镜头的球面距离，米） */
  distance: number;
  /** 镜头额外高度偏移（米） */
  height: number;
  /** 肩部 / 水平右偏移（米，负值向左） */
  shoulder: number;
  /** 相对角色朝向的水平角度偏移（度） */
  yawOffset: number;
  /** 俯仰角（度，越大越俯视） */
  pitch: number;
  /** 前向注视偏移（米，看向角色前方） */
  lookAhead: number;
  /** 注视枢轴相对角色脚底的高度（米） */
  targetHeight: number;
  fov: number;
}

/** 镜头世界坐标 AABB 边界（镜头位置会被 clamp 到盒子内） */
export interface Bounds3D {
  enabled: boolean;
  min: Vec3Tuple;
  max: Vec3Tuple;
}

export interface CameraZone {
  id: string;
  name: string;
  color: string;
  /** 盒体中心（世界坐标） */
  center: Vec3Tuple;
  /** 盒体完整尺寸 */
  size: Vec3Tuple;
  /** 绕 Y 轴旋转（度） */
  rotationY: number;
  /** 重叠时 priority 大的区域生效 */
  priority: number;
  /** 出区域滞回距离（米），防止边界抖动 */
  hysteresis: number;
  /** 进入该区域时，参数过渡的秒数 */
  transitionTime: number;
  easing: EasingName;
  params: CameraParams;
  bounds: Bounds3D;
}

export interface Waypoint {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  /** 从上一个点移动到该点所需秒数（第一个点忽略） */
  moveTime: number;
  /** 到达该点后停留秒数 */
  hold: number;
}

export type LoopMode = 'once' | 'loop' | 'pingpong';

export interface RouteConfig {
  loopMode: LoopMode;
  waypoints: Waypoint[];
}

export interface OcclusionConfig {
  enabled: boolean;
  /** 命中点前预留距离，防止贴墙 / 穿模 */
  skin: number;
  /** 允许侧向移位尝试 */
  sideProbe: boolean;
  /** 允许抬高镜头尝试 */
  raiseProbe: boolean;
  /** 避让位置平滑时间（秒） */
  smoothing: number;
}

export interface ProjectData {
  appId: 'third-person-camera-debugger';
  schemaVersion: 1;
  name: string;
  savedAt?: string;
  defaultParams: CameraParams;
  occlusion: OcclusionConfig;
  zones: CameraZone[];
  route: RouteConfig;
}

/** 导出给游戏运行时的精简结构 */
export interface RuntimeCameraConfig {
  format: 'tpc-camera-config';
  formatVersion: 1;
  defaultParams: CameraParams;
  occlusion: OcclusionConfig;
  zones: Array<{
    id: string;
    name: string;
    priority: number;
    shape: {
      type: 'box';
      center: Vec3Tuple;
      size: Vec3Tuple;
      rotationY: number;
      hysteresis: number;
    };
    transition: { time: number; easing: EasingName };
    params: CameraParams;
    bounds: Bounds3D;
  }>;
}

export type OcclusionReasonKind =
  | 'clear'
  | 'pull-in'
  | 'side-shift'
  | 'raise'
  | 'combined'
  | 'forced';

export interface OcclusionReport {
  kind: OcclusionReasonKind;
  /** 中文原因，直接显示在调试面板 */
  reason: string;
  hitObjectName: string | null;
  /** 原始期望位置到第一个碰撞点的距离 */
  hitDistance: number | null;
  /** 期望距离 vs 最终距离 */
  desiredDistance: number;
  finalDistance: number;
  /** 调试用：尝试过的候选点 */
  attempts: OcclusionAttempt[];
  /** 最近一次射线命中点 / 起点，用于画调试线 */
  rayFrom: Vec3Tuple | null;
  rayTo: Vec3Tuple | null;
  hitPoint: Vec3Tuple | null;
}

export interface OcclusionAttempt {
  label: string;
  clear: boolean;
  cost: number;
  position: Vec3Tuple;
  hitName?: string;
}

export interface ResolvedCameraState {
  zoneId: string | null;
  zoneName: string;
  /** 同时包含目标点的所有区域（按优先级） */
  overlappingZoneIds: string[];
  /** 当前区域是靠滞回距离保留的（目标已短暂越界） */
  hysteresisKept: boolean;
  fromZoneName: string | null;
  transition: { active: boolean; elapsed: number; duration: number; t: number; easing: EasingName };
  params: CameraParams;
  boundsActive: boolean;
  boundsClamped: boolean;
  target: Vec3Tuple;
  targetYaw: number;
  desiredPosition: Vec3Tuple;
  finalPosition: Vec3Tuple;
  lookAt: Vec3Tuple;
  fov: number;
  occlusion: OcclusionReport;
}
