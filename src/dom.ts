namespace SamplerLab {
  // ---------- 极简 DOM 辅助 ----------

  type ElProps = Record<string, unknown> & { dataset?: Record<string, string>; style?: Partial<CSSStyleDeclaration> };

  export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: ElProps = {},
    children: (Node | string)[] = [],
  ): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined) continue;
      if (k === 'dataset') {
        for (const [dk, dv] of Object.entries(v as Record<string, string>)) el.dataset[dk] = dv;
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(el.style, v);
      } else {
        (el as unknown as Record<string, unknown>)[k] = v;
      }
    }
    for (const c of children) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
  }

  export function clear(el: HTMLElement): void {
    el.replaceChildren();
  }

  export function labeledNumber(
    label: string,
    value: number,
    step: number,
    onInput: (v: number) => void,
    opts: { min?: number; max?: number } = {},
  ): HTMLElement {
    const input = h('input', {
      type: 'number',
      value: String(value),
      step: String(step),
      ...(opts.min !== undefined ? { min: opts.min } : {}),
      ...(opts.max !== undefined ? { max: opts.max } : {}),
    });
    input.addEventListener('change', () => {
      const n = Number(input.value);
      if (Number.isFinite(n)) onInput(n);
    });
    return h('label', { className: 'num-field' }, [h('span', { textContent: label }), input]);
  }

  export function swatch(c: RGB, title = ''): HTMLElement {
    return h('span', { className: 'swatch', style: { background: rgbToCss(c) }, title });
  }

  export function fmt(x: number, digits = 3): string {
    if (!Number.isFinite(x)) return String(x);
    return x.toFixed(digits);
  }
}
