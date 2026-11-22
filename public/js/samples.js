/* samples.js — 程序化示例纹理（全部成分以尺寸为周期，可严格平铺）
 *
 * 两张图：
 *   cloth —— 布纹：所有噪声/织纹均为周期函数，接缝处零电平差
 *   floor —— 地砖：周期网格 + 周期云纹，但整体亮度沿 x 方向单向倾斜，
 *            平铺后只在竖向接缝产生跳变，横向接缝保持连续
 */
(function (global) {
  'use strict';

  function hash2(ix, iy, seed) {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function fade(t) { return t * t * (3 - 2 * t); }

  /** 双线性 value noise，晶格按 period 环绕 → 输出以 period 为周期 */
  function valueNoise(x, y, period, seed) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = fade(x - xi), fy = fade(y - yi);
    const x0 = ((xi % period) + period) % period;
    const y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period;
    const y1 = (y0 + 1) % period;
    const v00 = hash2(x0, y0, seed);
    const v10 = hash2(x1, y0, seed);
    const v01 = hash2(x0, y1, seed);
    const v11 = hash2(x1, y1, seed);
    const a = v00 + (v10 - v00) * fx;
    const b = v01 + (v11 - v01) * fx;
    return a + (b - a) * fy;
  }

  /** 分形叠加；size 为 2 的幂时每倍频的周期仍为整数，严格周期 */
  function fbm(x, y, size, octaves, seed) {
    let amp = 0.5, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const period = size / freq;
      sum += amp * valueNoise(x * freq, y * freq, period, seed + o * 101);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  function createImageData(size) {
    if (typeof ImageData !== 'undefined') return new ImageData(size, size);
    return { data: new Uint8ClampedArray(size * size * 4), width: size, height: size };
  }

  /** 布纹：经纬织纹 + 周期云纹 + 细纤维噪声，全周期 */
  function generateCloth(size) {
    size = size || 256;
    const img = createImageData(size);
    const d = img.data;
    const TWO_PI = Math.PI * 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const cloud = fbm(x / 8, y / 8, size / 8, 4, 11);          // 大块明暗 0..1
        const fiber = fbm(x / 2, y / 2, size / 2, 3, 23);          // 细纤维
        const warp = Math.sin(TWO_PI * x / 7) * 0.5 + 0.5;         // 经向织纹
        const weft = Math.sin(TWO_PI * y / 7) * 0.5 + 0.5;         // 纬向织纹
        const weave = warp * 0.5 + weft * 0.5;

        const v = (cloud - 0.5) * 26 + (fiber - 0.5) * 10 + (weave - 0.5) * 14;
        const i = (y * size + x) * 4;
        d[i]     = 196 + v + (warp - 0.5) * 6;   // R 略暖
        d[i + 1] = 188 + v;
        d[i + 2] = 172 + v - (weft - 0.5) * 4;   // B 略冷
        d[i + 3] = 255;
      }
    }
    return img;
  }

  /**
   * 地砖：周期性网格与云纹 + x 方向单向亮度斜坡。
   * 斜坡在平铺边界（右缘 → 下一块左缘）制造约 30% 的电平跳变，
   * 且只作用于 x，因此只产生竖向接缝；y 方向所有成分均周期连续。
   */
  function generateFloor(size) {
    size = size || 256;
    const img = createImageData(size);
    const d = img.data;
    const cell = size / 4;                       // 4×4 地砖
    const grout = Math.max(4, Math.round(size / 64));  // 偶数：可在周期边界两侧均分
    const TWO_PI = Math.PI * 2;
    const tilesPerAxis = 4;                      // 砖块明暗表按 4×4 环绕 → 严格周期

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
      const gx = x % cell, gy = y % cell;
      const half = grout / 2;
      // 砖缝对称跨在格子的周期边界上（边界两侧各 grout/2），
      // 平铺时接缝两边都是砖缝 → 横向/纵向均连续，不露线
      const inGrout = gx < half || gx >= cell - half ||
                      gy < half || gy >= cell - half;
        // 环绕索引：跨右/下边缘的两块砖在平铺世界中是同一张表里的项
        const tx = Math.floor(x / cell) % tilesPerAxis;
        const ty = Math.floor(y / cell) % tilesPerAxis;
        const tileShade = hash2(tx, ty, 7) - 0.5;                 // 每块砖固定色差（周期 4）
        const cloud = fbm(x / 10, y / 10, size / 10, 4, 47);
        const grain = fbm(x / 2, y / 2, size / 2, 2, 59);

        // 单向斜坡：左 0.86 → 右 1.14，接缝处跳变 0.28（仅 x 方向 → 只产生竖向接缝）
        const ramp = 0.86 + 0.28 * (x / (size - 1));

        let r = 178, g = 166, b = 148;
        const v = (cloud - 0.5) * 22 + (grain - 0.5) * 8 + tileShade * 16;
        r += v; g += v; b += v;
        // 砖面微弱横纹（周期）
        r += Math.sin(TWO_PI * y / 13) * 3;
        g += Math.sin(TWO_PI * y / 13) * 3;

        if (inGrout) { r = 96; g = 92; b = 86; }
        const i = (y * size + x) * 4;
        d[i]     = r * ramp;
        d[i + 1] = g * ramp;
        d[i + 2] = b * ramp;
        d[i + 3] = 255;
      }
    }
    return img;
  }

  const api = { generateCloth, generateFloor, valueNoise, fbm, hash2 };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.SeamSamples = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
