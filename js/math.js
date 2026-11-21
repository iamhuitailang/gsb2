/* 投影校正工具 —— 数学核心
 * 全部挂载到全局命名空间 PCAL，避免使用 ES module（file:// 下 module 会被 CORS 拦截）。
 *
 * 透视关系用 3x3 单应矩阵 H 表达：源素材规范坐标 (u,v) -> 输出画面坐标 (x,y)。
 * 渲染时对每个输出像素求 H 的逆矩阵，回到源图采样，这是透视正确的关键，
 * 不能用仿射近似（仿射近似无法表现梯形/消失点）。
 */
(function (global) {
  'use strict';

  var PCAL = global.PCAL || (global.PCAL = {});

  /** 高斯消元求解线性方程组 A·x = b（A 为 n×n，按行存的一维数组）。无解返回 null。 */
  function solveLinear(A, b, n) {
    // 增广矩阵
    var M = new Array(n);
    for (var i = 0; i < n; i++) {
      M[i] = new Array(n + 1);
      for (var j = 0; j < n; j++) M[i][j] = A[i * n + j];
      M[i][n] = b[i];
    }
    // 带部分主元的前向消元
    for (var col = 0; col < n; col++) {
      var pivot = col;
      var maxAbs = Math.abs(M[col][col]);
      for (var r = col + 1; r < n; r++) {
        var v = Math.abs(M[r][col]);
        if (v > maxAbs) { maxAbs = v; pivot = r; }
      }
      if (maxAbs < 1e-10) return null; // 奇异矩阵
      if (pivot !== col) { var tmp = M[col]; M[col] = M[pivot]; M[pivot] = tmp; }
      for (var r2 = col + 1; r2 < n; r2++) {
        var factor = M[r2][col] / M[col][col];
        if (factor === 0) continue;
        for (var k = col; k <= n; k++) M[r2][k] -= factor * M[col][k];
      }
    }
    // 回代
    var x = new Array(n);
    for (var i2 = n - 1; i2 >= 0; i2--) {
      var sum = M[i2][n];
      for (var j2 = i2 + 1; j2 < n; j2++) sum -= M[i2][j2] * x[j2];
      var diag = M[i2][i2];
      if (Math.abs(diag) < 1e-12) return null;
      x[i2] = sum / diag;
    }
    return x;
  }

  /**
   * 由 4 对点计算单应矩阵（行优先 3×3，h33 固定为 1）。
   * srcPts/dstPts: [{x,y} × 4]，顺序 左上、右上、右下、左下。
   * 退化（四点共线/三点共线等）时返回 null。
   */
  function findHomography(srcPts, dstPts) {
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var s = srcPts[i], d = dstPts[i];
      // x' = (h11 u + h12 v + h13) / (h31 u + h32 v + 1)
      A.push(s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y);
      b.push(d.x);
      A.push(0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y);
      b.push(d.y);
    }
    var h = solveLinear(A, b, 8);
    if (!h) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  /** 3×3 矩阵求逆（伴随矩阵法）。奇异返回 null。 */
  function invert3(H) {
    var a = H[0], b = H[1], c = H[2];
    var d = H[3], e = H[4], f = H[5];
    var g = H[6], h = H[7], i = H[8];
    var A = e * i - f * h;
    var B = -(d * i - f * g);
    var C = d * h - e * g;
    var det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    var invDet = 1 / det;
    return [
      A * invDet,
      (c * h - b * i) * invDet,
      (b * f - c * e) * invDet,
      B * invDet,
      (a * i - c * g) * invDet,
      (c * d - a * f) * invDet,
      C * invDet,
      (b * g - a * h) * invDet,
      (a * e - b * d) * invDet
    ];
  }

  /** 应用单应：返回 {x, y}，并给出齐次分母 w（调用方可据此判断点是否落在有效半平面）。 */
  function applyH(H, x, y) {
    var w = H[6] * x + H[7] * y + H[8];
    return {
      x: (H[0] * x + H[1] * y + H[2]) / w,
      y: (H[3] * x + H[4] * y + H[5]) / w,
      w: w
    };
  }

  /** 点积/叉积等小工具 */
  function cross(ax, ay, bx, by) { return ax * by - ay * bx; }
  function dist(ax, ay, bx, by) {
    var dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  PCAL.math = {
    solveLinear: solveLinear,
    findHomography: findHomography,
    invert3: invert3,
    applyH: applyH,
    cross: cross,
    dist: dist,
    clamp: clamp,
    lerp: lerp
  };
})(window);
