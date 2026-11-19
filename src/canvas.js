/**
 * 画布编辑器：视图变换、渲染、命中检测和指针交互。
 *
 * 关键约束：
 * - 所有持久化坐标都是图像像素坐标，屏幕坐标只存在于渲染/交互层；
 * - 每次缩放都以光标为锚点，缩放前后光标下的图像坐标不变；
 * - 我绘制的所有点、拖动后的所有顶点都会夹在图像边界内。
 */

import {
  HANDLE_CURSORS,
  MIN_RECT_SIZE,
  clamp,
  clampView,
  distance,
  fitView,
  hitTestPolygon,
  hitTestRect,
  imageToScreen,
  moveRectHandle,
  normalizePoint,
  normalizeRect,
  pointsBounds,
  rectHandles,
  roundTo,
  screenTolerance,
  screenToImage,
  zoomViewAt,
} from './geometry.js';

const ACCENT = '#3c9dff';
const WHITE = '#ffffff';
const DRAFT_FILL = 'rgba(60, 157, 255, 0.16)';

function hexToRgba(hex, alpha) {
  const value = String(hex || '#888888').replace('#', '');
  let full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  // #rrggbbaa：画布填充只取 RGB，透明度统一由 alpha 控制
  if (full.length === 8) full = full.slice(0, 6);
  const n = Number.parseInt(full, 16);
  const safe = Number.isFinite(n) ? n : 0x888888;
  return `rgba(${(safe >> 16) & 255}, ${(safe >> 8) & 255}, ${safe & 255}, ${alpha})`;
}

function translateGeometry(annotation, dx, dy, width, height) {
  if (annotation.type === 'rect') {
    const { x, y, width: w, height: h } = annotation.rect;
    const safeDx = clamp(dx, -x, width - (x + w));
    const safeDy = clamp(dy, -y, height - (y + h));
    return { rect: { ...annotation.rect, x: roundTo(x + safeDx), y: roundTo(y + safeDy) } };
  }
  // 整体平移：限制位移量而不是逐点夹取，避免贴边时把多边形压变形
  const bounds = pointsBounds(annotation.points);
  const safeDx = clamp(dx, -bounds.x, width - (bounds.x + bounds.width));
  const safeDy = clamp(dy, -bounds.y, height - (bounds.y + bounds.height));
  return {
    points: annotation.points.map(([x, y]) => [
      roundTo(x + safeDx),
      roundTo(y + safeDy),
    ]),
  };
}

export class CanvasEditor {
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.handlers = handlers;
    this.state = {
      image: null,
      annotations: [],
      labels: [],
      selectedId: null,
      tool: 'select',
      activeLabelId: null,
      imageBitmap: null,
      imageMissing: false,
    };
    this.view = { scale: 1, tx: 0, ty: 0 };
    this.draft = null; // { type:'polygon', points } | { type:'rect', start, current }
    this.drag = null;
    this.hover = null;
    this.preview = null;
    this.spaceHeld = false;
    this.cursor = null;
    this.pointer = null;
    this.lastPolygonClick = null;
    this.hasFitted = false;
    this.raf = 0;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.bindEvents();
    this.observeResize();
  }

  /* ---------------- state ---------------- */

  setState(patch) {
    if ('image' in patch && (patch.image?.id ?? null) !== (this.state.image?.id ?? null)) {
      // 切换图片后需要重新适应窗口，并丢弃旧图上的草稿/拖拽状态
      this.hasFitted = false;
      this.draft = null;
      this.drag = null;
      this.preview = null;
      this.cursor = null;
      this.emitDraftChange();
    }
    Object.assign(this.state, patch);
    this.scheduleRender();
  }

  setTool(tool) {
    if (this.state.tool === tool) return;
    this.cancelDraft(false);
    this.state.tool = tool;
    this.updateCursorStyle();
    this.scheduleRender();
    this.emitDraftChange();
  }

  setActiveLabelId(id) {
    this.state.activeLabelId = id;
  }

  setSelected(id) {
    this.state.selectedId = id;
    this.scheduleRender();
  }

  getSelected() {
    return this.state.annotations.find((annotation) => annotation.id === this.state.selectedId) ?? null;
  }

  hasDraft() {
    return Boolean(this.draft);
  }

  /* ---------------- view ---------------- */

  getView() {
    return { ...this.view };
  }

  setView(view) {
    this.view = view;
    this.handlers.onViewChange?.(this.getView());
    this.scheduleRender();
  }

  fit() {
    const image = this.state.image;
    if (!image) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    this.setView(fitView(image.width, image.height, rect.width, rect.height));
    this.hasFitted = true;
    this.scheduleRender();
  }

  /** 以画布中心为锚点缩放。 */
  zoomBy(factor) {
    const rect = this.canvas.getBoundingClientRect();
    const anchor = [rect.width / 2, rect.height / 2];
    this.applyZoom(factor, anchor);
  }

  applyZoom(factor, screenAnchor) {
    if (!this.state.image) return;
    // 缩放严格以锚点为中心：不在这里做常规平移夹取，
    // 否则靠近边缘缩放时光标下的图像坐标会漂移，后续落点随之偏移。
    const next = zoomViewAt(this.view, screenAnchor, this.view.scale * factor);
    const rect = this.canvas.getBoundingClientRect();
    // 仅在“整张图被缩到视口外”这种退化情况才拉回可见区域
    const scaledW = this.state.image.width * next.scale;
    const scaledH = this.state.image.height * next.scale;
    const fullyOutside = next.tx + scaledW < 0 || next.ty + scaledH < 0
      || next.tx > rect.width || next.ty > rect.height;
    this.view = fullyOutside
      ? clampView(next, this.state.image.width, this.state.image.height, rect.width, rect.height)
      : next;
    this.handlers.onViewChange?.(this.getView());
    this.scheduleRender();
  }

  /* ---------------- draft API ---------------- */

  undoDraftPoint() {
    if (!this.draft || this.draft.type !== 'polygon') return false;
    this.draft.points.pop();
    if (this.draft.points.length === 0) {
      this.draft = null;
    }
    this.emitDraftChange();
    this.scheduleRender();
    return true;
  }

  closeDraft() {
    if (!this.draft) return { ok: false, reason: '当前没有正在绘制的标注' };
    if (this.draft.type === 'rect') {
      const rect = normalizeRect(
        this.draft.start,
        this.draft.current,
        this.state.image.width,
        this.state.image.height,
      );
      this.draft = null;
      this.emitDraftChange();
      this.scheduleRender();
      if (rect.width < MIN_RECT_SIZE || rect.height < MIN_RECT_SIZE) {
        return { ok: false, reason: '矩形太小，已忽略' };
      }
      return this.commitShape({ type: 'rect', rect });
    }
    const points = this.finalizePolygonPoints(this.draft.points);
    if (!points) return { ok: false, reason: '多边形至少需要 3 个不同顶点' };
    this.draft = null;
    this.emitDraftChange();
    this.scheduleRender();
    return this.commitShape({ type: 'polygon', points });
  }

  cancelDraft(notify = true) {
    const had = Boolean(this.draft);
    this.draft = null;
    if (notify && had) this.handlers.onMessage?.('已取消当前绘制', false);
    this.emitDraftChange();
    this.scheduleRender();
    return had;
  }

  drawPointFromScreen(screenPoint) {
    const image = this.state.image;
    if (!image) return;
    if (!this.state.activeLabelId) {
      this.handlers.onMessage?.('请先在右侧新建或选择一个标签', true);
      return;
    }
    const point = normalizePoint(screenToImage(screenPoint, this.view), image.width, image.height);
    if (!this.draft) {
      this.draft = { type: 'polygon', points: [point] };
    } else if (this.draft.type === 'polygon') {
      const first = this.draft.points[0];
      const threshold = screenTolerance(this.view, 10);
      if (first && this.draft.points.length >= 3 && distance(point, first) <= threshold) {
        this.closeDraft();
        return;
      }
      this.draft.points.push(point);
    }
    this.emitDraftChange();
    this.scheduleRender();
  }

  finalizePolygonPoints(points) {
    const width = this.state.image.width;
    const height = this.state.image.height;
    const clean = [];
    for (const point of points) {
      const p = normalizePoint(point, width, height);
      const last = clean[clean.length - 1];
      if (last && distance(last, p) < 0.5) continue;
      clean.push(p);
    }
    if (clean.length > 2 && distance(clean[0], clean[clean.length - 1]) < 0.5) clean.pop();
    if (clean.length < 3) return null;
    // 完全退化的多边形（所有点共线）没有面积
    let area = 0;
    for (let i = 0; i < clean.length; i += 1) {
      const [x1, y1] = clean[i];
      const [x2, y2] = clean[(i + 1) % clean.length];
      area += x1 * y2 - x2 * y1;
    }
    if (Math.abs(area) < 1) return null;
    return clean;
  }

  commitShape(shape) {
    const labelId = this.state.activeLabelId;
    if (!labelId) {
      this.handlers.onMessage?.('请先在右侧新建或选择一个标签', true);
      return { ok: false, reason: '没有活动标签' };
    }
    const result = this.handlers.onCreate?.({ type: shape.type, labelId, ...shape });
    if (result && result.ok === false) {
      this.handlers.onMessage?.(result.reason ?? '创建标注失败', true);
      return { ok: false, reason: result.reason };
    }
    return { ok: true };
  }

  /** 微调选中标注（方向键）。 */
  nudgeSelected(dx, dy) {
    const annotation = this.getSelected();
    const image = this.state.image;
    if (!annotation || annotation.locked || !image) return false;
    const geometry = translateGeometry(annotation, dx, dy, image.width, image.height);
    this.handlers.onUpdateGeometry?.(annotation.id, geometry);
    return true;
  }

  /* ---------------- rendering ---------------- */

  scheduleRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  resizeBackingStore() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.dpr = dpr;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  render() {
    const ctx = this.ctx;
    const canvas = this.canvas;
    this.resizeBackingStore();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const image = this.state.image;
    if (!image) {
      ctx.fillStyle = '#6b7484';
      ctx.font = '13px -apple-system, "PingFang SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('导入图片或载入示例后开始标注', width / 2, height / 2);
      return;
    }

    // 首次渲染 / 切换图片后画布尺寸才确定：在这里补一次“适应窗口”，
    // 避免在布局完成前 fit() 因尺寸为 0 而失效，导致图片以 1:1 顶到左上角。
    if (!this.hasFitted && width > 2 && height > 2) {
      this.view = fitView(image.width, image.height, width, height);
      this.hasFitted = true;
      this.handlers.onViewChange?.(this.getView());
    }
    const { scale, tx, ty } = this.view;
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = scale < 2;

    const bitmap = this.state.imageBitmap;
    if (bitmap) {
      ctx.drawImage(bitmap, 0, 0, image.width, image.height);
    } else {
      this.drawImagePlaceholder(ctx, image);
    }
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.strokeRect(0, 0, image.width, image.height);

    const labelById = new Map(this.state.labels.map((label) => [label.id, label]));
    const selectedId = this.state.selectedId;
    for (const annotation of this.state.annotations) {
      const display = this.annotationForDisplay(annotation);
      if (!display) continue;
      const isSelected = annotation.id === selectedId;
      if (annotation.hidden && !isSelected) continue;
      this.drawAnnotation(ctx, display, labelById.get(annotation.labelId), {
        selected: isSelected,
        hidden: annotation.hidden,
        locked: annotation.locked,
        scale,
      });
    }

    this.drawDraft(ctx, scale);
    ctx.restore();

    this.drawScreenOverlays(ctx);
  }

  annotationForDisplay(annotation) {
    if (this.preview && this.preview.id === annotation.id) {
      return { ...annotation, ...this.preview.geometry };
    }
    return annotation;
  }

  drawImagePlaceholder(ctx, image) {
    ctx.fillStyle = '#171b22';
    ctx.fillRect(0, 0, image.width, image.height);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    const step = 32;
    ctx.beginPath();
    for (let x = 0; x <= image.width; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, image.height);
    }
    for (let y = 0; y <= image.height; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(image.width, y);
    }
    ctx.stroke();
    ctx.fillStyle = '#8b93a1';
    ctx.font = `${Math.max(12, 18 / this.view.scale)}px -apple-system, "PingFang SC", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('图片未载入（可重新导入同名图片）', image.width / 2, image.height / 2);
    ctx.textBaseline = 'alphabetic';
  }

  traceAnnotation(ctx, annotation) {
    if (annotation.type === 'rect') {
      const { x, y, width, height } = annotation.rect;
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      return;
    }
    ctx.beginPath();
    annotation.points.forEach(([x, y], index) => {
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }

  drawAnnotation(ctx, annotation, label, { selected, hidden, locked, scale }) {
    const color = label?.color ?? '#8b8d98';
    ctx.save();
    this.traceAnnotation(ctx, annotation);
    ctx.fillStyle = hidden ? 'rgba(255,255,255,0.03)' : hexToRgba(color, selected ? 0.32 : 0.2);
    ctx.fill();
    ctx.lineJoin = 'round';
    if (hidden) {
      ctx.setLineDash([4 / scale, 4 / scale]);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1 / scale;
    } else if (selected) {
      ctx.strokeStyle = WHITE;
      ctx.lineWidth = 3.5 / scale;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 / scale;
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6 / scale;
    }
    ctx.stroke();
    ctx.restore();
  }

  drawDraft(ctx, scale) {
    const draft = this.draft;
    if (!draft) return;
    if (draft.type === 'rect') {
      const rect = normalizeRect(
        draft.start,
        draft.current,
        this.state.image.width,
        this.state.image.height,
      );
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.fillStyle = DRAFT_FILL;
      ctx.fill();
      ctx.setLineDash([6 / scale, 4 / scale]);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.8 / scale;
      ctx.stroke();
      ctx.restore();
      return;
    }
    const points = draft.points;
    if (points.length === 0) return;
    ctx.save();
    ctx.beginPath();
    points.forEach(([x, y], index) => {
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.8 / scale;
    ctx.lineJoin = 'round';
    ctx.stroke();
    if (this.cursor) {
      const [lastX, lastY] = points[points.length - 1];
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(this.cursor[0], this.cursor[1]);
      ctx.setLineDash([5 / scale, 4 / scale]);
      ctx.strokeStyle = 'rgba(60,157,255,0.7)';
      ctx.stroke();
    }
    ctx.restore();
  }

  drawScreenOverlays(ctx) {
    const image = this.state.image;
    if (!image) return;
    const selectedId = this.state.selectedId;

    for (const annotation of this.state.annotations) {
      if (annotation.id !== selectedId) continue;
      if (annotation.hidden) continue;
      if (annotation.type === 'rect') {
        this.drawRectHandles(ctx, this.annotationForDisplay(annotation), annotation.locked);
      } else {
        const display = this.annotationForDisplay(annotation);
        this.drawVertexHandles(ctx, display.points, annotation.locked);
      }
    }

    // 标签名 chip
    const labelById = new Map(this.state.labels.map((label) => [label.id, label]));
    for (const annotation of this.state.annotations) {
      if (annotation.hidden && annotation.id !== selectedId) continue;
      this.drawLabelChip(ctx, annotation, labelById.get(annotation.labelId));
    }

    // 绘制中的实时提示
    if (this.draft?.type === 'polygon' && this.draft.points.length > 0) {
      const first = imageToScreen(this.draft.points[0], this.view);
      ctx.save();
      ctx.beginPath();
      ctx.arc(first[0], first[1], 7, 0, Math.PI * 2);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      this.drawVertexHandles(ctx, this.draft.points, false, true);
    }
    if (this.draft?.type === 'rect') {
      const rect = normalizeRect(
        this.draft.start,
        this.draft.current,
        image.width,
        image.height,
      );
      this.drawSizeBadge(ctx, rect);
    }
    if (this.draft?.type === 'polygon' && this.cursor) {
      this.drawPointDot(ctx, this.cursor);
    }
    if (this.drag?.kind === 'move' || this.drag?.kind === 'resize') {
      const base = this.getSelected();
      if (base) {
        const shown = this.annotationForDisplay(base);
        this.drawSizeBadge(ctx, shown.type === 'rect' ? shown.rect : pointsBounds(shown.points));
      }
    }
  }

  drawPointDot(ctx, imagePoint) {
    const screen = imageToScreen(imagePoint, this.view);
    ctx.save();
    ctx.beginPath();
    ctx.arc(screen[0], screen[1], 3, 0, Math.PI * 2);
    ctx.fillStyle = ACCENT;
    ctx.fill();
    ctx.restore();
  }

  drawVertexHandles(ctx, points, locked, draft = false) {
    if (locked && !draft) return;
    ctx.save();
    for (const point of points) {
      const [x, y] = imageToScreen(point, this.view);
      ctx.beginPath();
      ctx.rect(x - 4, y - 4, 8, 8);
      ctx.fillStyle = draft ? ACCENT : WHITE;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = draft ? WHITE : '#0b0d11';
      ctx.stroke();
    }
    ctx.restore();
  }

  drawRectHandles(ctx, annotation, locked) {
    if (locked) return;
    const handles = rectHandles(annotation.rect);
    ctx.save();
    for (const handle of handles) {
      const [x, y] = imageToScreen(handle.point, this.view);
      ctx.beginPath();
      ctx.rect(x - 3.5, y - 3.5, 7, 7);
      ctx.fillStyle = WHITE;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#0b0d11';
      ctx.stroke();
    }
    ctx.restore();
  }

  drawLabelChip(ctx, annotation, label) {
    if (!label) return;
    const shown = this.annotationForDisplay(annotation);
    const bounds = shown.type === 'rect'
      ? shown.rect
      : pointsBounds(shown.points);
    const topLeft = imageToScreen([bounds.x, bounds.y], this.view);
    const bottomRight = imageToScreen(
      [bounds.x + bounds.width, bounds.y + bounds.height],
      this.view,
    );
    if (bottomRight[0] - topLeft[0] < 16 && bottomRight[1] - topLeft[1] < 12) return;
    // 小于一定屏幕面积时只显示选中项，避免密集区域刷屏
    const area = (bottomRight[0] - topLeft[0]) * (bottomRight[1] - topLeft[1]);
    if (area < 900 && annotation.id !== this.state.selectedId) return;

    const text = annotation.hidden ? `${label.name} · 隐藏` : label.name;
    ctx.save();
    ctx.font = '600 10.5px -apple-system, "PingFang SC", sans-serif';
    const textWidth = ctx.measureText(text).width;
    const paddingX = 5;
    const chipW = textWidth + paddingX * 2;
    const chipH = 15;
    let x = topLeft[0];
    let y = topLeft[1] - chipH - 2;
    if (y < 2) y = Math.min(bottomRight[1] + 2, this.canvas.clientHeight - chipH - 2);
    if (x + chipW > this.canvas.clientWidth - 2) x = this.canvas.clientWidth - chipW - 2;
    x = Math.max(2, x);
    ctx.globalAlpha = annotation.hidden ? 0.55 : 1;
    ctx.fillStyle = label.color;
    this.roundRect(ctx, x, y, chipW, chipH, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + paddingX, y + chipH / 2 + 0.5);
    if (annotation.locked) {
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.beginPath();
      ctx.arc(x + chipW - 5, y + 4, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawSizeBadge(ctx, rect) {
    if (!rect) return;
    const text = `${Math.round(rect.width)} × ${Math.round(rect.height)} px`;
    ctx.save();
    ctx.font = '11px ui-monospace, Menlo, monospace';
    const w = ctx.measureText(text).width + 12;
    const screen = imageToScreen(
      [rect.x + rect.width / 2, rect.y + rect.height],
      this.view,
    );
    const x = screen[0] - w / 2;
    const y = screen[1] + 10;
    ctx.fillStyle = 'rgba(10,13,18,0.86)';
    this.roundRect(ctx, x, y, w, 20, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#dfe5ee';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, screen[0], y + 10.5);
    ctx.restore();
  }

  roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  /* ---------------- hit testing ---------------- */

  localPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  imagePoint(event) {
    return screenToImage(this.localPoint(event), this.view);
  }

  /**
   * 从最上层（最后绘制）往下找。
   * 先跳过锁定标注，避免顶层锁定项挡住下面可编辑的标注；
   * 如果没有可编辑项，再返回顶层的锁定项（用于选中/查看）。
   */
  hitAnnotation(point, { includeLocked = true } = {}) {
    const tolerance = screenTolerance(this.view, 6);
    let lockedHit = null;
    for (let i = this.state.annotations.length - 1; i >= 0; i -= 1) {
      const annotation = this.state.annotations[i];
      if (annotation.hidden) continue;
      const hit = annotation.type === 'rect'
        ? hitTestRect(point, annotation.rect, tolerance)
        : hitTestPolygon(point, annotation.points, tolerance);
      if (!hit) continue;
      if (!annotation.locked) return { annotation, hit };
      if (!lockedHit) lockedHit = { annotation, hit };
    }
    return includeLocked ? lockedHit : null;
  }

  /** 选中标注的控制点命中（优先于普通命中）。 */
  hitSelectedHandle(point) {
    const annotation = this.getSelected();
    if (!annotation || annotation.locked || annotation.hidden) return null;
    const tolerance = screenTolerance(this.view, 9);
    if (annotation.type === 'rect') {
      const hit = hitTestRect(point, annotation.rect, tolerance);
      if (hit?.part === 'handle') return hit;
      return null;
    }
    for (let i = 0; i < annotation.points.length; i += 1) {
      if (distance(point, annotation.points[i]) <= tolerance) {
        return { part: 'vertex', index: i };
      }
    }
    return null;
  }

  /* ---------------- events ---------------- */

  bindEvents() {
    const canvas = this.canvas;
    this.onPointerDown = this.handlePointerDown.bind(this);
    this.onPointerMove = this.handlePointerMove.bind(this);
    this.onPointerUp = this.handlePointerUp.bind(this);
    this.onPointerLeave = this.handlePointerLeave.bind(this);
    this.onWheel = this.handleWheel.bind(this);
    this.onContextMenu = (event) => event.preventDefault();
    this.onKeyDown = this.handleKeyDown.bind(this);
    this.onKeyUp = this.handleKeyUp.bind(this);

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.onContextMenu);
    canvas.addEventListener('keydown', this.onKeyDown);
    canvas.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  observeResize() {
    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleRender();
    });
    this.resizeObserver.observe(this.canvas);
  }

  handleKeyDown(event) {
    if (event.code === 'Space' && !this.isEditingText(event.target)) {
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        this.updateCursorStyle();
      }
      if (event.target === this.canvas) event.preventDefault();
    }
  }

  handleKeyUp(event) {
    if (event.code === 'Space') {
      this.spaceHeld = false;
      this.updateCursorStyle();
    }
  }

  isEditingText(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  handleWheel(event) {
    if (!this.state.image) return;
    event.preventDefault();
    const point = this.localPoint(event);
    if (event.shiftKey) {
      // Shift + 滚轮：水平平移
      this.view = { ...this.view, tx: this.view.tx - event.deltaY };
      this.handlers.onViewChange?.(this.getView());
      this.scheduleRender();
      return;
    }
    // 鼠标滚轮一次 deltaY≈100，对应的缩放系数约为 1.25；
    // 触控板/捏合会给出更小的 delta，缩放更细腻。
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.012 : 0.0022));
    this.applyZoom(factor, point);
  }

  handlePointerDown(event) {
    if (!this.state.image) return;
    this.canvas.focus({ preventScroll: true });
    const local = this.localPoint(event);
    const imagePoint = screenToImage(local, this.view);
    this.pointer = local;
    this.cursor = imagePoint;

    if (event.button === 2) {
      // 右键：绘制时退一个点/取消；非绘制时取消选中
      if (this.draft) {
        this.cancelDraft();
      } else if (this.state.selectedId) {
        this.handlers.onSelect?.(null);
      }
      return;
    }

    const panButton = event.button === 1 || this.spaceHeld;
    if (panButton) {
      this.startPan(event, local);
      return;
    }
    if (event.button !== 0) return;

    if (this.state.tool === 'polygon') {
      // PointerEvent 的 detail 通常为 0，这里自己判断双击：
      // 短时间内、同一位置再次点击 → 闭合，而不是再补一个几乎重合的顶点。
      const last = this.lastPolygonClick;
      const isDoubleClick = last
        && event.timeStamp - last.time < 350
        && Math.hypot(local[0] - last.x, local[1] - last.y) < 5;
      this.lastPolygonClick = { time: event.timeStamp, x: local[0], y: local[1] };
      if (isDoubleClick && this.draft?.type === 'polygon' && this.draft.points.length >= 3) {
        const result = this.closeDraft();
        if (!result.ok && result.reason) this.handlers.onMessage?.(result.reason, true);
        return;
      }
      this.drawPointFromScreen(local);
      return;
    }

    if (this.state.tool === 'rect') {
      if (!this.state.activeLabelId) {
        this.handlers.onMessage?.('请先在右侧新建或选择一个标签', true);
        return;
      }
      this.draft = { type: 'rect', start: imagePoint, current: imagePoint };
      this.drag = {
        kind: 'draw-rect',
        start: local,
        startImage: imagePoint,
        pointerId: event.pointerId,
      };
      this.canvas.setPointerCapture(event.pointerId);
      this.emitDraftChange();
      this.scheduleRender();
      return;
    }

    // 选择工具
    const handle = this.hitSelectedHandle(imagePoint);
    if (handle) {
      const annotation = this.getSelected();
      this.drag = {
        kind: annotation.type === 'rect' ? 'resize' : 'vertex',
        annId: annotation.id,
        handle: handle.part === 'handle' ? handle.handle : null,
        vertexIndex: handle.part === 'vertex' ? handle.index : -1,
        startImage: imagePoint,
        snapshot: annotation,
        geometry: null,
        pointerId: event.pointerId,
      };
      this.preview = { id: annotation.id, geometry: {} };
      this.canvas.setPointerCapture(event.pointerId);
      this.updateCursorStyle(annotation.type === 'rect' ? HANDLE_CURSORS[handle.handle] : 'crosshair');
      return;
    }

    const hit = this.hitAnnotation(imagePoint);
    if (hit) {
      const { annotation, hit: hitInfo } = hit;
      if (annotation.id !== this.state.selectedId) {
        this.handlers.onSelect?.(annotation.id);
      }
      if (annotation.locked) {
        this.handlers.onMessage?.('该标注已锁定，先解锁才能编辑', true);
        this.scheduleRender();
        return;
      }
      if (hitInfo.part === 'vertex' && annotation.type === 'polygon') {
        this.drag = {
          kind: 'vertex',
          annId: annotation.id,
          vertexIndex: hitInfo.index,
          startImage: imagePoint,
          snapshot: annotation,
          geometry: null,
          pointerId: event.pointerId,
        };
        this.preview = { id: annotation.id, geometry: {} };
      } else {
        this.drag = {
          kind: 'move',
          annId: annotation.id,
          startImage: imagePoint,
          snapshot: annotation,
          geometry: null,
          pointerId: event.pointerId,
        };
        this.preview = { id: annotation.id, geometry: {} };
      }
      this.canvas.setPointerCapture(event.pointerId);
      this.updateCursorStyle('move');
      this.scheduleRender();
      return;
    }

    // 空白处：取消选中并平移
    if (this.state.selectedId) this.handlers.onSelect?.(null);
    this.startPan(event, local);
  }

  startPan(event, local) {
    this.drag = {
      kind: 'pan',
      start: local,
      startView: { ...this.view },
      pointerId: event.pointerId,
    };
    this.canvas.setPointerCapture(event.pointerId);
    this.updateCursorStyle('grabbing');
  }

  handlePointerMove(event) {
    if (!this.state.image) return;
    const local = this.localPoint(event);
    this.pointer = local;
    const imagePoint = screenToImage(local, this.view);
    this.cursor = imagePoint;
    const image = this.state.image;
    const bounded = normalizePoint(imagePoint, image.width, image.height);
    this.handlers.onCursor?.(bounded, imagePoint);

    const drag = this.drag;
    if (!drag) {
      this.updateHoverCursor(imagePoint);
      if (this.draft) this.scheduleRender();
      return;
    }

    if (drag.kind === 'pan') {
      const next = clampView(
        {
          scale: drag.startView.scale,
          tx: drag.startView.tx + (local[0] - drag.start[0]),
          ty: drag.startView.ty + (local[1] - drag.start[1]),
        },
        image.width,
        image.height,
        this.canvas.clientWidth,
        this.canvas.clientHeight,
      );
      this.view = next;
      this.handlers.onViewChange?.(this.getView());
      this.scheduleRender();
      return;
    }

    if (drag.kind === 'draw-rect') {
      this.draft.current = normalizePoint(imagePoint, image.width, image.height);
      this.scheduleRender();
      return;
    }

    if (drag.kind === 'move') {
      const snapshot = drag.snapshot;
      let dx = imagePoint[0] - drag.startImage[0];
      let dy = imagePoint[1] - drag.startImage[1];
      if (snapshot.type === 'rect') {
        dx = clamp(dx, -snapshot.rect.x, image.width - (snapshot.rect.x + snapshot.rect.width));
        dy = clamp(dy, -snapshot.rect.y, image.height - (snapshot.rect.y + snapshot.rect.height));
      } else {
        const bounds = pointsBounds(snapshot.points);
        dx = clamp(dx, -bounds.x, image.width - (bounds.x + bounds.width));
        dy = clamp(dy, -bounds.y, image.height - (bounds.y + bounds.height));
      }
      drag.geometry = snapshot.type === 'rect'
        ? { rect: { ...snapshot.rect, x: roundTo(snapshot.rect.x + dx), y: roundTo(snapshot.rect.y + dy) } }
        : { points: snapshot.points.map(([x, y]) => [roundTo(x + dx), roundTo(y + dy)]) };
      this.preview = { id: drag.annId, geometry: drag.geometry };
      this.scheduleRender();
      return;
    }

    if (drag.kind === 'vertex') {
      const snapshot = drag.snapshot;
      const points = snapshot.points.map((point, index) => (
        index === drag.vertexIndex ? normalizePoint(imagePoint, image.width, image.height) : point
      ));
      drag.geometry = { points };
      this.preview = { id: drag.annId, geometry: drag.geometry };
      this.scheduleRender();
      return;
    }

    if (drag.kind === 'resize') {
      const snapshot = drag.snapshot;
      const rect = this.resizeRect(snapshot.rect, drag.handle, imagePoint, image.width, image.height);
      drag.geometry = { rect };
      this.preview = { id: drag.annId, geometry: drag.geometry };
      this.scheduleRender();
    }
  }

  /** 拖动矩形控制点；复用 geometry 中的实现，越界会被夹住且保留最小尺寸。 */
  resizeRect(rect, handle, point, width, height) {
    return moveRectHandle(rect, handle, point, width, height, MIN_RECT_SIZE);
  }

  handlePointerUp(event) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(drag.pointerId);
    } catch {
      // 指针可能已经释放
    }

    if (drag.kind === 'pan') {
      this.updateCursorStyle();
      this.scheduleRender();
      return;
    }

    if (drag.kind === 'draw-rect') {
      // 优先用指针释放位置作为终点；pointercancel 时退回最后一次移动的位置
      const image = this.state.image;
      const endImage = event?.type === 'pointercancel'
        ? (this.draft?.current ?? drag.startImage)
        : screenToImage(this.localPoint(event), this.view);
      const rect = normalizeRect(drag.startImage, endImage, image.width, image.height);
      this.draft = null;
      this.emitDraftChange();
      this.preview = null;
      this.scheduleRender();
      if (rect.width < MIN_RECT_SIZE || rect.height < MIN_RECT_SIZE) {
        return;
      }
      this.commitShape({ type: 'rect', rect });
      return;
    }

    const geometry = drag.geometry;
    this.preview = null;
    this.updateCursorStyle();
    if (geometry && this.hasGeometryChange(drag.snapshot, geometry)) {
      this.handlers.onUpdateGeometry?.(drag.annId, geometry);
    } else {
      this.scheduleRender();
    }
  }

  hasGeometryChange(snapshot, geometry) {
    if (snapshot.type === 'rect' && geometry.rect) {
      const a = snapshot.rect;
      const b = geometry.rect;
      return ['x', 'y', 'width', 'height'].some((key) => Math.abs(a[key] - b[key]) > 0.001);
    }
    if (snapshot.type === 'polygon' && geometry.points) {
      return geometry.points.some((point, index) => {
        const origin = snapshot.points[index];
        return !origin || Math.abs(origin[0] - point[0]) > 0.001 || Math.abs(origin[1] - point[1]) > 0.001;
      });
    }
    return false;
  }

  handlePointerLeave() {
    if (this.drag) return;
    this.cursor = null;
    this.handlers.onCursor?.(null);
    this.scheduleRender();
  }

  updateHoverCursor(imagePoint) {
    if (!this.state.image) return;
    if (this.spaceHeld) {
      this.canvas.style.cursor = this.drag ? 'grabbing' : 'grab';
      return;
    }
    if (this.state.tool !== 'select') {
      this.canvas.style.cursor = 'crosshair';
      return;
    }
    const handle = this.hitSelectedHandle(imagePoint);
    if (handle) {
      const annotation = this.getSelected();
      this.canvas.style.cursor = annotation.type === 'rect'
        ? HANDLE_CURSORS[handle.handle]
        : 'crosshair';
      return;
    }
    const hit = this.hitAnnotation(imagePoint);
    this.canvas.style.cursor = hit
      ? (hit.annotation.locked ? 'not-allowed' : 'move')
      : 'default';
  }

  updateCursorStyle(override = null) {
    if (override) {
      this.canvas.style.cursor = override;
      return;
    }
    if (this.spaceHeld) {
      this.canvas.style.cursor = 'grab';
      return;
    }
    if (this.state.tool === 'select') {
      this.canvas.style.cursor = 'default';
    } else {
      this.canvas.style.cursor = 'crosshair';
    }
  }

  emitDraftChange() {
    const draft = this.draft;
    this.handlers.onDraftChange?.({
      active: Boolean(draft),
      type: draft?.type ?? null,
      pointCount: draft?.type === 'polygon' ? draft.points.length : 0,
    });
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}
