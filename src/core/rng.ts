/**
 * 确定性随机数工具。
 *
 * 粒子的随机属性不依赖播放顺序：每个属性由
 * (项目种子, 发射器 id, 周期, 发射流, 粒子序号, 通道) 直接哈希得到，
 * 因此跳到任意一帧重新计算都能得到同样结果。
 */

const emitterHashCache = new Map<string, number>();

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** FNV-1a 32 位字符串哈希，跨会话稳定。 */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  return hash >>> 0;
}

export function hashInts(...values: number[]): number {
  let hash = 0x811c9dc5;
  for (const value of values) {
    hash ^= value >>> 0;
    hash = Math.imul(hash, 0x01000193);
    hash ^= hash >>> 13;
  }
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** Mulberry32：快、小、结果稳定。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function emitterHash(emitterId: string): number {
  let hash = emitterHashCache.get(emitterId);
  if (hash === undefined) {
    hash = hashString(emitterId);
    emitterHashCache.set(emitterId, hash);
  }
  return hash;
}

/** 一个粒子的基哈希；之后所有属性都从它派生。 */
export function candidateBase(
  seed: number,
  emitterHashValue: number,
  cycle: number,
  stream: number,
  index: number,
): number {
  return hashInts(seed, emitterHashValue, cycle + 1, stream + 1, index + 1);
}

/**
 * 从基哈希派生第 channel 个 [0,1) 随机数。
 * 常数来自 SplitMix32 风格的混合，通道之间足够独立。
 */
export function channelUnit(base: number, channel: number): number {
  let h = (base ^ Math.imul(channel + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export function deterministicUnit(
  seed: number,
  emitterHashValue: number,
  cycle: number,
  stream: number,
  index: number,
  channel: number,
): number {
  return channelUnit(candidateBase(seed, emitterHashValue, cycle, stream, index), channel);
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}
