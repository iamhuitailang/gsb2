/* 通用工具：命名空间、数学、DOM、下载 */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});

  const util = {
    uid(prefix) {
      return (
        (prefix || 'id') +
        '_' +
        Date.now().toString(36) +
        Math.random().toString(36).slice(2, 8)
      );
    },

    clamp(v, min, max) {
      return v < min ? min : v > max ? max : v;
    },

    lerp(a, b, t) {
      return a + (b - a) * t;
    },

    deepClone(obj) {
      return JSON.parse(JSON.stringify(obj));
    },

    /** 接近相等（关键帧命中用） */
    near(a, b, eps) {
      return Math.abs(a - b) <= (eps == null ? 1e-6 : eps);
    },

    /** 帧吸附 */
    snapTime(t, fps, enabled) {
      if (!enabled) return Math.max(0, t);
      return Math.round(t * fps) / fps;
    },

    formatTime(t, fps) {
      t = Math.max(0, t);
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      const cs = Math.floor((t * 100) % 100);
      const mm = String(m).padStart(2, '0');
      const ss = String(s).padStart(2, '0');
      const cc = String(cs).padStart(2, '0');
      return `${mm}:${ss}.${cc}`;
    },

    formatFrameTime(t, fps) {
      const frame = Math.round(t * fps);
      return `第 ${frame} 帧`;
    },

    /** 触发浏览器下载（Blob / 文本） */
    downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    },

    downloadText(text, filename, mime) {
      util.downloadBlob(new Blob([text], { type: mime || 'application/json' }), filename);
    },

    readFileAsText(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsText(file);
      });
    },

    readFileAsDataURL(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
    },

    loadImage(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = src;
      });
    },

    /** 等待若干毫秒（导出时让出主线程刷新进度） */
    tick(ms) {
      return new Promise((r) => setTimeout(r, ms == null ? 0 : ms));
    },

    /** 简洁的 DOM 创建：h('div', {class:'x', onclick}, '文本'|node|[...]) */
    h(tag, props, children) {
      const el = document.createElement(tag);
      if (props) {
        for (const k in props) {
          const v = props[k];
          if (v == null || v === false) continue;
          if (k === 'class' || k === 'className') el.className = v;
          else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
          else if (k.startsWith('on') && typeof v === 'function') {
            el.addEventListener(k.slice(2).toLowerCase(), v);
          } else if (k === 'dataset') {
            Object.assign(el.dataset, v);
          } else if (k in el && k !== 'list' && typeof v !== 'object') {
            try { el[k] = v; } catch (e) { el.setAttribute(k, v); }
          } else {
            el.setAttribute(k, v === true ? '' : v);
          }
        }
      }
      if (children != null) {
        const arr = Array.isArray(children) ? children : [children];
        for (const c of arr) {
          if (c == null || c === false) continue;
          el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(c) : c);
        }
      }
      return el;
    },

    /** 颜色 hex/rgba 处理 */
    withAlpha(hex, alpha) {
      if (!hex || hex[0] !== '#' || hex.length < 7) return hex;
      const n = parseInt(hex.slice(1, 7), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    },
  };

  G.util = util;
})();
