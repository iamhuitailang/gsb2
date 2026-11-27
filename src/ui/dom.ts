// 极简 hyperscript + 挂载工具，避免引入框架，保证 file:// 单文件可跑。

export type Child = Node | string | number | false | null | undefined | Child[];

// 宽松的属性袋：常见事件 / dataset / html 单独处理，其余直接写到元素上。
export type Props = {
  class?: string;
  dataset?: Record<string, string | number>;
  html?: string;
  style?: string | Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'html') el.innerHTML = String(value);
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'dataset') {
        for (const [dk, dv] of Object.entries(value as Record<string, string | number>)) {
          el.dataset[dk] = String(dv);
        }
      } else if (key === 'style' && typeof value === 'string') {
        el.style.cssText = value;
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(el.style, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === 'value') {
        // input/select/textarea 的 value 直接赋值以保持受控行为
        (el as HTMLInputElement).value = String(value);
      } else if (key.startsWith('aria-') || key === 'role' || key === 'for' || key === 'accept' || key === 'spellcheck') {
        el.setAttribute(key === 'for' ? 'for' : key, String(value));
      } else {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (el as any)[key] = value;
        } catch {
          el.setAttribute(key, String(value));
        }
      }
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el: HTMLElement, children: Child[]) {
  for (const child of children) {
    if (child === false || child == null || child === undefined) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(el: HTMLElement) {
  el.replaceChildren();
}

export function mount(el: HTMLElement, view: Node) {
  clear(el);
  el.appendChild(view);
}

/** 模态框：返回关闭函数。 */
export function openModal(title: string, content: Node, opts?: { wide?: boolean }): () => void {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': '关闭', onclick: () => close() }, '✕');
  const box = h(
    'div',
    { class: `modal${opts?.wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h3', null, title), closeBtn),
    h('div', { class: 'modal-body' }, content),
  );
  backdrop.appendChild(box);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }
  return close;
}
