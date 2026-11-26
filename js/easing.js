/* 缓动函数：全部满足 f(0)=0, f(1)=1，保证关键帧边界连续 */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});

  const Easing = {
    linear: { label: '线性', fn: (t) => t },

    easeInQuad: { label: '缓入 · 二次', fn: (t) => t * t },
    easeOutQuad: { label: '缓出 · 二次', fn: (t) => 1 - (1 - t) * (1 - t) },
    easeInOutQuad: {
      label: '缓入缓出 · 二次',
      fn: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    },

    easeInCubic: { label: '缓入', fn: (t) => t * t * t },
    easeOutCubic: {
      label: '缓出',
      fn: (t) => 1 - Math.pow(1 - t, 3),
    },
    easeInOutCubic: {
      label: '缓入缓出',
      fn: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    },

    easeOutBack: {
      label: '回弹出场',
      fn(t) {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
      },
    },
    easeInBack: {
      label: '回弹进场(反向)',
      fn(t) {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return c3 * t * t * t - c1 * t * t;
      },
    },
    easeOutElastic: {
      label: '弹性',
      fn(t) {
        const c4 = (2 * Math.PI) / 3;
        if (t === 0 || t === 1) return t;
        return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
      },
    },
  };

  /** 下拉选项（顺序即展示顺序） */
  Easing.options = [
    'linear',
    'easeOutCubic',
    'easeInCubic',
    'easeInOutCubic',
    'easeOutQuad',
    'easeInQuad',
    'easeInOutQuad',
    'easeOutBack',
    'easeInBack',
    'easeOutElastic',
  ];

  G.Easing = Easing;
})();
