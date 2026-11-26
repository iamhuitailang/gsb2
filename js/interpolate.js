/* 关键帧采样：同一时刻左右区间在关键帧上取到完全相同的值，杜绝跳变 */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});
  const { lerp } = G.util;
  const Easing = G.Easing;

  /**
   * 在一条关键帧轨道上采样。
   * keys 已按 t 升序；每个关键帧除 t/ease 外携带数值字段。
   * fields: ['x','y'] 等；base: 无关键帧时的静态值对象。
   */
  function sampleTrack(keys, fields, base, t) {
    if (!keys || keys.length === 0) {
      const b = {};
      fields.forEach((f) => (b[f] = base[f]));
      return b;
    }
    if (t <= keys[0].t) {
      const o = {};
      fields.forEach((f) => (o[f] = keys[0][f]));
      return o;
    }
    if (t >= keys[keys.length - 1].t) {
      const last = keys[keys.length - 1];
      const o = {};
      fields.forEach((f) => (o[f] = last[f]));
      return o;
    }
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const span = b.t - a.t;
    const p = span > 1e-9 ? (t - a.t) / span : 1;
    const ease = (Easing[a.ease] && Easing[a.ease].fn) || Easing.linear.fn;
    const e = ease(p);
    const o = {};
    fields.forEach((f) => (o[f] = lerp(a[f], b[f], e)));
    return o;
  }

  /** 计算某图层在 t 秒的完整变换状态 */
  function sampleLayer(layer, t) {
    const k = layer.keys || {};
    const pos = sampleTrack(k.position, ['x', 'y'], { x: layer.x, y: layer.y }, t);
    const scl = sampleTrack(k.scale, ['sx', 'sy'], { sx: layer.scaleX, sy: layer.scaleY }, t);
    const siz = sampleTrack(k.size, ['w', 'h'], { w: layer.w, h: layer.h }, t);
    const rot = sampleTrack(k.rotation, ['v'], { v: layer.rotation }, t);
    const opa = sampleTrack(k.opacity, ['v'], { v: layer.opacity }, t);
    return {
      x: pos.x,
      y: pos.y,
      scaleX: scl.sx,
      scaleY: scl.sy,
      w: Math.max(0.01, siz.w),
      h: Math.max(0.01, siz.h),
      rotation: rot.v,
      opacity: Math.max(0, Math.min(100, opa.v)),
    };
  }

  /** 图层在该时刻是否处于片段范围内（in/out 之外不渲染） */
  function isActiveAt(layer, t) {
    const inn = layer.in || 0;
    const out = layer.out == null ? Infinity : layer.out;
    return t >= inn - 1e-6 && t <= out + 1e-6;
  }

  G.Interpolate = { sampleTrack, sampleLayer, isActiveAt };
})();
