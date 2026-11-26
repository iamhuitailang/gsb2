/**
 * render.js — 浏览器端渲染层
 *
 * 所有分析都基于真实合成后的 ImageData 像素；视图模式只对合成结果做转换，
 * 不重新摆放图标，因此切换正常/色盲模拟/灰度时位置与尺寸完全不变。
 */
(function (root, factory) {
  const C = (typeof require === 'function') ? require('./color') : root.C;
  const Geo = (typeof require === 'function') ? require('./geometry') : root.Geo;
  const Analysis = (typeof require === 'function') ? require('./analysis') : root.Analysis;
  const Assets = (typeof require === 'function') ? require('./assets') : root.Assets;
  const api = factory(C, Geo, Analysis, Assets);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Render = api;
})(typeof self !== 'undefined' ? self : this, function (C, Geo, Analysis, Assets) {
  'use strict';

  const VIEW_MODES = [
    { id: 'normal', label: '正常画面' },
    { id: 'protan', label: '红色盲模拟（甲型）' },
    { id: 'deutan', label: '绿色盲模拟（乙型）' },
    { id: 'tritan', label: '蓝黄色弱模拟（附加）' },
    { id: 'gray', label: '灰度画面' },
  ];

  class Scene {
    constructor(canvas, W, H) {
      this.canvas = canvas;
      this.W = W; this.H = H;
      canvas.width = W; canvas.height = H;
      this.ctx = canvas.getContext('2d');
      this.bg = null;
      this.icons = [];
      this.seq = 1;
      this.mode = 'normal';
      this.overlay = null;      // {type:'heat'|'alpha'|'scan', ...}
      this._frameCache = null;
    }

    setBackground(bgCanvas) {
      this.bg = bgCanvas;
      this._frameCache = null;
    }

    addIcon(sourceCanvas, name) {
      const maxH = Math.round(this.H * 0.32);
      const scale = maxH / sourceCanvas.height;
      const w = Math.round(sourceCanvas.width * scale);
      const h = maxH;
      const icon = {
        id: 'icon' + (this.seq++),
        name: name || ('提示 ' + this.seq),
        src: sourceCanvas,
        x: Math.round(this.W * 0.12 + (this.icons.length % 3) * 40),
        y: Math.round(this.H * 0.34),
        w, h,
        tintHue: 0, tintSat: 1,
        symbol: 'none', symbolColor: '#ffffff',
        border: false, borderColor: '#ffffff',
      };
      this.icons.push(icon);
      this._frameCache = null;
      return icon;
    }

    removeIcon(id) {
      this.icons = this.icons.filter(i => i.id !== id);
      this._frameCache = null;
    }

    bump() { this._frameCache = null; }

    /** 当前生效的图标位图（应用改色后缓存于 srcTinted） */
    effectiveCanvas(icon) {
      const key = icon.tintHue + '|' + icon.tintSat;
      if (!icon._tintKey || icon._tintKey !== key) {
        icon._tintKey = key;
        icon._tinted = (icon.tintHue === 0 && icon.tintSat === 1)
          ? icon.src
          : Assets.recolorIcon(icon.src, icon.tintHue, icon.tintSat);
      }
      return icon._tinted;
    }

    /**
     * 合成一帧。
     * @param hideId 隐藏某图（两提示单独合成时使用）
     * @returns {{frame:ImageData, alphaOf:Map<id,Uint8ClampedArray>, coveredOf:Map<id,Uint8Array>}}
     */
    composite(hideIds) {
      const hide = new Set(Array.isArray(hideIds) ? hideIds : (hideIds ? [hideIds] : []));
      const { W, H } = this;
      const frame = this.ctx.createImageData(W, H);
      // 1) 背景
      if (this.bg) {
        const bgd = this.bg.getContext('2d').getImageData(0, 0, W, H).data;
        frame.data.set(bgd);
      } else {
        frame.data.fill(255);
      }
      const alphaOf = new Map();
      const coveredOf = new Map();

      for (const icon of this.icons) {
        if (hide.has(icon.id)) continue;
        const buf = this._drawIconBuffer(icon); // 画面尺寸的透明 ImageData
        alphaOf.set(icon.id, buf.data.filter((_, i) => i % 4 === 3));
        const covered = new Uint8Array(W * H);
        for (let p = 0; p < W * H; p++) {
          if (buf.data[p * 4 + 3] > Geo.ALPHA_EDGE_LO) covered[p] = 1;
        }
        coveredOf.set(icon.id, covered);
        alphaOver(frame.data, buf.data);
      }
      return { frame, alphaOf, coveredOf };
    }

    /** 把单个图标按当前位置尺寸画到与画面同尺寸的透明缓冲上 */
    _drawIconBuffer(icon) {
      const { W, H } = this;
      const buf = this.ctx.createImageData(W, H);
      const c = Assets.makeCanvas(icon.w, icon.h);
      const cctx = c.getContext('2d');
      cctx.drawImage(this.effectiveCanvas(icon), 0, 0, icon.w, icon.h);
      // 描边与符号在最终尺寸上叠加
      this._decorate(cctx, icon);
      const piece = c.getContext('2d').getImageData(0, 0, icon.w, icon.h);
      for (let y = 0; y < icon.h; y++) {
        const fy = icon.y + y;
        if (fy < 0 || fy >= H) continue;
        for (let x = 0; x < icon.w; x++) {
          const fx = icon.x + x;
          if (fx < 0 || fx >= W) continue;
          const si = (y * icon.w + x) * 4;
          const di = (fy * W + fx) * 4;
          buf.data[di] = piece.data[si];
          buf.data[di + 1] = piece.data[si + 1];
          buf.data[di + 2] = piece.data[si + 2];
          buf.data[di + 3] = piece.data[si + 3];
        }
      }
      return buf;
    }

    _decorate(ctx, icon) {
      if (icon.border) {
        ctx.lineWidth = Math.max(3, icon.w * 0.08);
        ctx.strokeStyle = icon.borderColor;
        ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2,
          icon.w - ctx.lineWidth, icon.h - ctx.lineWidth);
      }
      if (icon.symbol && icon.symbol !== 'none') {
        const cx = icon.w / 2, cy = icon.h / 2;
        const t = icon.w * 0.26, w = Math.max(4, icon.w * 0.1);
        ctx.strokeStyle = icon.symbolColor;
        ctx.fillStyle = icon.symbolColor;
        ctx.lineWidth = w; ctx.lineCap = 'round';
        ctx.beginPath();
        switch (icon.symbol) {
          case 'plus':
            ctx.moveTo(cx - t, cy); ctx.lineTo(cx + t, cy);
            ctx.moveTo(cx, cy - t); ctx.lineTo(cx, cy + t);
            break;
          case 'ring':
            ctx.arc(cx, cy, t, 0, Math.PI * 2);
            break;
          case 'dot':
            ctx.arc(cx, cy, t * 0.7, 0, Math.PI * 2);
            break;
          case 'bar':
            ctx.moveTo(cx - t, cy + t * 0.9);
            ctx.lineTo(cx + t, cy + t * 0.9);
            break;
        }
        if (icon.symbol === 'dot') ctx.fill(); else ctx.stroke();
      }
    }

    /** 视图模式转换后的帧（带缓存） */
    transformedFrame(mode, hideId) {
      const { frame } = this.composite(hideId);
      if (mode === 'normal') return frame;
      const out = this.ctx.createImageData(this.W, this.H);
      out.data.set(C.transformFrame(frame.data, mode));
      return out;
    }

    /** 主绘制：合成 -> 视图转换 -> 叠加层 */
    render() {
      const mode = this.mode;
      const img = this.transformedFrame(mode);
      this.ctx.putImageData(img, 0, 0);
      if (this.overlay) this._renderOverlay();
      this._drawSelection();
    }

    _renderOverlay() {
      const ov = this.overlay;
      if (ov.type === 'heat') this._heatOverlay(ov.heat, ov.valid, ov.alpha);
      if (ov.type === 'pairHeat') this._heatOverlay(ov.heat, ov.valid, ov.alpha);
      if (ov.type === 'alpha') this._alphaOverlay(ov.alphaOf);
      if (ov.type === 'scan') this._scanOverlay(ov);
    }

    /** 色差热力：蓝(低)→黄→红(高)，低色差区域即“难分”区 */
    _heatOverlay(heat, valid, alpha) {
      const { W, H } = this;
      const img = this.ctx.getImageData(0, 0, W, H);
      const d = img.data;
      for (let p = 0; p < W * H; p++) {
        if (!valid || !valid[p]) continue;
        const t = Math.min(1, heat[p] / 25);
        const [hr, hg, hb] = heatColor(t);
        const k = (alpha == null ? 0.55 : alpha);
        const i = p * 4;
        d[i] = d[i] * (1 - k) + hr * k;
        d[i + 1] = d[i + 1] * (1 - k) + hg * k;
        d[i + 2] = d[i + 2] * (1 - k) + hb * k;
      }
      this.ctx.putImageData(img, 0, 0);
    }

    /** alpha 分类叠加：绿=不透明，橙=半透明边缘，紫=全透明区 */
    _alphaOverlay(alphaOf) {
      const { W, H } = this;
      const img = this.ctx.getImageData(0, 0, W, H);
      const d = img.data;
      for (const [, alpha] of alphaOf) {
        for (let p = 0; p < W * H; p++) {
          const a = alpha[p];
          if (a <= Geo.ALPHA_EDGE_LO) continue;
          const cls = Geo.alphaClass(a);
          const col = cls === 'full' ? [46, 204, 113] : [241, 156, 42];
          const i = p * 4, k = 0.5;
          d[i] = d[i] * (1 - k) + col[0] * k;
          d[i + 1] = d[i + 1] * (1 - k) + col[1] * k;
          d[i + 2] = d[i + 2] * (1 - k) + col[2] * k;
        }
      }
      // 全透明区（图标包围盒内 alpha=0）：紫色斜纹描点
      this.ctx.save();
      this.ctx.globalAlpha = 0.55;
      this.ctx.fillStyle = '#9b59d0';
      for (const icon of this.icons) {
        const alpha = alphaOf.get(icon.id);
        for (let y = icon.y; y < icon.y + icon.h; y += 6) {
          for (let x = icon.x; x < icon.x + icon.w; x += 6) {
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            if (alpha[y * W + x] <= Geo.ALPHA_EDGE_LO) this.ctx.fillRect(x, y, 2, 2);
          }
        }
      }
      this.ctx.restore();
    }

    _scanOverlay(ov) {
      const { grid, cols, rows, step, hardest } = ov;
      const { ctx } = this;
      ctx.save();
      for (let k = 0; k < grid.length; k++) {
        const gx = k % cols, gy = Math.floor(k / cols);
        const x = gx * step, y = gy * step;
        const t = Math.min(1, grid[k] / 25);
        const [r, g, b] = heatColor(t);
        ctx.fillStyle = `rgba(${r},${g},${b},0.35)`;
        ctx.fillRect(x, y, step, step);
      }
      // 最难位置红框
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ff2d55';
      ctx.strokeRect(hardest.x - 1, hardest.y - 1, ov.iconW + 2, ov.iconH + 2);
      ctx.restore();
    }

    _drawSelection() {
      const sel = this.icons.find(i => i.id === this.selectedId);
      if (!sel) return;
      this.ctx.save();
      this.ctx.strokeStyle = '#2f80ed';
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash([6, 4]);
      this.ctx.strokeRect(sel.x - 2, sel.y - 2, sel.w + 4, sel.h + 4);
      this.ctx.setLineDash([]);
      // 右下角缩放柄
      this.ctx.fillStyle = '#2f80ed';
      this.ctx.fillRect(sel.x + sel.w - 5, sel.y + sel.h - 5, 10, 10);
      this.ctx.restore();
    }

    hitTest(x, y) {
      for (let i = this.icons.length - 1; i >= 0; i--) {
        const ic = this.icons[i];
        if (x >= ic.x && x <= ic.x + ic.w && y >= ic.y && y <= ic.y + ic.h) {
          const handle = x >= ic.x + ic.w - 12 && y >= ic.y + ic.h - 12;
          return { icon: ic, handle };
        }
      }
      return null;
    }

    /** 供扫描使用：把指定图标临时放到 x,y 合成，返回转换后帧与逐像素 alpha */
    renderProbe(iconId, x, y, mode) {
      const target = this.icons.find(i => i.id === iconId);
      const saved = { x: target.x, y: target.y };
      const others = this.icons.filter(i => i.id !== iconId).map(i => i.id);
      target.x = x; target.y = y;
      const { frame, alphaOf } = this.composite(others);
      target.x = saved.x; target.y = saved.y;
      const data = mode === 'normal' ? frame.data : C.transformFrame(frame.data, mode);
      return {
        frame: data,
        iconAlpha: (() => {
          const a = alphaOf.get(iconId);
          const out = new Uint8ClampedArray(target.w * target.h);
          for (let yy = 0; yy < target.h; yy++) {
            for (let xx = 0; xx < target.w; xx++) {
              const fx = x + xx, fy = y + yy;
              out[yy * target.w + xx] =
                (fx < 0 || fy < 0 || fx >= this.W || fy >= this.H) ? 0 : a[fy * this.W + fx];
            }
          }
          return out;
        })(),
      };
    }
  }

  /** Porter-Duff source-over（in-place 到 dst） */
  function alphaOver(dst, src) {
    for (let i = 0; i < dst.length; i += 4) {
      const sa = src[i + 3] / 255;
      if (sa === 0) continue;
      const da = dst[i + 3] / 255;
      const oa = sa + da * (1 - sa);
      if (oa === 0) continue;
      for (let k = 0; k < 3; k++) {
        dst[i + k] = (src[i + k] * sa + dst[i + k] * da * (1 - sa)) / oa;
      }
      dst[i + 3] = oa * 255;
    }
  }

  /** t:0 低色差(蓝) → 0.5 黄 → 1 高色差(红) */
  function heatColor(t) {
    const stops = [
      [0.0, 38, 92, 211],   // 蓝
      [0.5, 242, 201, 76],  // 黄
      [1.0, 224, 49, 49],   // 红
    ];
    for (let s = 0; s < stops.length - 1; s++) {
      const [t0, r0, g0, b0] = stops[s];
      const [t1, r1, g1, b1] = stops[s + 1];
      if (t <= t1) {
        const u = (t - t0) / (t1 - t0);
        return [
          Math.round(r0 + (r1 - r0) * u),
          Math.round(g0 + (g1 - g0) * u),
          Math.round(b0 + (b1 - b0) * u),
        ];
      }
    }
    return stops[stops.length - 1].slice(1);
  }

  return { Scene, VIEW_MODES, alphaOver, heatColor };
});
