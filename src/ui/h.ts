/** 极简 hyperscript，避免引入框架，保证 bundle 能离线 file:// 直接运行 */

export type Child = Node | string | number | false | null | undefined | Child[];

export interface Attrs {
  class?: string;
  id?: string;
  title?: string;
  type?: string;
  value?: string | number;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  rows?: number;
  cols?: number;
  placeholder?: string;
  checked?: boolean;
  disabled?: boolean;
  href?: string;
  download?: string;
  dataset?: Record<string, string>;
  onclick?: (ev: MouseEvent) => void;
  oninput?: (ev: Event) => void;
  onchange?: (ev: Event) => void;
  onkeydown?: (ev: KeyboardEvent) => void;
  [key: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);

  if (attrs) {
    for (const [key, raw] of Object.entries(attrs)) {
      if (key === 'spellcheck') {
        el.setAttribute('spellcheck', String(raw));
        continue;
      }
      if (raw === undefined || raw === null || raw === false) continue;
      if (key === 'class') {
        el.className = String(raw);
      } else if (key === 'dataset' && raw && typeof raw === 'object') {
        for (const [dk, dv] of Object.entries(raw as Record<string, string>)) {
          el.dataset[dk] = dv;
        }
      } else if (key.startsWith('on') && typeof raw === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), raw as EventListener);
      } else if (key === 'value' && el instanceof HTMLInputElement) {
        el.value = String(raw);
      } else if (key === 'checked' && el instanceof HTMLInputElement) {
        el.checked = Boolean(raw);
      } else if (key in el && key !== 'list') {
        try {
          (el as unknown as Record<string, unknown>)[key] = raw;
        } catch {
          el.setAttribute(key, String(raw));
        }
      } else {
        el.setAttribute(key, String(raw));
      }
    }
  }

  appendChildren(el, children);
  return el;
}

export function appendChildren(el: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    if (Array.isArray(child)) {
      appendChildren(el, child);
    } else if (child instanceof Node) {
      el.appendChild(child);
    } else {
      el.appendChild(document.createTextNode(String(child)));
    }
  }
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

/** 下载文本文件（纯前端 Blob，不联网） */
export function downloadText(filename: string, content: string, mime = 'text/markdown'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
