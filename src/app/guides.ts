import type { CompositionData } from '../core/types.js';
import { safeAreaRect } from '../core/evaluate.js';

export interface OverlayLayout {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Composition-guide overlay. This layer is DOM, not WebGL, which is what keeps
 * the guides (and all editor chrome) out of canvas screenshots/exports.
 */
export function renderGuides(
  host: HTMLElement,
  comp: CompositionData,
  layout: OverlayLayout,
  opts: { showGuides: boolean; width?: number; height?: number } = { showGuides: true },
): void {
  host.replaceChildren();
  if (!opts.showGuides) return;
  const hostWidth = opts.width ?? host.clientWidth;
  const hostHeight = opts.height ?? host.clientHeight;

  const { left, top, width, height } = layout;
  const frame = document.createElement('div');
  frame.className = 'guide guide-frame-border';
  frame.style.left = `${left}px`;
  frame.style.top = `${top}px`;
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  host.append(frame);

  // Letterbox masks (outside the frame).
  const masks: Array<[number, number, number, number]> = [];
  if (top > 0.5) masks.push([0, 0, hostWidth, top]);
  if (left > 0.5) masks.push([0, top, left, height]);
  const right = hostWidth - (left + width);
  const bottom = hostHeight - (top + height);
  if (right > 0.5) masks.push([left + width, top, right, height]);
  if (bottom > 0.5) masks.push([left, top + height, width, bottom]);
  for (const [x, y, w, h] of masks) {
    const mask = document.createElement('div');
    mask.className = 'guide guide-letterbox-mask';
    mask.style.left = `${x}px`;
    mask.style.top = `${y}px`;
    mask.style.width = `${w}px`;
    mask.style.height = `${h}px`;
    host.append(mask);
  }

  if (comp.showThirds) {
    for (const t of [1 / 3, 2 / 3]) {
      addLine(host, left + width * t, top, 1, height, 'guide-thirds-line');
      addLine(host, left, top + height * t, width, 1, 'guide-thirds-line');
    }
  }

  if (comp.showCenter) {
    addLine(host, left + width / 2, top, 1, height, 'guide-center-line');
    addLine(host, left, top + height / 2, width, 1, 'guide-center-line');
    const dot = document.createElement('div');
    dot.className = 'guide-center-dot';
    dot.style.left = `${left + width / 2}px`;
    dot.style.top = `${top + height / 2}px`;
    host.append(dot);
    // Small crosshair arms around the centre.
    addLine(host, left + width / 2 - 14, top + height / 2, 8, 1, 'guide-crosshair');
    addLine(host, left + width / 2 + 6, top + height / 2, 8, 1, 'guide-crosshair');
    addLine(host, left + width / 2, top + height / 2 - 14, 1, 8, 'guide-crosshair');
    addLine(host, left + width / 2, top + height / 2 + 6, 1, 8, 'guide-crosshair');
  }

  if (comp.showActionSafe) {
    const r = safeAreaRect(comp.actionSafePct);
    addSafeFrame(host, left, top, width, height, r, 'guide-safe', `动作安全框 ${comp.actionSafePct}%`);
  }
  if (comp.showTitleSafe) {
    const r = safeAreaRect(comp.titleSafePct);
    addSafeFrame(host, left, top, width, height, r, 'guide-safe is-title', `字幕安全框 ${comp.titleSafePct}%`);
  }

  // Corner aspect label.
  const label = document.createElement('div');
  label.className = 'guide-label';
  label.style.left = `${left + 6}px`;
  label.style.top = `${top + height - 15}px`;
  label.textContent = `${formatAspect(comp.aspect)} · ${Math.round(width)}×${Math.round(height)}`;
  host.append(label);
}

function addSafeFrame(
  host: HTMLElement,
  left: number,
  top: number,
  width: number,
  height: number,
  rect: { x0: number; y0: number; x1: number; y1: number },
  cls: string,
  labelText: string,
): void {
  const frame = document.createElement('div');
  frame.className = cls;
  frame.style.left = `${left + width * rect.x0}px`;
  frame.style.top = `${top + height * rect.y0}px`;
  frame.style.width = `${width * (rect.x1 - rect.x0)}px`;
  frame.style.height = `${height * (rect.y1 - rect.y0)}px`;
  host.append(frame);

  const label = document.createElement('div');
  label.className = 'guide-label';
  label.style.left = `${left + width * rect.x0 + 4}px`;
  label.style.top = `${top + height * rect.y0 + 3}px`;
  label.textContent = labelText;
  host.append(label);
}

function addLine(host: HTMLElement, x: number, y: number, w: number, h: number, cls: string): void {
  const line = document.createElement('div');
  line.className = cls;
  line.style.left = `${x}px`;
  line.style.top = `${y}px`;
  line.style.width = `${w}px`;
  line.style.height = `${h}px`;
  host.append(line);
}

export function formatAspect(aspect: number): string {
  const known: Array<[number, string]> = [
    [16 / 9, '16:9'],
    [4 / 3, '4:3'],
    [2.39, '2.39:1'],
    [1.85, '1.85:1'],
    [1, '1:1'],
    [9 / 16, '9:16'],
    [2 / 1, '2:1'],
    [21 / 9, '21:9'],
  ];
  for (const [v, label] of known) {
    if (Math.abs(v - aspect) < 0.02) return label;
  }
  return `${aspect.toFixed(2)}:1`;
}
