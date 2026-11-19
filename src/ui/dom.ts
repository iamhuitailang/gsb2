export type Child = Node | string | number | null | false | undefined;

export interface ElementProps {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: {
    [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void;
  };
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      el.setAttribute(key, String(value));
    }
  }
  if (props.on) {
    for (const [key, handler] of Object.entries(props.on)) {
      el.addEventListener(key, handler as unknown as EventListener);
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Element, children: Child[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node: Element) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function fmt(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return rounded.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 10000) return `${(value / 1000).toFixed(1)}k`;
  return Math.round(value).toString();
}

export function formatTime(time: number, fps?: number): string {
  const seconds = Math.max(0, time);
  if (fps) {
    const frame = Math.round(seconds * fps);
    return `${seconds.toFixed(2)}s · 帧 ${frame}`;
  }
  return `${seconds.toFixed(2)}s`;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.append(input);
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    input.click();
  });
}

let toastTimer: number | null = null;

export function toast(message: string, tone: 'info' | 'warn' | 'error' = 'info') {
  let layer = document.querySelector<HTMLElement>('.toast-layer');
  if (!layer) {
    layer = h('div', { class: 'toast-layer' });
    document.body.append(layer);
  }
  clear(layer);
  layer.append(h('div', { class: `toast toast-${tone}`, text: message }));
  layer.classList.add('visible');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    layer?.classList.remove('visible');
    toastTimer = null;
  }, 3600);
}

export function debounce<T extends (...args: never[]) => void>(fn: T, delay: number): T {
  let timer: number | null = null;
  return ((...args: never[]) => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  }) as T;
}

export function safeFilename(name: string, extension: string): string {
  const base = name
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `${base || 'particle-project'}.${extension}`;
}
