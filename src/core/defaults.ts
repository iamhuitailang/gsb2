import type { CameraParams, ProjectData } from './types';

export const STORAGE_KEY = 'tp-camera-debugger-project-v1';

export const DEFAULT_PARAMS: CameraParams = {
  distance: 6.5,
  height: 0.6,
  shoulder: 0.9,
  yawOffset: 0,
  pitch: 14,
  lookAhead: 0.9,
  targetHeight: 1.4,
  fov: 55,
};

/**
 * 内置示例布局（俯视 XZ 平面，Y 向上）：
 *
 *   z+  广场 Plaza（开阔、长跟随距离、右肩偏移）
 *        wp0 ●
 *              ╲  遮挡柱 / 货箱
 *               wp2 ● ──→ wp3 ● ──┐
 *   z=0  ─────────────────────── 门洞(墙 x≈0) ── wp4 ── 窄路(两墙夹道) ── wp6/7 ── 转弯
 *                                                └────────────────────────────── wp8/9
 *   z-                                  拐角观景区域（反向往返可验证镜头不跳变）
 *
 * 所有几何体都由代码生成，见 src/scene/buildScene.ts。
 */
export function createDefaultProject(): ProjectData {
  return {
    appId: 'third-person-camera-debugger',
    schemaVersion: 1,
    name: '门洞 · 窄路 · 多镜头区域 示例',
    defaultParams: { ...DEFAULT_PARAMS },
    occlusion: {
      enabled: true,
      skin: 0.25,
      sideProbe: true,
      raiseProbe: true,
      smoothing: 0.08,
    },
    zones: [
      {
        id: 'zone_plaza',
        name: '开阔广场',
        color: '#38bdf8',
        center: [-9.5, 3, 3],
        size: [15, 6, 12],
        rotationY: 0,
        priority: 1,
        hysteresis: 0.35,
        transitionTime: 1.0,
        easing: 'smoothstep',
        params: {
          distance: 7.6,
          height: 0.9,
          shoulder: 1.15,
          yawOffset: 0,
          pitch: 12,
          lookAhead: 1.0,
          targetHeight: 1.4,
          fov: 58,
        },
        bounds: {
          enabled: true,
          min: [-24, 0.3, -6],
          max: [2, 9, 13],
        },
      },
      {
        id: 'zone_door',
        name: '门洞近距离',
        color: '#f59e0b',
        center: [0.8, 2.5, 0],
        size: [5.2, 5, 7],
        rotationY: 0,
        priority: 3,
        hysteresis: 0.25,
        transitionTime: 0.35,
        easing: 'easeOutCubic',
        params: {
          distance: 3.6,
          height: 0.25,
          shoulder: 0,
          yawOffset: 0,
          pitch: 10,
          lookAhead: 0.6,
          targetHeight: 1.4,
          fov: 63,
        },
        // 关键边界：z 向夹在门洞宽度内，镜头不会晃到墙外侧
        bounds: {
          enabled: true,
          min: [-7.5, 0.4, -1.75],
          max: [3.6, 3.4, 1.75],
        },
      },
      {
        id: 'zone_alley',
        name: '窄路俯视',
        color: '#a78bfa',
        center: [7.4, 2.6, 0],
        size: [8.8, 5.2, 4.6],
        rotationY: 0,
        priority: 2,
        hysteresis: 0.25,
        transitionTime: 0.5,
        easing: 'easeInOutCubic',
        params: {
          distance: 3.1,
          height: 0.5,
          shoulder: 0.15,
          yawOffset: 0,
          pitch: 22,
          lookAhead: 0.5,
          targetHeight: 1.35,
          fov: 60,
        },
        // 镜头必须留在两墙之间
        bounds: {
          enabled: true,
          min: [2.6, 0.45, -1.5],
          max: [12.2, 4.6, 1.5],
        },
      },
      {
        id: 'zone_overlook',
        name: '转角观景',
        color: '#34d399',
        center: [12.8, 3, -5],
        size: [6.4, 6, 7.2],
        rotationY: 0,
        priority: 1,
        hysteresis: 0.35,
        transitionTime: 1.1,
        easing: 'easeInOutCubic',
        params: {
          distance: 6.2,
          height: 1.1,
          shoulder: -1.4,
          yawOffset: 12,
          pitch: 16,
          lookAhead: 0.8,
          targetHeight: 1.4,
          fov: 52,
        },
        bounds: {
          enabled: false,
          min: [9, 0.5, -9],
          max: [16.5, 8, -1],
        },
      },
    ],
    route: {
      loopMode: 'pingpong',
      waypoints: [
        { id: 'wp_0', name: '广场起点', x: -15, y: 0, z: 6, moveTime: 0, hold: 0.8 },
        { id: 'wp_1', name: '广场斜行', x: -10.5, y: 0, z: 4.5, moveTime: 4.2, hold: 0 },
        { id: 'wp_2', name: '货箱旁', x: -7, y: 0, z: 1.5, moveTime: 3.6, hold: 0.2 },
        { id: 'wp_3', name: '门洞前', x: -3.2, y: 0, z: 0, moveTime: 3.4, hold: 0.4 },
        { id: 'wp_4', name: '穿过门洞', x: 1.2, y: 0, z: 0, moveTime: 2.8, hold: 0.2 },
        { id: 'wp_5', name: '进入窄路', x: 4.8, y: 0, z: 0, moveTime: 2.6, hold: 0 },
        { id: 'wp_6', name: '窄路中段', x: 8.2, y: 0, z: 0, moveTime: 2.8, hold: 0.2 },
        { id: 'wp_7', name: '窄路出口', x: 10.6, y: 0, z: 0, moveTime: 2.0, hold: 0.2 },
        { id: 'wp_8', name: '右转', x: 12.8, y: 0, z: -2.6, moveTime: 2.6, hold: 0.2 },
        { id: 'wp_9', name: '观景终点', x: 12.8, y: 0, z: -7.6, moveTime: 3.6, hold: 1.0 },
      ],
    },
  };
}
