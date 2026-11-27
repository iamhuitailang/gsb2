// 确定性随机：字符串种子 -> uint32，mulberry32 PRNG + Fisher-Yates。

export function hashSeed(text: string): number {
  // xfnv1a：短字符串也能得到分布不错的 32bit 种子
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seedText: string): { seedNum: number; rng: () => number } {
  const seedNum = hashSeed(seedText);
  return { seedNum, rng: mulberry32(seedNum) };
}

/** Fisher-Yates 原地洗牌，消费传入 rng，保证同种子同结果。 */
export function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
