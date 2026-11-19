import type {
  BackgroundMode,
  BlendMode,
  Easing,
  EmissionMode,
  MotionType,
  SpaceMode,
  TextureKind,
} from './types.ts';

export const EASING_LABELS: Record<Easing, string> = {
  linear: '线性',
  easeIn: '缓入',
  easeOut: '缓出',
  easeInOut: '缓入缓出',
  smoothstep: '平滑',
};

export const SPACE_LABELS: Record<SpaceMode, string> = {
  local: '本地坐标',
  world: '世界坐标',
};

export const SPACE_HINTS: Record<SpaceMode, string> = {
  local: '已有粒子跟随发射器移动，适合烟囱、引擎尾焰。',
  world: '已有粒子留在出生位置，适合拖尾、爆点。',
};

export const BLEND_LABELS: Record<BlendMode, string> = {
  normal: '正常混合',
  additive: '叠加发光',
};

export const TEXTURE_LABELS: Record<TextureKind, string> = {
  soft: '柔和光点',
  smoke: '烟雾团',
  spark: '细长火花',
};

export const MOTION_LABELS: Record<MotionType, string> = {
  static: '静止',
  orbit: '环绕',
  pingpong: '往返',
};

export const EMISSION_LABELS: Record<EmissionMode, string> = {
  rate: '持续发射',
  burst: '一次性爆发',
};

export const BACKGROUND_LABELS: Record<BackgroundMode, string> = {
  preview: '渐变参考',
  dark: '纯深色',
  transparent: '透明',
};
