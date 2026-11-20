/*
 * registration.js — 两份点云的配准误差评估
 * 指标: 对源点云中每个(抽样后的)点, 在目标点云中找最近邻,
 * 统计距离的 RMSE / 平均 / 最大 / 中位数。纯几何最近邻,不做 ICP。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./kdtree.js'), require('./math3d.js'));
  } else root.PCRegistration = factory(root.PCKdTree, root.PCMath);
})(typeof self !== 'undefined' ? self : this, function (KDTree, M) {
  'use strict';

  /**
   * @param sourcePoints 已应用当前变换的源点云(世界坐标)
   * @param targetPoints 目标点云(世界坐标)
   * @param maxSamples 参与计算的源点上限(大数据量时自动等步长抽样)
   */
  function nearestNeighborError(sourcePoints, targetPoints, maxSamples) {
    if (!sourcePoints.length || !targetPoints.length) {
      return { rmse: null, mean: null, max: null, median: null,
        samples: 0, targetCount: targetPoints.length, message: '点云为空,无法计算' };
    }
    maxSamples = maxSamples || 5000;
    const sampleIdx = M.strideSample(sourcePoints.length,
      Math.min(maxSamples, sourcePoints.length));

    const tree = new KDTree(targetPoints);
    const dists = new Float64Array(sampleIdx.length);
    let sumSq = 0, sum = 0, maxD = 0;
    for (let i = 0; i < sampleIdx.length; i++) {
      const q = sourcePoints[sampleIdx[i]];
      const nn = tree.knn(q, 1);
      const d = Math.sqrt(nn[0].dist2);
      dists[i] = d;
      sumSq += d * d;
      sum += d;
      if (d > maxD) maxD = d;
    }
    const sorted = Array.from(dists).sort(function (a, b) { return a - b; });
    const median = sorted.length % 2
      ? sorted[(sorted.length - 1) >> 1]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const n = sampleIdx.length;
    return {
      rmse: Math.sqrt(sumSq / n),
      mean: sum / n,
      max: maxD,
      median: median,
      samples: n,
      targetCount: targetPoints.length,
      message: ''
    };
  }

  return { nearestNeighborError: nearestNeighborError };
});
