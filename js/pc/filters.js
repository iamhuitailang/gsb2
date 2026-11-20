/*
 * filters.js — 点云筛选算子,全部以「原始点索引数组」表达结果,
 * 便于撤销: 不销毁任何点,只切换当前可见索引。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./kdtree.js'), require('./math3d.js'));
  } else root.PCFilters = factory(root.PCKdTree, root.PCMath);
})(typeof self !== 'undefined' ? self : this, function (KDTree, M) {
  'use strict';

  /**
   * 统计离群点筛除 (Statistical Outlier Removal)
   * 对每个点取 k 个近邻,平均距离 d_i; 全局均值 mu、标准差 sigma;
   * 剔除 d_i > mu + sigma * stdRatio 的点。
   * @returns {{keep:Uint32Array, remove:Uint32Array, removedCount:number,
   *            meanDist:number, threshold:number}}
   */
  function statisticalOutlierRemoval(points, k, stdRatio) {
    k = Math.max(1, k || 8);
    stdRatio = Number.isFinite(stdRatio) ? stdRatio : 1.0;
    const n = points.length;
    const keep = [];
    const remove = [];
    if (n === 0) {
      return { keep: new Uint32Array(0), remove: new Uint32Array(0),
        removedCount: 0, meanDist: 0, threshold: 0 };
    }
    const tree = new KDTree(points);
    const avg = new Float64Array(n);
    let mu = 0;
    for (let i = 0; i < n; i++) {
      const nn = tree.knn(points[i], k + 1); // 第 0 个是自己
      let sum = 0;
      for (let j = 1; j < nn.length; j++) sum += Math.sqrt(nn[j].dist2);
      avg[i] = nn.length > 1 ? sum / (nn.length - 1) : 0;
      mu += avg[i];
    }
    mu /= n;
    let variance = 0;
    for (let i = 0; i < n; i++) {
      const d = avg[i] - mu;
      variance += d * d;
    }
    const sigma = Math.sqrt(variance / n);
    const threshold = mu + sigma * stdRatio;
    for (let i = 0; i < n; i++) {
      if (avg[i] > threshold) remove.push(i);
      else keep.push(i);
    }
    return {
      keep: Uint32Array.from(keep),
      remove: Uint32Array.from(remove),
      removedCount: remove.length,
      meanDist: mu,
      threshold: threshold
    };
  }

  /**
   * 体素栅格降采样: 每个体素保留距体素中心最近的一个点(颜色取平均)。
   * @returns {{indices:Uint32Array, voxelCount:number, gridSize:number}}
   */
  function voxelDownsample(points, voxelSize) {
    voxelSize = Math.max(1e-9, voxelSize);
    const box = M.bbox(points);
    if (!box) return { indices: new Uint32Array(0), voxelCount: 0, gridSize: voxelSize };
    const dims = box.size.map(function (s) { return Math.max(1, Math.ceil(s / voxelSize) + 1); });
    const buckets = new Map();
    const centers = new Map();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const gx = Math.min(dims[0] - 1, Math.floor((p[0] - box.min[0]) / voxelSize));
      const gy = Math.min(dims[1] - 1, Math.floor((p[1] - box.min[1]) / voxelSize));
      const gz = Math.min(dims[2] - 1, Math.floor((p[2] - box.min[2]) / voxelSize));
      const key = gx * dims[1] * dims[2] + gy * dims[2] + gz;
      if (!buckets.has(key)) {
        buckets.set(key, []);
        centers.set(key, [
          box.min[0] + (gx + 0.5) * voxelSize,
          box.min[1] + (gy + 0.5) * voxelSize,
          box.min[2] + (gz + 0.5) * voxelSize
        ]);
      }
      buckets.get(key).push(i);
    }
    const out = [];
    buckets.forEach(function (ids, key) {
      const c = centers.get(key);
      let best = ids[0], bestD = Infinity;
      for (let j = 0; j < ids.length; j++) {
        const p = points[ids[j]];
        const dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) { bestD = d2; best = ids[j]; }
      }
      out.push(best);
    });
    out.sort(function (a, b) { return a - b; });
    return {
      indices: Uint32Array.from(out),
      voxelCount: buckets.size,
      gridSize: voxelSize
    };
  }

  /**
   * 等步长稀疏采样(确定性)
   * @returns {{indices:Uint32Array}}
   */
  function strideSample(points, targetCount) {
    return { indices: M.strideSample(points.length, targetCount) };
  }

  // 对当前索引集合应用 AABB 裁剪, mode: 'keep-inside' | 'remove-inside'
  function cropByBox(points, activeIndices, box, mode) {
    const keep = [];
    const removed = [];
    for (let i = 0; i < activeIndices.length; i++) {
      const idx = activeIndices[i];
      const inside = M.pointInBox(points[idx], box);
      const retain = mode === 'remove-inside' ? !inside : inside;
      if (retain) keep.push(idx);
      else removed.push(idx);
    }
    return {
      keep: Uint32Array.from(keep),
      removed: Uint32Array.from(removed)
    };
  }

  return {
    statisticalOutlierRemoval: statisticalOutlierRemoval,
    voxelDownsample: voxelDownsample,
    strideSample: strideSample,
    cropByBox: cropByBox
  };
});
