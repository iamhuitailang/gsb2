/* 通用数学与几何工具 */
'use strict';

const Util = {
  clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; },
  lerp(a, b, t) { return a + (b - a) * t; },
  dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); },

  // 角度插值（处理 ±π 环绕）
  lerpAngle(a, b, t) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  },

  // 线段 p1->p2 与 p3->p4 是否相交（严格相交，不含端点共线）
  segmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
    const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
    if (Math.abs(d) < 1e-12) return false;
    const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
    const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
    return t > 0 && t < 1 && u > 0 && u < 1;
  },

  pointInCircle(px, py, cx, cy, r) {
    return Util.dist(px, py, cx, cy) <= r;
  },

  // 点到线段距离（用于墙体点击拾取）
  distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Util.clamp(t, 0, 1);
    return Util.dist(px, py, x1 + t * dx, y1 + t * dy);
  },

  uid() {
    return 'id_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
  },

  download(filename, text, mime) {
    const blob = text instanceof Blob ? text : new Blob([text], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
  },
};
