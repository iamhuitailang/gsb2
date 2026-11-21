/*
 * geometry.js — 矩形与坐标基础工具（纯逻辑，无 DOM 依赖）
 * 所有业务矩形统一使用归一化坐标 {x,y,w,h}，取值 0..1，绑定原图；
 * 渲染/导出时再按原图像素尺寸反归一化。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.SCGeometry = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-6;

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function round4(v) {
    return Math.round(v * 10000) / 10000;
  }

  function roundRect(r, d) {
    const p = d == null ? 4 : d;
    const f = Math.pow(10, p);
    return {
      x: Math.round(r.x * f) / f,
      y: Math.round(r.y * f) / f,
      w: Math.round(r.w * f) / f,
      h: Math.round(r.h * f) / f,
    };
  }

  function area(r) {
    return Math.max(0, r.w) * Math.max(0, r.h);
  }

  function intersection(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.w, b.x + b.w);
    const bottom = Math.min(a.y + a.h, b.y + b.h);
    if (right <= x || bottom <= y) return null;
    return { x, y, w: right - x, h: bottom - y };
  }

  function intersectionArea(a, b) {
    const i = intersection(a, b);
    return i ? area(i) : 0;
  }

  function containsRect(outer, inner, eps) {
    const e = eps == null ? EPS : eps;
    return (
      inner.x >= outer.x - e &&
      inner.y >= outer.y - e &&
      inner.x + inner.w <= outer.x + outer.w + e &&
      inner.y + inner.h <= outer.y + outer.h + e
    );
  }

  function center(r) {
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** 像素矩形 -> 归一化 */
  function normalizeRect(r, imgW, imgH) {
    return {
      x: r.x / imgW,
      y: r.y / imgH,
      w: r.w / imgW,
      h: r.h / imgH,
    };
  }

  /** 归一化矩形 -> 像素矩形 */
  function denormalizeRect(r, imgW, imgH) {
    return {
      x: r.x * imgW,
      y: r.y * imgH,
      w: r.w * imgW,
      h: r.h * imgH,
    };
  }

  function rectFromPoints(x1, y1, x2, y2) {
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    return { x, y, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }

  /**
   * 保持矩形宽高不变，把位置夹进 bounds 内。
   * 若矩形比 bounds 大，则贴齐左上角并由调用方决定是否缩放。
   */
  function clampRectToBounds(r, bounds) {
    const x = clamp(r.x, bounds.x, Math.max(bounds.x, bounds.x + bounds.w - r.w));
    const y = clamp(r.y, bounds.y, Math.max(bounds.y, bounds.y + bounds.h - r.h));
    return { x, y, w: r.w, h: r.h };
  }

  function inflate(r, dx, dy) {
    return { x: r.x - dx, y: r.y - dy, w: r.w + dx * 2, h: r.h + dy * 2 };
  }

  function aspectOf(w, h) {
    return w / h;
  }

  /** 两个矩形是否近似相等（像素坐标，容差 0.5px） */
  function sameRect(a, b, tol) {
    const t = tol == null ? 0.5 : tol;
    return (
      Math.abs(a.x - b.x) <= t &&
      Math.abs(a.y - b.y) <= t &&
      Math.abs(a.w - b.w) <= t &&
      Math.abs(a.h - b.h) <= t
    );
  }

  return {
    EPS,
    clamp,
    lerp,
    round4,
    roundRect,
    area,
    intersection,
    intersectionArea,
    containsRect,
    center,
    distance,
    normalizeRect,
    denormalizeRect,
    rectFromPoints,
    clampRectToBounds,
    inflate,
    aspectOf,
    sameRect,
  };
});
