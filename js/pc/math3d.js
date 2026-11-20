/*
 * math3d.js — 纯函数 3D 数学工具(不依赖 THREE,便于 Node 单元测试)
 * 所有矩阵均为 16 元素列主序 Float32Array,与 THREE.Matrix4 内存布局一致。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PCMath = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vscale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vcross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }
  function vlen(a) { return Math.sqrt(vdot(a, a)); }
  function vdist(a, b) { return vlen(vsub(a, b)); }

  // 列主序 4x4 恒等矩阵
  function identity() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  }

  function multiply(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        out[c * 4 + r] = s;
      }
    }
    return out;
  }

  function makeTranslation(t) {
    const m = identity();
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
    return m;
  }

  // 绕单轴旋转(弧度),axis: 0=X 1=Y 2=Z
  function makeAxisRotation(axis, rad) {
    const c = Math.cos(rad), s = Math.sin(rad);
    const m = identity();
    if (axis === 0) { m[5] = c; m[6] = s; m[9] = -s; m[10] = c; }
    else if (axis === 1) { m[0] = c; m[2] = -s; m[8] = s; m[10] = c; }
    else { m[0] = c; m[1] = s; m[4] = -s; m[5] = c; }
    return m;
  }

  // 欧拉角(弧度,XYZ 内旋顺序,与 THREE 默认 Euler 'XYZ' 一致)
  function makeRotationEuler(rx, ry, rz) {
    return multiply(makeAxisRotation(2, rz),
      multiply(makeAxisRotation(1, ry), makeAxisRotation(0, rx)));
  }

  // 由平移 + 欧拉角构造刚体变换
  function makeTransform(translation, eulerRad) {
    return multiply(makeTranslation(translation),
      makeRotationEuler(eulerRad[0], eulerRad[1], eulerRad[2]));
  }

  function applyPoint(m, p) {
    const x = p[0], y = p[1], z = p[2];
    return [
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14]
    ];
  }

  function bbox(points) {
    if (!points.length) return null;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      for (let k = 0; k < 3; k++) {
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
    }
    return {
      min, max,
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    };
  }

  function pointInBox(p, box) {
    return p[0] >= box.min[0] && p[0] <= box.max[0] &&
           p[1] >= box.min[1] && p[1] <= box.max[1] &&
           p[2] >= box.min[2] && p[2] <= box.max[2];
  }

  // 等步长索引抽样(确定性,无需随机数)
  function strideSample(n, target) {
    if (target <= 0 || target >= n) {
      const all = new Uint32Array(n);
      for (let i = 0; i < n; i++) all[i] = i;
      return all;
    }
    const out = new Uint32Array(target);
    const step = n / target;
    for (let i = 0; i < target; i++) out[i] = Math.floor(i * step);
    return out;
  }

  return {
    vadd, vsub, vscale, vdot, vcross, vlen, vdist,
    identity, multiply, makeTranslation, makeAxisRotation,
    makeRotationEuler, makeTransform, applyPoint,
    bbox, pointInBox, strideSample
  };
});
