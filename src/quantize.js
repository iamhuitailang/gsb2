/**
 * 减色核心：调色板映射 + 误差扩散 / 有序抖动。
 *
 * 透明约定（贯穿整个工具）：
 *   - alpha < alphaCutoff 的像素视为“透明像素”，绝不参与颜色统计、
 *     不会成为误差扩散的目标，也不会被写入任何背景色。
 *   - 透明像素在输出中固定为 (0,0,0,0)，索引值为 transparentIndex。
 *   - alphaMode 为 preserve 时，alpha >= cutoff 的半透明像素会保留原始 alpha；
 *     binary 模式则会变成完全不透明。透明像素在两种模式下都不会发生颜色合并。
 */
import {
  clamp255,
  dedupePalette,
  rgbToLab,
  deltaE76,
  packRgb,
} from './color.js';

export const DITHER_MODES = [
  { id: 'none', name: '无抖动', kind: 'none' },
  { id: 'floyd-steinberg', name: 'Floyd–Steinberg', kind: 'diffusion' },
  { id: 'false-floyd', name: 'False Floyd–Steinberg', kind: 'diffusion' },
  { id: 'atkinson', name: 'Atkinson', kind: 'diffusion' },
  { id: 'stucki', name: 'Stucki', kind: 'diffusion' },
  { id: 'burkes', name: 'Burkes', kind: 'diffusion' },
  { id: 'sierra', name: 'Sierra-3', kind: 'diffusion' },
  { id: 'sierra-lite', name: 'Sierra Lite', kind: 'diffusion' },
  { id: 'jarvis', name: 'Jarvis–Judice–Ninke', kind: 'diffusion' },
  { id: 'bayer2', name: 'Bayer 2×2 网格', kind: 'ordered' },
  { id: 'bayer4', name: 'Bayer 4×4 网格', kind: 'ordered' },
  { id: 'bayer8', name: 'Bayer 8×8 网格', kind: 'ordered' },
  { id: 'clustered4', name: '聚集点 4×4 网格', kind: 'ordered' },
];

export const DITHER_IDS = DITHER_MODES.map((m) => m.id);

export function ditherModeInfo(id) {
  return DITHER_MODES.find((m) => m.id === id) || DITHER_MODES[0];
}

/** 扩散核：[dx, dy, weight]，权重和为 1（Atkinson 为 6/8）。 */
const DIFFUSION_KERNELS = {
  'floyd-steinberg': [
    [1, 0, 7 / 16],
    [-1, 1, 3 / 16],
    [0, 1, 5 / 16],
    [1, 1, 1 / 16],
  ],
  'false-floyd': [
    [1, 0, 3 / 8],
    [0, 1, 3 / 8],
    [1, 1, 2 / 8],
  ],
  atkinson: [
    [1, 0, 1 / 8],
    [2, 0, 1 / 8],
    [-1, 1, 1 / 8],
    [0, 1, 1 / 8],
    [1, 1, 1 / 8],
    [0, 2, 1 / 8],
  ],
  stucki: [
    [1, 0, 8 / 42],
    [2, 0, 4 / 42],
    [-2, 1, 2 / 42],
    [-1, 1, 4 / 42],
    [0, 1, 8 / 42],
    [1, 1, 4 / 42],
    [2, 1, 2 / 42],
    [-2, 2, 1 / 42],
    [-1, 2, 2 / 42],
    [0, 2, 4 / 42],
    [1, 2, 2 / 42],
    [2, 2, 1 / 42],
  ],
  burkes: [
    [1, 0, 8 / 32],
    [2, 0, 4 / 32],
    [-2, 1, 2 / 32],
    [-1, 1, 4 / 32],
    [0, 1, 8 / 32],
    [1, 1, 4 / 32],
    [2, 1, 2 / 32],
  ],
  sierra: [
    [1, 0, 5 / 32],
    [2, 0, 3 / 32],
    [-2, 1, 2 / 32],
    [-1, 1, 4 / 32],
    [0, 1, 5 / 32],
    [1, 1, 4 / 32],
    [2, 1, 2 / 32],
    [-1, 2, 2 / 32],
    [0, 2, 3 / 32],
    [1, 2, 2 / 32],
  ],
  'sierra-lite': [
    [1, 0, 2 / 4],
    [-1, 1, 1 / 4],
    [0, 1, 1 / 4],
  ],
  jarvis: [
    [1, 0, 7 / 48],
    [2, 0, 5 / 48],
    [-2, 1, 3 / 48],
    [-1, 1, 5 / 48],
    [0, 1, 7 / 48],
    [1, 1, 5 / 48],
    [2, 1, 3 / 48],
    [-2, 2, 1 / 48],
    [-1, 2, 3 / 48],
    [0, 2, 5 / 48],
    [1, 2, 3 / 48],
    [2, 2, 1 / 48],
  ],
};

export const KERNEL_NAMES = Object.keys(DIFFUSION_KERNELS);

const BAYER_MATRICES = {
  bayer2: [[0, 2], [3, 1]],
  bayer4: [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ],
  bayer8: [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
  ],
  // 聚集点（clustered-dot）矩阵：网点在 4×4 内从中心向外生长，
  // 与 Bayer 的分散分布形成明显不同的观感，适合报纸/复古打印风。
  clustered4: [
    [12, 5, 6, 13],
    [4, 0, 1, 7],
    [11, 3, 2, 8],
    [15, 10, 9, 14],
  ],
};

export function orderedMatrix(id) {
  return BAYER_MATRICES[id] || null;
}

/** 计算带透明索引的颜色上限：索引 PNG 的调色板最多 256 项，其中一项留给透明。 */
export function effectiveColorLimit(requested, hasTransparency) {
  const n = Math.max(1, Math.min(256, Math.floor(requested) || 1));
  return hasTransparency ? Math.min(n, 255) : n;
}

export function imageHasTransparency(rgba, alphaCutoff = 128) {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < alphaCutoff) return true;
  }
  return false;
}

export function imageTransparencyStats(rgba, alphaCutoff = 128) {
  let transparent = 0;
  let semi = 0;
  let opaque = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    const a = rgba[i];
    if (a < alphaCutoff) transparent++;
    else {
      opaque++;
      if (a < 255) semi++;
    }
  }
  return { transparent, semi, opaque };
}

/**
 * 预编译调色板查找器。同一颜色只精确计算一次（Map 缓存），
 * 大图上这项缓存能把最近色搜索的耗电压下去，同时不引入量化误差。
 */
export function createMatcher(palette, metric = 'redmean') {
  const colors = dedupePalette(palette).slice(0, 256);
  if (!colors.length) throw new Error('调色板不能为空');
  const n = colors.length;
  const pr = new Float32Array(n);
  const pg = new Float32Array(n);
  const pb = new Float32Array(n);
  const lab = metric === 'lab' ? colors.map((c) => rgbToLab(c.r, c.g, c.b)) : null;
  for (let i = 0; i < n; i++) {
    pr[i] = colors[i].r;
    pg[i] = colors[i].g;
    pb[i] = colors[i].b;
  }

  // 精确缓存：同一颜色只计算一次最近色。用 Map 而不是降低精度的
  // 量化查找表，保证“无抖动”等模式下的最近色判断严格准确。
  const cache = new Map();
  const CACHE_LIMIT = 1 << 18;

  function nearestExact(r, g, b) {
    let best = 0;
    let bestDistance = Infinity;
    if (metric === 'lab') {
      const target = rgbToLab(r, g, b);
      for (let i = 0; i < n; i++) {
        const d = deltaE76(target, lab[i]);
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }
      return best;
    }
    if (metric === 'rgb') {
      for (let i = 0; i < n; i++) {
        const dr = r - pr[i];
        const dg = g - pg[i];
        const db = b - pb[i];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }
      return best;
    }
    // redmean（CompuPhase 加权）
    for (let i = 0; i < n; i++) {
      const rmean = (r + pr[i]) * 0.5;
      const dr = r - pr[i];
      const dg = g - pg[i];
      const db = b - pb[i];
      const d =
        (2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db;
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    return best;
  }

  function nearest(r, g, b) {
    const ri = clamp255(r) | 0;
    const gi = clamp255(g) | 0;
    const bi = clamp255(b) | 0;
    const key = (ri << 16) | (gi << 8) | bi;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const idx = nearestExact(ri, gi, bi);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, idx);
    return idx;
  }

  return {
    palette: colors,
    size: n,
    nearest,
    nearestExact,
    colors: { r: pr, g: pg, b: pb },
  };
}

/**
 * 估计调色板在每个通道上的平均量化步长，用于有序抖动幅度。
 * 步长取「调色板通道跨度 /（不同取值数 - 1）」，与经典 Bayer 阈值配合，
 * 能让黑白两色在灰度渐变上完整铺开，而不是只产生很浅的噪声。
 */
export function estimatePaletteSpacing(palette) {
  if (palette.length < 2) return { r: 48, g: 48, b: 48 };
  const estimate = (channel) => {
    const values = [...new Set(palette.map((c) => c[channel]))].sort((a, b) => a - b);
    if (values.length < 2) return 0;
    const span = values[values.length - 1] - values[0];
    return span / (values.length - 1);
  };
  const er = estimate('r');
  const eg = estimate('g');
  const eb = estimate('b');
  // 全通道都只有一种取值时（纯色图像）给一个小的默认幅度，避免除零。
  const fallback = Math.max(er, eg, eb) || 32;
  return {
    r: er || fallback,
    g: eg || fallback,
    b: eb || fallback,
  };
}

function normalizeOptions(options) {
  const alphaCutoff = Math.max(1, Math.min(255, Math.round(options.alphaCutoff ?? 128)));
  return {
    alphaCutoff,
    alphaMode: options.alphaMode === 'preserve' ? 'preserve' : 'binary',
    dither: DITHER_IDS.includes(options.dither) ? options.dither : 'floyd-steinberg',
    strength: Math.max(0, Math.min(2, Number.isFinite(options.strength) ? options.strength : 1)),
    serpentine: options.serpentine !== false,
    metric: ['redmean', 'rgb', 'lab'].includes(options.metric) ? options.metric : 'redmean',
  };
}

/**
 * 执行量化。
 * @param {Uint8ClampedArray|Uint8Array} rgba 原图 RGBA
 * @param {number} width
 * @param {number} height
 * @param {{palette:Array, alphaCutoff?:number, alphaMode?:string, dither?:string, strength?:number, serpentine?:boolean, metric?:string}} options
 * @returns {{rgba:Uint8ClampedArray, indices:Uint8Array, palette:Array, transparentIndex:number, hasTransparency:boolean, usedColors:number, colorUsage:Int32Array, alphaCutoff:number, alphaMode:string, dither:string}}
 */
export function quantizeImage(rgba, width, height, options) {
  if (!width || !height) throw new Error('图像尺寸无效');
  if (rgba.length < width * height * 4) throw new Error('像素数据不完整');
  const opts = normalizeOptions(options || {});
  const hasTransparency = imageHasTransparency(rgba, opts.alphaCutoff);
  const maxColors = hasTransparency ? 255 : 256;
  const palette = dedupePalette(options.palette || []).slice(0, maxColors);
  if (!palette.length) throw new Error('调色板不能为空');

  const matcher = createMatcher(palette, opts.metric);
  const colors = matcher.palette;
  const transparentIndex = hasTransparency ? colors.length : -1;
  const paletteWithAlpha = hasTransparency
    ? [...colors, { r: 0, g: 0, b: 0, transparent: true }]
    : colors;

  const out = new Uint8ClampedArray(width * height * 4);
  const indices = new Uint8Array(width * height);
  const colorUsage = new Int32Array(colors.length);
  const mode = ditherModeInfo(opts.dither);

  if (mode.kind === 'none' || opts.strength === 0) {
    quantizeSimple(rgba, width, height, opts, matcher, out, indices, colorUsage, transparentIndex);
  } else if (mode.kind === 'ordered') {
    quantizeOrdered(rgba, width, height, opts, matcher, out, indices, colorUsage, transparentIndex, mode.id);
  } else {
    quantizeDiffusion(rgba, width, height, opts, matcher, out, indices, colorUsage, transparentIndex, mode.id);
  }

  let usedColors = 0;
  for (let i = 0; i < colorUsage.length; i++) if (colorUsage[i] > 0) usedColors++;

  return {
    rgba: out,
    indices,
    palette: paletteWithAlpha,
    transparentIndex,
    hasTransparency,
    usedColors,
    colorUsage,
    alphaCutoff: opts.alphaCutoff,
    alphaMode: opts.alphaMode,
    dither: opts.dither,
    width,
    height,
  };
}

function isOpaqueAt(rgba, index, cutoff) {
  return rgba[index * 4 + 3] >= cutoff;
}

function writePixel(out, indices, offset, color, alpha, index, transparentIndex) {
  const o = offset * 4;
  if (alpha <= 0) {
    out[o] = 0;
    out[o + 1] = 0;
    out[o + 2] = 0;
    out[o + 3] = 0;
    indices[offset] = transparentIndex >= 0 ? transparentIndex : 0;
    return;
  }
  out[o] = color.r;
  out[o + 1] = color.g;
  out[o + 2] = color.b;
  out[o + 3] = alpha;
  indices[offset] = index;
}

function quantizeSimple(rgba, width, height, opts, matcher, out, indices, usage, transparentIndex) {
  const count = width * height;
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    const a = rgba[i + 3];
    if (a < opts.alphaCutoff) {
      writePixel(out, indices, p, { r: 0, g: 0, b: 0 }, 0, 0, transparentIndex);
      continue;
    }
    const idx = matcher.nearest(rgba[i], rgba[i + 1], rgba[i + 2]);
    const color = matcher.palette[idx];
    usage[idx]++;
    const alpha = opts.alphaMode === 'preserve' ? a : 255;
    writePixel(out, indices, p, color, alpha, idx, transparentIndex);
  }
}

function quantizeOrdered(rgba, width, height, opts, matcher, out, indices, usage, transparentIndex, modeId) {
  const matrix = orderedMatrix(modeId);
  const n = matrix.length;
  const spacing = estimatePaletteSpacing(matcher.palette);
  const ampR = spacing.r * opts.strength;
  const ampG = spacing.g * opts.strength;
  const ampB = spacing.b * opts.strength;
  const offsets = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      offsets[y * n + x] = (matrix[y][x] + 0.5) / (n * n) - 0.5;
    }
  }
  // 三通道共用同一阈值，避免在色块交界处产生彩色噪点。
  for (let y = 0; y < height; y++) {
    const rowBase = (y % n) * n;
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      const a = rgba[i + 3];
      if (a < opts.alphaCutoff) {
        writePixel(out, indices, p, { r: 0, g: 0, b: 0 }, 0, 0, transparentIndex);
        continue;
      }
      const t = offsets[rowBase + (x % n)];
      const r = clamp255(rgba[i] + t * ampR);
      const g = clamp255(rgba[i + 1] + t * ampG);
      const b = clamp255(rgba[i + 2] + t * ampB);
      const idx = matcher.nearest(r, g, b);
      usage[idx]++;
      const alpha = opts.alphaMode === 'preserve' ? a : 255;
      writePixel(out, indices, p, matcher.palette[idx], alpha, idx, transparentIndex);
    }
  }
}

function quantizeDiffusion(rgba, width, height, opts, matcher, out, indices, usage, transparentIndex, modeId) {
  const kernel = DIFFUSION_KERNELS[modeId];
  if (!kernel) throw new Error(`未知的扩散核: ${modeId}`);
  const totalWeight = kernel.reduce((s, k) => s + k[2], 0);
  let maxDy = 0;
  for (const [, dy] of kernel) if (dy > maxDy) maxDy = dy;
  // 误差只会向下传播，所以只需要保留“尚未读到的若干行”。
  // 用环形行缓冲把内存从 O(W×H) 降到 O(W×核高度)，大照片也不会因为
  // 误差缓冲而耗尽内存。
  const rowCount = Math.max(1, maxDy + 1);
  const width3 = width * 3;
  const err = new Float32Array(rowCount * width3);
  const cutoff = opts.alphaCutoff;
  const strength = opts.strength;

  for (let y = 0; y < height; y++) {
    const reverse = opts.serpentine && (y & 1) === 1;
    const slotOffset = (y % rowCount) * width3;
    for (let step = 0; step < width; step++) {
      const x = reverse ? width - 1 - step : step;
      const p = y * width + x;
      const i = p * 4;
      const e = slotOffset + x * 3;
      const a = rgba[i + 3];

      if (a < cutoff) {
        writePixel(out, indices, p, { r: 0, g: 0, b: 0 }, 0, 0, transparentIndex);
        // 透明像素不读取、也不写入误差缓冲。
        continue;
      }

      const r = clamp255(rgba[i] + err[e]);
      const g = clamp255(rgba[i + 1] + err[e + 1]);
      const b = clamp255(rgba[i + 2] + err[e + 2]);
      const idx = matcher.nearest(r, g, b);
      const color = matcher.palette[idx];
      usage[idx]++;
      const alpha = opts.alphaMode === 'preserve' ? a : 255;
      writePixel(out, indices, p, color, alpha, idx, transparentIndex);

      if (strength === 0) continue;

      const diffR = (r - color.r) * strength;
      const diffG = (g - color.g) * strength;
      const diffB = (b - color.b) * strength;
      if (diffR === 0 && diffG === 0 && diffB === 0) continue;

      // 先收集有效目标（在图像内且不是透明像素），再按比例补回被丢弃的权重。
      let validWeight = 0;
      const targets = [];
      for (let k = 0; k < kernel.length; k++) {
        const [kdx, kdy, weight] = kernel[k];
        const nx = x + (reverse ? -kdx : kdx);
        const ny = y + kdy;
        if (nx < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (!isOpaqueAt(rgba, np, cutoff)) continue;
        validWeight += weight;
        targets.push([ny, nx, weight]);
      }
      if (!targets.length || validWeight <= 0) continue;

      // 边缘处只把误差分配给“有效邻居”。按 总权重/有效权重 补偿，
      // 但把放大系数封顶在 2×：既减少透明边缘一侧整体变亮/变暗，又不会因为
      // 只剩一个 1/16 邻居就把误差放大 16 倍、制造极值噪点。
      // 无论如何，误差都不会进入透明像素。
      const scale = Math.min(2, totalWeight / validWeight);
      for (const [ny, nx, weight] of targets) {
        const ne = (ny % rowCount) * width3 + nx * 3;
        const f = weight * scale;
        err[ne] += diffR * f;
        err[ne + 1] += diffG * f;
        err[ne + 2] += diffB * f;
      }
    }
    // 本行已处理完，清空槽位供 y + rowCount 行复用。
    err.fill(0, slotOffset, slotOffset + width3);
  }
}

/** 把调色板用量转成便于展示的列表。 */
export function paletteUsageList(result) {
  const list = result.palette.map((c, i) => ({
    index: i,
    r: c.r,
    g: c.g,
    b: c.b,
    transparent: !!c.transparent,
    count: i === result.transparentIndex ? 0 : result.colorUsage[i] || 0,
  }));
  return list;
}

/** 供 Worker / 批量复用：原始调色板哈希。 */
export function signatureOfPalette(palette) {
  return palette.map((c) => packRgb(c.r, c.g, c.b)).join(',');
}