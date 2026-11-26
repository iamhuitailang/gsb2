/**
 * geometry.js — 掩膜分类与距离变换
 *
 * 关键要求：透明边缘（0<alpha<255）与全透明区（alpha=0）必须分开统计；
 * 局部背景取“距离每个图标像素最近的、未被任何提示覆盖的真实背景像素”，
 * 不使用整图平均色。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Geo = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // alpha 分类阈值
  const ALPHA_FULL = 250;   // >= 视为全不透明
  const ALPHA_EDGE_LO = 8;  // <= 视为全透明

  function alphaClass(a) {
    if (a <= ALPHA_EDGE_LO) return 'transparent';
    if (a >= ALPHA_FULL) return 'full';
    return 'edge';
  }

  /**
   * 两遍 Chamfer 距离变换。
   * @param W,H 画面尺寸
   * @param isTarget Uint8Array，1=目标像素（此处为“背景像素”）
   * @returns {{dist: Float64Array, nearest: Int32Array}} 每个像素到最近目标的
   *          欧氏距离（近似）与目标像素线性索引；目标自身 dist=0
   */
  function nearestTarget(W, H, isTarget) {
    const N = W * H;
    const dist = new Float64Array(N).fill(Infinity);
    const nearest = new Int32Array(N).fill(-1);
    for (let p = 0; p < N; p++) {
      if (isTarget[p]) { dist[p] = 0; nearest[p] = p; }
    }
    const ORTH = 1, DIAG = Math.SQRT2;
    // 前向：上、左上、右上、左
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        consider(p, p - W, ORTH);
        if (x > 0) {
          consider(p, p - 1, ORTH);
          consider(p, p - W - 1, DIAG);
        }
        if (x < W - 1) consider(p, p - W + 1, DIAG);
      }
    }
    // 后向：下、左下、右下、右
    for (let y = H - 1; y >= 0; y--) {
      for (let x = W - 1; x >= 0; x--) {
        const p = y * W + x;
        consider(p, p + W, ORTH);
        if (x < W - 1) {
          consider(p, p + 1, ORTH);
          consider(p, p + W + 1, DIAG);
        }
        if (x > 0) consider(p, p + W - 1, DIAG);
      }
    }
    function consider(p, q, cost) {
      if (q < 0 || q >= N) return;
      if (dist[q] === Infinity) return;
      const d = dist[q] + cost;
      if (d < dist[p]) { dist[p] = d; nearest[p] = nearest[q]; }
    }
    return { dist, nearest };
  }

  /** 统计汇总：mean/min/分位数/阈值达标率 */
  function summarize(values) {
    if (!values.length) {
      return { count: 0, mean: NaN, min: NaN, p5: NaN, p10: NaN, p50: NaN };
    }
    const sorted = Float64Array.from(values).sort();
    const n = sorted.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sorted[i];
    const q = (frac) => sorted[Math.min(n - 1, Math.floor(frac * n))];
    return {
      count: n,
      mean: sum / n,
      min: sorted[0],
      p5: q(0.05),
      p10: q(0.10),
      p50: q(0.50),
    };
  }

  /** 在给定数值数组上计算低于各阈值的比例 */
  function passRates(values, thresholds) {
    const out = {};
    const n = values.length || 1;
    for (const t of thresholds) {
      let below = 0;
      for (const v of values) if (v < t) below++;
      out['lt' + t] = below / n;
    }
    return out;
  }

  return { ALPHA_FULL, ALPHA_EDGE_LO, alphaClass, nearestTarget, summarize, passRates };
});
