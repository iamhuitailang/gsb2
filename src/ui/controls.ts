import { h } from './dom.ts';

/** 一行「标签 + 控件 + 提示」；直接返回 DOM 节点，便于嵌进 section / 网格。 */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const hintEl = h('div', { class: 'field-hint', text: hint ?? '' });
  if (!hint) hintEl.hidden = true;
  return h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label', text: label }),
    h('div', { class: 'field-control' }, control),
    hintEl,
  );
}

export interface SliderOptions {
  min: number;
  max: number;
  step: number;
  value: number;
  /** 数值显示格式化 */
  format?: (value: number) => string;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  disabled?: boolean;
}

export interface SliderControl {
  root: HTMLElement;
  setValue(value: number): void;
  setDisabled(disabled: boolean): void;
  /** 用户是否正在操作该滑杆 */
  readonly isActive: boolean;
  setLimits(min: number, max: number): void;
}

/** 滑杆 + 可编辑数字输入，双向同步。 */
export function slider(options: SliderOptions): SliderControl {
  const format = options.format ?? ((v: number) => String(round(v)));
  let min = options.min;
  let max = options.max;
  const range = h('input', {
    class: 'range',
    attrs: {
      type: 'range',
      min,
      max,
      step: options.step,
      value: options.value,
      'aria-label': '滑杆',
    },
  });
  const number_ = h('input', {
    class: 'number-input',
    attrs: {
      type: 'text',
      inputmode: 'decimal',
      value: format(options.value),
      'aria-label': '数值',
    },
  });

  let current = options.value;
  let editing = false;
  let active = false;

  const clampValue = (value: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

  function apply(value: number, commit: boolean) {
    current = clampValue(snap(value, options.step));
    range.value = String(current);
    if (!editing) number_.value = format(current);
    options.onChange(current);
    if (commit) options.onCommit?.(current);
  }

  range.addEventListener('pointerdown', () => {
    active = true;
  });
  range.addEventListener('pointerup', () => {
    active = false;
  });
  range.addEventListener('pointercancel', () => {
    active = false;
  });
  range.addEventListener('blur', () => {
    active = false;
  });
  range.addEventListener('input', () => {
    apply(Number(range.value), false);
  });
  range.addEventListener('change', () => {
    apply(Number(range.value), true);
  });

  number_.addEventListener('focus', () => {
    editing = true;
    active = true;
    number_.select();
  });
  number_.addEventListener('blur', () => {
    editing = false;
    active = false;
    const parsed = parseNumber(number_.value);
    if (parsed === null) {
      number_.value = format(current);
      return;
    }
    apply(parsed, true);
    number_.value = format(current);
  });
  number_.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      (event.target as HTMLInputElement).blur();
    } else if (event.key === 'Escape') {
      number_.value = format(current);
      (event.target as HTMLInputElement).blur();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const dir = event.key === 'ArrowUp' ? 1 : -1;
      const step = event.shiftKey ? options.step * 10 : options.step;
      apply(current + dir * step, true);
      number_.value = format(current);
    }
  });

  if (options.disabled) {
    range.disabled = true;
    number_.disabled = true;
  }

  const root = h('div', { class: 'slider' }, range, number_);

  return {
    root,
    setValue(value) {
      current = clampValue(value);
      if (!editing) number_.value = format(current);
      if (document.activeElement !== range) range.value = String(current);
    },    setDisabled(disabled) {
      range.disabled = disabled;
      number_.disabled = disabled;
      root.classList.toggle('is-disabled', disabled);
    },
    get isActive() {
      return active;
    },
    setLimits(nextMin, nextMax) {
      min = nextMin;
      max = nextMax;
      range.min = String(min);
      range.max = String(max);
    },
  };
}

function snap(value: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return value;
  return Math.round(value / step) * step;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.+-eE]/g, '');
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export interface RangeControl {
  root: HTMLElement;
  setValue(min: number, max: number): void;
}

export function rangePair(
  labelMin: string,
  labelMax: string,
  min: number,
  max: number,
  step: number,
  value: { min: number; max: number },
  onChange: (value: { min: number; max: number }) => void,
): RangeControl {
  let current = { ...value };
  const low = slider({
    min,
    max,
    step,
    value: current.min,
    onChange: (v) => {
      current = { min: Math.min(v, current.max), max: current.max };
      onChange(current);
    },
  });
  const high = slider({
    min,
    max,
    step,
    value: current.max,
    onChange: (v) => {
      current = { min: current.min, max: Math.max(v, current.min) };
      onChange(current);
    },
  });
  const root = h(
    'div',
    { class: 'range-pair' },
    h('div', { class: 'range-pair-row' }, h('span', { class: 'range-pair-label', text: labelMin }), low.root),
    h('div', { class: 'range-pair-row' }, h('span', { class: 'range-pair-label', text: labelMax }), high.root),
  );
  return {
    root,
    setValue(nextMin, nextMax) {
      current = { min: nextMin, max: nextMax };
      low.setValue(nextMin);
      high.setValue(nextMax);
    },
  };
}

export function selectField<T extends string>(
  options: { value: T; label: string }[],
  value: T,
  onChange: (value: T) => void,
): HTMLSelectElement {
  const select = h('select', { class: 'select' });
  for (const option of options) {
    const el = h('option', { text: option.label, attrs: { value: option.value } });
    if (option.value === value) el.selected = true;
    select.append(el);
  }
  select.addEventListener('change', () => onChange(select.value as T));
  return select;
}

export function toggle(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
): { root: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { attrs: { type: 'checkbox' } });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const root = h('label', { class: 'toggle' }, input, h('span', { class: 'toggle-track' }), h('span', { text: label }));
  return { root, input };
}

export function button(
  label: string,
  onClick: () => void,
  options: { variant?: 'primary' | 'ghost' | 'danger' | 'icon'; title?: string; disabled?: boolean } = {},
): HTMLButtonElement {
  const el = h('button', {
    class: `btn${options.variant && options.variant !== 'icon' ? ` btn-${options.variant}` : ''}${
      options.variant === 'icon' ? ' btn-icon' : ''
    }`,
    text: label,
    title: options.title,
    attrs: { type: 'button' },
  });
  el.addEventListener('click', onClick);
  if (options.disabled) el.disabled = true;
  return el;
}

export function section(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
  const body = h('div', { class: 'section-body' });
  for (const child of children) if (child) body.append(child);
  return h(
    'section',
    { class: 'section' },
    h('header', { class: 'section-header' }, h('h3', { text: title })),
    body,
  );
}

export function chip(text: string, tone: 'neutral' | 'good' | 'warn' | 'bad' = 'neutral'): HTMLElement {
  return h('span', { class: `chip chip-${tone}`, text });
}
