import type {
  BackgroundMode,
  BlendMode,
  Curve,
  EmissionMode,
  EmitterConfig,
  Gradient,
  MotionType,
  Project,
  SceneConfig,
  SpaceMode,
  TextureKind,
  Vec2,
} from './types.ts';
import { PROJECT_VERSION, STAGE_HEIGHT, STAGE_WIDTH } from './types.ts';
import { isEasing, normalizeCurvePoints } from './curve.ts';
import { isValidHexColor, normalizeGradient } from './color.ts';
import { HARD_EMITTER_LIMIT, HARD_PARTICLE_LIMIT } from './simulation.ts';

export interface NormalizeResult {
  project: Project;
  warnings: string[];
}

let emitterCounter = 0;

export function createEmitterId(): string {
  emitterCounter += 1;
  return `emitter-${Date.now().toString(36)}-${emitterCounter}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

function num(value: unknown, fallback: number, min = -Infinity, max = Infinity, warnings?: string[], label?: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min || parsed > max) {
    if (warnings && label) warnings.push(`${label} 超出范围，已限制为 ${Math.min(max, Math.max(min, parsed))}。`);
    return Math.min(max, Math.max(min, parsed));
  }
  return parsed;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(num(value, fallback, min, max));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pick<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function text(value: unknown, fallback: string, maxLength = 80): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLength);
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function vec2(value: unknown, fallback: Vec2, limit = 4000): Vec2 {
  const raw = obj(value);
  return {
    x: num(raw.x, fallback.x, -limit, limit),
    y: num(raw.y, fallback.y, -limit, limit),
  };
}

const SPACE_OPTIONS: readonly SpaceMode[] = ['local', 'world'];
const BLEND_OPTIONS: readonly BlendMode[] = ['normal', 'additive'];
const TEXTURE_OPTIONS: readonly TextureKind[] = ['soft', 'smoke', 'spark'];
const MOTION_OPTIONS: readonly MotionType[] = ['static', 'orbit', 'pingpong'];
const EMISSION_OPTIONS: readonly EmissionMode[] = ['rate', 'burst'];
const BACKGROUND_OPTIONS: readonly BackgroundMode[] = ['preview', 'dark', 'transparent'];

export function defaultSizeCurve(): Curve {
  return {
    points: [
      { t: 0, v: 20 },
      { t: 0.35, v: 42 },
      { t: 0.75, v: 58 },
      { t: 1, v: 66 },
    ],
    interpolation: 'smoothstep',
  };
}

export function defaultAlphaCurve(): Curve {
  return {
    points: [
      { t: 0, v: 0 },
      { t: 0.08, v: 0.85 },
      { t: 0.55, v: 0.5 },
      { t: 1, v: 0 },
    ],
    interpolation: 'smoothstep',
  };
}

export function defaultGradient(): Gradient {
  return {
    stops: [
      { t: 0, color: '#fff1c9' },
      { t: 0.45, color: '#ffb15c' },
      { t: 1, color: '#ff4d2e' },
    ],
  };
}

export function createEmitter(overrides: Partial<EmitterConfig> = {}): EmitterConfig {
  const base: EmitterConfig = {
    id: createEmitterId(),
    name: '新发射器',
    enabled: true,
    position: { x: STAGE_WIDTH / 2, y: STAGE_HEIGHT * 0.72 },
    motion: { type: 'static', speed: 0.8, radius: 80, radiusY: 40, phase: 0 },
    space: 'world',
    texture: 'soft',
    blend: 'additive',
    emission: {
      mode: 'rate',
      rate: 60,
      duration: 8,
      loop: true,
      startDelay: 0,
      burstCount: 32,
      burstTime: 0,
    },
    speed: { min: 120, max: 260 },
    direction: { angle: 270, spread: 60 },
    spawnRadius: 12,
    lifetime: { min: 0.6, max: 1.4 },
    sizeCurve: defaultSizeCurve(),
    alphaCurve: defaultAlphaCurve(),
    gradient: defaultGradient(),
    alpha: 0.9,
    gravityScale: 1,
  };
  return mergeEmitter(base, overrides);
}

function mergeEmitter(base: EmitterConfig, overrides: Partial<EmitterConfig>): EmitterConfig {
  return {
    ...base,
    ...overrides,
    position: { ...base.position, ...overrides.position },
    motion: { ...base.motion, ...overrides.motion },
    emission: { ...base.emission, ...overrides.emission },
    speed: { ...base.speed, ...overrides.speed },
    direction: { ...base.direction, ...overrides.direction },
    lifetime: { ...base.lifetime, ...overrides.lifetime },
    sizeCurve: overrides.sizeCurve ?? base.sizeCurve,
    alphaCurve: overrides.alphaCurve ?? base.alphaCurve,
    gradient: overrides.gradient ?? base.gradient,
  };
}

export function defaultScene(): SceneConfig {
  return {
    seed: 20240517,
    duration: 10,
    fps: 30,
    gravity: { x: 0, y: 120 },
    maxParticles: 4000,
    background: 'preview',
  };
}

export function createProject(overrides: Partial<Project> = {}): Project {
  const scene = defaultScene();
  return {
    version: PROJECT_VERSION,
    name: overrides.name ?? '未命名粒子工程',
    scene: {
      ...scene,
      ...overrides.scene,
      gravity: { ...scene.gravity, ...overrides.scene?.gravity },
    },
    emitters: overrides.emitters ?? [createEmitter()],
  };
}

function normalizeCurve(value: unknown, fallback: Curve, maxPoints = 64): Curve {
  const raw = obj(value);
  const rawPoints = Array.isArray(raw.points) ? raw.points : [];
  const points = rawPoints.slice(0, maxPoints).map((point) => {
    const p = obj(point);
    return { t: num(p.t, 0, 0, 1), v: num(p.v, 0, -10000, 10000) };
  });
  const interpolation = isEasing(raw.interpolation) ? raw.interpolation : fallback.interpolation;
  if (points.length === 0) {
    return {
      points: fallback.points.map((p) => ({ ...p })),
      interpolation,
    };
  }
  return { points: normalizeCurvePoints(points), interpolation };
}

function normalizeGradientField(value: unknown, fallback: Gradient): Gradient {
  const raw = obj(value);
  const rawStops = Array.isArray(raw.stops) ? raw.stops : [];
  const stops = rawStops.slice(0, 16).map((stop) => {
    const s = obj(stop);
    return {
      t: num(s.t, 0, 0, 1),
      color: isValidHexColor(s.color) ? s.color.toLowerCase() : '#ffffff',
    };
  });
  if (stops.length === 0) {
    return normalizeGradient({ stops: fallback.stops.map((s) => ({ ...s })) });
  }
  return normalizeGradient({ stops });
}

function normalizeEmitter(value: unknown, index: number, warnings: string[]): EmitterConfig {
  const raw = obj(value);
  const fallback = createEmitter({ name: `发射器 ${index + 1}` });
  const label = text(raw.name, `#${index + 1}`);
  const emitterWarnings: string[] = [];
  const emissionRaw = obj(raw.emission);
  const mode = pick(emissionRaw.mode, EMISSION_OPTIONS, fallback.emission.mode);
  const emission = {
    mode,
    rate: num(emissionRaw.rate, fallback.emission.rate, 0, 2000),
    duration: num(emissionRaw.duration, fallback.emission.duration, 0.01, 120, emitterWarnings, '发射周期'),
    loop: bool(emissionRaw.loop, fallback.emission.loop),
    startDelay: num(emissionRaw.startDelay, fallback.emission.startDelay, 0, 120),
    burstCount: int(emissionRaw.burstCount, fallback.emission.burstCount, 0, 5000),
    burstTime: num(emissionRaw.burstTime, fallback.emission.burstTime, 0, 120),
  };
  if (raw.emission !== undefined && !Array.isArray(raw.emission) && typeof raw.emission === 'object') {
    const rawRate = num(emissionRaw.rate, fallback.emission.rate);
    if (rawRate !== emission.rate) {
      emitterWarnings.push('发射率已限制在 0–2000/秒');
    }
  }

  const rawId = typeof raw.id === 'string' ? raw.id.trim() : '';
  const id = rawId && rawId.length <= 120 ? rawId : createEmitterId();

  if (emitterWarnings.length > 0) {
    warnings.push(`发射器「${label}」：${emitterWarnings.join('；')}。`);
  }

  return {
    id,
    name: text(raw.name, fallback.name),
    enabled: bool(raw.enabled, true),
    position: vec2(raw.position, fallback.position),
    motion: {
      type: pick(obj(raw.motion).type, MOTION_OPTIONS, fallback.motion.type),
      speed: num(obj(raw.motion).speed, fallback.motion.speed, -30, 30),
      radius: num(obj(raw.motion).radius, fallback.motion.radius, 0, 2000),
      radiusY: num(obj(raw.motion).radiusY, fallback.motion.radiusY, 0, 2000),
      phase: num(obj(raw.motion).phase, fallback.motion.phase, -3600, 3600),
    },
    space: pick(raw.space, SPACE_OPTIONS, fallback.space),
    texture: pick(raw.texture, TEXTURE_OPTIONS, fallback.texture),
    blend: pick(raw.blend, BLEND_OPTIONS, fallback.blend),
    emission,
    speed: {
      min: num(obj(raw.speed).min, fallback.speed.min, 0, 5000),
      max: num(obj(raw.speed).max, fallback.speed.max, 0, 5000),
    },
    direction: {
      angle: num(obj(raw.direction).angle, fallback.direction.angle, -3600, 3600),
      spread: num(obj(raw.direction).spread, fallback.direction.spread, 0, 360),
    },
    spawnRadius: num(raw.spawnRadius, fallback.spawnRadius, 0, 1000),
    lifetime: {
      min: num(obj(raw.lifetime).min, fallback.lifetime.min, 0.02, 60),
      max: num(obj(raw.lifetime).max, fallback.lifetime.max, 0.02, 60),
    },
    sizeCurve: normalizeCurve(raw.sizeCurve, fallback.sizeCurve),
    alphaCurve: normalizeCurve(raw.alphaCurve, fallback.alphaCurve),
    gradient: normalizeGradientField(raw.gradient, fallback.gradient),
    alpha: num(raw.alpha, fallback.alpha, 0, 1),
    gravityScale: num(raw.gravityScale, fallback.gravityScale, -10, 10),
  };
}

export function normalizeProject(value: unknown): NormalizeResult {
  const warnings: string[] = [];
  const raw = obj(value);
  if (raw.version !== undefined && num(raw.version, 1, 0, 999) > PROJECT_VERSION) {
    warnings.push(`工程版本 ${String(raw.version)} 高于当前支持的 ${PROJECT_VERSION}，已尽量兼容。`);
  }
  const rawScene = obj(raw.scene);
  const sceneWarnings: string[] = [];
  const scene = {
    seed: int(rawScene.seed, defaultScene().seed, 0, 0xffffffff),
    duration: num(rawScene.duration, defaultScene().duration, 0.1, 120, sceneWarnings, '时间轴时长'),
    fps: int(rawScene.fps, defaultScene().fps, 1, 120),
    gravity: vec2(rawScene.gravity, defaultScene().gravity, 5000),
    maxParticles: int(rawScene.maxParticles, defaultScene().maxParticles, 0, HARD_PARTICLE_LIMIT),
    background: pick(rawScene.background, BACKGROUND_OPTIONS, defaultScene().background),
  };
  warnings.push(...sceneWarnings);

  const rawEmitters = Array.isArray(raw.emitters) ? raw.emitters : [];
  if (rawEmitters.length > HARD_EMITTER_LIMIT) {
    warnings.push(`工程包含 ${rawEmitters.length} 个发射器，超过上限 ${HARD_EMITTER_LIMIT}，多余部分已忽略。`);
  }
  const emitters = rawEmitters
    .slice(0, HARD_EMITTER_LIMIT)
    .map((emitter, index) => normalizeEmitter(emitter, index, warnings));

  const seen = new Set<string>();
  for (const emitter of emitters) {
    if (seen.has(emitter.id)) {
      const old = emitter.id;
      emitter.id = createEmitterId();
      warnings.push(`发现重复的发射器 id「${old}」，已重新分配。`);
    }
    seen.add(emitter.id);
    emitter.speed = {
      min: Math.min(emitter.speed.min, emitter.speed.max),
      max: Math.max(emitter.speed.min, emitter.speed.max),
    };
    emitter.lifetime = {
      min: Math.min(emitter.lifetime.min, emitter.lifetime.max),
      max: Math.max(emitter.lifetime.min, emitter.lifetime.max),
    };
  }

  return {
    project: {
      version: PROJECT_VERSION,
      name: text(raw.name, '未命名粒子工程'),
      scene,
      emitters,
    },
    warnings,
  };
}
