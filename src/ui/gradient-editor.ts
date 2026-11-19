import type { ColorStop, Gradient } from '../core/types.ts';
import { clamp } from '../core/rng.ts';
import { h } from './dom.ts';

export interface GradientEditorOptions {
  onChange: (gradient: Gradient) => void;
  onCommit?: (gradient: Gradient) => void;
}

export interface GradientEditor {
  root: HTMLElement;
  setGradient(gradient: Gradient): void;
  setDisabled(disabled: boolean): void;
  destroy(): void;
}

/** 颜色渐变编辑：拖动色标改位置，双击色带加点，双击色标改色，右键删除。 */
export function gradientEditor(options: GradientEditorOptions): GradientEditor {
  const bar = h('div', { class: 'gradient-bar' });
  const stopsLayer = h('div', { class: 'gradient-stops' });
  const track = h('div', { class: 'gradient-track' }, bar, stopsLayer);
  const colorInput = h('input', { class: 'gradient-color-input', attrs: { type: 'color', 'aria-label': '色标颜色' } });
  const hint = h('span', {
    class: 'curve-hint',
    text: '双击色带加点 · 拖动改位置 · 双击色标改色 · 右键删除',
  });
  const meta = h('span', { class: 'curve-meta' });
  const footer = h('div', { class: 'curve-footer' }, hint, meta);
  const root = h('div', { class: 'gradient-editor' }, track, colorInput, footer);

  let gradient: Gradient = { stops: [] };
  let disabled = false;
  let dragIndex = -1;

  function updateBg() {
    const sorted = [...gradient.stops].sort((a, b) => a.t - b.t);
    if (sorted.length === 0) {
      bar.style.background = '#222';
      return;
    }
    bar.style.background =
      sorted.length === 1
        ? `linear-gradient(90deg, ${sorted[0].color}, ${sorted[0].color})`
        : `linear-gradient(90deg, ${sorted
            .map((s) => `${s.color} ${(clamp(s.t, 0, 1) * 100).toFixed(2)}%`)
            .join(', ')})`;
  }

  function commit(stops: ColorStop[], final: boolean) {
    gradient = {
      stops: [...stops]
        .map((s) => ({ t: clamp(s.t, 0, 1), color: s.color }))
        .sort((a, b) => a.t - b.t),
    };
    options.onChange(cloneGradient(gradient));
    if (final) options.onCommit?.(cloneGradient(gradient));
    updateBg();
    renderStops();
  }

  function openColorPicker(index: number) {
    const stop = gradient.stops[index];
    if (!stop) return;
    colorInput.value = stop.color;
    colorInput.dataset.index = String(index);
    // 用隐藏的 color input 触发系统取色器。
    colorInput.click();
  }

  colorInput.addEventListener('input', () => {
    const index = Number(colorInput.dataset.index);
    if (!Number.isFinite(index)) return;
    const stops = gradient.stops.map((s) => ({ ...s }));
    const target = stops[index];
    if (!target) return;
    target.color = colorInput.value;
    gradient = { stops };
    options.onChange(cloneGradient(gradient));
    updateBg();
    renderStops();
  });
  colorInput.addEventListener('change', () => {
    options.onCommit?.(cloneGradient(gradient));
  });

  function renderStops() {
    stopsLayer.replaceChildren();
    gradient.stops.forEach((stop, index) => {
      const handle = h('button', {
        class: 'gradient-stop',
        attrs: { type: 'button', 'aria-label': `色标 ${index + 1}：${stop.color}` },
      });
      handle.style.left = `${clamp(stop.t, 0, 1) * 100}%`;
      handle.style.setProperty('--stop-color', stop.color);

      handle.addEventListener('pointerdown', (event) => {
        if (disabled) return;
        dragIndex = index;
        event.preventDefault();
        event.stopPropagation();
      });

      handle.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        event.preventDefault();
        if (disabled) return;
        openColorPicker(index);
      });

      handle.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (disabled || gradient.stops.length <= 2) return;
        commit(
          gradient.stops.filter((_, i) => i !== index),
          true,
        );
      });
      stopsLayer.append(handle);
    });
    meta.textContent = `${gradient.stops.length} 个色标`;
  }

  // 拖动在 window 上统一处理，色标节点重建也不会中断。
  function onWindowPointerMove(event: PointerEvent) {
    if (dragIndex < 0 || disabled) return;
    const rect = track.getBoundingClientRect();
    const t = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const stops = gradient.stops.map((s) => ({ ...s }));
    const target = stops[dragIndex];
    if (!target) return;
    target.t = t;
    const sorted = [...stops].sort((a, b) => a.t - b.t);
    dragIndex = sorted.indexOf(target);
    gradient = { stops: sorted };
    options.onChange(cloneGradient(gradient));
    updateBg();
    renderStops();
  }

  function onWindowPointerUp() {
    if (dragIndex < 0) return;
    dragIndex = -1;
    options.onCommit?.(cloneGradient(gradient));
  }

  window.addEventListener('pointermove', onWindowPointerMove);
  window.addEventListener('pointerup', onWindowPointerUp);
  window.addEventListener('pointercancel', onWindowPointerUp);

  track.addEventListener('dblclick', (event) => {
    if (disabled) return;
    if (event.target !== track && event.target !== bar) return;
    const rect = track.getBoundingClientRect();
    const t = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    commit([...gradient.stops, { t, color: sampleCss(t) }], true);
  });

  function sampleCss(t: number): string {
    const stops = [...gradient.stops].sort((a, b) => a.t - b.t);
    if (stops.length === 0) return '#ffffff';
    if (t <= stops[0].t) return stops[0].color;
    const last = stops[stops.length - 1];
    if (t >= last.t) return last.color;
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1];
      const b = stops[i];
      if (t <= b.t) {
        const span = b.t - a.t;
        const k = span <= 1e-9 ? 1 : (t - a.t) / span;
        const ca = hexToRgb(a.color);
        const cb = hexToRgb(b.color);
        return rgbToHex(
          ca[0] + (cb[0] - ca[0]) * k,
          ca[1] + (cb[1] - ca[1]) * k,
          ca[2] + (cb[2] - ca[2]) * k,
        );
      }
    }
    return last.color;
  }

  return {
    root,
    setGradient(next) {
      // 值相同（例如自己触发的回写）时不重绘，避免拖拽中途被打断。
      if (sameGradient(gradient, next)) return;
      // 外部整体替换（撤销、载入工程）时结束进行中的拖动，索引已失效。
      dragIndex = -1;
      gradient = cloneGradient(next);
      updateBg();
      renderStops();
    },
    setDisabled(next) {
      disabled = next;
      root.classList.toggle('is-disabled', next);
    },
    destroy() {
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
      root.remove();
    },
  };
}

function cloneGradient(gradient: Gradient): Gradient {
  return { stops: gradient.stops.map((s) => ({ ...s })) };
}

function sameGradient(a: Gradient, b: Gradient): boolean {
  if (a.stops.length !== b.stops.length) return false;
  for (let i = 0; i < a.stops.length; i++) {
    if (a.stops[i].t !== b.stops[i].t || a.stops[i].color !== b.stops[i].color) return false;
  }
  return true;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) || 0,
    parseInt(hex.slice(3, 5), 16) || 0,
    parseInt(hex.slice(5, 7), 16) || 0,
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
