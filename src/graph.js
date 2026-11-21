/**
 * Canvas 剧情图：绘制、命中检测、拖拽、连线、缩放。
 * 所有几何信息由 layout() 计算，绘制与交互共用同一份结果。
 */
import { NODE_TYPES, choiceColor, getText } from './story.js';

const NODE_W = 212;
const HEAD_H = 30;
const PREVIEW_H = 30;
const ROW_H = 23;
const FOOT_H = 24;
const PORT_R = 6;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.2;

const COLORS = {
  bg: '#12141a',
  grid: 'rgba(255,255,255,0.028)',
  gridStrong: 'rgba(255,255,255,0.05)',
  nodeBg: '#1b1f28',
  nodeBgSel: '#202634',
  nodeBorder: '#2f3545',
  nodeBorderSel: '#d9a55f',
  title: '#e8eaf0',
  text: '#8d96a8',
  faint: '#5f687a',
  next: '#5b6478',
  nextHover: '#94a0b8',
  start: '#7fbf92',
  entry: '#7fa8c9',
  error: '#d97f7f',
  warning: '#d9a95f',
  hint: '#b3a2e0',
  cycle: '#9c8ad0',
  chip: '#262b37',
};

export class StoryGraph {
  constructor(canvas, { onSelect, onMove, onConnect, onAddNode, onContext, onHover, onZoom }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.handlers = { onSelect, onMove, onConnect, onAddNode, onContext, onHover, onZoom };
    this.camera = { x: 60, y: 40, scale: 1 };
    this.nodes = [];
    this.report = null;
    this.selectedId = null;
    this.editLocale = 'zh-CN';
    this.highlight = 'all';
    this.missingNodeIds = new Set();
    this.cycleNodeIds = new Set();
    this.hover = null;
    this.drag = null;
    this.linkDrag = null;
    this.panning = null;
    this.spaceDown = false;
    this.raf = 0;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.bind();
    this.resize();
    this.observe();
  }

  setData({ nodes, report, selectedId, editLocale, sourceLocale, highlight, missingNodeIds, cycleNodeIds }) {
    this.nodes = nodes;
    this.report = report;
    this.selectedId = selectedId;
    this.editLocale = editLocale || this.editLocale;
    this.sourceLocale = sourceLocale || this.sourceLocale || editLocale;
    this.highlight = highlight || 'all';
    this.missingNodeIds = missingNodeIds || new Set();
    this.cycleNodeIds = cycleNodeIds || new Set();
    this.requestDraw();
  }

  setSelection(selectedId) {
    if (this.selectedId === selectedId) return;
    this.selectedId = selectedId;
    this.requestDraw();
  }

  observe() {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement);
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.dpr = dpr;
    this.width = width;
    this.height = height;
    this.requestDraw();
  }

  requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  /* ------------------------------ 几何 ------------------------------ */
  nodeHeight(node) {
    return HEAD_H + PREVIEW_H + node.choices.length * ROW_H + FOOT_H;
  }

  layout() {
    const drag = this.dragPreview;
    const nodes = this.nodes.map((source) => {
      const node = source;
      const h = this.nodeHeight(node);
      const x = drag && drag.nodeId === node.id ? drag.x : node.position.x;
      const y = drag && drag.nodeId === node.id ? drag.y : node.position.y;
      const item = {
        id: node.id,
        node,
        x,
        y,
        w: NODE_W,
        h,
        ports: [],
      };
      if (node.choices.length) {
        node.choices.forEach((choice, index) => {
          item.ports.push({
            kind: 'choice',
            choiceId: choice.id,
            x: item.x + NODE_W,
            y: item.y + HEAD_H + PREVIEW_H + index * ROW_H + ROW_H / 2,
            color: choiceColor(index),
          });
        });
      }
      if (node.type !== 'end') {
        item.ports.push({
          kind: 'next',
          x: item.x + NODE_W,
          y: item.y + HEAD_H + PREVIEW_H + node.choices.length * ROW_H + FOOT_H / 2,
          color: COLORS.next,
        });
      }
      item.input = { x: item.x, y: item.y + 34 };
      return item;
    });
    return nodes;
  }

  toWorld(screenX, screenY) {
    return {
      x: (screenX - this.camera.x) / this.camera.scale,
      y: (screenY - this.camera.y) / this.camera.scale,
    };
  }

  toScreen(worldX, worldY) {
    return {
      x: worldX * this.camera.scale + this.camera.x,
      y: worldY * this.camera.scale + this.camera.y,
    };
  }

  pointerPos(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  hitTest(point) {
    const world = this.toWorld(point.x, point.y);
    const layout = this.layout();
    const portRadius = Math.max(9, PORT_R + 4) / this.camera.scale;
    for (const item of layout) {
      for (const port of item.ports) {
        if (Math.hypot(port.x - world.x, port.y - world.y) <= portRadius) {
          return { type: 'port', item, port };
        }
      }
    }
    for (let index = layout.length - 1; index >= 0; index -= 1) {
      const item = layout[index];
      if (world.x >= item.x && world.x <= item.x + item.w && world.y >= item.y && world.y <= item.y + item.h) {
        return { type: 'node', item };
      }
    }
    return { type: 'empty' };
  }

  /* ------------------------------ 交互 ------------------------------ */
  bind() {
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button === 2) return;
      const point = this.pointerPos(event);
      const hit = this.hitTest(point);
      this.canvas.setPointerCapture(event.pointerId);

      if (hit.type === 'port') {
        this.linkDrag = {
          fromNodeId: hit.item.id,
          choiceId: hit.port.kind === 'choice' ? hit.port.choiceId : null,
          start: { x: hit.port.x, y: hit.port.y },
          current: { x: hit.port.x, y: hit.port.y },
          origin: point,
          color: hit.port.color,
        };
        canvas.classList.add('linking');
        this.requestDraw();
        return;
      }

      if (hit.type === 'node') {
        this.handlers.onSelect?.(hit.item.id, null);
        const world = this.toWorld(point.x, point.y);
        this.drag = {
          nodeId: hit.item.id,
          originX: hit.item.node.position.x,
          originY: hit.item.node.position.y,
          offsetX: world.x - hit.item.node.position.x,
          offsetY: world.y - hit.item.node.position.y,
          startScreen: point,
          moved: false,
          lastWorld: { ...hit.item.node.position },
        };
        canvas.classList.add('dragging');
        this.requestDraw();
        return;
      }

      if (event.button === 1 || this.spaceDown || event.shiftKey) {
        this.panning = { start: point, camera: { ...this.camera } };
        canvas.classList.add('dragging');
        return;
      }

      this.panning = { start: point, camera: { ...this.camera } };
      this.handlers.onSelect?.(null, null);
      canvas.classList.add('dragging');
    });

    canvas.addEventListener('pointermove', (event) => {
      const point = this.pointerPos(event);

      if (this.drag) {
        const world = this.toWorld(point.x, point.y);
        const next = {
          x: Math.round(world.x - this.drag.offsetX),
          y: Math.round(world.y - this.drag.offsetY),
        };
        if (Math.abs(point.x - this.drag.startScreen.x) > 2 || Math.abs(point.y - this.drag.startScreen.y) > 2) {
          this.drag.moved = true;
        }
        this.drag.lastWorld = next;
        this.dragPreview = { nodeId: this.drag.nodeId, ...next };
        this.requestDraw();
        return;
      }

      if (this.linkDrag) {
        this.linkDrag.current = this.toWorld(point.x, point.y);
        const hit = this.hitTest(point);
        this.linkDrag.hoverNodeId = hit.type === 'node' ? hit.item.id : hit.type === 'port' ? hit.item.id : null;
        this.requestDraw();
        return;
      }

      if (this.panning) {
        this.camera.x = this.panning.camera.x + (point.x - this.panning.start.x);
        this.camera.y = this.panning.camera.y + (point.y - this.panning.start.y);
        this.requestDraw();
        return;
      }

      const hit = this.hitTest(point);
      const key = hit.type === 'node' ? `node:${hit.item.id}` : hit.type === 'port' ? `port:${hit.item.id}:${hit.port.choiceId || 'next'}` : null;
      if (key !== this.hover) {
        this.hover = key;
        this.handlers.onHover?.(hit.type === 'node' ? hit.item.node : hit.type === 'port' ? hit.item.node : null);
        this.requestDraw();
      }
      canvas.style.cursor =
        hit.type === 'port' ? 'crosshair' : hit.type === 'node' ? 'grab' : this.spaceDown ? 'grab' : 'default';
    });

    const finishDrag = (event) => {
      const point = this.pointerPos(event);

      if (this.drag) {
        if (this.drag.moved) {
          this.handlers.onMove?.(this.drag.nodeId, this.drag.lastWorld);
        }
        this.drag = null;
        this.dragPreview = null;
        canvas.classList.remove('dragging');
        this.requestDraw();
      }

      if (this.linkDrag) {
        const hit = this.hitTest(point);
        const link = this.linkDrag;
        this.linkDrag = null;
        canvas.classList.remove('linking');
        if (hit.type === 'node' && hit.item.id !== link.fromNodeId) {
          this.handlers.onConnect?.({ fromNodeId: link.fromNodeId, choiceId: link.choiceId, toNodeId: hit.item.id });
        } else if (hit.type === 'empty') {
          this.handlers.onAddNode?.(this.toWorld(point.x, point.y), {
            fromNodeId: link.fromNodeId,
            choiceId: link.choiceId,
          });
        }
        this.requestDraw();
      }

      if (this.panning) {
        this.panning = null;
        canvas.classList.remove('dragging');
      }
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };

    canvas.addEventListener('pointerup', finishDrag);
    canvas.addEventListener('pointercancel', (event) => {
      this.drag = null;
      this.dragPreview = null;
      this.linkDrag = null;
      this.panning = null;
      canvas.classList.remove('dragging', 'linking');
      this.requestDraw();
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    });

    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const point = this.pointerPos(event);
      const factor = Math.exp(-event.deltaY * 0.0014);
      this.zoomAt(point, factor);
    }, { passive: false });

    canvas.addEventListener('dblclick', (event) => {
      const point = this.pointerPos(event);
      const hit = this.hitTest(point);
      if (hit.type === 'empty') {
        this.handlers.onAddNode?.(this.toWorld(point.x, point.y), null);
      }
    });

    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const point = this.pointerPos(event);
      const hit = this.hitTest(point);
      this.handlers.onContext?.({
        x: event.clientX,
        y: event.clientY,
        nodeId: hit.type === 'node' ? hit.item.id : null,
        choiceId: hit.type === 'port' ? hit.port.choiceId : null,
      });
    });

    window.addEventListener('keydown', (event) => {
      if (event.code === 'Space' && !isTypingTarget(event.target)) {
        this.spaceDown = true;
        this.canvas.style.cursor = 'grab';
      }
    });
    window.addEventListener('keyup', (event) => {
      if (event.code === 'Space') {
        this.spaceDown = false;
        this.canvas.style.cursor = 'default';
      }
    });
  }

  zoomAt(point, factor) {
    const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.camera.scale * factor));
    const world = this.toWorld(point.x, point.y);
    this.camera.scale = nextScale;
    this.camera.x = point.x - world.x * nextScale;
    this.camera.y = point.y - world.y * nextScale;
    this.requestDraw();
    this.emitCamera();
  }

  setZoom(scale) {
    const center = { x: this.width / 2, y: this.height / 2 };
    const world = this.toWorld(center.x, center.y);
    this.camera.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    this.camera.x = center.x - world.x * this.camera.scale;
    this.camera.y = center.y - world.y * this.camera.scale;
    this.requestDraw();
    this.emitCamera();
  }

  zoomBy(factor) {
    this.setZoom(this.camera.scale * factor);
  }

  emitCamera() {
    this.handlers.onZoom?.(this.camera.scale);
  }

  fit({ padding = 80 } = {}) {
    if (!this.nodes.length) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of this.nodes) {
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + NODE_W);
      maxY = Math.max(maxY, node.position.y + this.nodeHeight(node));
    }
    const width = maxX - minX;
    const height = maxY - minY;
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min((this.width - padding * 2) / Math.max(1, width), (this.height - padding * 2) / Math.max(1, height))),
    );
    this.camera.scale = scale;
    this.camera.x = (this.width - width * scale) / 2 - minX * scale;
    this.camera.y = (this.height - height * scale) / 2 - minY * scale;
    this.requestDraw();
    this.emitCamera();
  }

  centerOn(nodeId) {
    const node = this.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const h = this.nodeHeight(node);
    this.camera.x = this.width / 2 - (node.position.x + NODE_W / 2) * this.camera.scale;
    this.camera.y = this.height / 2 - (node.position.y + h / 2) * this.camera.scale;
    this.requestDraw();
  }

  /* ------------------------------ 绘制 ------------------------------ */
  draw() {
    const ctx = this.ctx;
    const { dpr, width, height } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // 背景点阵
    this.drawGrid(ctx);

    ctx.save();
    ctx.translate(this.camera.x, this.camera.y);
    ctx.scale(this.camera.scale, this.camera.scale);

    const layout = this.layout();
    const byId = new Map(layout.map((item) => [item.id, item]));

    this.drawEdges(ctx, layout, byId);
    for (const item of layout) this.drawNode(ctx, item);
    if (this.linkDrag) this.drawLinkDrag(ctx, byId);

    ctx.restore();
  }

  drawGrid(ctx) {
    const scale = this.camera.scale;
    const step = 28 * scale;
    if (step < 8) return;
    const offsetX = this.camera.x % step;
    const offsetY = this.camera.y % step;
    ctx.fillStyle = COLORS.grid;
    for (let x = offsetX; x < this.width; x += step) {
      for (let y = offsetY; y < this.height; y += step) {
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  edgePath(from, to) {
    const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
    const path = new Path2D();
    path.moveTo(from.x, from.y);
    path.bezierCurveTo(from.x + dx, from.y, to.x - dx, to.y, to.x, to.y);
    return path;
  }

  drawEdges(ctx, layout, byId) {
    for (const item of layout) {
      const node = item.node;
      // 默认出口
      if (node.next) {
        const target = byId.get(node.next);
        const port = item.ports.find((p) => p.kind === 'next');
        if (target && port) {
          this.strokeEdge(ctx, port, target.input, COLORS.next, 1.5, null);
        } else if (port) {
          this.drawDanglingEdge(ctx, port, target ? '右侧未开放' : '失效目标');
        }
      }
      if (!node.choices.length) continue;
      node.choices.forEach((choice, index) => {
        const port = item.ports.find((p) => p.kind === 'choice' && p.choiceId === choice.id);
        const color = choiceColor(index);
        const target = choice.target ? byId.get(choice.target) : null;
        if (!port) return;
        if (target) {
          const label = choiceLabel(choice, this.editLocale);
          const condition = choice.condition?.trim();
          this.strokeEdge(ctx, port, target.input, color, 1.7, { label, condition, color });
        } else if (choice.target) {
          this.drawDanglingEdge(ctx, port, '失效目标');
        } else {
          this.drawDanglingEdge(ctx, port, '未连接');
        }
      });
    }
  }

  strokeEdge(ctx, from, to, color, width, meta) {
    const path = this.edgePath(from, to);
    ctx.save();
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.82;
    ctx.stroke(path);
    ctx.globalAlpha = 1;

    // 终点箭头：朝向来线方向
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    ctx.save();
    ctx.translate(to.x, to.y);
    ctx.rotate(angle);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-8, -4);
    ctx.lineTo(-8, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    if (meta) {
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
      this.drawEdgeLabel(ctx, midX, midY, meta);
    }
    ctx.restore();
  }

  drawEdgeLabel(ctx, x, y, meta) {
    const text = meta.label || '选项';
    const condition = meta.condition ? `if ${meta.condition}` : '';
    ctx.font = '10.5px "SF Mono", Menlo, monospace';
    const textWidth = ctx.measureText(text).width;
    ctx.font = '9.5px "SF Mono", Menlo, monospace';
    const condWidth = condition ? ctx.measureText(condition).width : 0;
    const w = Math.min(180, Math.max(textWidth, condWidth) + 14);
    const h = condition ? 30 : 17;
    const boxX = x - w / 2;
    const boxY = y - h / 2;

    ctx.fillStyle = 'rgba(18,20,26,0.88)';
    roundRect(ctx, boxX, boxY, w, h, 5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    roundRect(ctx, boxX, boxY, w, h, 5);
    ctx.clip();
    ctx.fillStyle = meta.color || '#aeb6c6';
    ctx.font = '10.5px "SF Mono", Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(ellipsize(ctx, text, w - 12), boxX + 7, condition ? boxY + 9 : y + 1);
    if (condition) {
      ctx.fillStyle = '#d9a95f';
      ctx.font = '9.5px "SF Mono", Menlo, monospace';
      ctx.fillText(ellipsize(ctx, condition, w - 12), boxX + 7, boxY + 22);
    }
    ctx.restore();
  }

  drawDanglingEdge(ctx, port, text) {
    ctx.save();
    ctx.strokeStyle = 'rgba(217,127,127,0.55)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(port.x, port.y);
    ctx.bezierCurveTo(port.x + 40, port.y, port.x + 30, port.y + 40, port.x + 12, port.y + 46);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(217,127,127,0.9)';
    ctx.font = '10px "SF Mono", Menlo, monospace';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 10;
    roundRect(ctx, port.x + 8, port.y + 40, w, 16, 4);
    ctx.fillStyle = 'rgba(30,22,24,0.92)';
    ctx.fill();
    ctx.fillStyle = 'rgba(224,148,148,0.95)';
    ctx.fillText(text, port.x + 13, port.y + 48.5);
    ctx.restore();
  }

  drawLinkDrag(ctx, byId) {
    const link = this.linkDrag;
    const to = link.current;
    ctx.save();
    ctx.strokeStyle = link.choiceId ? '#d9a55f' : '#8a94a8';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    const dx = Math.max(40, Math.abs(to.x - link.start.x) * 0.5);
    ctx.moveTo(link.start.x, link.start.y);
    ctx.bezierCurveTo(link.start.x + dx, link.start.y, to.x - dx, to.y, to.x, to.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(to.x, to.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#d9a55f';
    ctx.fill();
    if (link.hoverNodeId && byId.has(link.hoverNodeId)) {
      const target = byId.get(link.hoverNodeId);
      ctx.strokeStyle = 'rgba(217,165,95,0.8)';
      ctx.lineWidth = 2;
      roundRect(ctx, target.x - 3, target.y - 3, target.w + 6, target.h + 6, 12);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawNode(ctx, item) {
    const { node, x, y, w, h } = item;
    const selected = node.id === this.selectedId;
    const level = nodeLevel(this.report, node.id);
    const isStart = this.report && this.report.entryList?.some((entry) => entry.isStart && entry.nodeId === node.id);
    const isEntry = node.entry;
    const missing = this.missingNodeIds.has(node.id);
    const cycle = this.cycleNodeIds.has(node.id);
    const dimmed =
      (this.highlight === 'issues' && !level) ||
      (this.highlight === 'missing' && !missing) ||
      (this.highlight === 'cycles' && !cycle);

    ctx.save();
    ctx.globalAlpha = dimmed ? 0.3 : 1;

    // 阴影/选中光晕
    if (selected) {
      ctx.shadowColor = 'rgba(217,165,95,0.35)';
      ctx.shadowBlur = 18;
    }
    ctx.fillStyle = selected ? COLORS.nodeBgSel : COLORS.nodeBg;
    roundRect(ctx, x, y, w, h, 10);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 左边条：开始 / 入口 / 普通
    ctx.save();
    roundRect(ctx, x, y, w, h, 10);
    ctx.clip();
    ctx.fillStyle = isStart ? COLORS.start : isEntry ? COLORS.entry : cycle ? COLORS.cycle : 'rgba(255,255,255,0.07)';
    ctx.fillRect(x, y, 3, h);
    ctx.restore();

    ctx.lineWidth = selected ? 1.6 : 1;
    ctx.strokeStyle = selected ? COLORS.nodeBorderSel : level === 'error' ? 'rgba(217,127,127,0.5)' : COLORS.nodeBorder;
    roundRect(ctx, x, y, w, h, 10);
    ctx.stroke();

    // 标题行
    ctx.font = '600 12.5px "PingFang SC", system-ui, sans-serif';
    ctx.fillStyle = COLORS.title;
    ctx.textBaseline = 'middle';
    const badge = NODE_TYPES[node.type]?.label || '对话';
    ctx.font = '10px system-ui, sans-serif';
    const badgeW = ctx.measureText(badge).width + 10;
    const titleMax = w - badgeW - 36;
    ctx.font = '600 12.5px "PingFang SC", system-ui, sans-serif';
    ctx.fillText(ellipsize(ctx, node.title, titleMax), x + 12, y + 16);

    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = node.type === 'end' ? 'rgba(179,162,224,0.85)' : 'rgba(217,165,95,0.8)';
    const badgeX = x + w - badgeW - 10;
    roundRect(ctx, badgeX, y + 7, badgeW, 16, 4);
    ctx.fillStyle = node.type === 'end' ? 'rgba(179,162,224,0.12)' : 'rgba(217,165,95,0.1)';
    ctx.fill();
    ctx.fillStyle = node.type === 'end' ? '#c9bcec' : '#dcb27c';
    ctx.fillText(badge, badgeX + 5, y + 16);

    // 预览文本（当前编辑语言为空时回退到原文）
    const preview = getText(node.text, this.editLocale) || getText(node.text, this.sourceLocale);
    ctx.font = '11px "PingFang SC", system-ui, sans-serif';
    ctx.fillStyle = preview ? COLORS.text : COLORS.faint;
    const previewText = preview ? preview.replace(/\s+/g, ' ') : '（未填写文本）';
    ctx.fillText(ellipsize(ctx, previewText, w - 24), x + 12, y + HEAD_H + 12);

    // 选项行
    node.choices.forEach((choice, index) => {
      const rowY = y + HEAD_H + PREVIEW_H + index * ROW_H;
      const color = choiceColor(index);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x + 15, rowY + ROW_H / 2, 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = '10.5px "PingFang SC", system-ui, sans-serif';
      ctx.fillStyle = '#b9c1d2';
      const text = choiceLabel(choice, this.editLocale) || '（无文本）';
      const condWidth = choice.condition?.trim() ? 46 : 0;
      ctx.fillText(ellipsize(ctx, text, w - 52 - condWidth), x + 24, rowY + ROW_H / 2);
      if (choice.condition?.trim()) {
        ctx.font = '9px "SF Mono", Menlo, monospace';
        ctx.fillStyle = '#b9a077';
        ctx.fillText(ellipsize(ctx, `if ${choice.condition}`, 56), x + w - 66, rowY + ROW_H / 2);
      }

      ctx.strokeStyle = 'rgba(255,255,255,0.045)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 10, rowY);
      ctx.lineTo(x + w - 8, rowY);
      ctx.stroke();
    });

    // 底部：默认出口
    const footY = y + h - FOOT_H;
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.beginPath();
    ctx.moveTo(x + 10, footY);
    ctx.lineTo(x + w - 8, footY);
    ctx.stroke();

    ctx.font = '10px "PingFang SC", system-ui, sans-serif';
    if (node.next) {
      const target = this.nodes.find((item) => item.id === node.next);
      ctx.fillStyle = target ? 'rgba(170,182,201,0.8)' : 'rgba(217,127,127,0.9)';
      ctx.fillText(target ? `默认出口 → ${ellipsize(ctx, target.title, 96)}` : '默认出口 → 失效目标', x + 12, footY + FOOT_H / 2);
    } else if (!node.choices.length) {
      ctx.fillStyle = node.type === 'end' ? 'rgba(179,162,224,0.7)' : 'rgba(217,127,127,0.85)';
      ctx.fillText(node.type === 'end' ? '结局 · 流程结束' : '没有出口', x + 12, footY + FOOT_H / 2);
    } else {
      ctx.fillStyle = 'rgba(140,150,168,0.6)';
      ctx.fillText(`${node.choices.length} 个选项`, x + 12, footY + FOOT_H / 2);
    }

    // 端口
    for (const port of item.ports) {
      this.drawPort(ctx, port, selected);
    }
    // 输入端口
    ctx.beginPath();
    ctx.arc(item.input.x, item.input.y, PORT_R - 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#12141a';
    ctx.fill();
    ctx.strokeStyle = '#3a4154';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 标记：开始 / 入口
    if (isStart) {
      this.drawChip(ctx, x + w - 8, y - 8, '开始', COLORS.start);
    } else if (isEntry) {
      this.drawChip(ctx, x + w - 8, y - 8, '入口', COLORS.entry);
    }

    // 问题 / 缺译 / 循环标记
    let markerX = x + 8;
    if (level) {
      const color = level === 'error' ? COLORS.error : level === 'warning' ? COLORS.warning : COLORS.hint;
      ctx.beginPath();
      ctx.arc(markerX + 3, y - 7, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = '#1a1d24';
      ctx.font = '700 8px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(level === 'error' ? '!' : level === 'warning' ? '!' : 'i', markerX + 3, y - 6);
      ctx.textAlign = 'left';
      markerX += 15;
    }
    if (missing) {
      this.drawChip(ctx, markerX + 20, y - 7, '缺译', COLORS.warning);
      markerX += 40;
    }
    if (cycle) {
      this.drawChip(ctx, markerX + 20, y - 7, '循环', COLORS.cycle);
    }

    ctx.restore();
  }

  drawPort(ctx, port, selected) {
    ctx.beginPath();
    ctx.arc(port.x, port.y, PORT_R, 0, Math.PI * 2);
    ctx.fillStyle = '#12141a';
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = port.kind === 'next' ? (selected ? '#9aa5ba' : '#4a5266') : port.color;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(port.x, port.y, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = port.kind === 'next' ? (selected ? '#9aa5ba' : '#4a5266') : port.color;
    ctx.fill();
  }

  drawChip(ctx, centerX, centerY, text, color) {
    ctx.font = '9.5px "PingFang SC", system-ui, sans-serif';
    const w = ctx.measureText(text).width + 12;
    roundRect(ctx, centerX - w, centerY - 8, w, 16, 5);
    ctx.fillStyle = 'rgba(20,23,30,0.95)';
    ctx.fill();
    ctx.strokeStyle = `${color}66`;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, centerX - w + 6, centerY + 0.5);
  }
}

function choiceLabel(choice, locale) {
  return getText(choice.text, locale) || Object.values(choice.text || {}).find((value) => value?.trim()) || '';
}

function nodeLevel(report, nodeId) {
  const list = report?.byNode?.[nodeId];
  if (!list?.length) return null;
  if (list.some((issue) => issue.severity === 'error')) return 'error';
  if (list.some((issue) => issue.severity === 'warning')) return 'warning';
  return 'hint';
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function ellipsize(ctx, text, maxWidth) {
  const value = String(text ?? '');
  if (ctx.measureText(value).width <= maxWidth) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${value.slice(0, mid)}…`).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${value.slice(0, low)}…`;
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}
