/** 极简 hyperscript：所有动态文本都走 textContent，避免导入 JSON 注入 HTML */

import { blockDataUri } from '../blocks';
import type { BlockStyle } from '../types';

export type Child = Node | string | number | null | undefined | false | Child[];

export interface Attrs {
  class?: string;
  text?: string | number;
  dataset?: Record<string, string | number | boolean>;
  [key: string]: unknown;
}

function appendChildren(el: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(el, child);
    } else if (child instanceof Node) {
      el.appendChild(child);
    } else {
      el.appendChild(document.createTextNode(String(child)));
    }
  }
}

export function h(
  tag: string,
  attrs: Attrs = {},
  children: Child | Child[] = [],
): HTMLElement {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') {
      el.className = String(value);
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(value as Record<string, unknown>)) {
        if (dv !== null && dv !== undefined) el.dataset[dk] = String(dv);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'htmlFor') {
      el.setAttribute('for', String(value));
    } else if (value === true) {
      el.setAttribute(key, '');
      if (key === 'checked' || key === 'disabled' || key === 'open') {
        (el as HTMLInputElement).toggleAttribute(key, true);
      }
    } else {
      el.setAttribute(key, String(value));
    }
  }

  appendChildren(el, Array.isArray(children) ? children : [children]);
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

/** 色块缩略图；block 为空时返回 null，由调用方放占位态 */
export function blockImage(block: BlockStyle | null | undefined, cls = 'thumb'): HTMLImageElement | null {
  if (!block) return null;
  const img = document.createElement('img');
  img.className = cls;
  img.width = 96;
  img.height = 96;
  img.alt = block.glyph;
  img.loading = 'lazy';
  img.src = blockDataUri(block);
  return img;
}
