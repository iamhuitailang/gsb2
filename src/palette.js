/**
 * 调色板生成：直方图、中位切分、K-means 精炼、预设调色板。
 * 所有结果都是确定性的：同样的输入产生同样的调色板顺序。
 */
import {
  rgbToLab,
  labToRgb,
  deltaE76,
  dedupePalette,
  packRgb,
  unpackRgb,
} from './color.js';

export const PALETTE_PRESETS = [
  {
    id: 'bw',
    name: '黑白 1-bit',
    description: '2 色，适合最古老的单色屏与电子墨水。',
    colors: ['#000000', '#ffffff'],
  },
  {
    id: 'gameboy',
    name: 'Game Boy 4 色',
    description: '经典 DMG 绿四阶。',
    colors: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  },
  {
    id: 'pico8',
    name: 'PICO-8 16 色',
    description: '幻想主机的 16 色调色板。',
    colors: [
      '#000000', '#1d2b53', '#7e2553', '#008751',
      '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
      '#ff004d', '#ffa300', '#ffec27', '#00e436',
      '#29adff', '#83769c', '#ff77a8', '#ffccaa',
    ],
  },
  {
    id: 'cga16',
    name: 'CGA 16 色',
    description: 'IBM CGA 的 16 色文本调色板。',
    colors: [
      '#000000', '#0000aa', '#00aa00', '#00aaaa',
      '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
      '#555555', '#5555ff', '#55ff55', '#55ffff',
      '#ff5555', '#ff55ff', '#ffff55', '#ffffff',
    ],
  },
  {
    id: 'zx',
    name: 'ZX Spectrum 15 色',
    description: '8 种基础色 + 8 种亮色（黑色不重复）。',
    colors: [
      '#000000', '#0000d7', '#d70000', '#d700d7',
      '#00d700', '#00d7d7', '#d7d700', '#d7d7d7',
      '#0000ff', '#ff0000', '#ff00ff', '#00ff00',
      '#00ffff', '#ffff00', '#ffffff',
    ],
  },
  {
    id: 'gray4',
    name: '灰阶 4 级',
    description: '4 阶中性灰，适合水墨与菜单界面。',
    colors: ['#000000', '#555555', '#aaaaaa', '#ffffff'],
  },
  {
    id: 'gray8',
    name: '灰阶 8 级',
    description: '8 阶中性灰。',
    colors: ['#000000', '#242424', '#484848', '#6d6d6d', '#919191', '#b6b6b6', '#dadada', '#ffffff'],
  },
  {
    id: 'warm8',
    name: '暖色 8 色',
    description: '纸张、皮革与暖光的低饱和调色板。',
    colors: ['#1a1210', '#3c2a24', '#6b4a3a', '#9c6b4f', '#c99570', '#e6c4a1', '#f3e4cf', '#fffaf0'],
  },
  {
    id: 'cool8',
    name: '冷色 8 色',
    description: '金属与夜色的低饱和调色板。',
    colors: ['#0a0f1a', '#16243a', '#27405c', '#3d5f7e', '#5d829e', '#8aafc4', '#c0d6e2', '#f2f8fb'],
  },
];

export function getPreset(id) {
  return PALETTE_PRESETS.find((p) => p.id === id) || null;
}

export function presetColors(id) {
  const preset = getPreset(id);
  if (!preset) return [];
  return preset.colors.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  });
}

/** 5 bit/通道的直方图累加器（32768 个分箱）。 */
export const HIST_BITS = 5;
export const HIST_SIZE = 1 << (HIST_BITS * 3);

export function createHistogram() {
  return {
    counts: new Float64Array(HIST_SIZE),
    r: new Float64Array(HIST_SIZE),
    g: new Float64Array(HIST_SIZE),
    b: new Float64Array(HIST_SIZE),
    total: 0,
  };
}

function binIndex(r, g, b) {
  // 每个通道保留 5 位，并把量化误差均匀落在分箱中心。
  const qr = r >> 3;
  const qg = g >> 3;
  const qb = b >> 3;
  return (qr << 10) | (qg << 5) | qb;
}

export function addImageToHistogram(hist, rgba, alphaThreshold = 128, stride = 1) {
  const step = Math.max(1, stride | 0) * 4;
  for (let i = 0; i < rgba.length; i += step) {
    if (rgba[i + 3] < alphaThreshold) continue;
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const bin = binIndex(r, g, b);
    hist.counts[bin] += 1;
    hist.r[bin] += r;
    hist.g[bin] += g;
    hist.b[bin] += b;
    hist.total += 1;
  }
}

export function finalizeHistogram(hist) {
  const bins = [];
  for (let i = 0; i < HIST_SIZE; i++) {
    const count = hist.counts[i];
    if (count > 0) {
      bins.push({
        r: hist.r[i] / count,
        g: hist.g[i] / count,
        b: hist.b[i] / count,
        count,
      });
    }
  }
  return { bins, total: hist.total };
}

/**
 * 同一张图可能像素很多，精确颜色集合设置上限；超过上限就退回 5-bit 分箱。
 * 像素画通常远远低于上限，能得到精确的颜色集合。
 */
export function collectExactColors(rgba, alphaThreshold = 128, limit = 8192) {
  const map = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < alphaThreshold) continue;
    const key = packRgb(rgba[i], rgba[i + 1], rgba[i + 2]);
    const entry = map.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      map.set(key, { r: rgba[i], g: rgba[i + 1], b: rgba[i + 2], count: 1 });
      if (map.size > limit) return null;
    }
  }
  return [...map.values()];
}

/** 供多图共用调色板使用：每个图都有自己的精确颜色收集上限。 */
export function createSourceModel(limit = 8192) {
  return {
    hist: createHistogram(),
    exact: new Map(),
    exactOverflow: false,
    limit,
    images: 0,
  };
}

export function addImageToModel(model, rgba, alphaThreshold = 128, stride = 1) {
  addImageToHistogram(model.hist, rgba, alphaThreshold, stride);
  model.images += 1;
  if (model.exactOverflow) return;
  const step = Math.max(1, stride | 0) * 4;
  for (let i = 0; i < rgba.length; i += step) {
    if (rgba[i + 3] < alphaThreshold) continue;
    const key = packRgb(rgba[i], rgba[i + 1], rgba[i + 2]);
    const entry = model.exact.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      model.exact.set(key, { r: rgba[i], g: rgba[i + 1], b: rgba[i + 2], count: 1 });
      if (model.exact.size > model.limit) {
        model.exactOverflow = true;
        model.exact = null;
        return;
      }
    }
  }
}

export function modelSamples(model) {
  if (model.exact && model.exact.size > 0) {
    return [...model.exact.values()];
  }
  return finalizeHistogram(model.hist).bins;
}

function weightedCentroid(samples) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (const s of samples) {
    r += s.r * s.count;
    g += s.g * s.count;
    b += s.b * s.count;
    count += s.count;
  }
  if (count <= 0) return { r: 0, g: 0, b: 0 };
  return { r: r / count, g: g / count, b: b / count };
}

function boxRange(samples) {
  let rMin = 255;
  let rMax = 0;
  let gMin = 255;
  let gMax = 0;
  let bMin = 255;
  let bMax = 0;
  let count = 0;
  for (const s of samples) {
    if (s.r < rMin) rMin = s.r;
    if (s.r > rMax) rMax = s.r;
    if (s.g < gMin) gMin = s.g;
    if (s.g > gMax) gMax = s.g;
    if (s.b < bMin) bMin = s.b;
    if (s.b > bMax) bMax = s.b;
    count += s.count;
  }
  const dr = rMax - rMin;
  const dg = gMax - gMin;
  const db = bMax - bMin;
  const max = Math.max(dr, dg, db);
  const channel = max === dr ? 'r' : max === dg ? 'g' : 'b';
  return { dr, dg, db, max, channel, count };
}

function splitBox(samples) {
  const range = boxRange(samples);
  if (samples.length < 2 || range.max <= 0) return null;
  const channel = range.channel;
  const sorted = samples.slice().sort((a, b) => {
    if (a[channel] !== b[channel]) return a[channel] - b[channel];
    if (a.r !== b.r) return a.r - b.r;
    if (a.g !== b.g) return a.g - b.g;
    return a.b - b.b;
  });
  const half = range.count / 2;
  let acc = 0;
  let splitAt = 1;
  for (let i = 0; i < sorted.length - 1; i++) {
    acc += sorted[i].count;
    if (acc >= half) {
      splitAt = i + 1;
      break;
    }
  }
  if (splitAt <= 0 || splitAt >= sorted.length) splitAt = Math.max(1, Math.floor(sorted.length / 2));
  return [sorted.slice(0, splitAt), sorted.slice(splitAt)];
}

export function medianCut(samples, colors) {
  if (!samples.length || colors <= 0) return [];
  if (samples.length <= colors) return samples.map(weightedCentroid);
  let boxes = [samples.slice()];
  while (boxes.length < colors) {
    let bestIndex = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const range = boxRange(boxes[i]);
      // 以「色域跨度 × 像素数」为优先级，兼顾大面积渐变与稀有高饱和色。
      const score = range.max * Math.log2(1 + range.count);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;
    const split = splitBox(boxes[bestIndex]);
    if (!split) break;
    boxes.splice(bestIndex, 1, split[0], split[1]);
  }
  return boxes.map(weightedCentroid);
}

function nearestCentroidIndex(lab, centroids) {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < centroids.length; i++) {
    const d = deltaE76(lab, centroids[i]);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

/**
 * 加权 Lloyd 迭代。空簇保留原中心，因此结果至少不会比初始化更差；
 * 结束后再次去重，避免两个中心收敛到同一颜色。
 */
export function kmeansRefine(samples, palette, iterations = 6) {
  if (!samples.length || palette.length < 2) return palette;
  const labs = samples.map((s) => ({ ...rgbToLab(s.r, s.g, s.b), weight: s.count }));
  let centroids = palette.map((c) => rgbToLab(c.r, c.g, c.b));
  let assignment = new Int32Array(samples.length).fill(-1);

  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    const sums = centroids.map(() => ({ l: 0, a: 0, b: 0, w: 0 }));
    for (let i = 0; i < labs.length; i++) {
      const idx = nearestCentroidIndex(labs[i], centroids);
      if (idx !== assignment[i]) changed = true;
      assignment[i] = idx;
      const w = labs[i].weight;
      sums[idx].l += labs[i].l * w;
      sums[idx].a += labs[i].a * w;
      sums[idx].b += labs[i].b * w;
      sums[idx].w += w;
    }
    for (let i = 0; i < centroids.length; i++) {
      if (sums[i].w > 0) {
        centroids[i] = { l: sums[i].l / sums[i].w, a: sums[i].a / sums[i].w, b: sums[i].b / sums[i].w };
      }
    }
    if (!changed) break;
  }

  const rgb = centroids.map((c) => {
    const v = labToRgb(c.l, c.a, c.b);
    return { r: Math.round(v.r), g: Math.round(v.g), b: Math.round(v.b) };
  });
  const deduped = dedupePalette(rgb);
  // 去重后如果颜色变少，尝试用中位切分补足。
  if (deduped.length < palette.length && samples.length >= palette.length) {
    const extra = medianCut(samples, palette.length);
    return sortPalette(dedupePalette([...deduped, ...extra]));
  }
  return sortPalette(deduped);
}

export function sortPalette(palette) {
  return palette.slice().sort((a, b) => {
    const la = 0.2126 * a.r + 0.7152 * a.g + 0.0722 * a.b;
    const lb = 0.2126 * b.r + 0.7152 * b.g + 0.0722 * b.b;
    if (la !== lb) return la - lb;
    if (a.r !== b.r) return a.r - b.r;
    if (a.g !== b.g) return a.g - b.g;
    return a.b - b.b;
  });
}

export function generatePaletteFromSamples(samples, colors, method = 'kmeans') {
  const limit = Math.max(1, Math.min(256, Math.floor(colors)));
  // 全透明图没有任何不透明像素：用 1 个占位色，输出时所有像素都会走透明索引。
  if (!samples.length) return [{ r: 0, g: 0, b: 0 }];
  const work = samples.length > 8192 ? topWeightedSamples(samples, 8192) : samples;
  if (work.length <= limit) {
    return sortPalette(
      dedupePalette(work.map((s) => ({ r: Math.round(s.r), g: Math.round(s.g), b: Math.round(s.b) }))),
    );
  }
  let palette = medianCut(work, limit);
  if (method === 'kmeans') palette = kmeansRefine(work, palette, 6);
  const result = sortPalette(dedupePalette(palette));
  return result.length ? result : [{ r: 0, g: 0, b: 0 }];
}

/**
 * 超大色集（超过 8192 个分箱）只保留出现次数最多的部分；
 * 调色板本来就偏向高频颜色，这样能把生成时间压到可用范围。
 */
function topWeightedSamples(samples, max) {
  return samples
    .slice()
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.r !== b.r) return a.r - b.r;
      if (a.g !== b.g) return a.g - b.g;
      return a.b - b.b;
    })
    .slice(0, max);
}

/**
 * 从多张图的联合色源生成调色板，透明像素被完全排除在外。
 * @param {{hist:any, exact:Map|null, exactOverflow:boolean}} model
 */
export function generatePaletteFromModel(model, colors, method = 'kmeans') {
  return generatePaletteFromSamples(modelSamples(model), colors, method);
}

/** 单图便捷入口。 */
export function generatePalette(rgba, width, height, alphaThreshold, colors, method = 'kmeans') {
  const model = createSourceModel();
  addImageToModel(model, rgba, alphaThreshold);
  return generatePaletteFromModel(model, colors, method);
}

/** 固定的色数上限说明：带透明的索引格式需要 1 个透明索引。 */
export function paletteColorLimit(colorCount, hasTransparency) {
  const requested = Math.max(1, Math.min(256, Math.floor(colorCount) || 1));
  return hasTransparency ? Math.min(requested, 255) : requested;
}

/** 供外部使用：把排序后的调色板转成可比较的指纹。 */
export function paletteSignature(palette) {
  return palette.map((c) => `${c.r},${c.g},${c.b}`).join(';');
}

export function paletteFromPacked(values) {
  return values.map((v) => {
    const [r, g, b] = unpackRgb(v);
    return { r, g, b };
  });
}
