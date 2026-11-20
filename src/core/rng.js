// 确定性随机：同一 seed 永远产生同一序列，所有散布结果因此可复现。
// 使用 mulberry32（32bit 状态的 PRNG）配合整数哈希，无任何 Math.random 调用。

/**
 * 把若干整数混合成一个 32 位无符号整数（xxHash 风格 avalanche）。
 * @param {...number} ints
 * @returns {number} uint32
 */
export function hashInts(...ints) {
  let h = 0x9e3779b9;
  for (const v of ints) {
    let x = (v | 0) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
    x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
    x ^= x >>> 15;
    h = (Math.imul(h ^ x, 0x85ebca6b) + 0xc2b2ae35) >>> 0;
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32 PRNG：给定 uint32 种子返回 [0,1) 随机数生成器。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 由若干整数 key 直接派生出一个 [0,1) 浮点。
 * 散布中每个格点的所有随机属性都通过它派生，保证“同格点同结果”，
 * 且与计算顺序、分块边界完全无关。
 */
export function randomFor(...keys) {
  return hashInts(...keys) / 4294967296;
}

/** 确定性区间插值：由 r∈[0,1) 映射到 [min,max)。 */
export function lerpRange(r, min, max) {
  return min + (max - min) * r;
}
