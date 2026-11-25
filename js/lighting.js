/*
 * lighting.js — 单灯渲染与多灯合成
 *
 * 每盏灯先独立计算遮挡、绘制到自己的离屏画布，
 * 再按选定的合成方式叠加到主画布：关掉任意一盏只是跳过它的离屏层，
 * 其他灯的结果逐像素保持不变。
 */
(function (root, factory) {
  root.Lighting = factory(root.Geometry);
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Lighting;
})(typeof window !== 'undefined' ? window : globalThis, function (Geom) {
  'use strict';

  const CIRCLE_EPS = 1e-6;

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#ffffff');
    if (!m) return { r: 255, g: 255, b: 255 };
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }

  function rgba(c, a) {
    return `rgba(${c.r},${c.g},${c.b},${Math.max(0, Math.min(1, a))})`;
  }

  /*
   * 把可见多边形转成画布路径。
   * 连续的“半径边缘顶点”之间用 arc() 补真正的圆弧，
   * 否则逐点连线会在半径圈上拉出折线、产生穿光的缺口或亮角。
   */
  function buildLightPath(ctx, origin, polygon) {
    // 多边形首顶点是灯自身（扇形中心），路径只使用按极角排序的外圈顶点
    const ring = polygon.filter(p => !p.isOrigin);
    if (!ring || ring.length < 3) return false;

    const radius = polygonRadius(ring);
    const pts = ring.map(p => ({
      x: p.x, y: p.y, angle: p.angle, dist: p.dist,
      onCircle: p.onCircle || Math.abs(p.dist - radius) < CIRCLE_EPS,
    }));
    // 极角展开成单调递增，处理 -π/π 环绕
    for (let i = 1; i < pts.length; i++) {
      while (pts[i].angle < pts[i - 1].angle) pts[i].angle += 2 * Math.PI;
    }

    const first = pts[0];
    const last = pts[pts.length - 1];
    // 首尾都在圆周上时补一个绕 2π 的点，让圆弧跨过角度环绕处闭合
    const wrap = (first.onCircle && last.onCircle)
      ? [{ x: first.x, y: first.y, angle: first.angle + 2 * Math.PI, dist: first.dist, onCircle: true }]
      : [];
    const seq = pts.concat(wrap);

    ctx.beginPath();
    ctx.moveTo(seq[0].x, seq[0].y);
    for (let i = 1; i < seq.length; i++) {
      const prev = seq[i - 1];
      const cur = seq[i];
      if (prev.onCircle && cur.onCircle) {
        ctx.arc(origin.x, origin.y, cur.dist, prev.angle, cur.angle, false);
      } else {
        ctx.lineTo(cur.x, cur.y);
      }
    }
    ctx.closePath();
    return true;
  }

  function polygonRadius(polygon) {
    // 取出现次数最多的距离作为半径（圆周顶点的 dist 都相等）
    const counts = new Map();
    let best = 0, bestR = polygon[0].dist;
    for (const p of polygon) {
      const key = p.dist.toFixed(3);
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      if (n > best) { best = n; bestR = p.dist; }
    }
    return bestR;
  }

  /* 渲染单灯离屏层（径向渐变 + 可见多边形裁剪） */
  function renderLightLayer(light, polygon, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (!polygon || polygon.filter(p => !p.isOrigin).length < 3) return canvas;

    ctx.save();
    if (buildLightPath(ctx, light, polygon)) {
      ctx.clip();
      const color = hexToRgb(light.color);
      const grad = ctx.createRadialGradient(
        light.x, light.y, 0,
        light.x, light.y, light.radius
      );
      // 中心亮度由强度决定，边缘线性衰减到 0；强度可 >1（加法混合下过曝）
      grad.addColorStop(0, rgba(color, light.intensity));
      grad.addColorStop(0.55, rgba(color, light.intensity * 0.45));
      grad.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.restore();
    return canvas;
  }

  /* 合成方式：加法 / 取亮(近似 max) / 普通透明叠加 */
  const COMPOSITE_OPS = {
    additive: { op: 'lighter', label: '加法叠加（lighter）' },
    lighten: { op: 'lighten', label: '取亮混合（lighten，近似 max）' },
    normal: { op: 'source-over', label: '普通透明叠加（alpha）' },
  };

  function compositeLayer(targetCtx, layer, mode) {
    targetCtx.save();
    targetCtx.globalCompositeOperation = (COMPOSITE_OPS[mode] || COMPOSITE_OPS.additive).op;
    targetCtx.drawImage(layer, 0, 0);
    targetCtx.restore();
  }

  return {
    hexToRgb, rgba, buildLightPath, renderLightLayer,
    compositeLayer, COMPOSITE_OPS,
  };
});
