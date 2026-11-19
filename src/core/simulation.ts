/**
 * 无状态粒子仿真。
 *
 * 关键约束：任意时间 t 的粒子集合只由「项目参数 + 种子 + t」决定，
 * 不依赖此前播放过哪些帧。因此拖动时间轴、逐帧前进、修改参数后
 * 预览都能得到一致结果，也不会出现播放状态错乱。
 *
 * 位置采用解析积分：pos = p0 + v·age + ½g·age²，
 * 不必逐帧累加，所以可直接跳到任意时间点。
 */

import { clamp, candidateBase, channelUnit, emitterHash } from './rng.ts';
import { evalCurve } from './curve.ts';
import { evalGradient } from './color.ts';
import type {
  EmitterConfig,
  EmitterSimResult,
  Particle,
  SceneConfig,
  SimulationResult,
  Vec2,
} from './types.ts';

/** 单个发射器每轮最多检查的候选粒子数；超出后等距抽样扫描。 */
export const MAX_SCAN_PER_EMITTER = 24000;
/** 单个发射器每轮最多渲染的粒子数。 */
export const MAX_RENDER_PER_EMITTER = 20000;
/** 渲染粒子总数硬上限，避免异常参数拖垮页面。 */
export const HARD_PARTICLE_LIMIT = 60000;
/** 发射器数量上限。 */
export const HARD_EMITTER_LIMIT = 16;

const EPS = 1e-6;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const TIME_EPS = 1e-9;

/** 随机通道索引。 */
const CH_ANGLE = 0;
const CH_RADIUS = 1;
const CH_DIRECTION = 2;
const CH_SPEED = 3;
const CH_LIFE = 4;
const CH_VARIANT = 5;
const CH_SIZE = 6;

const STREAM_RATE = 0;
const STREAM_BURST = 1;

export function sanitizeRange(min: number, max: number): [number, number] {
  const a = Number.isFinite(min) ? min : 0;
  const b = Number.isFinite(max) ? max : 0;
  return a <= b ? [a, b] : [b, a];
}

/** 发射器在某一时刻的位置，完全由时间决定。 */
export function emitterPositionAt(emitter: EmitterConfig, t: number): Vec2 {
  const base = emitter.position;
  const motion = emitter.motion;
  const radius = Number.isFinite(motion.radius) ? motion.radius : 0;
  const radiusY = Number.isFinite(motion.radiusY) ? motion.radiusY : 0;
  const speed = Number.isFinite(motion.speed) ? motion.speed : 0;
  const phase = (Number.isFinite(motion.phase) ? motion.phase : 0) * DEG;
  const angle = phase + speed * t;

  switch (motion.type) {
    case 'orbit':
      return {
        x: base.x + Math.cos(angle) * radius,
        y: base.y + Math.sin(angle) * (radiusY || radius),
      };
    case 'pingpong': {
      // 三角波：水平方向在 +radius 与 -radius 之间匀速往返；
      // 纵向以半径 radiusY、半速缓慢起伏，轨迹始终有界。
      const tri = (2 / Math.PI) * Math.asin(clamp(Math.sin(angle), -1, 1));
      return {
        x: base.x + tri * radius,
        y: base.y + radiusY * Math.sin(angle * 0.5),
      };
    }
    case 'static':
    default:
      return { x: base.x, y: base.y };
  }
}

interface CandidateRef {
  spawnTime: number;
  cycle: number;
  stream: number;
  index: number;
}

interface ScanPlan {
  /** 寿命窗口内的候选总量 */
  candidateCount: number;
  /** 本轮实际检查的候选数 */
  scanCount: number;
  /** 采样倍率：1 表示全量检查 */
  stride: number;
  scanReduced: boolean;
  /** 第 i 个被检查候选（i < scanCount） */
  describe: (i: number) => CandidateRef;
}

function makePlan(
  candidateCount: number,
  scanLimit: number,
  toCandidate: (ordinal: number) => CandidateRef,
): ScanPlan | null {
  if (!(candidateCount > 0) || !Number.isFinite(candidateCount)) return null;
  const stride = candidateCount > scanLimit ? candidateCount / scanLimit : 1;
  const scanCount = stride === 1 ? candidateCount : scanLimit;
  if (stride === 1) {
    return { candidateCount, scanCount, stride, scanReduced: false, describe: toCandidate };
  }
  return {
    candidateCount,
    scanCount,
    stride,
    scanReduced: true,
    describe: (i) => toCandidate(Math.min(candidateCount - 1, Math.floor(i * stride))),
  };
}

function planRate(
  emitter: EmitterConfig,
  t: number,
  maxLife: number,
  scanLimit: number,
): ScanPlan | null {
  const emission = emitter.emission;
  if (!(emission.rate > 0)) return null;
  const rate = Math.max(emission.rate, 1e-4);
  const first = Math.max(0, emission.startDelay);
  if (t < first - TIME_EPS) return null;

  let lastIndex = Math.floor((t - first) * rate + 1e-7);
  if (!emission.loop) {
    // 非循环：只在 [startDelay, startDelay + duration) 内发射。
    // 用 ceil 才能包含恰好落在窗口内的最后一次发射。
    const windowCount = Math.ceil(Math.max(0, emission.duration) * rate - 1e-7);
    lastIndex = Math.min(lastIndex, windowCount - 1);
  }
  if (lastIndex < 0) return null;

  let firstIndex = Math.ceil((t - maxLife - first) * rate - 1e-7);
  if (firstIndex < 0) firstIndex = 0;
  if (firstIndex > lastIndex) return null;

  return makePlan(lastIndex - firstIndex + 1, scanLimit, (ordinal) => {
    const k = firstIndex + ordinal;
    return { spawnTime: first + k / rate, cycle: 0, stream: STREAM_RATE, index: k };
  });
}

function planBurst(
  emitter: EmitterConfig,
  t: number,
  maxLife: number,
  scanLimit: number,
): ScanPlan | null {
  const emission = emitter.emission;
  const count = Math.max(0, Math.floor(emission.burstCount));
  if (count === 0) return null;

  const firstBurst = Math.max(0, emission.startDelay) + Math.max(0, emission.burstTime);
  if (t < firstBurst - TIME_EPS) return null;

  const loop = emission.loop;
  const period = loop ? Math.max(emission.duration, 0.01) : Number.POSITIVE_INFINITY;
  let minCycle = 0;
  let maxCycle = 0;
  if (loop) {
    maxCycle = Math.floor((t - firstBurst) / period + TIME_EPS);
    minCycle = Math.ceil((t - maxLife - firstBurst) / period - TIME_EPS);
    if (minCycle < 0) minCycle = 0;
    if (maxCycle < minCycle) return null;
  } else if (firstBurst < t - maxLife - TIME_EPS) {
    return null;
  }

  const cycles = maxCycle - minCycle + 1;
  return makePlan(cycles * count, scanLimit, (ordinal) => {
    const cycleOffset = Math.floor(ordinal / count);
    const index = ordinal - cycleOffset * count;
    const cycle = minCycle + cycleOffset;
    return {
      // 非循环时 period 为 Infinity，避免 0 × Infinity = NaN。
      spawnTime: loop ? firstBurst + cycle * period : firstBurst,
      cycle,
      stream: STREAM_BURST,
      index,
    };
  });
}

function planFor(
  emitter: EmitterConfig,
  t: number,
  maxLife: number,
  scanLimit: number,
): ScanPlan | null {
  return emitter.emission.mode === 'burst'
    ? planBurst(emitter, t, maxLife, scanLimit)
    : planRate(emitter, t, maxLife, scanLimit);
}

function sampleLife(emitter: EmitterConfig, unit: number): number {
  const [min, max] = sanitizeRange(emitter.lifetime.min, emitter.lifetime.max);
  return Math.max(EPS, min + (max - min) * unit);
}

interface CountOutcome {
  /** 检查过的候选数 */
  checked: number;
  /** 检查中存活的候选数 */
  alive: number;
  /** 按采样倍率还原的存活估计 */
  aliveEstimate: number;
}

function countAlive(
  emitter: EmitterConfig,
  plan: ScanPlan,
  t: number,
  seed: number,
  emitterHashValue: number,
): CountOutcome {
  let checked = 0;
  let alive = 0;
  for (let i = 0; i < plan.scanCount; i++) {
    const c = plan.describe(i);
    if (c.spawnTime > t + TIME_EPS) break;
    checked++;
    const base = candidateBase(seed, emitterHashValue, c.cycle, c.stream, c.index);
    if (t - c.spawnTime < sampleLife(emitter, channelUnit(base, CH_LIFE))) alive++;
  }
  const ratio = plan.scanCount > 0 ? plan.candidateCount / plan.scanCount : 0;
  return {
    checked,
    alive,
    aliveEstimate: Math.min(plan.candidateCount, Math.round(alive * (ratio || 1))),
  };
}

interface BuildOutcome {
  particles: Particle[];
}

function buildParticles(
  emitter: EmitterConfig,
  plan: ScanPlan,
  t: number,
  seed: number,
  emitterHashValue: number,
  gravity: Vec2,
  allowance: number,
  aliveInScan: number,
): BuildOutcome {
  const particles: Particle[] = [];
  if (allowance <= 0) return { particles };

  const [speedMinRaw, speedMaxRaw] = sanitizeRange(emitter.speed.min, emitter.speed.max);
  const speedMin = Math.max(0, speedMinRaw);
  const speedSpan = Math.max(0, speedMaxRaw) - speedMin;
  const spawnRadius = Math.max(0, emitter.spawnRadius);
  const directionBase = emitter.direction.angle * DEG;
  const spread = Math.max(0, emitter.direction.spread) * DEG;
  const gravityScale = Number.isFinite(emitter.gravityScale) ? emitter.gravityScale : 1;
  const gx = gravity.x * gravityScale;
  const gy = gravity.y * gravityScale;
  const local = emitter.space === 'local';
  const emitterNow = local ? emitterPositionAt(emitter, t) : null;
  // 抽样步长以「本次扫描实际看到的存活数」为准，避免估算偏差导致空转。
  const basis = Math.max(1, aliveInScan);
  const subset = allowance < basis;
  const alphaScale = clamp(emitter.alpha, 0, 1);

  let aliveIndex = 0;

  for (let i = 0; i < plan.scanCount; i++) {
    const c = plan.describe(i);
    if (c.spawnTime > t + TIME_EPS) break;

    const base = candidateBase(seed, emitterHashValue, c.cycle, c.stream, c.index);
    const life = sampleLife(emitter, channelUnit(base, CH_LIFE));
    const age = t - c.spawnTime;
    if (age < -TIME_EPS || age >= life) continue;
    if (particles.length >= allowance) break;

    if (subset) {
      // 分层等距抽样：在存活序列中均匀保留 allowance 个。
      const before = Math.floor((aliveIndex * allowance) / basis);
      const after = Math.floor(((aliveIndex + 1) * allowance) / basis);
      aliveIndex++;
      if (after === before) continue;
    }

    const u = clamp(age / life, 0, 1);

    const spawnAngle = channelUnit(base, CH_ANGLE) * TAU;
    const spawnDist = Math.sqrt(channelUnit(base, CH_RADIUS)) * spawnRadius;
    const offsetX = Math.cos(spawnAngle) * spawnDist;
    const offsetY = Math.sin(spawnAngle) * spawnDist;

    const direction = directionBase + (channelUnit(base, CH_DIRECTION) - 0.5) * spread;
    const speed = speedMin + speedSpan * channelUnit(base, CH_SPEED);
    const vx = Math.cos(direction) * speed;
    const vy = Math.sin(direction) * speed;

    const anchor = emitterNow ?? emitterPositionAt(emitter, c.spawnTime);
    const x = anchor.x + offsetX + vx * age + 0.5 * gx * age * age;
    const y = anchor.y + offsetY + vy * age + 0.5 * gy * age * age;

    const sizeScale = 0.8 + 0.4 * channelUnit(base, CH_SIZE);
    const size = Math.max(0.05, evalCurve(emitter.sizeCurve, u) * sizeScale);
    const alpha = clamp(evalCurve(emitter.alphaCurve, u), 0, 1) * alphaScale;

    particles.push({
      x,
      y,
      vx: vx + gx * age,
      vy: vy + gy * age,
      size,
      alpha,
      color: evalGradient(emitter.gradient, u),
      spawnTime: c.spawnTime,
      age,
      life,
      u,
      variant: Math.floor(channelUnit(base, CH_VARIANT) * 3) % 3,
    });
  }

  return { particles };
}

function clock(): number {
  return globalThis.performance?.now() ?? Date.now();
}

export interface SimulateOptions {
  /** 总预算；默认使用 scene.maxParticles */
  cap?: number;
  /** 单个发射器的扫描上限；测试时可调小 */
  scanLimit?: number;
  /** 单个发射器的渲染上限；测试时可调小 */
  renderLimit?: number;
}

export function simulateScene(
  scene: SceneConfig,
  emitters: EmitterConfig[],
  t: number,
  options: SimulateOptions = {},
): SimulationResult {
  const cap = clamp(Math.floor(options.cap ?? scene.maxParticles), 0, HARD_PARTICLE_LIMIT);
  const scanLimit = clamp(Math.floor(options.scanLimit ?? MAX_SCAN_PER_EMITTER), 1, 200000);
  const renderLimit = clamp(
    Math.floor(options.renderLimit ?? MAX_RENDER_PER_EMITTER),
    0,
    HARD_PARTICLE_LIMIT,
  );
  const time = Math.max(0, t);

  const prepared = emitters.slice(0, HARD_EMITTER_LIMIT).map((emitter) => {
    if (!emitter.enabled) return { emitter, plan: null, count: null };
    const [, maxLife] = sanitizeRange(emitter.lifetime.min, emitter.lifetime.max);
    const plan = planFor(emitter, time, Math.max(maxLife, EPS), scanLimit);
    if (!plan) return { emitter, plan: null, count: null };
    const count = countAlive(emitter, plan, time, scene.seed, emitterHash(emitter.id));
    return { emitter, plan, count };
  });

  let aliveTotal = 0;
  for (const item of prepared) aliveTotal += item.count?.aliveEstimate ?? 0;

  const overBudget = aliveTotal > cap;
  const results: EmitterSimResult[] = [];
  let remaining = cap;
  let candidateTotal = 0;
  let omittedTotal = 0;
  let total = 0;
  let scanReduced = false;

  for (const item of prepared) {
    const started = clock();
    const { emitter, plan, count } = item;
    if (!plan || !count) {
      results.push({
        emitterId: emitter.id,
        particles: [],
        candidateCount: 0,
        scannedCount: 0,
        aliveCount: 0,
        omitted: 0,
        budget: 0,
        truncated: false,
        scanReduced: false,
        simMs: clock() - started,
      });
      continue;
    }

    const estimate = count.aliveEstimate;
    // 抽样扫描时，用实际检查到的存活数作为渲染与抽样基数；
    // 全量扫描时它就是精确存活数。
    const basis = plan.scanReduced ? count.alive : estimate;

    // 预算内按比例分配；超预算时每个有粒子的发射器至少保留 1 个，便于看清画面。
    let share: number;
    if (overBudget) {
      share = Math.floor((cap * estimate) / Math.max(1, aliveTotal));
      if (estimate > 0 && share < 1) share = 1;
    } else {
      share = estimate;
    }
    if (plan.scanReduced) share = Math.min(share, basis);

    const allowance = Math.max(0, Math.min(share, renderLimit, remaining));

    const built = buildParticles(
      emitter,
      plan,
      time,
      scene.seed,
      emitterHash(emitter.id),
      scene.gravity,
      allowance,
      basis,
    );

    remaining = Math.max(0, remaining - built.particles.length);

    // 全量扫描时 estimate 是精确存活数；抽样扫描时以本次扫描到的存活数
    // 为口径，额外由 scanReduced 提示「画面为近似值」。
    const aliveCount = plan.scanReduced ? basis : estimate;
    const omitted = Math.max(0, aliveCount - built.particles.length);
    total += built.particles.length;
    candidateTotal += plan.candidateCount;
    omittedTotal += omitted;
    if (plan.scanReduced) scanReduced = true;

    results.push({
      emitterId: emitter.id,
      particles: built.particles,
      candidateCount: plan.candidateCount,
      scannedCount: count.checked,
      aliveCount,
      omitted,
      budget: allowance,
      truncated: omitted > 0,
      scanReduced: plan.scanReduced,
      simMs: clock() - started,
    });
  }

  return {
    emitters: results,
    total,
    candidateTotal,
    aliveTotal,
    omittedTotal,
    cap,
    capped: omittedTotal > 0,
    overBudget,
    scanReduced,
  };
}
