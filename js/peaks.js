/*
 * peaks.js — 为画布渲染预计算波形峰值桶（min/max），
 * 桶宽按画布像素走，缩放窗口时重建。
 */
(function (global) {
  'use strict';

  /**
   * 返回 { bucketsPerChannel: [{min:Float32Array, max:Float32Array}], bucketSize }
   * 每个画布像素列对应一个桶，桶内取 min/max。
   */
  function buildPeaks(channelData, widthPx) {
    const n = channelData[0].length;
    const buckets = Math.max(50, Math.min(widthPx | 0, n));
    const bucketSize = n / buckets;

    const result = channelData.map((data) => {
      const min = new Float32Array(buckets);
      const max = new Float32Array(buckets);
      for (let b = 0; b < buckets; b++) {
        const start = Math.floor(b * bucketSize);
        const end = Math.min(n, Math.floor((b + 1) * bucketSize) || start + 1);
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = start; i < end; i++) {
          const v = data[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        min[b] = lo === Infinity ? 0 : lo;
        max[b] = hi === -Infinity ? 0 : hi;
      }
      return { min, max };
    });

    return { perChannel: result, bucketSize, buckets };
  }

  global.Peaks = { buildPeaks };
})(typeof window !== 'undefined' ? window : globalThis);
