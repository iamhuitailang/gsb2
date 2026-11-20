/*
 * state.js — 扫描数据状态管理
 * 每个 Scan 持有不可变的原始点集(points/colors),当前可见性用索引数组表达;
 * 所有筛选/裁剪动作入栈,撤销只需恢复上一帧索引 —— 原始点始终可还原。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./math3d.js'));
  else root.PCState = factory(root.PCMath);
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';

  let scanSeq = 0;

  function Scan(data, name) {
    this.id = 'scan-' + (++scanSeq) + '-' + Date.now().toString(36);
    this.name = name || 'scan' + scanSeq;
    this.fileName = data.fileName || '';
    this.format = data.format || 'xyz';
    // 原始数据(不可变)
    this.points = data.points;
    this.colors = data.colors; // null 或与 points 等长的 [r,g,b] 数组
    this.parseErrors = data.errors || [];
    // 变换(平移单位与点坐标一致;欧拉角为度,UI 友好)
    this.translation = [0, 0, 0];
    this.rotationDeg = [0, 0, 0];
    // 可见索引(指向原始点);null 视为全部可见
    this.activeIndices = null;
    // 最近一次裁剪范围(世界坐标 AABB),用于工程持久化;null 表示未裁剪
    this.lastCropBox = null;
    // 撤销栈: 每项 {label, indices, translation, rotationDeg, cropBox}
    this.history = [];
    this.bbox = M.bbox(data.points);
  }

  Scan.prototype.count = function () {
    return this.activeIndices ? this.activeIndices.length : this.points.length;
  };
  Scan.prototype.originalCount = function () { return this.points.length; };

  Scan.prototype._snapshot = function (label) {
    this.history.push({
      label: label,
      indices: this.activeIndices ? this.activeIndices.slice() : null,
      translation: this.translation.slice(),
      rotationDeg: this.rotationDeg.slice(),
      cropBox: this.lastCropBox
        ? { min: this.lastCropBox.min.slice(), max: this.lastCropBox.max.slice() } : null
    });
    if (this.history.length > 50) this.history.shift();
  };

  // 应用一个只改变索引的操作(滤波/裁剪/降采样)
  Scan.prototype.applyIndices = function (indices, label, cropBox) {
    this._snapshot(label);
    this.activeIndices = indices.slice();
    if (cropBox) this.lastCropBox = cropBox;
  };

  Scan.prototype.setTransform = function (translation, rotationDeg, label) {
    this._snapshot(label || '变换调整');
    this.translation = translation.slice();
    this.rotationDeg = rotationDeg.slice();
  };

  Scan.prototype.undo = function () {
    const prev = this.history.pop();
    if (!prev) return null;
    this.activeIndices = prev.indices;
    this.translation = prev.translation;
    this.rotationDeg = prev.rotationDeg;
    this.lastCropBox = prev.cropBox;
    return prev;
  };

  // 恢复到导入时的完整点集与零变换(清空全部历史)
  Scan.prototype.restoreAll = function () {
    this.activeIndices = null;
    this.translation = [0, 0, 0];
    this.rotationDeg = [0, 0, 0];
    this.lastCropBox = null;
    const cleared = this.history.length;
    this.history = [];
    return cleared;
  };

  // 当前世界坐标点(应用变换 + 可见索引),供配准误差/导出使用
  Scan.prototype.worldPoints = function () {
    const m = M.makeTransform(this.translation,
      this.rotationDeg.map(function (d) { return d * Math.PI / 180; }));
    const idx = this.activeIndices;
    const n = idx ? idx.length : this.points.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = M.applyPoint(m, this.points[idx ? idx[i] : i]);
    }
    return out;
  };

  Scan.prototype.matrix = function () {
    return M.makeTransform(this.translation,
      this.rotationDeg.map(function (d) { return d * Math.PI / 180; }));
  };

  function ScanStore() {
    this.scans = [];
    this.activeId = null;
  }
  ScanStore.prototype.add = function (data, name) {
    const s = new Scan(data, name);
    this.scans.push(s);
    if (!this.activeId) this.activeId = s.id;
    return s;
  };
  ScanStore.prototype.get = function (id) {
    return this.scans.find(function (s) { return s.id === id; }) || null;
  };
  ScanStore.prototype.active = function () { return this.get(this.activeId); };
  ScanStore.prototype.remove = function (id) {
    const i = this.scans.findIndex(function (s) { return s.id === id; });
    if (i < 0) return;
    this.scans.splice(i, 1);
    if (this.activeId === id) {
      this.activeId = this.scans.length ? this.scans[0].id : null;
    }
  };

  return { Scan: Scan, ScanStore: ScanStore };
});
