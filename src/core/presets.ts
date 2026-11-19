import type { EmitterConfig, Project } from './types.ts';
import { PROJECT_VERSION } from './types.ts';
import { createEmitter, defaultScene } from './project.ts';

function sparkEmitters(): EmitterConfig[] {
  const core = createEmitter({
    id: 'preset-spark-core',
    name: '火花 · 核心',
    position: { x: 500, y: 360 },
    space: 'world',
    texture: 'spark',
    blend: 'additive',
    emission: {
      mode: 'burst',
      rate: 90,
      duration: 1.1,
      loop: true,
      startDelay: 0,
      burstCount: 46,
      burstTime: 0,
    },
    speed: { min: 220, max: 520 },
    direction: { angle: 270, spread: 360 },
    spawnRadius: 6,
    lifetime: { min: 0.6, max: 1.15 },
    sizeCurve: {
      points: [
        { t: 0, v: 7 },
        { t: 0.3, v: 5 },
        { t: 1, v: 1 },
      ],
      interpolation: 'easeOut',
    },
    alphaCurve: {
      points: [
        { t: 0, v: 1 },
        { t: 0.6, v: 0.8 },
        { t: 1, v: 0 },
      ],
      interpolation: 'easeOut',
    },
    gradient: {
      stops: [
        { t: 0, color: '#fff8d6' },
        { t: 0.35, color: '#ffd05a' },
        { t: 0.7, color: '#ff7a1a' },
        { t: 1, color: '#c22a12' },
      ],
    },
    alpha: 1,
    gravityScale: 1.6,
  });

  const drift = createEmitter({
    id: 'preset-spark-drift',
    name: '火花 · 余烬',
    position: { x: 500, y: 372 },
    space: 'world',
    texture: 'soft',
    blend: 'additive',
    emission: {
      mode: 'rate',
      rate: 26,
      duration: 1.1,
      loop: true,
      startDelay: 0,
      burstCount: 0,
      burstTime: 0,
    },
    speed: { min: 30, max: 120 },
    direction: { angle: 270, spread: 120 },
    spawnRadius: 28,
    lifetime: { min: 1.4, max: 2.8 },
    sizeCurve: {
      points: [
        { t: 0, v: 4 },
        { t: 0.5, v: 6 },
        { t: 1, v: 0.5 },
      ],
      interpolation: 'easeOut',
    },
    alphaCurve: {
      points: [
        { t: 0, v: 0 },
        { t: 0.2, v: 0.9 },
        { t: 1, v: 0 },
      ],
      interpolation: 'easeInOut',
    },
    gradient: {
      stops: [
        { t: 0, color: '#ffcf7a' },
        { t: 0.5, color: '#ff8a2b' },
        { t: 1, color: '#7a1d0c' },
      ],
    },
    alpha: 0.85,
    gravityScale: -0.12,
  });

  const flash = createEmitter({
    id: 'preset-spark-flash',
    name: '火花 · 闪焰',
    position: { x: 500, y: 360 },
    space: 'world',
    texture: 'smoke',
    blend: 'additive',
    emission: {
      mode: 'burst',
      rate: 0,
      duration: 1.1,
      loop: true,
      startDelay: 0,
      burstCount: 2,
      burstTime: 0,
    },
    speed: { min: 0, max: 10 },
    direction: { angle: 270, spread: 360 },
    spawnRadius: 4,
    lifetime: { min: 0.16, max: 0.26 },
    sizeCurve: {
      points: [
        { t: 0, v: 48 },
        { t: 1, v: 150 },
      ],
      interpolation: 'easeOut',
    },
    alphaCurve: {
      points: [
        { t: 0, v: 0.95 },
        { t: 1, v: 0 },
      ],
      interpolation: 'easeOut',
    },
    gradient: {
      stops: [
        { t: 0, color: '#fffdf0' },
        { t: 0.6, color: '#ffd27a' },
        { t: 1, color: '#ff8a2b' },
      ],
    },
    alpha: 0.8,
    gravityScale: 0,
  });

  return [flash, core, drift];
}

function smokeEmitters(): EmitterConfig[] {
  const body = createEmitter({
    id: 'preset-smoke-body',
    name: '烟雾 · 主体',
    position: { x: 500, y: 520 },
    space: 'local',
    texture: 'smoke',
    blend: 'normal',
    motion: { type: 'pingpong', speed: 0.9, radius: 46, radiusY: 0, phase: 0 },
    emission: {
      mode: 'rate',
      rate: 34,
      duration: 9,
      loop: true,
      startDelay: 0,
      burstCount: 0,
      burstTime: 0,
    },
    speed: { min: 28, max: 78 },
    direction: { angle: 270, spread: 38 },
    spawnRadius: 56,
    lifetime: { min: 3.2, max: 5.6 },
    sizeCurve: {
      points: [
        { t: 0, v: 46 },
        { t: 0.3, v: 110 },
        { t: 0.7, v: 190 },
        { t: 1, v: 240 },
      ],
      interpolation: 'easeOut',
    },
    alphaCurve: {
      points: [
        { t: 0, v: 0 },
        { t: 0.14, v: 0.34 },
        { t: 0.55, v: 0.2 },
        { t: 1, v: 0 },
      ],
      interpolation: 'easeInOut',
    },
    gradient: {
      stops: [
        { t: 0, color: '#8f8a86' },
        { t: 0.5, color: '#5f5c5a' },
        { t: 1, color: '#3a3938' },
      ],
    },
    alpha: 0.6,
    gravityScale: 0.02,
  });

  const haze = createEmitter({
    id: 'preset-smoke-haze',
    name: '烟雾 · 薄霭',
    position: { x: 500, y: 548 },
    space: 'world',
    texture: 'smoke',
    blend: 'normal',
    motion: { type: 'orbit', speed: 0.35, radius: 120, radiusY: 40, phase: 0 },
    emission: {
      mode: 'rate',
      rate: 12,
      duration: 9,
      loop: true,
      startDelay: 0,
      burstCount: 0,
      burstTime: 0,
    },
    speed: { min: 8, max: 34 },
    direction: { angle: 270, spread: 90 },
    spawnRadius: 120,
    lifetime: { min: 4.2, max: 6.5 },
    sizeCurve: {
      points: [
        { t: 0, v: 90 },
        { t: 1, v: 330 },
      ],
      interpolation: 'easeOut',
    },
    alphaCurve: {
      points: [
        { t: 0, v: 0 },
        { t: 0.25, v: 0.14 },
        { t: 1, v: 0 },
      ],
      interpolation: 'easeInOut',
    },
    gradient: {
      stops: [
        { t: 0, color: '#6c6a68' },
        { t: 1, color: '#33322f' },
      ],
    },
    alpha: 0.45,
    gravityScale: 0,
  });

  return [haze, body];
}

export interface PresetSummary {
  id: string;
  name: string;
  description: string;
  build: () => Project;
}

export const PRESETS: PresetSummary[] = [
  {
    id: 'spark',
    name: '火花 Sparx',
    description: '爆发式火花，叠加发光、带重力和余烬。演示 world 坐标与一次性爆发。',
    build: () => ({
      version: PROJECT_VERSION,
      name: '火花示例',
      scene: {
        ...defaultScene(),
        seed: 7351,
        duration: 6,
        fps: 30,
        gravity: { x: 0, y: 620 },
        maxParticles: 4000,
        background: 'dark',
      },
      emitters: sparkEmitters(),
    }),
  },
  {
    id: 'smoke',
    name: '烟雾 Smoke',
    description: '持续上升的烟雾柱，发射器往返摆动。演示 local 坐标与柔和大贴图。',
    build: () => ({
      version: PROJECT_VERSION,
      name: '烟雾示例',
      scene: {
        ...defaultScene(),
        seed: 9124,
        duration: 12,
        fps: 30,
        gravity: { x: 0, y: -18 },
        maxParticles: 4000,
        background: 'preview',
      },
      emitters: smokeEmitters(),
    }),
  },
];

export function getPreset(id: string): PresetSummary | null {
  return PRESETS.find((preset) => preset.id === id) ?? null;
}

export function createPresetProject(id: string): Project {
  const preset = getPreset(id) ?? PRESETS[0];
  return preset.build();
}
