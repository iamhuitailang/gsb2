/**
 * Deterministic integer-hash noise. No Math.random anywhere in the render path,
 * so a project reopened with the same seed produces the same pixels.
 */

const UINT32 = 4294967296;

function hash2(x: number, y: number, seed: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (y | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Uniform value in [0, 1) for an integer lattice point. */
export function hash01(x: number, y: number, seed: number): number {
  return hash2(x, y, seed) / UINT32;
}

/** A deterministic random integer, used by the "随机种子" button. */
export function randomSeed(): number {
  const values = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(values);
  } else {
    values[0] = (Date.now() ^ Math.floor(performance.now() * 1000)) >>> 0;
  }
  return values[0]! % 2147483647;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Smooth value noise in [0, 1] over the plane. */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);

  const v00 = hash01(x0, y0, seed);
  const v10 = hash01(x0 + 1, y0, seed);
  const v01 = hash01(x0, y0 + 1, seed);
  const v11 = hash01(x0 + 1, y0 + 1, seed);

  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

/** Fractal Brownian motion built from value noise. Result is in [0, 1]. */
export function fbm2D(
  x: number,
  y: number,
  seed: number,
  octaves: number,
  gain: number,
): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let weight = 0;
  const count = Math.max(1, Math.min(8, Math.round(octaves)));
  for (let i = 0; i < count; i += 1) {
    // Offset the seed per octave so layers are not correlated.
    const octaveSeed = (seed + Math.imul(i + 1, 0x9e3779b1)) | 0;
    sum += valueNoise2D(x * frequency, y * frequency, octaveSeed) * amplitude;
    weight += amplitude;
    amplitude *= gain;
    frequency *= 2;
  }
  return weight > 0 ? sum / weight : 0;
}
