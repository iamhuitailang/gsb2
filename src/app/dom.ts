export type ElAttrs = {
  class?: string;
  id?: string;
  text?: string;
  html?: string;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  min?: string;
  max?: string;
  step?: string;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  ariaLabel?: string;
  dataset?: Record<string, string>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElAttrs = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs.class) node.className = attrs.class;
  if (attrs.id) node.id = attrs.id;
  if (attrs.text !== undefined) node.textContent = attrs.text;
  if (attrs.html !== undefined) node.innerHTML = attrs.html;
  if (attrs.title) node.title = attrs.title;
  if (attrs.ariaLabel) node.setAttribute('aria-label', attrs.ariaLabel);
  if (attrs.dataset) {
    for (const [k, v] of Object.entries(attrs.dataset)) node.dataset[k] = v;
  }
  // Apply form properties through the DOM, not attributes, so <option> values
  // and checkbox state behave as expected.
  const formNode = node as unknown as HTMLInputElement & HTMLOptionElement;
  if (attrs.type !== undefined && 'type' in node) formNode.type = attrs.type;
  if (attrs.value !== undefined && 'value' in node) formNode.value = attrs.value;
  if (attrs.placeholder !== undefined && 'placeholder' in node) formNode.placeholder = attrs.placeholder;
  if (attrs.min !== undefined && 'min' in node) formNode.min = attrs.min;
  if (attrs.max !== undefined && 'max' in node) formNode.max = attrs.max;
  if (attrs.step !== undefined && 'step' in node) formNode.step = attrs.step;
  if (attrs.checked !== undefined && 'checked' in node) formNode.checked = attrs.checked;
  if (attrs.selected !== undefined && 'selected' in node) formNode.selected = attrs.selected;
  if (attrs.disabled !== undefined && 'disabled' in node) formNode.disabled = attrs.disabled;
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

export function button(label: string, onClick: () => void, attrs: ElAttrs = {}): HTMLButtonElement {
  const b = el('button', { ...attrs, text: label, type: 'button' });
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

export function section(title: string, children: Array<Node | null | undefined>, extra?: ElAttrs): HTMLElement {
  const wrap = el('section', { class: `panel-section ${extra?.class ?? ''}`.trim() });
  wrap.append(el('h2', { class: 'panel-title', text: title }));
  for (const child of children) if (child) wrap.append(child);
  return wrap;
}

export interface NumberFieldOptions {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
  onCommit?: () => void;
}

export function numberField(opts: NumberFieldOptions): HTMLElement {
  const input = el('input', {
    type: 'number',
    class: 'num-input',
    value: formatNumber(opts.value),
    min: opts.min !== undefined ? String(opts.min) : undefined,
    max: opts.max !== undefined ? String(opts.max) : undefined,
    step: String(opts.step ?? 0.1),
    ariaLabel: opts.label,
  });
  const row = el('label', { class: 'field' }, [
    el('span', { class: 'field-label', text: opts.label }),
    input,
    opts.unit ? el('span', { class: 'field-unit', text: opts.unit }) : null,
  ]);
  input.addEventListener('change', () => {
    const n = Number(input.value);
    if (Number.isFinite(n)) {
      opts.onChange(n);
      opts.onCommit?.();
    }
    input.value = formatNumber(Number(input.value));
  });
  return row;
}

export function sliderField(opts: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
  onStart?: () => void;
  onCommit?: () => void;
}): HTMLElement {
  const input = el('input', {
    type: 'range',
    class: 'slider',
    value: String(opts.value),
    min: String(opts.min),
    max: String(opts.max),
    step: String(opts.step),
    ariaLabel: opts.label,
  });
  const value = el('span', { class: 'field-value', text: `${formatNumber(opts.value)}${opts.unit ?? ''}` });
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    opts.onStart?.();
  };
  input.addEventListener('pointerdown', start);
  input.addEventListener('keydown', start);
  input.addEventListener('input', () => {
    start();
    const n = Number(input.value);
    value.textContent = `${formatNumber(n)}${opts.unit ?? ''}`;
    opts.onChange(n);
  });
  input.addEventListener('change', () => {
    started = false;
    opts.onCommit?.();
  });
  return el('label', { class: 'field field-slider' }, [
    el('span', { class: 'field-label', text: opts.label }),
    el('div', { class: 'slider-wrap' }, [input]),
    value,
  ]);
}

export function checkField(opts: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): HTMLElement {
  const input = el('input', { type: 'checkbox', class: 'check-input', checked: opts.checked });
  input.addEventListener('change', () => opts.onChange(input.checked));
  return el('label', { class: 'field field-check' }, [
    input,
    el('span', { class: 'field-label', text: opts.label }),
  ]);
}

export function selectField(opts: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}): HTMLElement {
  const select = el('select', { class: 'select-input' });
  for (const option of opts.options) {
    const o = el('option', { value: option.value, text: option.label });
    if (option.value === opts.value) o.selected = true;
    select.append(o);
  }
  select.addEventListener('change', () => opts.onChange(select.value));
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-label', text: opts.label }),
    select,
  ]);
}

export function segmented(opts: {
  value: string;
  options: Array<{ value: string; label: string; title?: string }>;
  onChange: (value: string) => void;
}): HTMLElement {
  const wrap = el('div', { class: 'segmented' });
  for (const option of opts.options) {
    const b = button(option.label, () => opts.onChange(option.value), {
      class: option.value === opts.value ? 'seg-item is-active' : 'seg-item',
      title: option.title,
    });
    wrap.append(b);
  }
  return wrap;
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

export function formatTime(t: number, fps: number): string {
  const totalFrames = Math.max(0, Math.round(t * fps));
  const totalSeconds = Math.floor(totalFrames / fps);
  const frames = totalFrames % fps;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(text: string, filename: string, type = 'application/json'): void {
  downloadBlob(new Blob([text], { type: `${type};charset=utf-8` }), filename);
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let handle: number | undefined;
  return (...args: Parameters<T>) => {
    if (handle !== undefined) window.clearTimeout(handle);
    handle = window.setTimeout(() => fn(...args), ms);
  };
}

export function safeFileStem(name: string): string {
  const stem = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_').trim();
  return stem.length > 0 ? stem : 'camera-path';
}
