/*
 * kdtree.js — 三维 KD 树(平衡构建 + k 近邻查询)
 * 纯逻辑模块,供离群点筛除与配准误差使用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PCKdTree = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function KDTree(points) {
    this.points = points;
    // 索引数组,构建过程中按轴重排
    const ids = new Uint32Array(points.length);
    for (let i = 0; i < points.length; i++) ids[i] = i;
    this.nodes = build(points, ids, 0, ids.length, 0);
  }

  function build(points, ids, lo, hi, depth) {
    if (lo >= hi) return null;
    const axis = depth % 3;
    const mid = (lo + hi) >> 1;
    // 原地选择中位数(数据量很大时避免完整排序的开销)
    selectNth(ids, lo, hi, mid, axis, points);
    return {
      index: ids[mid],
      axis: axis,
      left: build(points, ids, lo, mid, depth + 1),
      right: build(points, ids, mid + 1, hi, depth + 1)
    };
  }

  function selectNth(ids, lo, hi, k, axis, points) {
    while (lo < hi - 1) {
      const pivot = ids[(lo + hi) >> 1];
      const pv = points[pivot][axis];
      let i = lo, j = hi - 1;
      while (i <= j) {
        while (points[ids[i]][axis] < pv) i++;
        while (points[ids[j]][axis] > pv) j--;
        if (i <= j) {
          const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
          i++; j--;
        }
      }
      if (k <= j) hi = j + 1;
      else if (k >= i) lo = i;
      else break;
    }
  }

  // 返回 k 个近邻的 [{index, dist2}],按距离平方升序
  KDTree.prototype.knn = function (query, k) {
    if (!this.nodes || k <= 0) return [];
    const heap = new MaxHeap(k);
    knnWalk(this.nodes, query, k, heap, this.points);
    return heap.toSortedArray().map(function (e) {
      return { index: e.id, dist2: e.key };
    });
  };

  function knnWalk(node, q, k, heap, points) {
    if (!node) return;
    const axis = node.axis;
    const diff = q[axis] - points[node.index][axis];
    const near = diff < 0 ? node.left : node.right;
    const far = diff < 0 ? node.right : node.left;

    knnWalk(near, q, k, heap, points);

    let d2 = 0;
    const p = points[node.index];
    for (let i = 0; i < 3; i++) {
      const d = q[i] - p[i];
      d2 += d * d;
    }
    heap.push(node.index, d2);

    if (far && (heap.size < k || diff * diff <= heap.topKey())) {
      knnWalk(far, q, k, heap, points);
    }
  }

  // 定容最大堆: 保存距离最小的 k 个
  function MaxHeap(capacity) {
    this.capacity = capacity;
    this.keys = [];
    this.ids = [];
    this.size = 0;
  }
  MaxHeap.prototype.topKey = function () { return this.keys[0]; };
  MaxHeap.prototype.push = function (id, key) {
    if (this.size < this.capacity) {
      this.keys.push(key); this.ids.push(id); this.size++;
      siftUp(this, this.size - 1);
    } else if (key < this.keys[0]) {
      this.keys[0] = key; this.ids[0] = id;
      siftDown(this, 0);
    }
  };
  function siftUp(h, i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (h.keys[parent] >= h.keys[i]) break;
      swap(h, parent, i);
      i = parent;
    }
  }
  function siftDown(h, i) {
    while (true) {
      const l = 2 * i + 1, r = l + 1;
      let largest = i;
      if (l < h.size && h.keys[l] > h.keys[largest]) largest = l;
      if (r < h.size && h.keys[r] > h.keys[largest]) largest = r;
      if (largest === i) break;
      swap(h, largest, i);
      i = largest;
    }
  }
  function swap(h, a, b) {
    const tk = h.keys[a]; h.keys[a] = h.keys[b]; h.keys[b] = tk;
    const ti = h.ids[a]; h.ids[a] = h.ids[b]; h.ids[b] = ti;
  }
  MaxHeap.prototype.toSortedArray = function () {
    const out = [];
    for (let i = 0; i < this.size; i++) out.push({ id: this.ids[i], key: this.keys[i] });
    out.sort(function (a, b) { return a.key - b.key; });
    return out;
  };

  return KDTree;
});
