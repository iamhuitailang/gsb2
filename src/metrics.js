/**
 * 画质损失指标。
 *
 * 约定：
 *   - 所有颜色误差只统计“参考图和结果图都不透明”的像素；
 *   - alpha < alphaCutoff 的透明像素被完全排除；
 *   - 需要判定 alpha 的整图扫描是完整进行的（便宜），但颜色误差指标按确定性
 *     步长采样，避免超大照片在浏览器里卡死。采样像素数与步长会一并返回；
 *   - 输出透明像素被错误地写成不透明（或反之）会单独计入 alphaMismatchPixels。
 */
import { rgbToLab, deltaE76, deltaE2000, luma } from './color.js';

const DEFAULT_MAX_SAMPLES = 262144; // 26 万像素，约 512×512

/**
 * 计算两幅同尺寸 RGBA 图像的误差。
 *
 * - 颜色误差只统计“两边都不透明”的像素；
 * - 透明与非透明不一致会计入 alphaMismatchPixels；
 * - 超大图按确定性步长采样颜色误差（alpha/掩码仍全量扫描）。
 */
export function computeMetrics(reference, quantized, width, height, options = {}) {
  const cutoff = Math.max(1, Math.min(255, Math.round(options.alphaCutoff ?? 128)));
  const maxSamples = Math.max(1, Math.floor(options.maxSamples ?? DEFAULT_MAX_SAMPLES));
  const total = width * height;
  const count = Math.min(total, Math.floor(reference.length / 4), Math.floor(quantized.length / 4));
  const step = Math.max(1, Math.ceil(count / maxSamples));

  let sampled = 0;
  let transparentPixels = 0;
  let opaquePixels = 0;
  let semiPixels = 0;
  let alphaMismatch = 0;

  let sumAbsRgb = 0;
  let sumSqRgb = 0;
  let sumDeltaE = 0;
  let sumDeltaE2000 = 0;

  let maxDeltaE = 0;
  const histDeltaE = new Uint32Array(64);
  const absR = new Uint32Array(256);
  const absG = new Uint32Array(256);
  const absB = new Uint32Array(256);
  const alphaHist = new Uint32Array(256);

  const useDeltaE2000 = options.perceptual === true;
  const edge = computeEdgeMetrics(reference, quantized, width, height, cutoff);

  // alpha 统计与掩码差异：完整扫描，不采样。
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    const ra = reference[i + 3];
    const qa = quantized[i + 3];
    alphaHist[qa]++;
    if (ra < cutoff) {
      transparentPixels++;
      if (qa >= cutoff) alphaMismatch++;
    } else {
      opaquePixels++;
      if (qa < cutoff) alphaMismatch++;
      if (ra < 255 || qa < 255) semiPixels++;
    }
  }

  for (let p = 0; p < count; p += step) {
    const i = p * 4;
    const ra = reference[i + 3];
    const qa = quantized[i + 3];
    if (ra < cutoff || qa < cutoff) continue;

    const dr = reference[i] - quantized[i];
    const dg = reference[i + 1] - quantized[i + 1];
    const db = reference[i + 2] - quantized[i + 2];
    const ar = dr < 0 ? -dr : dr;
    const ag = dg < 0 ? -dg : dg;
    const ab = db < 0 ? -db : db;
    absR[ar]++;
    absG[ag]++;
    absB[ab]++;
    sumAbsRgb += (ar + ag + ab) / 3;
    sumSqRgb += (dr * dr + dg * dg + db * db) / 3;

    const labRef = rgbToLab(reference[i], reference[i + 1], reference[i + 2]);
    const labQ = rgbToLab(quantized[i], quantized[i + 1], quantized[i + 2]);
    const de76 = deltaE76(labRef, labQ);
    sumDeltaE += de76;
    if (de76 > maxDeltaE) maxDeltaE = de76;
    histDeltaE[Math.min(63, Math.floor(de76))]++;
    if (useDeltaE2000) sumDeltaE2000 += deltaE2000(labRef, labQ);
    sampled++;
  }

  const mse = sampled > 0 ? sumSqRgb / sampled : 0;
  const psnr = sampled > 0 ? (mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse)) : 0;

  return {
    width,
    height,
    totalPixels: count,
    sampledPixels: sampled,
    sampleStep: step,
    transparentPixels,
    opaquePixels,
    semiPixels,
    alphaMismatchPixels: alphaMismatch,
    mae: sampled > 0 ? sumAbsRgb / sampled / 255 : 0,
    mae255: sampled > 0 ? sumAbsRgb / sampled : 0,
    mse,
    rmse: Math.sqrt(mse),
    psnr,
    deltaE76Mean: sampled > 0 ? sumDeltaE / sampled : 0,
    deltaE76Max: sampled > 0 ? maxDeltaE : 0,
    deltaE2000Mean: useDeltaE2000 && sampled > 0 ? sumDeltaE2000 / sampled : null,
    p95DeltaE76: percentileFromHistogram(histDeltaE, sampled, 0.95),
    p99DeltaE76: percentileFromHistogram(histDeltaE, sampled, 0.99),
    alphaCoverage: {
      meanAlpha: count > 0 ? computeMeanAlpha(quantized, count) : 0,
      opaqueRatio: count > 0 ? opaquePixels / count : 0,
      semiRatio: count > 0 ? semiPixels / count : 0,
      alphaPixels: count,
    },
    edge,
    histograms: {
      r: histogramToArray(absR, sampled),
      g: histogramToArray(absG, sampled),
      b: histogramToArray(absB, sampled),
      deltaE: histogramToArray(histDeltaE, sampled),
      alpha: histogramToArray(alphaHist, count),
    },
    metricNotes: {
      alphaCutoff: cutoff,
      alphaMode: options.alphaMode || 'binary',
      perceptual: useDeltaE2000,
      maxSamples,
    },
  };
}

function computeMeanAlpha(rgba, count) {
  let sum = 0;
  for (let p = 0; p < count; p++) sum += rgba[p * 4 + 3];
  return count > 0 ? sum / count / 255 : 0;
}

function histogramToArray(h, total) {
  const out = new Array(h.length);
  for (let i = 0; i < h.length; i++) out[i] = total > 0 ? h[i] / total : 0;
  return out;
}

function percentileFromHistogram(hist, total, p) {
  if (total <= 0) return 0;
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return hist.length - 1;
}

/** alpha 覆盖率：基于结果 alpha，透明像素占比也一并返回。 */
export function computeAlphaCoverage(rgba, count, cutoff = 128) {
  let opaque = 0;
  let semi = 0;
  let sum = 0;
  for (let p = 0; p < count; p++) {
    const a = rgba[p * 4 + 3];
    sum += a;
    if (a >= cutoff) opaque++;
    if (a > 0 && a < 255) semi++;
  }
  return {
    meanAlpha: count > 0 ? sum / count / 255 : 0,
    opaqueRatio: count > 0 ? opaque / count : 0,
    semiRatio: count > 0 ? semi / count : 0,
    alphaPixels: count,
  };
}

/** 形状差异：两图“不透明”掩码不一致的像素数量，并统计其中紧邻透明区的比例。 */
export function computeEdgeMetrics(reference, quantized, width, height, cutoff) {
  const total = width * height;
  let mismatch = 0;
  let edgeTotal = 0;
  let edgeMismatch = 0;
  const alphaAt = (p) => reference[p * 4 + 3] >= cutoff;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const refOpaque = alphaAt(p);
      const qOpaque = quantized[p * 4 + 3] >= cutoff;
      if (refOpaque !== qOpaque) mismatch++;
      const edge =
        (x > 0 && alphaAt(p - 1) !== refOpaque) ||
        (x + 1 < width && alphaAt(p + 1) !== refOpaque) ||
        (y > 0 && alphaAt(p - width) !== refOpaque) ||
        (y + 1 < height && alphaAt(p + width) !== refOpaque);
      if (edge) {
        edgeTotal++;
        if (refOpaque !== qOpaque) edgeMismatch++;
      }
    }
  }
  return {
    maskMismatchPixels: mismatch,
    maskMismatchRatio: total > 0 ? mismatch / total : 0,
    edgePixels: edgeTotal,
    edgeMismatchPixels: edgeMismatch,
    edgeMismatchRatio: edgeTotal > 0 ? edgeMismatch / edgeTotal : 0,
  };
}

/**
 * 全图 SSIM（灰度，8×8 窗口滑动步长 4）。
 * 只用于结构性损失的参考；超过 4MP 时直接跳过并返回 null。
 */
export function computeSSIM(reference, quantized, width, height, alphaCutoff = 128) {
  if (width * height > 4_000_000) return null;
  const win = 8;
  const stride = 4;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const refGray = new Float32Array(width * height);
  const qGray = new Float32Array(width * height);
  const valid = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    refGray[p] = luma(reference[i], reference[i + 1], reference[i + 2]);
    qGray[p] = luma(quantized[i], quantized[i + 1], quantized[i + 2]);
    valid[p] = reference[i + 3] >= alphaCutoff && quantized[i + 3] >= alphaCutoff ? 1 : 0;
  }
  let sum = 0;
  let windows = 0;
  for (let y = 0; y + win <= height; y += stride) {
    for (let x = 0; x + win <= width; x += stride) {
      let n = 0;
      let meanA = 0;
      let meanB = 0;
      for (let yy = 0; yy < win; yy++) {
        for (let xx = 0; xx < win; xx++) {
          const p = (y + yy) * width + (x + xx);
          if (!valid[p]) continue;
          meanA += refGray[p];
          meanB += qGray[p];
          n++;
        }
      }
      if (n < win * win * 0.5) continue;
      meanA /= n;
      meanB /= n;
      let varA = 0;
      let varB = 0;
      let cov = 0;
      for (let yy = 0; yy < win; yy++) {
        for (let xx = 0; xx < win; xx++) {
          const p = (y + yy) * width + (x + xx);
          if (!valid[p]) continue;
          const da = refGray[p] - meanA;
          const db = qGray[p] - meanB;
          varA += da * da;
          varB += db * db;
          cov += da * db;
        }
      }
      varA /= n;
      varB /= n;
      cov /= n;
      sum +=
        ((2 * meanA * meanB + C1) * (2 * cov + C2)) /
        ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2));
      windows++;
    }
  }
  return windows > 0 ? sum / windows : null;
}

export function metricLabel(key) {
  const labels = {
    mae: '平均绝对误差 (MAE)',
    mae255: 'MAE（0–255）',
    mse: '均方误差 (MSE)',
    rmse: '均方根误差 (RMSE)',
    psnr: '峰值信噪比 (PSNR)',
    deltaE76Mean: '平均 ΔE76',
    deltaE76Max: '最大 ΔE76',
    deltaE2000Mean: '平均 ΔE2000',
    p95DeltaE76: 'ΔE76 P95',
    p99DeltaE76: 'ΔE76 P99',
    ssim: '结构相似度 (SSIM)',
    sampledPixels: '参与颜色统计的像素',
    transparentPixels: '透明像素（不参与误差）',
    alphaMismatchPixels: '透明/不透明判定不一致',
  };
  return labels[key] || key;
}
