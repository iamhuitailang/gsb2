// 画布：SVG 渲染 + 指针交互。所有命中判断先把屏幕坐标换回文档坐标，因此任意缩放下命中位置都正确
import {
  V, sub, add, dist, pathToD, pathBounds, distanceToPath,
  pointInPath, equalP, anchor,
} from './geometry.js';
import {
  walk, findNode, insertNode, createPath,
  moveAnchor, moveHandle, insertAnchorOnSegment, deleteAnchor,
} from './model.js';
import { lineSubpaths, rectSubpaths } from './geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HANDLE_HIT = 8;   // 屏幕像素命中容差
const PATH_HIT = 5;     // 文档单位描边命中附加容差
const GRID = 20;

const el = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  return node;
};

export class CanvasView {
  constructor(store, mountEl, callbacks = {}) {
    this.store = store;
    this.mount = mountEl;
    this.cb = callbacks;
    this.spaceDown = false;
    this.drag = null;           // 进行中的手势
    this.penDown = null;        // 钢笔按下信息（区分点击/拖拽）
    this.lastCandidate = null;  // 同点重复点击轮换重叠路径
    this.lastCandidateAt = 0;

    this.svg = el('svg', { class: 'stage', tabindex: 0 });
    this.defs = el('defs');
    this.gridLayer = el('g', { class: 'grid-layer' });
    this.world = el('g', { class: 'world' });       // 文档内容（随视图变换）
    this.overlay = el('g', { class: 'overlay' });   // 选中框/锚点/控制柄
    this.draftLayer = el('g', { class: 'draft-layer' });
    this.svg.append(this.defs, this.gridLayer, this.world, this.overlay, this.draftLayer);
    this.mount.append(this.svg);

    this.candidateBox = document.createElement('div');
    this.candidateBox.className = 'candidate-pop';
    this.candidateBox.hidden = true;
    this.mount.append(this.candidateBox);

    this._bindEvents();
    store.subscribe((kind) => {
      if (kind !== 'view') this.render();
      this._updateView();
    });
    this._updateView();
    this.render();
    this.fitView();
  }

  // ---------- 坐标 ----------
  toDoc(clientX, clientY) {
    const r = this.svg.getBoundingClientRect();
    const z = this.store.view.zoom;
    return V(
      (clientX - r.left - this.store.view.panX) / z,
      (clientY - r.top - this.store.view.panY) / z,
    );
  }
  toScreen(p) {
    const r = this.svg.getBoundingClientRect();
    return V(r.left + this.store.view.panX + p.x * this.store.view.zoom,
      r.top + this.store.view.panY + p.y * this.store.view.zoom);
  }

  _updateView() {
    const { zoom, panX, panY } = this.store.view;
    this.world.setAttribute('transform', `matrix(${zoom},0,0,${zoom},${panX},${panY})`);
    this.overlay.setAttribute('transform', `matrix(${zoom},0,0,${zoom},${panX},${panY})`);
    this.draftLayer.setAttribute('transform', `matrix(${zoom},0,0,${zoom},${panX},${panY})`);
    this._renderGrid();
  }

  _renderGrid() {
    const { zoom, panX, panY } = this.store.view;
    const r = this.svg.getBoundingClientRect();
    this.gridLayer.replaceChildren();
    const step = GRID * zoom;
    if (step < 8) return;
    const offX = ((panX % step) + step) % step;
    const offY = ((panY % step) + step) % step;
    for (let x = offX; x < r.width; x += step) {
      this.gridLayer.append(el('line', { x1: x, y1: 0, x2: x, y2: r.height, class: 'grid-line' }));
    }
    for (let y = offY; y < r.height; y += step) {
      this.gridLayer.append(el('line', { x1: 0, y1: y, x2: r.width, y2: y, class: 'grid-line' }));
    }
  }

  // ---------- 渲染文档 ----------
  render() {
    const { doc } = this.store;
    // 画布边界
    this.world.replaceChildren();
    const bg = el('rect', { x: 0, y: 0, width: doc.width, height: doc.height, class: 'canvas-bg' });
    this.world.append(bg);
    for (const node of doc.layers) this.world.append(this._renderNode(node));
    this._renderOverlay();
    this._renderDraft();
  }

  _renderNode(node) {
    if (node.type === 'group') {
      const g = el('g', { class: 'layer-group' });
      if (!node.visible) g.setAttribute('display', 'none');
      for (const c of node.children) g.append(this._renderNode(c));
      return g;
    }
    const s = node.style;
    const p = el('path', {
      d: pathToD(node.subpaths),
      fill: s.fill,
      stroke: s.stroke,
      'fill-rule': s.fillRule,
      'fill-opacity': s.fillOpacity,
      'stroke-width': s.strokeWidth,
      'stroke-opacity': s.strokeOpacity,
      'stroke-linecap': s.strokeLinecap,
      'stroke-linejoin': s.strokeLinejoin,
      opacity: s.opacity,
      class: 'shape',
      'data-id': node.id,
    });
    if (s.strokeDash && s.strokeDash !== 'none') p.setAttribute('stroke-dasharray', s.strokeDash);
    if (!node.visible) p.setAttribute('display', 'none');
    if (node.locked) p.classList.add('locked');
    return p;
  }

  _selectedPathNodes() {
    return this.store.selection.paths
      .map((id) => findNode(this.store.doc.layers, id))
      .filter((n) => n && n.type === 'path');
  }

  // 选中描边 + 锚点/控制柄（标记尺寸按 1/zoom 换算，屏幕上大小恒定）
  _renderOverlay() {
    this.overlay.replaceChildren();
    const inv = 1 / this.store.view.zoom;
    for (const node of this._selectedPathNodes()) {
      const d = pathToD(node.subpaths);
      this.overlay.append(el('path', { d, class: 'sel-outline', 'fill-rule': node.style.fillRule }));
      const b = pathBounds(node.subpaths);
      if (b) {
        this.overlay.append(el('rect', {
          x: b.x, y: b.y, width: b.w, height: b.h, class: 'sel-bbox',
          'stroke-width': inv,
        }));
      }
      node.subpaths.forEach((sp, si) => {
        sp.anchors.forEach((a, ai) => {
          const isActive = this.store.selection.anchor
            && this.store.selection.anchor.pathId === node.id
            && this.store.selection.anchor.si === si
            && this.store.selection.anchor.ai === ai;
          // 控制柄连线与端点
          if (isActive || this.store.selection.handle?.pathId === node.id) {
            const inP = add(V(a.x, a.y), a.hIn);
            const outP = add(V(a.x, a.y), a.hOut);
            if (!equalP(inP, V(a.x, a.y))) {
              this.overlay.append(el('line', { x1: a.x, y1: a.y, x2: inP.x, y2: inP.y, class: 'handle-line', 'stroke-width': inv }));
              this.overlay.append(el('circle', { cx: inP.x, cy: inP.y, r: HANDLE_HIT * 0.6 * inv, class: 'handle-point', 'data-side': 'in', 'stroke-width': inv }));
            }
            if (!equalP(outP, V(a.x, a.y))) {
              this.overlay.append(el('line', { x1: a.x, y1: a.y, x2: outP.x, y2: outP.y, class: 'handle-line', 'stroke-width': inv }));
              this.overlay.append(el('circle', { cx: outP.x, cy: outP.y, r: HANDLE_HIT * 0.6 * inv, class: 'handle-point', 'data-side': 'out', 'stroke-width': inv }));
            }
          }
          this.overlay.append(el('rect', {
            x: a.x - 3 * inv, y: a.y - 3 * inv, width: 6 * inv, height: 6 * inv,
            class: isActive ? 'anchor active' : 'anchor',
            'data-path': node.id, 'data-si': si, 'data-ai': ai, 'stroke-width': inv,
          }));
        });
      });
    }
  }

  _renderDraft() {
    this.draftLayer.replaceChildren();
    const draft = this.store.penDraft;
    if (!draft || !draft.anchors.length) return;
    const d = pathToD([{ closed: false, anchors: draft.anchors }]);
    this.draftLayer.append(el('path', { d, class: 'draft-path' }));
    if (this.draftHover) {
      const last = draft.anchors[draft.anchors.length - 1];
      this.draftLayer.append(el('line', {
        x1: last.x, y1: last.y, x2: this.draftHover.x, y2: this.draftHover.y, class: 'rubber',
        'stroke-width': 1 / this.store.view.zoom,
      }));
    }
  }

  // ---------- 命中测试 ----------
  _hitHandle(node, si, ai, pDoc) {
    const a = node.subpaths[si].anchors[ai];
    const tol = HANDLE_HIT / this.store.view.zoom;
    const inP = add(V(a.x, a.y), a.hIn);
    const outP = add(V(a.x, a.y), a.hOut);
    if (dist(pDoc, inP) <= tol) return 'in';
    if (dist(pDoc, outP) <= tol) return 'out';
    return null;
  }

  _hitAnchor(pDoc) {
    for (const node of this._selectedPathNodes()) {
      const tol = HANDLE_HIT / this.store.view.zoom;
      for (let si = 0; si < node.subpaths.length; si++) {
        const sp = node.subpaths[si];
        for (let ai = 0; ai < sp.anchors.length; ai++) {
          if (dist(pDoc, sp.anchors[ai]) <= tol) return { pathId: node.id, si, ai };
        }
      }
    }
    return null;
  }

  // 返回点下所有可见未锁定路径，按栈顶优先
  _hitPaths(pDoc) {
    const out = [];
    const visit = (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const node = list[i];
        if (node.type === 'group') {
          if (node.visible && !node.locked) visit(node.children);
          continue;
        }
        if (!node.visible || node.locked) continue;
        const strokeTol = PATH_HIT + node.style.strokeWidth / 2;
        if (distanceToPath(pDoc, node.subpaths) <= strokeTol
          || pointInPath(pDoc, node.subpaths, node.style.fillRule)) {
          out.push(node);
        }
      }
    };
    visit(this.store.doc.layers);
    return out;
  }

  _anchorSegmentAt(pDoc, node) {
    // 在选中路径上找距离最近的曲线段，供双击插入锚点
    let best = null;
    node.subpaths.forEach((sp, si) => {
      const a = sp.anchors;
      const count = sp.closed ? a.length : a.length - 1;
      for (let i = 0; i < count; i++) {
        const a0 = a[i], a1 = a[(i + 1) % a.length];
        const p0 = V(a0.x, a0.y), p1 = add(p0, a0.hOut);
        const p2 = add(V(a1.x, a1.y), a1.hIn), p3 = V(a1.x, a1.y);
        for (let k = 1; k < 24; k++) {
          const t = k / 24;
          const u = 1 - t;
          const q = V(
            u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
            u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
          );
          const d = dist(pDoc, q);
          if (!best || d < best.d) best = { d, si, ai: i, t };
        }
      }
    });
    if (best && best.d <= PATH_HIT + 8 / this.store.view.zoom) return best;
    return null;
  }

  // ---------- 事件 ----------
  _bindEvents() {
    const svg = this.svg;
    svg.addEventListener('pointerdown', (e) => this._onDown(e));
    window.addEventListener('pointermove', (e) => this._onMove(e));
    window.addEventListener('pointerup', (e) => this._onUp(e));
    svg.addEventListener('dblclick', (e) => this._onDblClick(e));
    svg.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !this.spaceDown) { this.spaceDown = true; svg.classList.add('panning'); }
      this._onKey(e);
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { this.spaceDown = false; svg.classList.remove('panning'); }
    });
    new ResizeObserver(() => this._renderGrid()).observe(this.mount);
  }

  _onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.zoomAt(e.clientX, e.clientY, factor);
  }

  zoomAt(clientX, clientY, factor) {
    const r = this.svg.getBoundingClientRect();
    const v = this.store.view;
    const before = V((clientX - r.left - v.panX) / v.zoom, (clientY - r.top - v.panY) / v.zoom);
    const zoom = Math.min(64, Math.max(0.05, v.zoom * factor));
    v.panX = clientX - r.left - before.x * zoom;
    v.panY = clientY - r.top - before.y * zoom;
    v.zoom = zoom;
    this.store.setView({ ...v });
  }

  zoomButton(factor) {
    const r = this.svg.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }

  fitView() {
    const { doc } = this.store;
    const r = this.svg.getBoundingClientRect();
    const pad = 48;
    const z = Math.min((r.width - pad * 2) / doc.width, (r.height - pad * 2) / doc.height, 4);
    const zoom = z > 0 ? z : 1;
    this.store.setView({
      zoom,
      panX: (r.width - doc.width * zoom) / 2,
      panY: (r.height - doc.height * zoom) / 2,
    });
  }

  _onDown(e) {
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      this.drag = { type: 'pan', start: V(e.clientX, e.clientY), view: { ...this.store.view } };
      this.svg.setPointerCapture?.(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    this.svg.focus();
    const p = this.toDoc(e.clientX, e.clientY);
    const tool = this.store.tool;
    if (tool === 'select') this._downSelect(e, p);
    else if (tool === 'pen') this._downPen(e, p);
    else this._downShape(e, p, tool);
  }

  // ----- 选择工具 -----
  _downSelect(e, p) {
    const sel = this.store.selection;
    // 1. 已选路径上的控制柄 / 锚点优先
    for (const ref of this._anchorRefs(sel)) {
      const node = findNode(this.store.doc.layers, ref.pathId);
      if (!node) continue;
      const side = this._hitHandle(node, ref.si, ref.ai, p);
      if (side && (sel.handle?.pathId === node.id || sel.anchor?.pathId === node.id)) {
        this.drag = { type: 'handle', ...ref, side };
        this.store.beginGesture('拖动控制柄');
        return;
      }
    }
    const anchorHit = this._hitAnchor(p);
    if (anchorHit) {
      this.store.select(sel.paths, anchorHit);
      this.drag = { type: 'anchor', ...anchorHit };
      this.store.beginGesture('拖动锚点');
      return;
    }
    // 2. 命中图形（含重叠轮换）
    const hits = this._hitPaths(p);
    if (hits.length) {
      let pick = hits[0];
      const now = performance.now();
      if (hits.length > 1 && this.lastCandidate
        && hits.some((h) => h.id === this.lastCandidate)
        && now - this.lastCandidateAt < 900 && !e.shiftKey) {
        const idx = hits.findIndex((h) => h.id === this.lastCandidate);
        pick = hits[(idx + 1) % hits.length];
      }
      this.lastCandidate = pick.id;
      this.lastCandidateAt = now;
      if (hits.length > 1) this._showCandidates(hits, e.clientX, e.clientY);
      else this._hideCandidates();

      if (e.shiftKey) this.store.toggleSelection(pick.id);
      else if (!sel.paths.includes(pick.id)) this.store.select([pick.id]);
      const node = findNode(this.store.doc.layers, pick.id);
      this.drag = {
        type: 'move',
        start: p,
        moved: false,
        snapshot: JSON.parse(JSON.stringify(this._selectedPathNodes().map((n) => ({ id: n.id, subpaths: n.subpaths })))),
      };
      this.store.beginGesture('移动路径');
      return;
    }
    // 3. 空白：清除选择 / 框选
    this._hideCandidates();
    if (!e.shiftKey) this.store.clearSelection();
    this.drag = { type: 'marquee', start: p };
  }

  _anchorRefs(sel) {
    const refs = [];
    if (sel.anchor) refs.push(sel.anchor);
    if (sel.handle) refs.push(sel.handle);
    return refs;
  }

  _showCandidates(hits, clientX, clientY) {
    const box = this.candidateBox;
    const r = this.mount.getBoundingClientRect();
    box.replaceChildren();
    const title = document.createElement('div');
    title.className = 'candidate-title';
    title.textContent = `重叠路径（${hits.length}）— 点击切换`;
    box.append(title);
    hits.forEach((h, i) => {
      const b = document.createElement('button');
      b.className = 'candidate-item';
      b.textContent = `${i + 1}. ${h.name}`;
      b.onclick = () => {
        this.store.select([h.id]);
        this._hideCandidates();
      };
      box.append(b);
    });
    box.style.left = `${clientX - r.left + 12}px`;
    box.style.top = `${clientY - r.top + 12}px`;
    box.hidden = false;
  }
  _hideCandidates() { this.candidateBox.hidden = true; }

  // ----- 钢笔工具 -----
  _downPen(e, p) {
    const draft = this.store.penDraft;
    if (!draft) {
      this.store.penDraft = { subIndex: 0, anchors: [anchor(p.x, p.y)] };
      this.drag = { type: 'pen-predict' };
      this.penDown = { start: p, moved: false };
      this.store.beginGesture('钢笔绘制');
      this.render();
      return;
    }
    // 点回起点 -> 闭合
    const first = draft.anchors[0];
    if (dist(p, first) <= HANDLE_HIT / this.store.view.zoom) {
      this._finishPen(true);
      return;
    }
    draft.anchors.push(anchor(p.x, p.y));
    this.penDown = { start: p, moved: false, ai: draft.anchors.length - 1 };
    this.drag = { type: 'pen-predict' };
    this.render();
  }

  _finishPen(closed) {
    const draft = this.store.penDraft;
    if (!draft) return;
    const anchors = draft.anchors;
    if (anchors.length >= 2 || (anchors.length === 1 && !closed)) {
      const sp = { closed, anchors: JSON.parse(JSON.stringify(anchors)) };
      const style = this.cb.getNewStyle ? this.cb.getNewStyle() : {};
      const node = createPath([sp], style, `路径 ${this.store.doc.layers.length + 1}`);
      insertNode(this.store.doc, node);
      this.cb.onStructureChange?.();
      this.store.select([node.id]);
    }
    this.store.penDraft = null;
    this.draftHover = null;
    this.store.commitGesture();
    this.drag = null;
    this.render();
  }

  cancelPen() {
    if (!this.store.penDraft) return;
    this.store.penDraft = null;
    this.draftHover = null;
    this.store.cancelGesture();
    this.drag = null;
    this.render();
  }

  // ----- 直线 / 矩形工具 -----
  _downShape(e, p, tool) {
    this.drag = { type: tool, start: p, current: p, shift: e.shiftKey };
    this.store.beginGesture(tool === 'rect' ? '绘制矩形' : '绘制直线');
  }

  _onMove(e) {
    const p = this.toDoc(e.clientX, e.clientY);
    if (!this.drag) {
      if (this.store.tool === 'pen' && this.store.penDraft) {
        this.draftHover = p;
        this._renderDraft();
      }
      this._updateCursor(p);
      return;
    }
    const d = this.drag;
    switch (d.type) {
      case 'pan': {
        const v = d.view;
        this.store.setView({
          ...v,
          panX: v.panX + (e.clientX - d.start.x),
          panY: v.panY + (e.clientY - d.start.y),
        });
        break;
      }
      case 'marquee':
        d.current = p;
        this._renderMarquee(d.start, p);
        break;
      case 'anchor': {
        const node = findNode(this.store.doc.layers, d.pathId);
        if (!node) break;
        const a = node.subpaths[d.si].anchors[d.ai];
        const delta = sub(p, V(a.x, a.y));
        this.store.updateGesture(() => moveAnchor(node, d.si, d.ai, delta, e.shiftKey));
        break;
      }
      case 'handle': {
        const node = findNode(this.store.doc.layers, d.pathId);
        if (!node) break;
        this.store.updateGesture(() => moveHandle(node, d.si, d.ai, d.side, p, e.altKey));
        break;
      }
      case 'move': {
        d.moved = true;
        const delta = sub(p, d.start);
        this.store.updateGesture(() => {
          for (const snap of d.snapshot) {
            const node = findNode(this.store.doc.layers, snap.id);
            if (!node || node.locked) continue;
            node.subpaths.forEach((sp, si) => sp.anchors.forEach((a, ai) => {
              const orig = snap.subpaths[si].anchors[ai];
              a.x = orig.x + delta.x; a.y = orig.y + delta.y;
            }));
          }
        });
        break;
      }
      case 'pen-predict': {
        if (this.penDown) {
          this.penDown.moved = true;
          const draft = this.store.penDraft;
          const ai = this.penDown.ai ?? draft.anchors.length - 1;
          const a = draft.anchors[ai];
          const h = sub(p, V(a.x, a.y));
          // 拖拽出向控制柄，入向镜像（平滑点）
          a.hOut = { dx: h.x, dy: h.y };
          a.hIn = { dx: -h.x, dy: -h.y };
          a.smooth = true;
          this._renderDraft();
        }
        break;
      }
      case 'line':
      case 'rect':
        d.current = p; d.shift = e.shiftKey;
        this._renderShapePreview(d);
        break;
    }
  }

  _onUp(e) {
    const d = this.drag;
    if (!d) return;
    if (d.type === 'pan') { this.drag = null; return; }
    if (d.type === 'marquee') {
      if (d.current) this._applyMarquee(d.start, d.current, e.shiftKey);
      this.drag = null;
      return;
    }
    if (d.type === 'anchor' || d.type === 'handle' || d.type === 'move') {
      this.store.commitGesture();
      this.drag = null;
      this.render();
      return;
    }
    if (d.type === 'pen-predict') {
      // 钢笔单击（未拖出控制柄）：保持当前点，手势仍在继续
      this.drag = null;
      this.penDown = null;
      return;
    }
    if (d.type === 'line' || d.type === 'rect') {
      const p0 = d.start, p1 = d.current || d.start;
      let subpaths;
      if (d.type === 'line') {
        let end = p1;
        if (d.shift) end = this._snap45(p0, p1);
        subpaths = lineSubpaths(p0.x, p0.y, end.x, end.y);
      } else {
        let x = Math.min(p0.x, p1.x), y = Math.min(p0.y, p1.y);
        let w = Math.abs(p1.x - p0.x), h = Math.abs(p1.y - p0.y);
        if (d.shift) { const s = Math.max(w, h); w = h = s; }
        subpaths = rectSubpaths(x, y, w, h);
      }
      const style = this.cb.getNewStyle ? this.cb.getNewStyle() : {};
      const node = createPath(subpaths, style, d.type === 'rect' ? '矩形' : '直线');
      insertNode(this.store.doc, node);
      this.cb.onStructureChange?.();
      this.store.commitGesture();
      this.store.select([node.id]);
      this.drag = null;
      this.render();
    }
  }

  _snap45(p0, p1) {
    const d = sub(p1, p0);
    const ang = Math.round(Math.atan2(d.y, d.x) / (Math.PI / 4)) * (Math.PI / 4);
    const l = Math.hypot(d.x, d.y);
    return add(p0, V(Math.cos(ang) * l, Math.sin(ang) * l));
  }

  _renderShapePreview(d) {
    this.draftLayer.replaceChildren();
    let subpaths;
    if (d.type === 'line') {
      const end = d.shift ? this._snap45(d.start, d.current) : d.current;
      subpaths = lineSubpaths(d.start.x, d.start.y, end.x, end.y);
    } else {
      let x = Math.min(d.start.x, d.current.x), y = Math.min(d.start.y, d.current.y);
      let w = Math.abs(d.current.x - d.start.x), h = Math.abs(d.current.y - d.start.y);
      if (d.shift) { const s = Math.max(w, h); w = h = s; }
      subpaths = rectSubpaths(x, y, w, h);
    }
    this.draftLayer.append(el('path', { d: pathToD(subpaths), class: 'draft-path' }));
  }

  _renderMarquee(a, b) {
    this.draftLayer.replaceChildren();
    this.draftLayer.append(el('rect', {
      x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
      class: 'marquee',
    }));
  }

  _applyMarquee(a, b, additive) {
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const hits = [];
    walk(this.store.doc.layers, (node) => {
      if (node.type !== 'path' || node.locked || !node.visible) return;
      const bd = pathBounds(node.subpaths);
      if (bd && bd.x >= x0 && bd.y >= y0 && bd.x + bd.w <= x1 && bd.y + bd.h <= y1) hits.push(node.id);
    });
    const ids = additive ? [...new Set([...this.store.selection.paths, ...hits])] : hits;
    this.store.select(ids);
    this.draftLayer.replaceChildren();
  }

  _onDblClick(e) {
    if (this.store.tool !== 'select') return;
    const p = this.toDoc(e.clientX, e.clientY);
    for (const node of this._selectedPathNodes()) {
      const seg = this._anchorSegmentAt(p, node);
      if (seg) {
        this.store.run('插入锚点', () => {
          const ref = insertAnchorOnSegment(node, seg.si, seg.ai, seg.t);
          this.store.select([node.id], { pathId: node.id, ...ref });
        });
        return;
      }
    }
  }

  _updateCursor(p) {
    if (this.spaceDown) { this.svg.style.cursor = 'grab'; return; }
    if (this.store.tool !== 'select') { this.svg.style.cursor = 'crosshair'; return; }
    this.svg.style.cursor = this._hitAnchor(p) || this._hitPaths(p).length ? 'pointer' : 'default';
  }

  _onKey(e) {
    if (e.target.matches('input, textarea, select')) return;
    const tag = (s) => { e.preventDefault(); this.store.setTool(s); };
    if (e.key === 'v' || e.key === 'V') tag('select');
    if (e.key === 'p' || e.key === 'P') tag('pen');
    if (e.key === 'l' || e.key === 'L') tag('line');
    if (e.key === 'r' || e.key === 'R') tag('rect');
    if (e.key === 'Escape') {
      if (this.store.penDraft) this.cancelPen();
      else { this.store.clearSelection(); this._hideCandidates(); }
    }
    if (e.key === 'Enter' && this.store.penDraft) this._finishPen(false);
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.store.selection.anchor) {
      const ref = this.store.selection.anchor;
      const node = findNode(this.store.doc.layers, ref.pathId);
      if (node) {
        e.preventDefault();
        this.store.run('删除锚点', () => {
          deleteAnchor(node, ref.si, ref.ai);
          if (!node.subpaths.length) return false;
          this.store.select([node.id]);
        });
      }
    }
    // 方向键微调
    if (e.key.startsWith('Arrow') && this.store.selection.paths.length) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const delta = {
        ArrowUp: V(0, -step), ArrowDown: V(0, step),
        ArrowLeft: V(-step, 0), ArrowRight: V(step, 0),
      }[e.key];
      this.store.run('微调位置', () => {
        for (const id of this.store.selection.paths) {
          const node = findNode(this.store.doc.layers, id);
          if (!node || node.locked) continue;
          for (const sp of node.subpaths) for (const a of sp.anchors) {
            a.x += delta.x; a.y += delta.y;
          }
        }
      });
    }
  }
}
