import type { Curve, CurvePoint } from '../core/types.ts';
import { applyEasing } from '../core/curve.ts';
import { clamp } from '../core/rng.ts';
import { h } from './dom.ts';

const PADDING = { top: 10, right: 10, bottom: 18, left: 30 };

export interface CurveEditorOptions {
  /** 纵轴最小值提示；实际范围会自适应 */
  min?: number;
  max?: number;
  /** 数值格式化 */
  format?: (value: number) => string;
  onChange: (curve: Curve) => void;
  onCommit?: (curve: Curve) => void;
}

export interface CurveEditor {
  root: HTMLElement;
  setCurve(curve: Curve): void;
  setDisabled(disabled: boolean): void;
  destroy(): void;
}

/**
 * 可拖拽的曲线编辑器。
 * 拖点改值；双击空白处加点；右键 / 双击点上删除。
 * 所有修改都通过 onChange 直接写入工程，预览随即刷新。
 */
export function curveEditor(options: CurveEditorOptions): CurveEditor {
  const canvas = h('canvas', { class: 'curve-canvas', attrs: { 'aria-label': '曲线编辑器' } });
  const hint = h('div', { class: 'curve-hint' });
  const meta = h('div', { class: 'curve-meta' });
  const root = h('div', { class: 'curve-editor' }, canvas, h('div', { class: 'curve-footer' }, hint, meta));

  let curve: Curve = { points: [], interpolation: 'smoothstep' };
  let disabled = false;
  let dragIndex = -1;
  let hoverIndex = -1;
  let width = 300;
  let height = 132;
  let dpr = 1;

  const format = options.format ?? ((v: number) => v.toFixed(2));

  function configureCanvas() {
    dpr = Math.max(1, globalThis.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    width = Math.max(120, rect.width);
    height = Math.max(90, rect.height);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  function extent(): { min: number; max: number } {
    let min = options.min ?? 0;
    let max = options.max ?? 1;
    for (const point of curve.points) {
      min = Math.min(min, point.v);
      max = Math.max(max, point.v);
    }
    if (max - min < 1e-6) max = min + 1;
    // 留出头部空间，避免顶点贴边。
    const pad = (max - min) * 0.18;
    return { min: min - (min < 0 ? pad : 0), max: max + pad };
  }

  function plotArea() {
    return {
      x: PADDING.left,
      y: PADDING.top,
      w: width - PADDING.left - PADDING.right,
      h: height - PADDING.top - PADDING.bottom,
    };
  }

  function toScreen(point: CurvePoint, ext: { min: number; max: number }) {
    const area = plotArea();
    return {
      x: area.x + clamp(point.t, 0, 1) * area.w,
      y: area.y + area.h - ((point.v - ext.min) / (ext.max - ext.min)) * area.h,
    };
  }

  function fromScreen(px: number, py: number, ext: { min: number; max: number }) {
    const area = plotArea();
    return {
      t: clamp((px - area.x) / area.w, 0, 1),
      v: ext.min + ((area.y + area.h - py) / area.h) * (ext.max - ext.min),
    };
  }

  function draw() {
    configureCanvas();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ext = extent();
    const area = plotArea();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // 背景
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fillRect(area.x, area.y, area.w, area.h);

    // 网格
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = area.y + (area.h * i) / 4;
      ctx.beginPath();
      ctx.moveTo(area.x, y);
      ctx.lineTo(area.x + area.w, y);
      ctx.stroke();
    }
    for (let i = 0; i <= 4; i++) {
      const x = area.x + (area.w * i) / 4;
      ctx.beginPath();
      ctx.moveTo(x, area.y);
      ctx.lineTo(x, area.y + area.h);
      ctx.stroke();
    }

    // 轴标签
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(format(ext.max), area.x - 5, area.y + 1);
    ctx.fillText(format(ext.min), area.x - 5, area.y + area.h - 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('0', area.x, area.y + area.h + 4);
    ctx.fillText('寿命 1.0', area.x + area.w, area.y + area.h + 4);

    // 曲线
    const gradient = ctx.createLinearGradient(area.x, 0, area.x + area.w, 0);
    gradient.addColorStop(0, 'rgba(122, 226, 255, 0.9)');
    gradient.addColorStop(1, 'rgba(126, 255, 194, 0.9)');
    ctx.strokeStyle = disabled ? 'rgba(255,255,255,0.25)' : gradient;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const samples = 120;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const v = evalLocal(curve, t);
      const point = toScreen({ t, v }, ext);
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();

    // 填充
    ctx.lineTo(area.x + area.w, area.y + area.h);
    ctx.lineTo(area.x, area.y + area.h);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, area.y, 0, area.y + area.h);
    fill.addColorStop(0, 'rgba(122, 226, 255, 0.18)');
    fill.addColorStop(1, 'rgba(122, 226, 255, 0)');
    ctx.fillStyle = fill;
    ctx.fill();

    // 控制点
    curve.points.forEach((point, index) => {
      const p = toScreen(point, ext);
      const active = index === dragIndex || index === hoverIndex;
      ctx.beginPath();
      ctx.fillStyle = active ? '#7ae2ff' : 'rgba(12, 16, 22, 0.95)';
      ctx.strokeStyle = active ? '#ffffff' : 'rgba(122, 226, 255, 0.85)';
      ctx.lineWidth = 1.6;
      ctx.arc(p.x, p.y, active ? 5.4 : 4.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });

    if (dragIndex >= 0 && curve.points[dragIndex]) {
      const p = toScreen(curve.points[dragIndex], ext);
      const value = format(curve.points[dragIndex].v);
      const textWidth = ctx.measureText(value).width;
      ctx.fillStyle = 'rgba(10, 14, 20, 0.92)';
      ctx.strokeStyle = 'rgba(122, 226, 255, 0.4)';
      ctx.lineWidth = 1;
      const boxX = Math.min(Math.max(area.x, p.x - textWidth / 2 - 6), area.x + area.w - textWidth - 12);
      ctx.beginPath();
      ctx.roundRect(boxX, p.y - 24, textWidth + 12, 17, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#d6f4ff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(value, boxX + (textWidth + 12) / 2, p.y - 15.5);
    }

    meta.textContent = `${curve.points.length} 个控制点 · ${curve.interpolation === 'linear' ? '线性' : '平滑'}`;
  }

  function evalLocal(target: Curve, t: number): number {
    const points = target.points;
    if (points.length === 0) return 0;
    if (t <= points[0].t) return points[0].v;
    const last = points[points.length - 1];
    if (t >= last.t) return last.v;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (t <= b.t) {
        const span = b.t - a.t;
        if (span <= 1e-9) return b.v;
        const k = applyEasing(target.interpolation, (t - a.t) / span);
        return a.v + (b.v - a.v) * k;
      }
    }
    return last.v;
  }

  function localPoint(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function hitTest(px: number, py: number): number {
    const ext = extent();
    let best = -1;
    let bestDist = 12;
    curve.points.forEach((point, index) => {
      const p = toScreen(point, ext);
      const dist = Math.hypot(p.x - px, p.y - py);
      if (dist < bestDist) {
        bestDist = dist;
        best = index;
      }
    });
    return best;
  }

  function commit(points: CurvePoint[], final: boolean) {
    const normalized = [...points]
      .map((p) => ({ t: clamp(p.t, 0, 1), v: p.v }))
      .sort((a, b) => a.t - b.t);
    curve = { ...curve, points: normalized };
    options.onChange(cloneCurve(curve));
    if (final) options.onCommit?.(cloneCurve(curve));
    draw();
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (disabled) return;
    // 忽略右键：删除交由 contextmenu 处理。
    if (event.button !== 0) return;
    const { x, y } = localPoint(event);
    const ext = extent();
    const index = hitTest(x, y);
    if (index >= 0 && event.detail >= 2) {
      // 双击控制点：删除中间点（首末点保留）。
      if (index > 0 && index < curve.points.length - 1) {
        commit(
          curve.points.filter((_, i) => i !== index),
          true,
        );
      }
      event.preventDefault();
      return;
    }
    if (index >= 0) {
      dragIndex = index;
      canvas.setPointerCapture(event.pointerId);
      draw();
      event.preventDefault();
      return;
    }
    if (event.detail >= 2) {
      // 双击空白：添加控制点。
      const point = fromScreen(x, y, ext);
      commit([...curve.points, point], true);
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    if (disabled) return;
    const { x, y } = localPoint(event);
    const ext = extent();
    if (dragIndex >= 0) {
      const points = curve.points.map((p) => ({ ...p }));
      const target = points[dragIndex];
      if (!target) return;
      const point = fromScreen(x, y, ext);
      target.v = point.v;
      // 首末点只允许上下移动，保持曲线覆盖完整寿命。
      if (dragIndex > 0 && dragIndex < points.length - 1) {
        const lowNeighbor = points[dragIndex - 1].t + 1e-4;
        const highNeighbor = points[dragIndex + 1].t - 1e-4;
        target.t = clamp(point.t, Math.min(lowNeighbor, highNeighbor), Math.max(lowNeighbor, highNeighbor));
      }
      curve = { ...curve, points };
      options.onChange(cloneCurve(curve));
      draw();
      return;
    }
    const hover = hitTest(x, y);
    if (hover !== hoverIndex) {
      hoverIndex = hover;
      canvas.style.cursor = hover >= 0 ? 'grab' : 'crosshair';
      draw();
    }
  });

  const endDrag = () => {
    if (dragIndex < 0) return;
    dragIndex = -1;
    options.onCommit?.(cloneCurve(curve));
    draw();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (dragIndex >= 0) return;
    if (hoverIndex !== -1) {
      hoverIndex = -1;
      draw();
    }
  });

  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (disabled) return;
    const rect = canvas.getBoundingClientRect();
    const index = hitTest(event.clientX - rect.left, event.clientY - rect.top);
    if (index <= 0 || index >= curve.points.length - 1) return;
    commit(
      curve.points.filter((_, i) => i !== index),
      true,
    );
  });

  hint.textContent = '拖动控制点调整 · 双击空白添加 · 双击点删除';

  const observer = new ResizeObserver(() => draw());
  observer.observe(canvas);

  return {
    root,
    setCurve(next) {
      // 若内容未变就不重设，避免外部回写打断正在进行的拖拽。
      if (!curveChanged(curve, next)) return;
      curve = cloneCurve(next);
      draw();
    },
    setDisabled(next) {
      disabled = next;
      root.classList.toggle('is-disabled', next);
      canvas.style.cursor = next ? 'default' : 'crosshair';
      draw();
    },
    destroy() {
      observer.disconnect();
      root.remove();
    },
  };
}

function cloneCurve(curve: Curve): Curve {
  return { points: curve.points.map((p) => ({ ...p })), interpolation: curve.interpolation };
}

function curveChanged(a: Curve, b: Curve): boolean {
  if (a.interpolation !== b.interpolation) return true;
  if (a.points.length !== b.points.length) return true;
  for (let i = 0; i < a.points.length; i++) {
    if (a.points[i].t !== b.points[i].t || a.points[i].v !== b.points[i].v) return true;
  }
  return false;
}
