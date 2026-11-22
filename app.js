/*
 * 贴图划痕修补工具 —— 纯本地实现
 *
 * 设计要点（对应需求）：
 * 1. 掩码/保护区全部保存在「原图分辨率、原图坐标」的离屏 canvas 上；旋转只改视图变换，
 *    指针坐标经逆变换换回原图坐标后落笔，因此掩码不会随观察角度漂移。
 * 2. 所有修补像素一律从「原始图像快照 sourceCanvas」取样，合成结果永远不会反过来充当来源，
 *    目标与参考重叠也不会产生自反馈。
 * 3. 保护区像素在混合时 alpha 强制为 0，任何修补步骤（含事后补画的保护）都改不到它们。
 * 4. 每步修补是一条不可变记录（掩码 PNG + 参考框 + 羽化），列表顺序即真实叠加顺序，
 *    可编辑/删除/重排；画笔笔迹另有独立撤销栈。
 */

'use strict';

// ---------- 纯几何/像素工具（同时供 Node 自测使用） ----------

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function imageToScreen(p, view, cw, ch, W, H) {
  const c = Math.cos(view.rot), s = Math.sin(view.rot);
  // 先把原图坐标平移到以图像中心为原点，缩放旋转后再移回屏幕中心
  const dx = (p.x - W / 2) * view.scale;
  const dy = (p.y - H / 2) * view.scale;
  return { x: cw / 2 + view.cx + dx * c - dy * s,
           y: ch / 2 + view.cy + dx * s + dy * c };
}

function screenToImage(p, view, cw, ch, W, H) {
  const c = Math.cos(-view.rot), s = Math.sin(-view.rot);
  const dx = p.x - (cw / 2 + view.cx);
  const dy = p.y - (ch / 2 + view.cy);
  const rx = dx * c - dy * s, ry = dx * s + dy * c;
  // 逆变换后再加回图像中心半宽/半高
  return { x: rx / view.scale + W / 2, y: ry / view.scale + H / 2 };
}

/** 一维盒式模糊（前缀和实现，边界按有效长度归一化） */
function boxBlur1D(inArr, outArr, len, r) {
  const prefix = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) prefix[i + 1] = prefix[i] + inArr[i];
  for (let i = 0; i < len; i++) {
    const lo = Math.max(0, i - r), hi = Math.min(len, i + r + 1);
    outArr[i] = (prefix[hi] - prefix[lo]) / (hi - lo);
  }
}

/** 对长度 w*h 的单通道数组做二维盒式模糊，返回新数组 */
function boxBlur2D(input, w, h, r) {
  if (r <= 0) return new Float32Array(input);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const row = new Float32Array(w), rowOut = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    row.set(input.subarray(y * w, y * w + w));
    boxBlur1D(row, rowOut, w, r);
    tmp.set(rowOut, y * w);
  }
  const col = new Float32Array(h), colOut = new Float32Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = tmp[y * w + x];
    boxBlur1D(col, colOut, h, r);
    for (let y = 0; y < h; y++) out[y * w + x] = colOut[y];
  }
  return out;
}

/**
 * 单像素 straight-alpha 混合：dst = src*t + dst*(1-t)，t 为羽化后掩码强度 0..1
 * 透明源/透明目标均按合成公式处理，可正确修补靠近透明边缘的区域。
 */
function blendPixel(d, di, s, si, t) {
  const sa = (s[si + 3] / 255) * t;
  const da = d[di + 3] / 255;
  const outA = sa + da * (1 - t);
  d[di + 3] = Math.round(clamp(outA, 0, 1) * 255);
  if (outA > 1e-6) {
    for (let k = 0; k < 3; k++) {
      const num = s[si + k] * sa + d[di + k] * da * (1 - t);
      d[di + k] = Math.round(clamp(num / outA, 0, 255));
    }
  } else {
    d[di] = d[di + 1] = d[di + 2] = 0;
  }
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// ---------- 以下为浏览器 UI 逻辑 ----------

function initApp() {
  const $ = (id) => document.getElementById(id);
  const canvas = $('viewCanvas');
  const ctx = canvas.getContext('2d');
  const wrap = $('canvasWrap');

  const state = {
    W: 0, H: 0,
    loaded: false,
    baseCanvas: null,      // 原图（可被 A/B 对比显示）
    sourceCanvas: null,    // 原图快照：所有修补唯一合法取样来源，永不修改
    compCanvas: null,      // 全分辨率合成结果
    draftMask: null,       // 当前正在画的修补掩码（全分辨率）
    protectCanvas: null,   // 保护区掩码（全分辨率）
    maskTint: null, protectTint: null,
    ops: [],
    editing: null,         // { index, op } 编辑中的已提交步骤
    draftSrc: null,        // {x,y,w,h}
    feather: 6,
    view: { scale: 1, rot: 0, cx: 0, cy: 0 },
    tool: 'brushAdd',
    brushSize: 24,
    showMask: true, showProtect: true, showRef: true,
    compare: false,
    pointer: { x: 0, y: 0, inside: false },
    stroke: null,          // 进行中的指针手势
    rubber: null,          // 矩形/参考框选临时状态
    spaceDown: false,
    dirty: true,
    strokeLog: [],         // { target:'draft'|'protect' }
    strokeStacks: { draft: [], protect: [] },
  };

  const STROKE_LIMIT = 40;

  // ---------- 离屏 canvas 工具 ----------

  function makeOffscreen(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function makeContext(c) {
    return c.getContext('2d', { willReadFrequently: true });
  }

  function alphaBBox(c) {
    if (c.__bboxCache) return c.__bboxCache;
    const w = c.width, h = c.height;
    const data = makeContext(c).getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 0) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    c.__bboxCache = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    return c.__bboxCache;
  }

  function invalidateBBox(c) { if (c) c.__bboxCache = null; }

  // 复合渲染合并到下一帧：连续画笔/拖动事件只触发一次全分辨率合成
  let compositeQueued = false;
  function scheduleComposite() {
    if (compositeQueued || !state.loaded) return;
    compositeQueued = true;
    requestAnimationFrame(() => {
      compositeQueued = false;
      renderComposite();
    });
  }

  // 导出/保存前调用：若有排队中的合成，先同步落地，保证写出的是最新结果
  function compositeNow() {
    if (compositeQueued) {
      compositeQueued = false;
      renderComposite();
    }
  }

  function rebuildTint(maskC, tintC, color) {
    const t = makeContext(tintC);
    t.clearRect(0, 0, tintC.width, tintC.height);
    t.drawImage(maskC, 0, 0);
    t.globalCompositeOperation = 'source-in';
    t.fillStyle = color;
    t.fillRect(0, 0, tintC.width, tintC.height);
    t.globalCompositeOperation = 'source-over';
  }

  // ---------- 全分辨率合成 ----------

  function applyOp(targetCtx, maskCanvas, srcRect, feather) {
    const W = state.W, H = state.H;
    const bbox = alphaBBox(maskCanvas);
    if (!bbox) return;
    const x0 = clamp(bbox.x, 0, W - 1), y0 = clamp(bbox.y, 0, H - 1);
    const x1 = clamp(bbox.x + bbox.w, 1, W), y1 = clamp(bbox.y + bbox.h, 1, H);
    const cw = x1 - x0, ch = y1 - y0;
    if (cw <= 0 || ch <= 0) return;

    const maskCtx = makeContext(maskCanvas);
    const maskData = maskCtx.getImageData(x0, y0, cw, ch).data;
    const protData = makeContext(state.protectCanvas).getImageData(x0, y0, cw, ch).data;

    const aIn = new Float32Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) {
      let a = maskData[i * 4 + 3];
      if (protData[i * 4 + 3] > 0) a = 0;   // 保护区永不参与修补
      aIn[i] = a;
    }
    const alpha = boxBlur2D(aIn, cw, ch, feather);
    let any = false;
    for (let i = 0; i < alpha.length; i++) if (alpha[i] > 1) { any = true; break; }
    if (!any) return;

    // 来源只可能是原始快照；来源矩形越界部分按像素跳过
    const sx0 = clamp(srcRect.x, 0, W - 1), sy0 = clamp(srcRect.y, 0, H - 1);
    const sx1 = clamp(srcRect.x + cw, 1, W), sy1 = clamp(srcRect.y + ch, 1, H);
    const sw = sx1 - sx0, sh = sy1 - sy0;
    if (sw <= 0 || sh <= 0) return;
    const srcData = makeContext(state.sourceCanvas).getImageData(sx0, sy0, sw, sh).data;

    const base = targetCtx.getImageData(x0, y0, cw, ch);
    const d = base.data;
    for (let j = 0; j < ch; j++) {
      for (let i = 0; i < cw; i++) {
        const k = j * cw + i;
        const t = alpha[k] / 255;
        if (t <= 0.004) continue;
        const sx = srcRect.x + i, sy = srcRect.y + j;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        const si = ((sy - sy0) * sw + (sx - sx0)) * 4;
        blendPixel(d, k * 4, srcData, si, t);
      }
    }
    targetCtx.putImageData(base, x0, y0);
  }

  function renderComposite() {
    const c = makeContext(state.compCanvas);
    c.clearRect(0, 0, state.W, state.H);
    c.drawImage(state.baseCanvas, 0, 0);
    for (const op of state.ops) {
      applyOp(c, op.mask, op.src, op.feather);
    }
    if (state.draftSrc || alphaBBox(state.draftMask)) {
      const bbox = alphaBBox(state.draftMask);
      if (bbox) {
        const src = state.draftSrc || defaultSrcRect(bbox);
        state.draftSrc = src;
        applyOp(c, state.draftMask, src, state.feather);
      }
    }
    state.dirty = true;
  }

  function defaultSrcRect(bbox) {
    const W = state.W, H = state.H;
    let x = bbox.x + bbox.w + 8;
    if (x + bbox.w > W) x = bbox.x - bbox.w - 8;
    x = clamp(x, 0, Math.max(0, W - bbox.w));
    const y = clamp(bbox.y, 0, Math.max(0, H - bbox.h));
    return { x, y, w: bbox.w, h: bbox.h };
  }

  // ---------- 视图绘制 ----------

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const r = wrap.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    state.dpr = dpr;
    state.dirty = true;
  }

  function fitView() {
    if (!state.loaded) return;
    const r = wrap.getBoundingClientRect();
    state.view.scale = Math.min(r.width / state.W, r.height / state.H) * 0.95;
    state.view.cx = 0; state.view.cy = 0; state.view.rot = 0;
    state.dirty = true;
  }

  function draw() {
    const dpr = state.dpr || 1;
    const cw = canvas.width / dpr, ch = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!state.loaded) return;

    const v = state.view;
    // 支点在图像中心：移到屏幕中心 → 旋转 → 缩放 → 把图像原点移回其左上角
    ctx.translate(cw / 2 + v.cx, ch / 2 + v.cy);
    ctx.rotate(v.rot);
    ctx.scale(v.scale, v.scale);
    ctx.translate(-state.W / 2, -state.H / 2);

    ctx.imageSmoothingEnabled = v.scale < 2;
    ctx.drawImage(state.compare ? state.baseCanvas : state.compCanvas, 0, 0);

    // 掩码与保护着色
    if (state.showMask) {
      ctx.globalAlpha = 0.42;
      ctx.drawImage(state.maskTint, 0, 0);
      ctx.globalAlpha = 1;
    }
    if (state.showProtect) {
      ctx.globalAlpha = 0.5;
      ctx.drawImage(state.protectTint, 0, 0);
      ctx.globalAlpha = 1;
    }

    // 参考框（黄色虚线）
    if (state.showRef && state.draftSrc) {
      const s = state.draftSrc;
      ctx.save();
      ctx.strokeStyle = '#ffd23d';
      ctx.lineWidth = 1.5 / v.scale;
      ctx.setLineDash([6 / v.scale, 4 / v.scale]);
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffd23d';
      ctx.font = `${12 / v.scale}px sans-serif`;
      ctx.fillText('参考', s.x, Math.max(12 / v.scale, s.y - 3 / v.scale));
      ctx.restore();
    }

    // 矩形选框橡皮条
    if (state.rubber && (state.tool.startsWith('rect') || state.tool === 'refPick')) {
      const a = state.rubber.start, b = state.rubber.current;
      const rx = Math.min(a.x, b.x), ry = Math.min(a.y, b.y);
      const rw = Math.abs(a.x - b.x), rh = Math.abs(a.y - b.y);
      ctx.save();
      ctx.strokeStyle = state.tool === 'refPick' ? '#ffd23d' : '#57e3f0';
      ctx.fillStyle = state.tool === 'refPick' ? 'rgba(255,210,61,.18)' : 'rgba(87,227,240,.18)';
      ctx.lineWidth = 1.5 / v.scale;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.restore();
    }

    // 图像边界
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 1 / v.scale;
    ctx.strokeRect(0, 0, state.W, state.H);

    // 笔刷光圈（屏幕空间，不随旋转变形）
    if (state.pointer.inside && state.tool.includes('brush')) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const p = imageToScreen(state.pointer, v, cw, ch, state.W, state.H);
      ctx.beginPath();
      ctx.arc(p.x, p.y, state.brushSize * 0.5 * v.scale, 0, Math.PI * 2);
      ctx.strokeStyle = state.tool.startsWith('protect') ? '#ff6b6b' : '#57e3f0';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function loop() {
    if (state.dirty) { state.dirty = false; draw(); }
    requestAnimationFrame(loop);
  }

  // ---------- 掩码笔迹与撤销 ----------

  function pushStroke(target) {
    const c = target === 'draft' ? state.draftMask : state.protectCanvas;
    state.strokeStacks[target].push(makeContext(c).getImageData(0, 0, c.width, c.height));
    state.strokeLog.push(target);
    while (state.strokeLog.length > STROKE_LIMIT) {
      const t = state.strokeLog.shift();
      state.strokeStacks[t].shift();
    }
  }

  function undoStroke() {
    const target = state.strokeLog.pop();
    if (!target) return false;
    const snap = state.strokeStacks[target].pop();
    const c = target === 'draft' ? state.draftMask : state.protectCanvas;
    makeContext(c).putImageData(snap, 0, 0);
    afterMaskChange(target);
    return true;
  }

  function stamp(ctx2, x, y, r, add) {
    ctx2.beginPath();
    ctx2.arc(x, y, r, 0, Math.PI * 2);
    ctx2.fillStyle = '#000';
    ctx2.globalCompositeOperation = add ? 'source-over' : 'destination-out';
    ctx2.fill();
    ctx2.globalCompositeOperation = 'source-over';
  }

  function paintLine(target, from, to, add) {
    const c = target === 'draft' ? state.draftMask : state.protectCanvas;
    const c2 = makeContext(c);
    const r = state.brushSize / 2;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, r * 0.25)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      stamp(c2, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, r, add);
    }
  }

  function fillRectMask(target, rect, add) {
    const c = target === 'draft' ? state.draftMask : state.protectCanvas;
    const c2 = makeContext(c);
    c2.fillStyle = '#000';
    c2.globalCompositeOperation = add ? 'source-over' : 'destination-out';
    c2.fillRect(rect.x, rect.y, rect.w, rect.h);
    c2.globalCompositeOperation = 'source-over';
  }

  /** 保护区改动后，把保护像素从所有修补掩码（含草稿与已提交步骤）中挖掉 */
  function punchProtected() {
    const punch = (c) => {
      const c2 = makeContext(c);
      c2.globalCompositeOperation = 'destination-out';
      c2.drawImage(state.protectCanvas, 0, 0);
      c2.globalCompositeOperation = 'source-over';
    };
    punch(state.draftMask);
    for (const op of state.ops) punch(op.mask);
  }

  function afterMaskChange(target) {
    if (target === 'protect') {
      punchProtected();
      invalidateBBox(state.protectCanvas);
    }
    invalidateBBox(state.draftMask);
    for (const op of state.ops) invalidateBBox(op.mask);
    rebuildTint(state.draftMask, state.maskTint, 'rgba(87,227,240,.9)');
    rebuildTint(state.protectCanvas, state.protectTint, 'rgba(255,80,80,.9)');
    scheduleComposite();
    refreshApplyButton();
    refreshRefInfo();
    state.dirty = true;
  }

  // ---------- 指针交互 ----------

  function eventPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function toImage(e) {
    const r = wrap.getBoundingClientRect();
    const p = eventPos(e);
    return screenToImage(p, state.view, r.width, r.height, state.W, state.H);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.loaded) return;
    canvas.setPointerCapture(e.pointerId);
    const p = toImage(e);
    const tool = state.tool;
    const panMode = tool === 'pan' || state.spaceDown || e.button === 1;

    if (panMode) {
      state.stroke = { kind: 'pan', start: eventPos(e), cx: state.view.cx, cy: state.view.cy };
      return;
    }
    if (tool.includes('brush')) {
      const target = tool.startsWith('protect') ? 'protect' : 'draft';
      const add = tool.endsWith('Add') !== (e.altKey);  // Alt 临时反转增减
      pushStroke(target);
      state.stroke = { kind: 'brush', target, add, last: p };
      paintLine(target, p, p, add);
      afterMaskChange(target);
      return;
    }
    if (tool.startsWith('rect')) {
      const add = tool === 'rectAdd';
      state.rubber = { start: p, current: p, target: 'draft', add, committed: false };
      state.stroke = { kind: 'rect' };
      state.dirty = true;
      return;
    }
    if (tool === 'refPick') {
      state.rubber = { start: p, current: p, committed: false };
      state.stroke = { kind: 'ref' };
      state.dirty = true;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const r = wrap.getBoundingClientRect();
    const sp = eventPos(e);
    state.pointer = { x: sp.x, y: sp.y, inside: true };
    if (!state.loaded) { state.dirty = true; return; }
    const p = screenToImage(sp, state.view, r.width, r.height, state.W, state.H);

    if (state.stroke?.kind === 'pan') {
      const s = state.stroke;
      state.view.cx = s.cx + (sp.x - s.start.x);
      state.view.cy = s.cy + (sp.y - s.start.y);
      state.dirty = true;
    } else if (state.stroke?.kind === 'brush') {
      const s = state.stroke;
      paintLine(s.target, s.last, p, s.add);
      s.last = p;
      afterMaskChange(s.target);
    } else if (state.stroke?.kind === 'rect' || state.stroke?.kind === 'ref') {
      state.rubber.current = p;
      state.dirty = true;
    } else {
      state.dirty = true;
    }
  });

  canvas.addEventListener('pointerup', () => {
    if (state.stroke?.kind === 'rect' && state.rubber && !state.rubber.committed) {
      const a = state.rubber.start, b = state.rubber.current;
      const rect = {
        x: clamp(Math.min(a.x, b.x), 0, state.W),
        y: clamp(Math.min(a.y, b.y), 0, state.H),
        w: Math.min(Math.abs(a.x - b.x), state.W),
        h: Math.min(Math.abs(a.y - b.y), state.H),
      };
      if (rect.w >= 1 && rect.h >= 1) {
        pushStroke('draft');
        fillRectMask('draft', rect, state.rubber.add);
        afterMaskChange('draft');
      }
    }
    if (state.stroke?.kind === 'ref' && state.rubber && !state.rubber.committed) {
      const a = state.rubber.start, b = state.rubber.current;
      const rect = {
        x: clamp(Math.min(a.x, b.x), 0, state.W - 1),
        y: clamp(Math.min(a.y, b.y), 0, state.H - 1),
        w: Math.round(Math.abs(a.x - b.x)),
        h: Math.round(Math.abs(a.y - b.y)),
      };
      if (rect.w >= 2 && rect.h >= 2) {
        rect.w = Math.min(rect.w, state.W - rect.x);
        rect.h = Math.min(rect.h, state.H - rect.y);
        state.draftSrc = rect;
        scheduleComposite();
        refreshRefInfo();
      }
    }
    state.stroke = null;
    state.rubber = null;
    state.dirty = true;
  });

  canvas.addEventListener('pointerleave', () => {
    state.pointer.inside = false;
    state.dirty = true;
  });

  canvas.addEventListener('wheel', (e) => {
    if (!state.loaded) return;
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    const sp = eventPos(e);
    const before = screenToImage(sp, state.view, r.width, r.height, state.W, state.H);
    const factor = Math.exp(-e.deltaY * 0.0012);
    state.view.scale = clamp(state.view.scale * factor, 0.05, 40);
    // 以光标为锚点缩放：保持光标下的原图坐标点不动
    const after = screenToImage(sp, state.view, r.width, r.height, state.W, state.H);
    const dxi = (after.x - before.x) * state.view.scale;
    const dyi = (after.y - before.y) * state.view.scale;
    const rot = state.view.rot;
    state.view.cx += dxi * Math.cos(rot) - dyi * Math.sin(rot);
    state.view.cy += dxi * Math.sin(rot) + dyi * Math.cos(rot);
    state.dirty = true;
  }, { passive: false });

  // ---------- 修补步骤的增删改/重排 ----------

  function genId() { return 'op_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }

  function snapshotMask(srcC) {
    const c = makeOffscreen(state.W, state.H);
    makeContext(c).drawImage(srcC, 0, 0);
    return c;
  }

  function applyPatch() {
    if (!state.loaded) return;
    const bbox = alphaBBox(state.draftMask);
    if (!bbox) { alert('请先用画笔或矩形涂出修补掩码。'); return; }
    if (!state.draftSrc) state.draftSrc = defaultSrcRect(bbox);
    const record = {
      id: genId(),
      mask: snapshotMask(state.draftMask),
      src: { ...state.draftSrc },
      feather: state.feather,
      bbox: { ...bbox },
    };
    if (state.editing) {
      state.ops.splice(clamp(state.editing.index, 0, state.ops.length), 0, record);
      state.editing = null;
    } else {
      state.ops.push(record);
    }
    // 固化为步骤后，草稿笔迹不再属于可撤销范围；下次撤销应直接作用于步骤
    state.strokeLog = [];
    state.strokeStacks = { draft: [], protect: [] };
    clearDraft();
    renderComposite();
    renderOpList();
    refreshApplyButton();
  }

  function clearDraft() {
    makeContext(state.draftMask).clearRect(0, 0, state.W, state.H);
    invalidateBBox(state.draftMask);
    state.strokeStacks.draft = [];
    state.draftSrc = null;
    rebuildTint(state.draftMask, state.maskTint, 'rgba(87,227,240,.9)');
    refreshApplyButton();
    refreshRefInfo();
    state.dirty = true;
  }

  function editOp(index) {
    const op = state.ops.splice(index, 1)[0];
    state.editing = { index, op };
    makeContext(state.draftMask).clearRect(0, 0, state.W, state.H);
    makeContext(state.draftMask).drawImage(op.mask, 0, 0);
    state.draftSrc = { ...op.src };
    state.feather = op.feather;
    $('feather').value = op.feather;
    $('featherVal').textContent = op.feather;
    state.strokeStacks.draft = [];
    afterMaskChange('draft');
    renderComposite();
    renderOpList();
    refreshApplyButton();
  }

  function cancelEdit() {
    if (!state.editing) return;
    const { index, op } = state.editing;
    state.ops.splice(clamp(index, 0, state.ops.length), 0, op);
    state.editing = null;
    clearDraft();
    renderComposite();
    renderOpList();
    refreshApplyButton();
  }

  function deleteOp(index) {
    if (state.editing) cancelEdit();
    state.ops.splice(index, 1);
    renderComposite();
    renderOpList();
  }

  function moveOp(index, dir) {
    const j = index + dir;
    if (j < 0 || j >= state.ops.length) return;
    [state.ops[index], state.ops[j]] = [state.ops[j], state.ops[index]];
    renderComposite();
    renderOpList();
  }

  function renderOpList() {
    const ol = $('opList');
    ol.innerHTML = '';
    state.ops.forEach((op, i) => {
      const li = document.createElement('li');
      const meta = `目标(${op.bbox.x},${op.bbox.y} ${op.bbox.w}×${op.bbox.h}) · 参考(${op.src.x},${op.src.y}) · 羽化${op.feather}px`;
      li.innerHTML = `<div class="op-head"><span class="order-name">#${i + 1} 修补</span></div>
        <div class="op-meta">${meta}</div>
        <div class="op-btns">
          <button data-act="edit">编辑</button>
          <button data-act="up">↑</button>
          <button data-act="down">↓</button>
          <button data-act="del">删除</button>
        </div>`;
      li.querySelector('[data-act=edit]').onclick = () => editOp(i);
      li.querySelector('[data-act=up]').onclick = () => moveOp(i, -1);
      li.querySelector('[data-act=down]').onclick = () => moveOp(i, 1);
      li.querySelector('[data-act=del]').onclick = () => deleteOp(i);
      ol.appendChild(li);
    });
    if (state.editing) {
      const li = document.createElement('li');
      li.className = 'editing';
      li.innerHTML = `<div class="op-head"><span class="op-name">编辑中（原第 ${state.editing.index + 1} 步）</span></div>
        <div class="op-btns"><button data-act="cancel">取消编辑</button></div>`;
      li.querySelector('[data-act=cancel]').onclick = cancelEdit;
      ol.appendChild(li);
    }
  }

  function refreshApplyButton() {
    const btn = $('btnApply');
    if (!state.loaded) { btn.disabled = true; return; }
    const hasMask = state.draftMask && alphaBBox(state.draftMask);
    btn.disabled = !hasMask;
    btn.textContent = state.editing ? '更新修补' : '应用修补';
  }

  function refreshRefInfo() {
    const el = $('refInfo');
    if (!state.loaded) { el.textContent = '参考区域：未选择'; return; }
    const s = state.draftSrc;
    el.textContent = s ? `参考区域：(${s.x},${s.y}) ${s.w}×${s.h}` : '参考区域：未选择（应用时自动放置）';
  }

  // ---------- 图像/工程载入与导出 ----------

  function loadImageElement(img) {
    const W = img.naturalWidth, H = img.naturalHeight;
    state.W = W; state.H = H; state.loaded = true;
    state.ops = []; state.editing = null;
    state.strokeLog = []; state.strokeStacks = { draft: [], protect: [] };

    state.baseCanvas = makeOffscreen(W, H);
    makeContext(state.baseCanvas).drawImage(img, 0, 0);
    state.sourceCanvas = makeOffscreen(W, H);   // 永不修改的取样来源
    makeContext(state.sourceCanvas).drawImage(img, 0, 0);
    state.compCanvas = makeOffscreen(W, H);
    state.draftMask = makeOffscreen(W, H);
    state.protectCanvas = makeOffscreen(W, H);
    state.maskTint = makeOffscreen(W, H);
    state.protectTint = makeOffscreen(W, H);
    state.draftSrc = null;

    $('emptyHint').style.display = 'none';
    fitView();
    renderComposite();
    renderOpList();
    refreshApplyButton();
    refreshRefInfo();
    updateStatus();
  }

  function loadImageFromURL(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { loadImageElement(img); resolve(); };
      img.onerror = reject;
      img.src = url;
    });
  }

  function loadImageFromFile(file) {
    const url = URL.createObjectURL(file);
    return loadImageFromURL(url).finally(() => URL.revokeObjectURL(url));
  }

  function download(url, name) {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  function exportResult() {
    if (!state.loaded) return;
    compositeNow();
    renderComposite();
    download(state.compCanvas.toDataURL('image/png'), 'patched_result.png');
  }

  function exportMask() {
    if (!state.loaded) return;
    // 所有已提交掩码的并集，保护区排除；白=修补 黑=不动
    const union = makeOffscreen(state.W, state.H);
    const uc = makeContext(union);
    uc.fillStyle = '#000';
    uc.fillRect(0, 0, state.W, state.H);
    uc.globalCompositeOperation = 'lighter';
    for (const op of state.ops) uc.drawImage(op.mask, 0, 0);
    uc.globalCompositeOperation = 'destination-out';
    uc.drawImage(state.protectCanvas, 0, 0);
    uc.globalCompositeOperation = 'source-over';
    const out = makeOffscreen(state.W, state.H);
    const oc = makeContext(out);
    oc.drawImage(union, 0, 0);
    oc.globalCompositeOperation = 'source-in';
    oc.fillStyle = '#fff';
    oc.fillRect(0, 0, state.W, state.H);
    download(out.toDataURL('image/png'), 'patch_mask.png');
  }

  function saveProject() {
    if (!state.loaded) return;
    compositeNow();
    const project = {
      version: 1,
      kind: 'texture-patch-project',
      image: state.baseCanvas.toDataURL('image/png'),
      protect: state.protectCanvas.toDataURL('image/png'),
      view: state.view,
      ops: state.ops.map((op) => ({
        id: op.id,
        mask: op.mask.toDataURL('image/png'),
        src: op.src, feather: op.feather, bbox: op.bbox,
      })),
    };
    const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
    download(URL.createObjectURL(blob), 'patch_project.json');
  }

  async function openProject(file) {
    const project = JSON.parse(await file.text());
    if (project.kind !== 'texture-patch-project') throw new Error('不是本工具的工程文件');
    await loadImageFromURL(project.image);
    const restore = async (url) => {
      const img = await new Promise((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
      });
      return img;
    };
    const pImg = await restore(project.protect);
    makeContext(state.protectCanvas).clearRect(0, 0, state.W, state.H);
    makeContext(state.protectCanvas).drawImage(pImg, 0, 0);
    state.ops = [];
    for (const rop of project.ops) {
      const mImg = await restore(rop.mask);
      const mc = makeOffscreen(state.W, state.H);
      makeContext(mc).drawImage(mImg, 0, 0);
      state.ops.push({
        id: rop.id || genId(), mask: mc,
        src: rop.src, feather: rop.feather,
        bbox: rop.bbox || alphaBBox(mc),
      });
    }
    if (project.view) state.view = project.view;
    clearDraft();
    afterMaskChange('protect');
    renderOpList();
    updateStatus();
  }

  // ---------- 透明像素一键保护 ----------

  function protectTransparent() {
    if (!state.loaded) return;
    pushStroke('protect');
    const data = makeContext(state.baseCanvas).getImageData(0, 0, state.W, state.H).data;
    const pc = makeOffscreen(state.W, state.H);
    const pd = pc.getContext('2d').createImageData(state.W, state.H);
    for (let i = 0; i < state.W * state.H; i++) {
      if (data[i * 4 + 3] < 8) {
        pd.data[i * 4] = 255; pd.data[i * 4 + 1] = 255; pd.data[i * 4 + 2] = 255;
        pd.data[i * 4 + 3] = 255;
      }
    }
    makeContext(pc).putImageData(pd, 0, 0);
    makeContext(state.protectCanvas).drawImage(pc, 0, 0);
    afterMaskChange('protect');
  }

  // ---------- 状态栏 ----------

  function updateStatus() {
    if (!state.loaded) { $('statusText').textContent = '未载入图像'; return; }
    const deg = Math.round((state.view.rot * 180 / Math.PI) % 360);
    $('statusText').textContent =
      `${state.W}×${state.H} · 缩放 ${(state.view.scale * 100).toFixed(0)}% · 角度 ${deg}° · ` +
      `${state.ops.length} 步修补${state.compare ? ' · 正在显示原图(A/B)' : ''}`;
  }

  // ---------- UI 绑定 ----------

  document.querySelectorAll('.tool').forEach((btn) => {
    btn.onclick = () => {
      state.tool = btn.dataset.tool;
      document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b === btn));
    };
  });

  $('btnOpenImage').onclick = () => $('fileImage').click();
  $('fileImage').onchange = (e) => {
    if (e.target.files[0]) loadImageFromFile(e.target.files[0]).catch((err) => alert('载入失败：' + err.message));
    e.target.value = '';
  };

  $('btnOpenProject').onclick = () => $('fileProject').click();
  $('fileProject').onchange = (e) => {
    if (e.target.files[0]) openProject(e.target.files[0]).catch((err) => alert('工程打开失败：' + err.message));
    e.target.value = '';
  };

  async function loadSample(name) {
    try {
      const resp = await fetch('public/samples/' + name);
      if (!resp.ok) throw new Error(resp.status);
      const url = URL.createObjectURL(await resp.blob());
      await loadImageFromURL(url);
      URL.revokeObjectURL(url);
    } catch {
      alert('样例载入失败。请先在仓库根目录运行 `npm run generate:samples` 生成样例，\n' +
        '并用 `npm run serve`（或任意本地静态服务器）打开本页面；\n' +
        '也可以直接用「打开贴图」选择 public/samples 下生成的 PNG。');
    }
  }
  $('btnLoadSample1').onclick = () => loadSample('sample1_checker_scratch.png');
  $('btnLoadSample2').onclick = () => loadSample('sample2_transparent_edge.png');

  $('btnRotateL').onclick = () => { state.view.rot -= Math.PI / 2; state.dirty = true; updateStatus(); };
  $('btnRotateR').onclick = () => { state.view.rot += Math.PI / 2; state.dirty = true; updateStatus(); };
  $('btnRotateReset').onclick = () => { state.view.rot = 0; state.dirty = true; updateStatus(); };
  $('btnFit').onclick = fitView;
  $('btnZoomIn').onclick = () => { state.view.scale = clamp(state.view.scale * 1.25, 0.05, 40); state.dirty = true; updateStatus(); };
  $('btnZoomOut').onclick = () => { state.view.scale = clamp(state.view.scale / 1.25, 0.05, 40); state.dirty = true; updateStatus(); };

  $('btnUndo').onclick = () => {
    if (undoStroke()) return;
    if (state.editing) { cancelEdit(); return; }
    if (state.ops.length) { state.ops.pop(); renderComposite(); renderOpList(); refreshApplyButton(); }
  };

  const compareToggle = (on) => { state.compare = on; $('btnCompare').classList.toggle('active', on); state.dirty = true; updateStatus(); };
  $('btnCompare').onclick = () => compareToggle(!state.compare);

  $('btnApply').onclick = applyPatch;
  $('btnExportResult').onclick = exportResult;
  $('btnExportMask').onclick = exportMask;
  $('btnSaveProject').onclick = saveProject;

  $('brushSize').oninput = (e) => { state.brushSize = +e.target.value; $('brushSizeVal').textContent = e.target.value; };
  $('feather').oninput = (e) => {
    state.feather = +e.target.value; $('featherVal').textContent = e.target.value;
    scheduleComposite();
  };
  $('btnClearMask').onclick = () => { if (state.loaded) { pushStroke('draft'); clearDraft(); renderComposite(); } };
  $('btnClearProtect').onclick = () => {
    if (!state.loaded) return;
    pushStroke('protect');
    makeContext(state.protectCanvas).clearRect(0, 0, state.W, state.H);
    afterMaskChange('protect');
  };
  $('btnProtectAlpha').onclick = protectTransparent;
  $('btnRefToMask').onclick = () => {
    if (!state.loaded) return;
    const bbox = alphaBBox(state.draftMask);
    if (!bbox) { alert('请先涂出修补掩码。'); return; }
    state.draftSrc = { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h };
    scheduleComposite(); refreshRefInfo();
  };

  $('showMask').onchange = (e) => { state.showMask = e.target.checked; state.dirty = true; };
  $('showProtect').onchange = (e) => { state.showProtect = e.target.checked; state.dirty = true; };
  $('showRef').onchange = (e) => { state.showRef = e.target.checked; state.dirty = true; };

  // 键盘快捷键
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === ' ') { state.spaceDown = true; e.preventDefault(); return; }
    if (k === 'b') document.querySelector('[data-tool=brushAdd]').click();
    else if (k === 'e') document.querySelector('[data-tool=brushSub]').click();
    else if (k === 'r') document.querySelector('[data-tool=rectAdd]').click();
    else if (k === 'p') document.querySelector('[data-tool=protectAdd]').click();
    else if (k === 's') document.querySelector('[data-tool=refPick]').click();
    else if (k === 'h') document.querySelector('[data-tool=pan]').click();
    else if (k === '[') { $('brushSize').value = Math.max(2, state.brushSize - 2); $('brushSize').dispatchEvent(new Event('input')); }
    else if (k === ']') { $('brushSize').value = Math.min(400, state.brushSize + 2); $('brushSize').dispatchEvent(new Event('input')); }
    else if (k === '\\') compareToggle(true);
    else if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); $('btnUndo').click(); }
    else if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); saveProject(); }
    else if (k === 'enter') applyPatch();
    else if (k.startsWith('arrow') && state.draftSrc) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const d = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[k];
      if (!d) return;
      const s = state.draftSrc;
      s.x = clamp(s.x + d[0] * step, 0, state.W - s.w);
      s.y = clamp(s.y + d[1] * step, 0, state.H - s.h);
      scheduleComposite(); refreshRefInfo(); state.dirty = true;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') state.spaceDown = false;
    if (e.key === '\\') compareToggle(false);
  });

  // 拖放：PNG 当贴图，JSON 当工程
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (f.name.endsWith('.json')) openProject(f).catch((err) => alert('工程打开失败：' + err.message));
    else loadImageFromFile(f).catch((err) => alert('载入失败：' + err.message));
  });

  new ResizeObserver(resizeCanvas).observe(wrap);
  resizeCanvas();
  refreshApplyButton();
  requestAnimationFrame(loop);

  // 调试探针按需暴露内部状态（默认关闭，见 window.__patchProbe）
  if (window.__patchDebug) window.__state = state;
}

// 浏览器自动启动；Node 下只导出纯函数供自测
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
  else initApp();
}

// 只读调试探针（仅浏览器、且显式开启 window.__patchDebug 时可用），供本地自动化测试观察内部状态，
// 不改变任何生产行为；Node 环境不挂载。
if (typeof window !== 'undefined') {
  window.__patchProbe = function () {
    if (!window.__patchDebug || !window.__state) return null;
    const s = window.__state;
    const count = (c) => {
      const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    };
    return {
      loaded: s.loaded, tool: s.tool, stroke: s.stroke && s.stroke.kind,
      draftPixels: s.draftMask ? count(s.draftMask) : 0,
      protectPixels: s.protectCanvas ? count(s.protectCanvas) : 0,
      strokeLog: s.strokeLog.slice(),
      draftStack: s.strokeStacks.draft.length,
      protectStack: s.strokeStacks.protect.length,
      ops: s.ops.length, brushSize: s.brushSize,
      W: s.W, H: s.H, view: s.view,
      // 用 app 自身的逆变换把画布 CSS 坐标换算为原图坐标，供测试确认落点在图像内
      imagePoint(screenX, screenY) {
        const rect = document.getElementById('viewCanvas').getBoundingClientRect();
        return screenToImage({ x: screenX, y: screenY }, s.view, rect.width, rect.height, s.W, s.H);
      },
    };
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { clamp, imageToScreen, screenToImage, boxBlur1D, boxBlur2D, blendPixel, rectsIntersect };
}
