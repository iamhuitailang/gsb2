/**
 * assets.js — 自带素材：纯 Canvas 矢量绘制，无任何外部文件
 *
 * 背景：纯白 / 纯深 / 渐变演示底（左白、右亮暗渐变）/ 棋盘格
 * 提示：圆形、菱形、方形、三角，2x 超采样抗锯齿，天然带 0<alpha<255 的软边
 */
(function (root, factory) {
  const C = (typeof require === 'function') ? require('./color') : root.C;
  const api = factory(C);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Assets = api;
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  function makeCanvas(W, H) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    return c;
  }

  // ---------------- 背景 ----------------
  function backgroundSolid(W, H, hex) {
    const c = makeCanvas(W, H), ctx = c.getContext('2d');
    ctx.fillStyle = hex; ctx.fillRect(0, 0, W, H);
    return c;
  }

  /** 演示底：左半纯白（纯色底合格区），右半亮暗+色相渐变（挪过去后局部难分） */
  function backgroundDemo(W, H) {
    const c = makeCanvas(W, H), ctx = c.getContext('2d');
    const half = Math.round(W / 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, half, H);
    const g = ctx.createLinearGradient(half, 0, W, H);
    g.addColorStop(0.0, '#e8f2c0'); // 浅黄绿
    g.addColorStop(0.32, '#7f9a4a'); // 橄榄绿（红/绿提示在此易融）
    g.addColorStop(0.52, '#d14f47'); // 砖红：与红圆主色 ΔE≈3，压上去局部难分
    g.addColorStop(0.72, '#b58a3e'); // 土黄
    g.addColorStop(1.0, '#2e3550');  // 深蓝暗角
    ctx.fillStyle = g;
    ctx.fillRect(half, 0, W - half, H);
    // 一条亮带，模拟关卡里局部高光
    const band = ctx.createLinearGradient(0, H * 0.15, 0, H * 0.55);
    band.addColorStop(0, 'rgba(255,255,255,0)');
    band.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    band.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = band;
    ctx.fillRect(half, 0, W - half, H);
    return c;
  }

  function backgroundChecker(W, H, cell) {
    const c = makeCanvas(W, H), ctx = c.getContext('2d');
    cell = cell || 24;
    for (let y = 0; y < H; y += cell) {
      for (let x = 0; x < W; x += cell) {
        ctx.fillStyle = ((x / cell + y / cell) % 2 === 0) ? '#f2f2f2' : '#c9c9c9';
        ctx.fillRect(x, y, cell, cell);
      }
    }
    return c;
  }

  function createBackground(type, W, H) {
    switch (type) {
      case 'white': return backgroundSolid(W, H, '#ffffff');
      case 'dark': return backgroundSolid(W, H, '#2b2f38');
      case 'checker': return backgroundChecker(W, H);
      case 'demo':
      default: return backgroundDemo(W, H);
    }
  }

  // ---------------- 提示图标（2x 超采样） ----------------
  const SHAPES = ['circle', 'diamond', 'square', 'triangle'];

  function shapePath(ctx, shape, size) {
    const m = size * 0.08; // 留边，避免超采样边缘被裁
    const s = size - m * 2;
    ctx.beginPath();
    switch (shape) {
      case 'circle':
        ctx.arc(size / 2, size / 2, s / 2, 0, Math.PI * 2);
        break;
      case 'square':
        ctx.rect(m, m, s, s);
        break;
      case 'diamond':
        ctx.moveTo(size / 2, m);
        ctx.lineTo(size - m, size / 2);
        ctx.lineTo(size / 2, size - m);
        ctx.lineTo(m, size / 2);
        ctx.closePath();
        break;
      case 'triangle':
        ctx.moveTo(size / 2, m);
        ctx.lineTo(size - m, size - m);
        ctx.lineTo(m, size - m);
        ctx.closePath();
        break;
    }
  }

  /**
   * 绘制提示图
   * @param opts {shape, fill, size, symbol:'none'|'plus'|'ring'|'dot'|'bar',
   *              symbolColor, border, borderColor, hueDeg, satScale}
   */
  function drawIcon(opts) {
    const size = opts.size || 96;
    const SS = 2;
    const c = makeCanvas(size, size);
    const ctx = c.getContext('2d');
    ctx.scale(SS, SS);
    const s = size / SS;

    // 轻微立体造型：同色明暗渐变（保留色相，产生明暗边缘像素）
    const base = C.hexToRgb(opts.fill || '#e0443e');
    const light = C.rgbToHex(...shade(base, 1.25));
    const dark = C.rgbToHex(...shade(base, 0.72));
    const grad = ctx.createLinearGradient(0, 0, s, s);
    grad.addColorStop(0, light);
    grad.addColorStop(1, dark);

    shapePath(ctx, opts.shape || 'circle', s);
    ctx.fillStyle = grad;
    ctx.fill();

    if (opts.border) {
      shapePath(ctx, opts.shape || 'circle', s);
      ctx.lineWidth = Math.max(2, s * 0.07);
      ctx.strokeStyle = opts.borderColor || '#ffffff';
      ctx.stroke();
    }

    // 附加符号（用于“颜色不够、符号来凑”的对比实验）
    if (opts.symbol && opts.symbol !== 'none') {
      ctx.fillStyle = opts.symbolColor || '#ffffff';
      ctx.strokeStyle = opts.symbolColor || '#ffffff';
      const cx = s / 2, cy = s / 2, t = s * 0.28, w = Math.max(2.5, s * 0.09);
      ctx.lineWidth = w; ctx.lineCap = 'round';
      switch (opts.symbol) {
        case 'plus':
          ctx.beginPath();
          ctx.moveTo(cx - t, cy); ctx.lineTo(cx + t, cy);
          ctx.moveTo(cx, cy - t); ctx.lineTo(cx, cy + t);
          ctx.stroke();
          break;
        case 'ring':
          ctx.beginPath();
          ctx.arc(cx, cy, t, 0, Math.PI * 2);
          ctx.lineWidth = w;
          ctx.stroke();
          break;
        case 'dot':
          ctx.beginPath();
          ctx.arc(cx, cy, t * 0.7, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'bar':
          ctx.beginPath();
          ctx.moveTo(cx - t, cy + t * 0.9);
          ctx.lineTo(cx + t, cy + t * 0.9);
          ctx.stroke();
          break;
      }
    }
    return c;
  }

  function shade(rgb, k) {
    return [rgb.r, rgb.g, rgb.b].map(v => C.clamp255(v * k));
  }

  /** 对已绘制的图标整体做 Lab 色相旋转，返回新 canvas（alpha 保持） */
  function recolorIcon(sourceCanvas, hueDeg, satScale) {
    const W = sourceCanvas.width, H = sourceCanvas.height;
    const src = sourceCanvas.getContext('2d').getImageData(0, 0, W, H);
    const out = makeCanvas(W, H);
    const dst = out.getContext('2d').createImageData(W, H);
    for (let i = 0; i < src.data.length; i += 4) {
      const a = src.data[i + 3];
      if (a === 0) { dst.data[i + 3] = 0; continue; }
      const c = C.rotateHueRGBA(src.data[i], src.data[i + 1], src.data[i + 2], hueDeg, satScale);
      dst.data[i] = C.clamp255(c.r);
      dst.data[i + 1] = C.clamp255(c.g);
      dst.data[i + 2] = C.clamp255(c.b);
      dst.data[i + 3] = a;
    }
    out.getContext('2d').putImageData(dst, 0, 0);
    return out;
  }

  /** 内置默认图标集（红/绿是一组红绿色盲易混色） */
  function defaultIconSet() {
    return [
      { name: '红圆', shape: 'circle', fill: '#e0443e', symbol: 'none' },
      { name: '绿菱', shape: 'diamond', fill: '#3f9d4d', symbol: 'none' },
      { name: '蓝方', shape: 'square', fill: '#3a6fe0', symbol: 'none' },
      { name: '橙三角', shape: 'triangle', fill: '#e8892a', symbol: 'none' },
    ];
  }

  return {
    SHAPES, makeCanvas,
    createBackground, backgroundDemo,
    drawIcon, recolorIcon, defaultIconSet, shade,
  };
});
