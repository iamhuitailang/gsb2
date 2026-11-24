// 固定尺寸，单位：米。探针放在格心，门位于 x = 1 的格边界上。

export const GRID = Object.freeze({
  originX: -5,
  originZ: -4,
  cell: 2,
  cols: 6,
  rows: 4,
  probeY: 0.98,
});

export const DIVIDER = Object.freeze({
  x: 1,
  thickness: 0.2,
  doorHalf: 1.1,
  doorHeight: 2.3,
  wallHeight: 3.1,
});

/** 渲染用的剖切高度：墙和门只画这么高，方便同时看到室内外。 */
export const CUTAWAY = Object.freeze({
  wallHeight: 1.34,
  doorHeight: 1.06,
});

export const ROOM = Object.freeze({
  minX: -5,
  maxX: 1,
  minZ: -4,
  maxZ: 4,
  height: 3.1,
});

export const FLOOR = Object.freeze({
  minX: -6,
  maxX: 8,
  minZ: -5,
  maxZ: 5,
});

export const MOVER = Object.freeze({
  size: 0.66,
  centerY: 0.33,
});

export const SAMPLE = Object.freeze({
  radius: 3.0,
  /**
   * 支撑度：参与探针的权重和 / supportTarget，夹在 0..1。
   * 权重和达到 supportTarget 即视为完全由实测数据覆盖；
   * 探针稀疏或缺格时支撑度下降，剩余部分按补缺值混合。
   */
  supportTarget: 0.5,
  fallback: {
    up: [0.22, 0.22, 0.24],
    side: {
      n: [0.16, 0.16, 0.17],
      e: [0.16, 0.16, 0.17],
      s: [0.16, 0.16, 0.17],
      w: [0.16, 0.16, 0.17],
    },
  },
});

/** 物体亮度 = 顶面与四个侧面颜色的加权（按可见面积近似）。 */
export const LUM_UP_WEIGHT = 0.35;
export const LUM_SIDE_WEIGHT = 0.65;

export const DEFAULT_STEP = 0.08;

/** 路径默认控制点：室内 → 穿门 → 室外。 */
export const DEFAULT_PATH = Object.freeze([
  { x: -3.5, z: 1.5 },
  { x: -2.2, z: 0.9 },
  { x: -1.0, z: 0.4 },
  { x: 0.3, z: 0.1 },
  { x: 1.3, z: 0.0 },
  { x: 2.8, z: -0.4 },
  { x: 4.4, z: -0.8 },
  { x: 6.0, z: -1.1 },
]);

export const DEMOS = Object.freeze({
  open: {
    label: '门开',
    title: '门开 · 门口有过渡',
    note: '门洞允许视线内的两侧探针经门口混色，门槛附近出现过渡带；室内远离门洞处仍偏暗。',
  },
  closed: {
    label: '门关',
    title: '门关 · 挡住另一侧亮色',
    note: '门关闭后，受区域限制的采样只用本侧探针；无区域限制的混色仍把室外亮色拖进室内，两条曲线在门内侧分开。',
  },
  gap: {
    label: '区域罩不全',
    title: '区域罩不全 · 补缺值介入',
    note: '室外远端倒数第二列探针缺失、最后一列被标为不可用：路径先出现“探针不足”的混合，再进入纯补缺。琥珀色标出补缺比例。',
  },
});

/** 分类色（已按暗色面校验的固定顺序，前两槽）。 */
export const COLORS = Object.freeze({
  surface: '#1a1a19',
  page: '#0d0d0d',
  seriesRestricted: '#3987e5',
  seriesUnrestricted: '#d95926',
  fallback: '#fab219',
  muted: '#898781',
  text: '#f0efec',
  textSecondary: '#c3c2b7',
  good: '#0ca30c',
  critical: '#d03b3b',
});
