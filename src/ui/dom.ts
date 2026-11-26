// 极简 DOM 构造与表单绑定，避免引入框架。

export type Child = Node | string | number | false | null | undefined | Child[];

export type HProps<K extends keyof HTMLElementTagNameMap> = Omit<
  Partial<HTMLElementTagNameMap[K]>,
  'style'
> & {
  class?: string;
  style?: string;
  dataset?: Record<string, string>;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: HProps<K> = {} as HProps<K>,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'style' && typeof value === 'string') el.setAttribute('style', value);
    else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(value as Record<string, string>)) el.dataset[dk] = dv;
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'html') {
      el.innerHTML = String(value);
    } else {
      (el as unknown as Record<string, unknown>)[key] = value;
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el: HTMLElement, children: Child[]) {
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    if (Array.isArray(child)) {
      appendChildren(el, child);
    } else if (child instanceof Node) {
      el.append(child);
    } else {
      el.append(document.createTextNode(String(child)));
    }
  }
}

export interface NumberFieldOptions {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  digits?: number;
  onChange: (v: number) => void;
}

export function numberField(o: NumberFieldOptions) {
  const input = h('input', {
    type: 'number',
    class: 'num-input',
    value: String(o.value),
    min: o.min !== undefined ? String(o.min) : undefined,
    max: o.max !== undefined ? String(o.max) : undefined,
    step: String(o.step ?? 0.1),
  }) as HTMLInputElement;

  const commit = () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) o.onChange(v);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });

  const el = h(
    'label',
    { class: 'field' },
    h('span', { class: 'field-label' }, o.label),
    h('span', { class: 'field-control' }, input, o.unit ? h('em', { class: 'unit' }, o.unit) : null),
  );

  return {
    el,
    input,
    set(v: number) {
      if (document.activeElement !== input) input.value = String(round(v, o.digits ?? 3));
    },
  };
}

function round(v: number, digits: number) {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

export interface SliderFieldOptions extends NumberFieldOptions {
  // 滑块 + 数字联动
}

export function sliderField(o: SliderFieldOptions) {
  const range = h('input', {
    type: 'range',
    class: 'slider-input',
    min: o.min !== undefined ? String(o.min) : '0',
    max: o.max !== undefined ? String(o.max) : '10',
    step: String(o.step ?? 0.1),
    value: String(o.value),
  }) as HTMLInputElement;
  const num = h('input', {
    type: 'number',
    class: 'num-input tiny',
    value: String(o.value),
    min: o.min !== undefined ? String(o.min) : undefined,
    max: o.max !== undefined ? String(o.max) : undefined,
    step: String(o.step ?? 0.1),
  }) as HTMLInputElement;

  const emit = (raw: string) => {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return;
    o.onChange(v);
  };
  range.addEventListener('input', () => {
    num.value = range.value;
    emit(range.value);
  });
  num.addEventListener('change', () => {
    const v = parseFloat(num.value);
    if (Number.isFinite(v)) {
      range.value = String(v);
      emit(num.value);
    }
  });

  return {
    el: h('label', { class: 'field slider-field' }, h('span', { class: 'field-label' }, o.label), h('span', { class: 'slider-row' }, range, num, o.unit ? h('em', { class: 'unit' }, o.unit) : null)),
    set(v: number) {
      range.value = String(v);
      if (document.activeElement !== num) num.value = String(round(v, o.digits ?? 2));
    },
  };
}

export function selectField<T extends string>(opts: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const select = h(
    'select',
    { class: 'select-input' },
    ...opts.options.map((o) => h('option', { value: o.value, selected: o.value === opts.value }, o.label)),
  ) as HTMLSelectElement;
  select.addEventListener('change', () => opts.onChange(select.value as T));
  return {
    el: h('label', { class: 'field' }, h('span', { class: 'field-label' }, opts.label), select),
    set(v: T) {
      select.value = v;
    },
  };
}

export function checkboxField(opts: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = opts.value;
  input.addEventListener('change', () => opts.onChange(input.checked));
  return h(
    'label',
    { class: 'field checkbox-field' },
    input,
    h('span', { class: 'field-label inline' }, opts.label),
  );
}

export function colorField(opts: { label: string; value: string; onChange: (v: string) => void }) {
  const input = h('input', { type: 'color', value: opts.value }) as HTMLInputElement;
  input.addEventListener('input', () => opts.onChange(input.value));
  return h(
    'label',
    { class: 'field color-field' },
    h('span', { class: 'field-label' }, opts.label),
    input,
  );
}

export function vec3Field(opts: {
  label: string;
  value: [number, number, number];
  step?: number;
  onChange: (v: [number, number, number]) => void;
}) {
  const axes: ('X' | 'Y' | 'Z')[] = ['X', 'Y', 'Z'];
  const inputs = axes.map((axis, i) =>
    h('input', {
      type: 'number',
      class: 'num-input axis',
      value: String(opts.value[i]),
      step: String(opts.step ?? 0.25),
      title: axis,
    }) as HTMLInputElement,
  );
  const commit = () => {
    const v = inputs.map((inp, i) => {
      const n = parseFloat(inp.value);
      return Number.isFinite(n) ? n : opts.value[i];
    }) as [number, number, number];
    opts.onChange(v);
  };
  inputs.forEach((inp) => inp.addEventListener('change', commit));
  return h(
    'div',
    { class: 'field vec3-field' },
    h('span', { class: 'field-label' }, opts.label),
    h(
      'span',
      { class: 'vec3-row' },
      ...inputs.map((inp, i) =>
        h('span', { class: `axis-box axis-${axes[i].toLowerCase()}` }, h('i', {}, axes[i]), inp),
      ),
    ),
  );
}

export function section(title: string, content: HTMLElement, openByDefault = true) {
  const body = h('div', { class: 'section-body' }, content);
  const toggle = h('button', { type: 'button', class: 'section-head' }, h('span', { class: 'chev' }, '▾'), title);
  const wrap = h('section', { class: 'ui-section' }, toggle, body);
  if (!openByDefault) {
    body.hidden = true;
    wrap.classList.add('collapsed');
  }
  toggle.addEventListener('click', () => {
    body.hidden = !body.hidden;
    wrap.classList.toggle('collapsed', body.hidden);
  });
  return wrap;
}

export function badge(text: string, cls = '') {
  return h('span', { class: `badge ${cls}` }, text);
}
