// 极简 DOM 构造工具，保持无框架依赖

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | number | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false || value === null) continue;
    if (key === 'className') el.className = String(value);
    else if (key === 'textContent') el.textContent = String(value);
    else if (key.startsWith('data-')) el.setAttribute(key, String(value));
    else el.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const container = document.getElementById('toast-container')!;
  const item = h('div', { className: `toast toast-${kind}`, textContent: message });
  container.append(item);
  window.setTimeout(() => {
    item.classList.add('toast-fade');
    item.addEventListener('transitionend', () => item.remove(), { once: true });
  }, 3200);
}

export function formatNumber(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 0.001 || abs >= 1e6)) return n.toExponential(3);
  return n.toFixed(digits);
}

export function downloadText(fileName: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
