/* core.js — 通用数值工具（浏览器与 Node 共用，无 DOM 依赖） */
(function (global) {
  'use strict';

  /** Rec.709 相对亮度，输入 0–255 的 sRGB 分量，输出 0–255 尺度 */
  function luminance(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** 平滑阶跃：x<=0 → 0，x>=1 → 1，中间为 3t²-2t³（C1 连续，接缝处导数连续） */
  function smoothstep(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** 无排序中位数；会复制数组，不修改入参 */
  function median(arr) {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) * 0.5;
  }

  /** 中位数绝对偏差（MAD），换算成与标准差同尺度（×1.4826） */
  function mad(arr, med) {
    if (med === undefined) med = median(arr);
    const dev = arr.map((v) => Math.abs(v - med));
    return 1.4826 * median(dev);
  }

  /** 分位数（q 取 0–1），不修改入参 */
  function quantile(arr, q) {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    const pos = (a.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    return a[base + 1] !== undefined
      ? a[base] + rest * (a[base + 1] - a[base])
      : a[base];
  }

  function mean(arr) {
    if (!arr.length) return 0;
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }

  /**
   * 像素缓冲：统一 Uint8ClampedArray 访问。
   * 浏览器可直接传 ImageData；Node 测试传 { data, width, height }。
   */
  function makeBuffer(width, height) {
    return { data: new Uint8ClampedArray(width * height * 4), width, height };
  }

  function idx(x, y, width) {
    return (y * width + x) * 4;
  }

  /** 环形索引：把越界坐标绕回 [0, size)，用于“平铺世界”采样 */
  function wrap(v, size) {
    v = v % size;
    if (v < 0) v += size;
    return v;
  }

  function copyBuffer(buf) {
    return { data: new Uint8ClampedArray(buf.data), width: buf.width, height: buf.height };
  }

  const api = {
    luminance, smoothstep, clamp, median, mad, quantile, mean, round3,
    makeBuffer, idx, wrap, copyBuffer,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.SeamCore = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
