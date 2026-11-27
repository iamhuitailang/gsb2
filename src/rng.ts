/**
 * 确定性随机流：同一个 key 永远产生同一条 uint32 序列。
 * 每个居民用自己的 (seed, townId, residentId) 派生独立流，
 * 因此新增居民不会扰动已有居民的随机序列（名册追加稳定）。
 */

/** FNV-1a 32 位哈希，把任意多个字符串折叠成一个种子数。 */
export function hashKey(...parts: string[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x1f; // 分隔符，避免 "ab"+"c" 与 "a"+"bc" 撞车
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** splitmix32：轻量、可复现的伪随机流。 */
export class RngStream {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = (z ^ (z >>> 15)) >>> 0;
    return z;
  }

  /** 均匀取 [0, n) */
  int(n: number): number {
    if (n <= 0) throw new Error(`RngStream.int: n must be > 0, got ${n}`);
    return this.next() % n;
  }

  pick<T>(items: readonly T[]): T {
    const v = items[this.int(items.length)];
    if (v === undefined) throw new Error('RngStream.pick: empty list');
    return v;
  }
}

export function streamFor(...parts: string[]): RngStream {
  return new RngStream(hashKey(...parts));
}
