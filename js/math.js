/* 基础数学：二维向量、3x3 仿射矩阵（与 Canvas setTransform 参数同序）、插值与缓动 */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;
  const DEG = 180 / Math.PI;

  const V = {
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, s) => ({ x: a.x * s, y: a.y * s }),
    len: (a) => Math.hypot(a.x, a.y),
    dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
    dot: (a, b) => a.x * b.x + a.y * b.y,
    angle: (a) => Math.atan2(a.y, a.x),
    lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
    rot: (a, r) => ({
      x: a.x * Math.cos(r) - a.y * Math.sin(r),
      y: a.x * Math.sin(r) + a.y * Math.cos(r),
    }),
  };

  /**
   * 3x3 仿射矩阵，数组布局 [a, b, c, d, e, f] 即 Canvas:
   * | a c e |
   * | b d f |
   * | 0 0 1 |
   */
  const M = {
    identity() { return [1, 0, 0, 1, 0, 0]; },

    translate(x, y) { return [1, 0, 0, 1, x, y]; },

    rotate(r) {
      const c = Math.cos(r), s = Math.sin(r);
      return [c, s, -s, c, 0, 0];
    },

    scale(sx, sy) { return [sx, 0, 0, sy, 0, 0]; },

    multiply(a, b) { // 结果 = a * b（先应用 b 再应用 a）
      return [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
      ];
    },

    compose(x, y, rotation, sx, sy) {
      const c = Math.cos(rotation), s = Math.sin(rotation);
      return [c * sx, s * sx, -s * sy, c * sy, x, y];
    },

    invert(m) {
      const [a, b, c, d, e, f] = m;
      const det = a * d - b * c;
      const id = 1 / det;
      return [
        d * id, -b * id, -c * id, a * id,
        (c * f - d * e) * id,
        (b * e - a * f) * id,
      ];
    },

    apply(m, p) {
      return {
        x: m[0] * p.x + m[2] * p.y + m[4],
        y: m[1] * p.x + m[3] * p.y + m[5],
      };
    },

    getTranslation(m) { return { x: m[4], y: m[5] }; },

    getRotation(m) {
      // 列向量基：x 轴为 (a, b)
      return Math.atan2(m[1], m[0]);
    },

    getScale(m) {
      const sx = Math.hypot(m[0], m[1]);
      const sy = Math.hypot(m[2], m[3]);
      return { sx, sy };
    },
  };

  /** 矩阵工具链：从局部 TRS 构建部件局部矩阵（部件挂在骨骼旋转节点上，用复合 R·T） */
  function localMatrix(t) {
    return M.compose(t.x, t.y, t.rotation, t.scaleX, t.scaleY);
  }

  /** 角度归一化到 [-PI, PI) */
  function normalizeAngle(r) {
    let a = r % TAU;
    if (a >= Math.PI) a -= TAU;
    if (a < -Math.PI) a += TAU;
    return a;
  }

  /** 最短路径角度插值，保证旋转连续 */
  function lerpAngle(a, b, t) {
    return a + normalizeAngle(b - a) * t;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function deg(r) { return r * DEG; }
  function rad(d) { return d / DEG; }

  /** 关键帧缓动函数，t ∈ [0,1]，均为单调函数，保证关键帧处连续 */
  const Easing = {
    linear: (t) => t,
    easeIn: (t) => t * t,
    easeOut: (t) => t * (2 - t),
    easeInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
    hold: (t) => (t >= 1 ? 1 : 0),
  };

  function ease(name, t) {
    return (Easing[name] || Easing.linear)(clamp(t, 0, 1));
  }

  global.Math2D = {
    TAU, V, M, localMatrix, normalizeAngle, lerpAngle,
    lerp, clamp, deg, rad, Easing, ease,
  };
})(window);
