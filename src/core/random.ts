/**
 * 确定性随机数与值噪声。
 * 同一 seed 下在任意浏览器/设备上结果完全一致，保证“保存后重开结果不变”。
 */

/** mulberry32：轻量确定性 PRNG，返回 [0,1)。 */
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

/** 整数哈希 -> [0,1)，用于值噪声网格。 */
function hash2(ix: number, iy: number, seed: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ (ix * 374761393), 668265263);
  h = Math.imul(h ^ (iy * 2246822519), 3266489917);
  h = (h ^ (h >>> 13)) >>> 0;
  return h / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 二维值噪声，输出约 [-1, 1]。 */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const v00 = hash2(ix, iy, seed);
  const v10 = hash2(ix + 1, iy, seed);
  const v01 = hash2(ix, iy + 1, seed);
  const v11 = hash2(ix + 1, iy + 1, seed);
  const sx = smooth(fx);
  const sy = smooth(fy);
  const top = v00 + (v10 - v00) * sx;
  const bot = v01 + (v11 - v01) * sx;
  return (top + (bot - top) * sy) * 2 - 1;
}

/** 分形布朗运动（多倍频值噪声叠加）。 */
export function fbm2D(
  x: number,
  y: number,
  seed: number,
  octaves = 5,
  lacunarity = 2,
  gain = 0.5
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2D(x * freq, y * freq, seed + o * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
