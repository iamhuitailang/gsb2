/*
 * render.js — 三种视图的 Canvas 绘制与命中检测
 *  normal：正常画面（按 computeOrder 的结果从后往前画）
 *  footprint：占地区域（只看地面格子、base 与 z 区间，不看高度透视）
 *  order：绘制顺序（半透明体块 + 顺序编号 + 冲突标记）
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.OcclRender = factory(root.OcclCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2',
    '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac', '#d9534f'];

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) + amt, g = ((n >> 8) & 255) + amt, b = (n & 255) + amt;
    r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function poly(ctx, pts, fill, stroke, lw) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
  }

  function diamondAt(cx, cy, z, scene) {
    const g = scene.grid;
    return [
      C.iso(cx, cy, z, g), C.iso(cx + 1, cy, z, g),
      C.iso(cx + 1, cy + 1, z, g), C.iso(cx, cy + 1, z, g),
    ];
  }

  function pointInDiamond(p, d) {
    // 菱形 = 4 个半平面，逐边同侧判定
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = d[i], b = d[(i + 1) % 4];
      const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  }

  function cellEdges(cells) {
    const set = new Set(cells.map(c => C.cellKey(c[0], c[1])));
    const dirs = [
      { d: [0, -1], e: [[0, 0], [1, 0]] },  // 北边 NW-NE
      { d: [1, 0], e: [[1, 0], [1, 1]] },   // 东边 NE-SE
      { d: [0, 1], e: [[1, 1], [0, 1]] },   // 南边 SE-SW
      { d: [-1, 0], e: [[0, 1], [0, 0]] },  // 西边 SW-NW
    ];
    const edges = [];
    for (const [cx, cy] of cells) {
      for (const dir of dirs) {
        if (!set.has(C.cellKey(cx + dir.d[0], cy + dir.d[1]))) {
          edges.push([[cx + dir.e[0][0], cy + dir.e[0][1]], [cx + dir.e[1][0], cy + dir.e[1][1]]]);
        }
      }
    }
    return edges;
  }

  function drawPrism(ctx, scene, cells, lo, hi, color, alpha) {
    const g = scene.grid;
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    // 侧面：只画格子集合的外边界，内部不留缝
    for (const [p1, p2] of cellEdges(cells)) {
      const top1 = C.iso(p1[0], p1[1], hi, g), top2 = C.iso(p2[0], p2[1], hi, g);
      const bot1 = C.iso(p1[0], p1[1], lo, g), bot2 = C.iso(p2[0], p2[1], lo, g);
      poly(ctx, [top1, top2, bot2, bot1], shade(color, -38), shade(color, -70), 1);
    }
    // 顶面：每格菱形
    for (const [cx, cy] of cells) {
      poly(ctx, diamondAt(cx, cy, hi, scene), color, shade(color, -55), 1);
    }
    ctx.globalAlpha = 1;
  }

  function drawGround(ctx, scene, idx) {
    const g = scene.grid;
    for (let y = 0; y < g.rows; y++) {
      for (let x = 0; x < g.cols; x++) {
        const key = C.cellKey(x, y);
        let fill = '#eef1f4', stroke = '#cfd6dd';
        if (idx.deck.has(key)) { fill = '#d9e2ec'; }       // 桥下区域
        if (idx.stair.has(key)) { fill = '#e3dccf'; }      // 台阶占地
        poly(ctx, diamondAt(x, y, 0, scene), fill, stroke, 1);
      }
    }
  }

  function drawBridge(ctx, scene, obj) {
    const g = scene.grid;
    // 桥墩：从地面 z=0 到桥底
    const e = (function () {
      let minX = 99, maxX = -1, minY = 99, maxY = -1;
      for (const [x, y] of obj.cells) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      return { minX, maxX, minY, maxY };
    })();
    for (const [cx, cy] of [[e.minX, e.minY], [e.maxX + 1, e.minY], [e.maxX + 1, e.maxY + 1], [e.minX, e.maxY + 1]]) {
      const top = C.iso(cx, cy, obj.lo, g), bot = C.iso(cx, cy, 0, g);
      ctx.strokeStyle = '#546e87'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(bot.x, bot.y); ctx.stroke();
    }
    drawPrism(ctx, scene, obj.cells, obj.lo, obj.hi, obj.color);
    label(ctx, scene, obj, obj.hi);
  }

  function drawStair(ctx, scene, obj) {
    // 每级台阶是不同高度的独立小棱柱，自然形成阶梯
    for (const [cx, cy] of obj.cells) {
      const top = obj.cellTops.get(C.cellKey(cx, cy));
      drawPrism(ctx, scene, [[cx, cy]], 0, top + 0.05, obj.color);
      poly(ctx, diamondAt(cx, cy, top + 0.05, scene), shade(obj.color, 18), shade(obj.color, -50), 1);
    }
    label(ctx, scene, obj, obj.hi);
  }

  function drawProp(ctx, scene, obj, selected) {
    drawPrism(ctx, scene, obj.cells, obj.lo, obj.hi, obj.color);
    if (obj.id === 'tree') { // 树冠：顶面加一个圆
      const g = scene.grid;
      const c = C.iso(obj.cells[0][0] + 0.5, obj.cells[0][1] + 0.5, obj.hi, g);
      ctx.fillStyle = shade(obj.color, 25);
      ctx.beginPath(); ctx.ellipse(c.x, c.y - 6, 16, 10, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = shade(obj.color, -50); ctx.stroke();
    }
    label(ctx, scene, obj, obj.hi);
    if (selected) ring(ctx, scene, obj);
  }

  function drawHero(ctx, scene, obj, selected) {
    const g = scene.grid;
    const [cx, cy] = obj.cells[0];
    const foot = C.iso(cx + 0.5, cy + 0.5, obj.lo, g);
    const h = (obj.hi - obj.lo) * g.cellH * 2;
    // 影子（投在脚底面）
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(foot.x, foot.y + 2, 13, 6, 0, 0, Math.PI * 2); ctx.fill();
    // 身体 + 头
    ctx.fillStyle = obj.color;
    roundRect(ctx, foot.x - 7, foot.y - h * 0.62, 14, h * 0.62, 5); ctx.fill();
    ctx.beginPath(); ctx.arc(foot.x, foot.y - h * 0.78, 8, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = shade(obj.color, -55); ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(obj.name, foot.x, foot.y - h - 4);
    if (selected) ring(ctx, scene, obj);
  }

  function ring(ctx, scene, obj) {
    ctx.save();
    ctx.strokeStyle = '#ffb400'; ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 4]);
    for (const [cx, cy] of obj.cells) poly(ctx, diamondAt(cx, cy, obj.hi, scene), null, '#ffb400', 2.5);
    ctx.restore();
  }

  function label(ctx, scene, obj, z) {
    const g = scene.grid;
    let ax = Infinity, ay = Infinity;
    for (const [x, y] of obj.cells) { ax = Math.min(ax, x); ay = Math.min(ay, y); }
    const p = C.iso(ax + 0.2, ay + 0.2, z, g);
    if (ctx.__deferLabels) { ctx.__deferLabels.push({ name: obj.name, x: p.x, y: p.y - 13 }); return; }
    drawLabelBox(ctx, p.x, p.y - 13, obj.name);
  }

  function drawLabelBox(ctx, x, y, name) {
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
    const w = ctx.measureText(name).width + 8;
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillRect(x - 4, y - 11, w, 15);
    ctx.fillStyle = '#333';
    ctx.fillText(name, x, y);
  }

  // 标签纵向避让：按 y 排序，与上一个水平区间重叠且间距不足时上移
  function flushLabels(ctx, items) {
    items.sort((a, b) => a.y - b.y);
    const placed = [];
    ctx.font = '11px sans-serif';
    for (const it of items) {
      const w = ctx.measureText(it.name).width + 8;
      let y = it.y;
      for (const p of placed) {
        const pw = ctx.measureText(p.name).width + 8;
        const xOverlap = !(it.x - 4 >= p.x - 4 + pw || p.x - 4 >= it.x - 4 + w);
        if (xOverlap && y - p.y < 16) y = p.y - 16;
      }
      placed.push({ name: it.name, x: it.x, y });
    }
    for (const p of placed) drawLabelBox(ctx, p.x, p.y, p.name);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------- 三种视图 ---------------- */

  function renderNormal(ctx, scene, result, selectedId) {
    const idx = C.buildTerrainIndex(scene);
    const byId = new Map(result.objects.map(o => [o.id, o]));
    drawGround(ctx, scene, idx);
    const labels = ctx.__deferLabels = [];
    for (const id of result.order) {
      const o = byId.get(id);
      if (o.kind === 'bridge') drawBridge(ctx, scene, o);
      else if (o.kind === 'stair') drawStair(ctx, scene, o);
      else if (o.kind === 'hero') drawHero(ctx, scene, o, selectedId === id);
      else drawProp(ctx, scene, o, selectedId === id);
    }
    ctx.__deferLabels = null;
    flushLabels(ctx, labels);
  }

  function renderFootprint(ctx, scene, result, selectedId) {
    const g = scene.grid;
    const idx = C.buildTerrainIndex(scene);
    drawGround(ctx, scene, idx);
    result.objects.forEach((o, i) => {
      const color = o.kind === 'hero' ? '#d9534f' : PALETTE[i % PALETTE.length];
      for (const [cx, cy] of o.cells) {
        poly(ctx, diamondAt(cx, cy, 0.001, scene), color + '55', color, 2);
      }
      // 锚点（参与方位比较的最小格）
      let ax = Infinity, ay = Infinity;
      for (const [x, y] of o.cells) { ax = Math.min(ax, x); ay = Math.min(ay, y); }
      const p = C.iso(ax + 0.5, ay + 0.5, 0.001, g);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
      const fmt = v => (Math.round(v * 100) / 100).toString();
      ctx.fillStyle = '#222'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(`${o.name} z[${fmt(o.lo)},${fmt(o.hi)})`, p.x, p.y - 8);
      if (selectedId === o.id) {
        ctx.save(); ctx.strokeStyle = '#ffb400'; ctx.lineWidth = 3; ctx.setLineDash([6, 4]);
        for (const [cx, cy] of o.cells) poly(ctx, diamondAt(cx, cy, 0.001, scene), null, '#ffb400', 3);
        ctx.restore();
      }
    });
    // 冲突对：红色叉描边
    ctx.save(); ctx.strokeStyle = '#e02424'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
    for (const cf of result.conflicts) {
      for (const id of [cf.a, cf.b]) {
        const o = result.objects.find(x => x.id === id);
        for (const [cx, cy] of o.cells) poly(ctx, diamondAt(cx, cy, 0.002, scene), null, '#e02424', 2);
      }
    }
    ctx.restore();
  }

  function renderOrder(ctx, scene, result, selectedId) {
    const g = scene.grid;
    const idx = C.buildTerrainIndex(scene);
    drawGround(ctx, scene, idx);
    const byId = new Map(result.objects.map(o => [o.id, o]));
    const conflictIds = new Set();
    result.conflicts.forEach(cf => { conflictIds.add(cf.a); conflictIds.add(cf.b); });
    result.order.forEach((id, i) => {
      const o = byId.get(id);
      const baseColor = PALETTE[i % PALETTE.length];
      drawPrism(ctx, scene, o.cells, o.lo, o.hi, baseColor, 0.55);
      // 顶面大号顺序号
      let ax = Infinity, ay = Infinity;
      for (const [x, y] of o.cells) { ax = Math.min(ax, x); ay = Math.min(ay, y); }
      const p = C.iso(ax + 0.5, ay + 0.5, o.hi, g);
      ctx.fillStyle = conflictIds.has(id) ? '#e02424' : '#1f2937';
      ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), p.x, p.y - 6);
      ctx.font = '10px sans-serif';
      ctx.fillText(o.name, p.x, p.y + 8);
      if (conflictIds.has(id)) {
        ctx.save(); ctx.strokeStyle = '#e02424'; ctx.lineWidth = 2.5; ctx.setLineDash([5, 3]);
        for (const [cx, cy] of o.cells) poly(ctx, diamondAt(cx, cy, o.hi, scene), null, '#e02424', 2.5);
        ctx.restore();
      }
      if (selectedId === id) ring(ctx, scene, o);
    });
  }

  /* ---------------- 命中检测 ---------------- */

  // 点在物体占地柱内即算命中；多个命中时取绘制顺序最靠前（最后画）的
  function hitTest(scene, result, pt) {
    const hits = [];
    for (const o of result.objects) {
      for (const [cx, cy] of o.cells) {
        if (pointInDiamond(pt, diamondAt(cx, cy, o.lo, scene))) { hits.push(o.id); break; }
      }
    }
    if (!hits.length) return null;
    hits.sort((a, b) => result.order.indexOf(a) - result.order.indexOf(b));
    return hits[hits.length - 1];
  }

  /* ---------------- 截图 ---------------- */

  function capture(view, scene, result, selectedId, caption, width, height) {
    const off = document.createElement('canvas');
    off.width = width; off.height = height;
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#f7f8fa'; ctx.fillRect(0, 0, width, height);
    if (view === 'normal') renderNormal(ctx, scene, result, selectedId);
    else if (view === 'footprint') renderFootprint(ctx, scene, result, selectedId);
    else renderOrder(ctx, scene, result, selectedId);
    if (caption) {
      ctx.fillStyle = 'rgba(17,24,39,0.82)';
      ctx.fillRect(0, height - 30, width, 30);
      ctx.fillStyle = '#fff'; ctx.font = '13px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(caption, 12, height - 10);
    }
    return off.toDataURL('image/png');
  }

  return {
    renderNormal, renderFootprint, renderOrder, hitTest, capture,
    diamondAt, pointInDiamond, PALETTE,
  };
});
