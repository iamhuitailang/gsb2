/** 极简 DOM 构造辅助 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string; dataset?: Record<string, string> } = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'class') {
      el.className = value as string;
    } else {
      (el as Record<string, unknown>)[key] = value;
    }
  }
  for (const child of children) {
    el.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return el;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatTime(sec: number): string {
  return `${sec.toFixed(2)}s`;
}
