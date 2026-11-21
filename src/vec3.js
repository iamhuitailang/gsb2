/* 极简 3D 向量工具：所有向量用 [x, y, z] 数组，z 为竖直方向 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoadVec3 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const V = {
    create: (x = 0, y = 0, z = 0) => [x, y, z],
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    lerp: (a, b, t) => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    len2: (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2],
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
    dist2D: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]),
    normalize(a) {
      const l = Math.hypot(a[0], a[1], a[2]);
      return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
    },
    /** 把 v 投影到垂直于 unitN 的平面上并归一化，用于求路面内横向量 */
    projectOnPlane(v, unitN) {
      const d = V.dot(v, unitN);
      const p = V.sub(v, V.scale(unitN, d));
      return V.normalize(p);
    },
  };

  return V;
});
