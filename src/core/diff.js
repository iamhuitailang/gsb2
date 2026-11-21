/**
 * Pixel-difference engine.
 *
 * Inputs are RGBA buffers of both images rendered into the same "world"
 * coordinate space (see core/world.js). The engine is deliberately pure so it
 * can run inside a worker, on the main thread as a fallback, and in tests.
 */

export const DEFAULT_DIFF_SETTINGS = Object.freeze({
  sensitivity: 55,
  minRegionArea: 24,
  includeUncovered: false,
});

export const DIFF_COLORS = Object.freeze({
  color: [255, 84, 68],
  coverage: [255, 183, 77],
  ignored: [68, 214, 196],
});

const COVERAGE_ALPHA = 16;
const MAX_REGIONS = 2000;
const BASE = [11, 15, 22];

export function clampSensitivity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_DIFF_SETTINGS.sensitivity;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function clampMinRegionArea(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_DIFF_SETTINGS.minRegionArea;
  return Math.max(0, Math.min(100000, Math.round(n)));
}

export function normalizeDiffSettings(input = {}) {
  return {
    sensitivity: clampSensitivity(input.sensitivity),
    minRegionArea: clampMinRegionArea(input.minRegionArea),
    includeUncovered: Boolean(input.includeUncovered),
  };
}

/**
 * Higher sensitivity => lower threshold. The range is intentionally wide:
 * 80 hides anti-aliasing noise, 4 reveals almost every resampled pixel.
 */
export function sensitivityToThreshold(sensitivity) {
  const s = clampSensitivity(sensitivity);
  return 4 + (1 - s / 100) * 76;
}

export function diffSettingsKey(settings, strokesRevision = 0) {
  const s = normalizeDiffSettings(settings);
  return `${s.sensitivity}|${s.minRegionArea}|${s.includeUncovered ? 1 : 0}|${strokesRevision}`;
}

/**
 * @param {Object} input
 * @param {Uint8ClampedArray} input.aPixels RGBA at diff resolution
 * @param {Uint8ClampedArray} input.bPixels RGBA at diff resolution
 * @param {Uint8Array|null} input.ignoreMask 1 = user ignored
 * @param {number} input.width
 * @param {number} input.height
 * @param {number} input.factor diff pixels per world pixel
 * @param {{minX:number,minY:number,width:number,height:number}} input.bounds world bounds
 */
export function computeDiff({
  aPixels,
  bPixels,
  ignoreMask = null,
  width,
  height,
  factor = 1,
  bounds = { minX: 0, minY: 0, width: width / factor, height: height / factor },
  sensitivity = DEFAULT_DIFF_SETTINGS.sensitivity,
  minRegionArea = DEFAULT_DIFF_SETTINGS.minRegionArea,
  includeUncovered = false,
}) {
  if (!aPixels || !bPixels) throw new Error('缺少图像像素数据');
  const pixelCount = width * height;
  if (aPixels.length < pixelCount * 4 || bPixels.length < pixelCount * 4) {
    throw new Error('像素缓冲区尺寸不匹配');
  }
  if (ignoreMask && ignoreMask.length < pixelCount) {
    throw new Error('忽略区蒙版尺寸不匹配');
  }

  const threshold = sensitivityToThreshold(sensitivity);
  const factorSq = factor * factor;
  const minAreaPixels = Math.max(0, minRegionArea) * factorSq;
  const rawMask = new Uint8Array(pixelCount);
  let compared = 0;
  let ignored = 0;
  const inv255 = 1 / 255;

  // Neutralise anti-aliasing / resampling chatter: when both versions have a
  // strong edge at the same pixel, a small colour delta is just export
  // resampling noise. If only one side has the edge, it is likely a real
  // structural change, so it keeps the normal threshold.
  const edgeMask = computeEdgeMask(aPixels, bPixels, width, height);
  const edgeThreshold = Math.min(255, threshold * 1.7 + 16);

  for (let i = 0, o = 0; i < pixelCount; i++, o += 4) {
    const aa = aPixels[o + 3];
    const ba = bPixels[o + 3];
    const aCov = aa >= COVERAGE_ALPHA;
    const bCov = ba >= COVERAGE_ALPHA;
    if (!aCov && !bCov) continue;

    if (ignoreMask && ignoreMask[i]) {
      // Only count ignored pixels that actually have image content, so the
      // "ignored area" statistic doesn't include empty background.
      ignored += 1;
      continue;
    }

    if (aCov && bCov) {
      compared += 1;
      let ar = aPixels[o];
      let ag = aPixels[o + 1];
      let ab = aPixels[o + 2];
      let br = bPixels[o];
      let bg = bPixels[o + 1];
      let bb = bPixels[o + 2];

      // Treat semi-transparent pixels the way they look on white paper.
      if (aa < 255 || ba < 255) {
        const wa = aa * inv255;
        const wb = ba * inv255;
        ar = ar * wa + 255 * (1 - wa);
        ag = ag * wa + 255 * (1 - wa);
        ab = ab * wa + 255 * (1 - wa);
        br = br * wb + 255 * (1 - wb);
        bg = bg * wb + 255 * (1 - wb);
        bb = bb * wb + 255 * (1 - wb);
      }

      const dr = ar - br;
      const dg = ag - bg;
      const db = ab - bb;
      const colorDist = Math.sqrt(
        0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db,
      );
      const alphaDist = Math.abs(aa - ba) * 0.5;
      const colorLimit = edgeMask[i] ? edgeThreshold : threshold;
      if (colorDist >= colorLimit || alphaDist >= threshold) rawMask[i] = 1;
      continue;
    }

    // Only one image covers this pixel: new/removed content.
    if (includeUncovered) rawMask[i] = 2;
  }

  // Suppress isolated single-pixel differences caused by resampling.
  const filtered = new Uint8Array(pixelCount);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const y0 = y > 0 ? y - 1 : y;
    const y1 = y < height - 1 ? y + 1 : y;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const value = rawMask[i];
      if (!value) continue;
      if (value === 2) {
        filtered[i] = 2;
        continue;
      }
      const x0 = x > 0 ? x - 1 : x;
      const x1 = x < width - 1 ? x + 1 : x;
      let neighbors = 0;
      for (let ny = y0; ny <= y1 && neighbors < 2; ny++) {
        const nrow = ny * width;
        for (let nx = x0; nx <= x1; nx++) {
          if ((ny !== y || nx !== x) && rawMask[nrow + nx]) {
            neighbors += 1;
            if (neighbors >= 2) break;
          }
        }
      }
      if (neighbors >= 2) filtered[i] = 1;
    }
  }

  // Connected components (8-neighbourhood) -> readable "change regions".
  const labels = new Int32Array(pixelCount);
  const stack = new Int32Array(pixelCount);
  const components = [];
  let label = 0;

  for (let start = 0; start < pixelCount; start++) {
    if (!filtered[start] || labels[start]) continue;
    label += 1;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    let count = 0;
    let colorCount = 0;
    let coverageCount = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let sumX = 0;
    let sumY = 0;

    while (top > 0) {
      const idx = stack[--top];
      const y = (idx / width) | 0;
      const x = idx - y * width;
      count += 1;
      if (filtered[idx] === 2) coverageCount += 1;
      else colorCount += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumX += x;
      sumY += y;

      const y0 = y > 0 ? y - 1 : y;
      const y1 = y < height - 1 ? y + 1 : y;
      const x0 = x > 0 ? x - 1 : x;
      const x1 = x < width - 1 ? x + 1 : x;
      for (let ny = y0; ny <= y1; ny++) {
        const nrow = ny * width;
        for (let nx = x0; nx <= x1; nx++) {
          const nidx = nrow + nx;
          if (!filtered[nidx] || labels[nidx]) continue;
          labels[nidx] = label;
          stack[top++] = nidx;
        }
      }
    }

    components.push({
      label,
      count,
      colorCount,
      coverageCount,
      minX,
      minY,
      maxX,
      maxY,
      sumX,
      sumY,
    });
  }

  const keep = new Uint8Array(components.length + 1);
  for (const comp of components) {
    if (comp.count >= minAreaPixels) keep[comp.label] = 1;
  }

  const regions = [];
  for (const comp of components) {
    if (!keep[comp.label]) continue;
    const type =
      comp.coverageCount === 0
        ? 'color'
        : comp.colorCount === 0
          ? 'coverage'
          : 'mixed';
    regions.push({
      id: comp.label,
      type,
      area: round(comp.count / factorSq, 2),
      bbox: roundRect({
        x: bounds.minX + comp.minX / factor,
        y: bounds.minY + comp.minY / factor,
        width: (comp.maxX - comp.minX + 1) / factor,
        height: (comp.maxY - comp.minY + 1) / factor,
      }),
      centroid: {
        x: round(bounds.minX + comp.sumX / comp.count / factor, 2),
        y: round(bounds.minY + comp.sumY / comp.count / factor, 2),
      },
      colorArea: round(comp.colorCount / factorSq, 2),
      coverageArea: round(comp.coverageCount / factorSq, 2),
    });
  }
  regions.sort((a, b) => b.area - a.area || a.id - b.id);
  const keptRegions = regions
    .slice(0, MAX_REGIONS)
    .map((region, index) => ({ ...region, index: index + 1 }));

  let keptColorCount = 0;
  let keptCoverageCount = 0;
  const overlayPixels = new Uint8ClampedArray(pixelCount * 4);
  const basePixels = new Uint8ClampedArray(pixelCount * 4);
  const colorDiff = DIFF_COLORS.color;
  const coverageDiff = DIFF_COLORS.coverage;
  const ignoreColor = DIFF_COLORS.ignored;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const o = i * 4;
      let value = filtered[i];
      if (value && labels[i] && !keep[labels[i]]) value = 0;
      if (value === 2) keptCoverageCount += 1;
      else if (value === 1) keptColorCount += 1;

      if (value) {
        const color = value === 2 ? coverageDiff : colorDiff;
        overlayPixels[o] = color[0];
        overlayPixels[o + 1] = color[1];
        overlayPixels[o + 2] = color[2];
        overlayPixels[o + 3] = 238;
      }

      // ---- base layer: grayscale A, faint B, checkerboard + ignored hatch ----
      const aa = aPixels[o + 3];
      const ba = bPixels[o + 3];
      let r = BASE[0];
      let g = BASE[1];
      let b = BASE[2];

      if (aa >= COVERAGE_ALPHA) {
        const w = aa * inv255;
        const lum =
          0.299 * (aPixels[o] * w + BASE[0] * (1 - w)) +
          0.587 * (aPixels[o + 1] * w + BASE[1] * (1 - w)) +
          0.114 * (aPixels[o + 2] * w + BASE[2] * (1 - w));
        r = g = b = 18 + lum * 0.6;
      } else if (ba >= COVERAGE_ALPHA) {
        const w = ba * inv255;
        const lum =
          0.299 * (bPixels[o] * w + BASE[0] * (1 - w)) +
          0.587 * (bPixels[o + 1] * w + BASE[1] * (1 - w)) +
          0.114 * (bPixels[o + 2] * w + BASE[2] * (1 - w));
        r = g = b = 10 + lum * 0.32;
      } else {
        const tile = ((x >> 4) + (y >> 4)) & 1;
        r = tile ? 14 : 10;
        g = tile ? 18 : 14;
        b = tile ? 26 : 21;
      }

      if (ignoreMask && ignoreMask[i]) {
        r = r * 0.62 + ignoreColor[0] * 0.16;
        g = g * 0.72 + ignoreColor[1] * 0.16;
        b = b * 0.8 + ignoreColor[2] * 0.16;
        if (((x + y) & 7) < 2) {
          r += 9;
          g += 20;
          b += 20;
        }
      }

      basePixels[o] = r;
      basePixels[o + 1] = g;
      basePixels[o + 2] = b;
      basePixels[o + 3] = 255;
    }
  }

  const compositePixels = composeDiffPixels(basePixels, overlayPixels);

  const changedCount = keptColorCount + keptCoverageCount;
  const changedArea = changedCount / factorSq;
  const changedColorArea = keptColorCount / factorSq;
  const coverageArea = keptCoverageCount / factorSq;
  const comparedArea = compared / factorSq;
  const ignoredArea = ignored / factorSq;
  const totalArea = bounds.width * bounds.height;

  return {
    width,
    height,
    factor,
    bounds: { ...bounds },
    threshold: round(threshold, 2),
    stats: {
      comparedArea: round(comparedArea, 2),
      changedArea: round(changedArea, 2),
      changedColorArea: round(changedColorArea, 2),
      coverageArea: round(coverageArea, 2),
      ignoredArea: round(ignoredArea, 2),
      totalArea: round(totalArea, 2),
      comparedPixels: compared,
      changedPixels: changedCount,
      ignoredPixels: ignored,
      changedPct: compared
        ? round((keptColorCount / compared) * 100, 2)
        : 0,
      changedPctOfTotal: totalArea
        ? round((changedCount / factorSq / totalArea) * 100, 2)
        : 0,
      ignoredPctOfTotal: totalArea
        ? round((ignored / factorSq / totalArea) * 100, 2)
        : 0,
      regionCount: keptRegions.length,
      threshold: round(threshold, 2),
    },
    regions: keptRegions,
    overlayPixels,
    basePixels,
    compositePixels,
  };
}

/** Composite the base layer with the diff overlay at `alpha` (0..1). */
export function composeDiffPixels(basePixels, overlayPixels, alpha = 1) {
  const out = new Uint8ClampedArray(basePixels.length);
  const a = Math.max(0, Math.min(1, alpha));
  if (a === 1) {
    for (let o = 0; o < basePixels.length; o += 4) {
      const oa = overlayPixels[o + 3] / 255;
      if (!oa) {
        out[o] = basePixels[o];
        out[o + 1] = basePixels[o + 1];
        out[o + 2] = basePixels[o + 2];
        out[o + 3] = basePixels[o + 3];
        continue;
      }
      const w = oa;
      out[o] = basePixels[o] * (1 - w) + overlayPixels[o] * w;
      out[o + 1] = basePixels[o + 1] * (1 - w) + overlayPixels[o + 1] * w;
      out[o + 2] = basePixels[o + 2] * (1 - w) + overlayPixels[o + 2] * w;
      out[o + 3] = 255;
    }
    return out;
  }
  for (let o = 0; o < basePixels.length; o += 4) {
    const w = (overlayPixels[o + 3] / 255) * a;
    out[o] = basePixels[o] * (1 - w) + overlayPixels[o] * w;
    out[o + 1] = basePixels[o + 1] * (1 - w) + overlayPixels[o + 1] * w;
    out[o + 2] = basePixels[o + 2] * (1 - w) + overlayPixels[o + 2] * w;
    out[o + 3] = 255;
  }
  return out;
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Flag pixels where BOTH images have a strong luminance gradient. Used only
 * to raise the local threshold, never to hide a pixel.
 */
function computeEdgeMask(aPixels, bPixels, width, height) {
  const mask = new Uint8Array(width * height);
  if (width < 3 || height < 3) return mask;
  const lumA = new Uint8ClampedArray(width * height);
  const lumB = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < lumA.length; i++, o += 4) {
    const wa = aPixels[o + 3] / 255;
    const wb = bPixels[o + 3] / 255;
    lumA[i] =
      0.299 * (aPixels[o] * wa + 255 * (1 - wa)) +
      0.587 * (aPixels[o + 1] * wa + 255 * (1 - wa)) +
      0.114 * (aPixels[o + 2] * wa + 255 * (1 - wa));
    lumB[i] =
      0.299 * (bPixels[o] * wb + 255 * (1 - wb)) +
      0.587 * (bPixels[o + 1] * wb + 255 * (1 - wb)) +
      0.114 * (bPixels[o + 2] * wb + 255 * (1 - wb));
  }
  const EDGE = 30;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const la = lumA[i];
      const lb = lumB[i];
      const ax = Math.abs(lumA[i - 1] - la) + Math.abs(lumA[i + 1] - la);
      const ay =
        Math.abs(lumA[i - width] - la) + Math.abs(lumA[i + width] - la);
      const bx = Math.abs(lumB[i - 1] - lb) + Math.abs(lumB[i + 1] - lb);
      const by =
        Math.abs(lumB[i - width] - lb) + Math.abs(lumB[i + width] - lb);
      const edgeA = ax + ay >= EDGE;
      const edgeB = bx + by >= EDGE;
      if (edgeA && edgeB) mask[i] = 1;
    }
  }
  return mask;
}

function roundRect(rect) {
  return {
    x: round(rect.x, 2),
    y: round(rect.y, 2),
    width: round(rect.width, 2),
    height: round(rect.height, 2),
  };
}

export const DIFF_SIDE_LIMIT = 1500;

/** Diff canvas scale so the longest comparison side stays manageable. */
export function diffFactorForBounds(bounds) {
  const longest = Math.max(bounds.width, bounds.height, 1);
  return Math.min(1, DIFF_SIDE_LIMIT / longest);
}

/**
 * Rasterise vector ignore strokes into a 0/1 mask at diff resolution.
 * Runs on the main thread because it needs a 2D canvas.
 */
export function rasterizeIgnoreMask(
  strokes,
  { width, height, factor, bounds, makeCanvas },
) {
  if (!strokes || !strokes.length) return null;
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(factor, 0, 0, factor, -bounds.minX * factor, -bounds.minY * factor);
  ctx.clearRect(
    bounds.minX,
    bounds.minY,
    bounds.width,
    bounds.height,
  );
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const stroke of strokes) {
    const points = stroke.points || [];
    if (!points.length) continue;
    ctx.globalCompositeOperation =
      stroke.mode === 'erase' ? 'destination-out' : 'source-over';
    const lineWidth = Math.max(0.5, stroke.size || 20);
    ctx.lineWidth = lineWidth;
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }

  const data = ctx.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let i = 0, o = 3; i < mask.length; i++, o += 4) {
    if (data[o] > 8) mask[i] = 1;
  }
  return mask;
}
