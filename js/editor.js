/* 画布渲染、视图变换（缩放/平移）与编辑工具 */
'use strict';

const Ed = {
  canvas: null, ctx: null,
  level: null,
  activeLayerId: null,
  tool: 'brush',            // brush | eraser | fill | select
  currentTile: 1,
  zoom: 1, panX: 0, panY: 0,
  showGrid: true, showBounds: true,
  collisionView: 'active',  // off | active | all
  hover: null,              // 当前图层下的格子 {x,y}
  selection: null,          // {x0,y0,x1,y1} 已归一化，当前图层格子坐标
  floating: null,           // 移动中的选区 {tiles,w,h,srcX,srcY,dx,dy}
  stroke: null,             // 进行中的笔刷（一次编辑）
  panning: false, spaceDown: false,
  resizePreview: null,      // {d:{left,right,top,bottom}, result}
  dirty: true,
  _drag: null,
};

function activeLayer() {
  return Ed.level.layers.find(l => l.id === Ed.activeLayerId) || Ed.level.layers[0] || null;
}

function requestRender() { Ed.dirty = true; }

/* ---------- 坐标变换：屏幕 <-> 世界（像素） ---------- */
function screenToWorld(sx, sy) {
  return { x: (sx - Ed.panX) / Ed.zoom, y: (sy - Ed.panY) / Ed.zoom };
}

/* 屏幕坐标 -> 指定图层格子坐标（缩放后仍精确对应） */
function screenToCell(layer, sx, sy) {
  const w = screenToWorld(sx, sy);
  return cellAt(layer, w.x, w.y);
}

function zoomAt(sx, sy, factor) {
  const before = screenToWorld(sx, sy);
  Ed.zoom = Math.min(16, Math.max(0.1, Ed.zoom * factor));
  Ed.panX = sx - before.x * Ed.zoom;
  Ed.panY = sy - before.y * Ed.zoom;
  requestRender();
  if (window.UI) UI.updateZoomLabel();
}

function centerView() {
  const W = levelWidthPx(Ed.level), H = levelHeightPx(Ed.level);
  const cw = Ed.canvas.clientWidth, ch = Ed.canvas.clientHeight;
  Ed.zoom = Math.min(cw / (W + 80), ch / (H + 80), 4);
  Ed.zoom = Math.max(0.1, Ed.zoom);
  Ed.panX = (cw - W * Ed.zoom) / 2;
  Ed.panY = (ch - H * Ed.zoom) / 2;
  requestRender();
}

/* ---------- 渲染 ---------- */
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = Ed.canvas.clientWidth, h = Ed.canvas.clientHeight;
  if (Ed.canvas.width !== Math.round(w * dpr) || Ed.canvas.height !== Math.round(h * dpr)) {
    Ed.canvas.width = Math.round(w * dpr);
    Ed.canvas.height = Math.round(h * dpr);
  }
  requestRender();
}

function render() {
  const cv = Ed.canvas, ctx = Ed.ctx;
  const dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth, ch = cv.clientHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#14151a';
  ctx.fillRect(0, 0, cw, ch);
  if (!Ed.level) return;

  const z = Ed.zoom;
  const toX = wx => wx * z + Ed.panX;
  const toY = wy => wy * z + Ed.panY;
  const LW = levelWidthPx(Ed.level), LH = levelHeightPx(Ed.level);

  // 关卡区域底色
  ctx.fillStyle = '#20222b';
  ctx.fillRect(toX(0), toY(0), LW * z, LH * z);

  // 图层（数组顺序即渲染顺序，先底后顶）
  for (const layer of Ed.level.layers) {
    if (!layer.visible) continue;
    drawLayerTiles(ctx, layer, z, toX, toY, cw, ch, layer.opacity);
  }
  // 移动中的选区浮层
  if (Ed.floating) drawFloating(ctx, z, toX, toY);

  // 碰撞覆盖层
  if (Ed.collisionView !== 'off') {
    for (const layer of Ed.level.layers) {
      if (!layer.visible) continue;
      const isActive = layer.id === Ed.activeLayerId;
      if (Ed.collisionView === 'active' && !isActive) continue;
      drawCollisionOverlay(ctx, layer, z, toX, toY, isActive);
    }
  }

  // 网格（按当前图层的格子尺寸）
  const al = activeLayer();
  if (Ed.showGrid && al) drawGrid(ctx, al, z, toX, toY, cw, ch);

  // 关卡范围
  if (Ed.showBounds) {
    ctx.strokeStyle = '#ffd54f';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(toX(0), toY(0), LW * z, LH * z);
    ctx.setLineDash([]);
  }

  // 尺寸调整预览
  if (Ed.resizePreview) drawResizePreview(ctx, z, toX, toY);

  // 选区
  if (Ed.selection && al) {
    const cs = al.cellSize;
    const x = toX(al.originX + Ed.selection.x0 * cs);
    const y = toY(al.originY + Ed.selection.y0 * cs);
    const w = (Ed.selection.x1 - Ed.selection.x0 + 1) * cs * z;
    const h = (Ed.selection.y1 - Ed.selection.y0 + 1) * cs * z;
    ctx.fillStyle = 'rgba(79,140,255,0.15)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#4f8cff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  // 悬停格子高亮
  if (Ed.hover && al && !Ed._drag) {
    const cs = al.cellSize;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(toX(al.originX + Ed.hover.x * cs), toY(al.originY + Ed.hover.y * cs), cs * z, cs * z);
  }
}

function drawLayerTiles(ctx, layer, z, toX, toY, cw, ch, alpha) {
  const cs = layer.cellSize;
  const size = cs * z;
  if (size < 1.5) return; // 太小不画
  const c0 = Math.max(0, Math.floor(((0 - Ed.panX) / z - layer.originX) / cs));
  const r0 = Math.max(0, Math.floor(((0 - Ed.panY) / z - layer.originY) / cs));
  const c1 = Math.min(layer.cols - 1, Math.ceil(((cw - Ed.panX) / z - layer.originX) / cs));
  const r1 = Math.min(layer.rows - 1, Math.ceil(((ch - Ed.panY) / z - layer.originY) / cs));
  ctx.globalAlpha = alpha;
  const drawSize = Math.ceil(size) + 0.5; // 避免缩放缝隙
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const id = layer.tiles[r * layer.cols + c];
      if (!id) continue;
      ctx.drawImage(TILESET_IMG, 0, id * TILE_SRC_SIZE, TILE_SRC_SIZE, TILE_SRC_SIZE,
        Math.floor(toX(layer.originX + c * cs)), Math.floor(toY(layer.originY + r * cs)), drawSize, drawSize);
    }
  }
  ctx.globalAlpha = 1;
}

function drawFloating(ctx, z, toX, toY) {
  const f = Ed.floating, layer = activeLayer();
  const cs = layer.cellSize;
  ctx.globalAlpha = 0.85;
  const size = Math.ceil(cs * z) + 0.5;
  for (let r = 0; r < f.h; r++) {
    for (let c = 0; c < f.w; c++) {
      const id = f.tiles[r * f.w + c];
      if (!id) continue;
      ctx.drawImage(TILESET_IMG, 0, id * TILE_SRC_SIZE, TILE_SRC_SIZE, TILE_SRC_SIZE,
        Math.floor(toX(layer.originX + (f.srcX + f.dx + c) * cs)),
        Math.floor(toY(layer.originY + (f.srcY + f.dy + r) * cs)), size, size);
    }
  }
  ctx.globalAlpha = 1;
}

function drawCollisionOverlay(ctx, layer, z, toX, toY, isActive) {
  const cs = layer.cellSize;
  ctx.fillStyle = isActive ? 'rgba(229,83,75,0.4)' : 'rgba(229,83,75,0.18)';
  ctx.strokeStyle = isActive ? 'rgba(229,83,75,0.9)' : 'rgba(229,83,75,0.4)';
  ctx.lineWidth = 1;
  for (let r = 0; r < layer.rows; r++) {
    for (let c = 0; c < layer.cols; c++) {
      const id = layer.tiles[r * layer.cols + c];
      if (!id) continue;
      const def = tileDef(id);
      if (!def || def.collision === 'none') continue;
      const x = toX(layer.originX + c * cs), y = toY(layer.originY + r * cs);
      if (collisionShapePath(ctx, def.collision, x, y, cs * z, cs * z)) {
        ctx.fill();
        ctx.stroke();
      }
    }
  }
}

function drawGrid(ctx, layer, z, toX, toY, cw, ch) {
  const cs = layer.cellSize;
  if (cs * z < 6) return;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const x0 = Math.floor(((0 - Ed.panX) / z - layer.originX) / cs) * cs + layer.originX;
  for (let x = x0; toX(x) < cw; x += cs) {
    const sx = Math.round(toX(x)) + 0.5;
    ctx.moveTo(sx, 0); ctx.lineTo(sx, ch);
  }
  const y0 = Math.floor(((0 - Ed.panY) / z - layer.originY) / cs) * cs + layer.originY;
  for (let y = y0; toY(y) < ch; y += cs) {
    const sy = Math.round(toY(y)) + 0.5;
    ctx.moveTo(0, sy); ctx.lineTo(cw, sy);
  }
  ctx.stroke();
}

function drawResizePreview(ctx, z, toX, toY) {
  const { d, result } = Ed.resizePreview;
  const ts = Ed.level.tileSize;
  // 新边界（绿色虚线）
  ctx.strokeStyle = '#69f0ae';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);
  ctx.strokeRect(toX(0), toY(0), result.newW * ts * z, result.newH * ts * z);
  ctx.setLineDash([]);
  // 将被裁掉的格子（红色，画在调整后的位置上）
  const dxPx = d.left * ts, dyPx = d.top * ts;
  ctx.fillStyle = 'rgba(229,83,75,0.45)';
  for (const item of result.removed) {
    const layer = item.layer, cs = layer.cellSize;
    for (const cell of item.cells) {
      ctx.fillRect(toX(layer.originX + dxPx + cell.x * cs),
                   toY(layer.originY + dyPx + cell.y * cs), cs * z, cs * z);
    }
  }
}

/* ---------- 工具 ---------- */
function paintCell(collector, layer, x, y, id) {
  if (!cellIntersectsLevel(layer, x, y, Ed.level)) return;
  collector.set(layer, x, y, id);
  requestRender();
}

/* 两点间插值，快速拖动不留空隙 */
function paintLine(collector, layer, x0, y0, x1, y1, id) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  for (;;) {
    paintCell(collector, layer, x, y, id);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

function floodFill(layer, sx, sy, id) {
  const target = layerTileAt(layer, sx, sy);
  if (target === id) return null;
  const collector = makeChangeCollector();
  const stack = [[sx, sy]];
  const seen = new Set([sx + ',' + sy]);
  while (stack.length) {
    const [x, y] = stack.pop();
    if (layerTileAt(layer, x, y) !== target) continue;
    if (!cellIntersectsLevel(layer, x, y, Ed.level)) continue;
    collector.set(layer, x, y, id);
    for (const [nx, ny] of [[x+1,y],[x-1,y],[x,y+1],[x,y-1]]) {
      const k = nx + ',' + ny;
      if (!seen.has(k)) { seen.add(k); stack.push([nx, ny]); }
    }
  }
  return collector;
}

function normalizeRect(a, b) {
  return {
    x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y),
  };
}

function inSelection(cell) {
  const s = Ed.selection;
  return s && cell.x >= s.x0 && cell.x <= s.x1 && cell.y >= s.y0 && cell.y <= s.y1;
}

function clearSelection() {
  const layer = activeLayer();
  const s = Ed.selection;
  if (!s || !layer) return;
  const collector = makeChangeCollector();
  for (let y = s.y0; y <= s.y1; y++)
    for (let x = s.x0; x <= s.x1; x++)
      collector.set(layer, x, y, 0);
  if (collector.commit(layer.id)) toast(`已清除选区（图层「${layer.name}」）`);
  Ed.selection = null;
  requestRender();
}

function selectAll() {
  const layer = activeLayer();
  if (!layer || layer.cols === 0) return;
  Ed.selection = { x0: 0, y0: 0, x1: layer.cols - 1, y1: layer.rows - 1 };
  requestRender();
}

/* 开始移动选区：把内容剪到浮层 */
function beginMove() {
  const layer = activeLayer();
  const s = Ed.selection;
  const w = s.x1 - s.x0 + 1, h = s.y1 - s.y0 + 1;
  const tiles = new Array(w * h).fill(0);
  const collector = makeChangeCollector();
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const id = layerTileAt(layer, s.x0 + c, s.y0 + r);
      tiles[r * w + c] = id;
      if (id) collector.set(layer, s.x0 + c, s.y0 + r, 0);
    }
  }
  Ed.floating = { tiles, w, h, srcX: s.x0, srcY: s.y0, dx: 0, dy: 0, collector };
}

function endMove(commit) {
  const f = Ed.floating;
  const layer = activeLayer();
  if (!f) return;
  if (!commit || (f.dx === 0 && f.dy === 0)) {
    f.collector.rollback(layer); // 还原剪切
  } else {
    for (let r = 0; r < f.h; r++)
      for (let c = 0; c < f.w; c++)
        f.collector.set(layer, f.srcX + f.dx + c, f.srcY + f.dy + r, f.tiles[r * f.w + c]);
    if (f.collector.commit(layer.id)) toast(`已移动选区（图层「${layer.name}」）`);
    Ed.selection = { x0: f.srcX + f.dx, y0: f.srcY + f.dy,
                     x1: f.srcX + f.dx + f.w - 1, y1: f.srcY + f.dy + f.h - 1 };
  }
  Ed.floating = null;
  requestRender();
}

/* ---------- 输入 ---------- */
function pointerPos(e) {
  const rect = Ed.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onPointerDown(e) {
  if (!Ed.level) return;
  const p = pointerPos(e);
  Ed.canvas.setPointerCapture(e.pointerId);

  if (e.button === 1 || Ed.spaceDown) { // 平移
    Ed.panning = true;
    Ed._drag = { kind: 'pan', startX: p.x, startY: p.y, panX: Ed.panX, panY: Ed.panY };
    return;
  }
  const layer = activeLayer();
  if (!layer) return;
  const cell = screenToCell(layer, p.x, p.y);
  const erase = e.button === 2; // 右键即擦除

  if (Ed.tool === 'brush' || Ed.tool === 'eraser' || erase) {
    const id = (Ed.tool === 'eraser' || erase) ? 0 : Ed.currentTile;
    Ed.stroke = makeChangeCollector();
    Ed._drag = { kind: 'paint', id, last: cell };
    paintCell(Ed.stroke, layer, cell.x, cell.y, id);
  } else if (Ed.tool === 'fill') {
    const id = erase ? 0 : Ed.currentTile;
    const collector = floodFill(layer, cell.x, cell.y, id);
    if (collector && collector.commit(layer.id)) toast(`已填充（图层「${layer.name}」）`);
    requestRender();
  } else if (Ed.tool === 'select') {
    if (Ed.floating) return;
    if (inSelection(cell)) {
      beginMove();
      Ed._drag = { kind: 'move', start: cell };
    } else {
      Ed.selection = null;
      Ed._drag = { kind: 'select', anchor: cell };
      requestRender();
    }
  }
}

function onPointerMove(e) {
  if (!Ed.level) return;
  const p = pointerPos(e);
  const layer = activeLayer();
  if (layer) Ed.hover = screenToCell(layer, p.x, p.y);

  const d = Ed._drag;
  if (!d) { requestRender(); if (window.UI) UI.updateStatusBar(); return; }

  if (d.kind === 'pan') {
    Ed.panX = d.panX + (p.x - d.startX);
    Ed.panY = d.panY + (p.y - d.startY);
  } else if (d.kind === 'paint') {
    const cell = screenToCell(layer, p.x, p.y);
    paintLine(Ed.stroke, layer, d.last.x, d.last.y, cell.x, cell.y, d.id);
    d.last = cell;
  } else if (d.kind === 'select') {
    Ed.selection = normalizeRect(d.anchor, screenToCell(layer, p.x, p.y));
  } else if (d.kind === 'move') {
    const cell = screenToCell(layer, p.x, p.y);
    Ed.floating.dx = cell.x - d.start.x;
    Ed.floating.dy = cell.y - d.start.y;
  }
  requestRender();
  if (window.UI) UI.updateStatusBar();
}

function onPointerUp(e) {
  const d = Ed._drag;
  Ed._drag = null;
  Ed.panning = false;
  if (!d || !Ed.level) return;
  const layer = activeLayer();
  if (d.kind === 'paint' && Ed.stroke) {
    if (Ed.stroke.commit(layer.id)) { /* 一次笔刷 = 一条历史 */ }
    Ed.stroke = null;
    if (window.UI) UI.refreshHistoryButtons();
  } else if (d.kind === 'move') {
    endMove(true);
    if (window.UI) UI.refreshHistoryButtons();
  }
  requestRender();
}

function onWheel(e) {
  e.preventDefault();
  const p = pointerPos(e);
  zoomAt(p.x, p.y, Math.pow(1.0015, -e.deltaY));
}

function cancelActiveGesture() {
  if (Ed.floating) endMove(false);       // Esc 取消移动
  else if (Ed.selection) { Ed.selection = null; requestRender(); }
  if (Ed._drag && Ed._drag.kind === 'paint' && Ed.stroke) {
    Ed.stroke.rollback(activeLayer());
    Ed.stroke = null;
  }
  Ed._drag = null;
}

function undo() {
  const a = History.undo(Ed.level);
  if (a) {
    const lname = a.kind === 'cells'
      ? (Ed.level.layers.find(l => l.id === a.layerId) || {}).name
      : null;
    if (Ed.floating) endMove(false);
    toast(lname ? `已撤销（图层「${lname}」）` : '已撤销');
    Ed.selection = null;
    requestRender();
    if (window.UI) { UI.refreshLayers(); UI.refreshHistoryButtons(); UI.updateStatusBar(); }
  }
}

function redo() {
  const a = History.redo(Ed.level);
  if (a) {
    if (Ed.floating) endMove(false);
    toast('已重做');
    Ed.selection = null;
    requestRender();
    if (window.UI) { UI.refreshLayers(); UI.refreshHistoryButtons(); UI.updateStatusBar(); }
  }
}

/* 应用地图尺寸调整（可撤销） */
function applyResize(d) {
  const before = cloneLevel(Ed.level);
  const result = resizeLevel(Ed.level, d, true);
  History.push({ kind: 'resize', before, after: cloneLevel(Ed.level) });
  Ed.resizePreview = null;
  toast(`地图尺寸已调整为 ${result.newW}×${result.newH}`);
  requestRender();
  if (window.UI) { UI.refreshHistoryButtons(); UI.updateStatusBar(); }
}

function setLevel(level) {
  Ed.level = level;
  Ed.activeLayerId = level.layers[0] ? level.layers[0].id : null;
  Ed.selection = null; Ed.floating = null; Ed.resizePreview = null;
  History.reset();
  centerView();
  if (window.UI) { UI.refreshAll(); }
}

function initEditor() {
  Ed.canvas = document.getElementById('canvas');
  Ed.ctx = Ed.canvas.getContext('2d');
  window.TILESET_IMG = buildTilesetCanvas();
  Ed.canvas.addEventListener('pointerdown', onPointerDown);
  Ed.canvas.addEventListener('pointermove', onPointerMove);
  Ed.canvas.addEventListener('pointerup', onPointerUp);
  Ed.canvas.addEventListener('wheel', onWheel, { passive: false });
  Ed.canvas.addEventListener('contextmenu', e => e.preventDefault());
  new ResizeObserver(resizeCanvas).observe(Ed.canvas);
  resizeCanvas();
  (function loop() {
    if (Ed.dirty) { Ed.dirty = false; render(); }
    requestAnimationFrame(loop);
  })();
}
