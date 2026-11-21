/** 极简 DOM 工具：h() 构建元素、toast、下载、防抖。 */

const BOOLEAN_PROPS = new Set(['checked', 'disabled', 'selected', 'hidden']);

export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props && typeof props === 'object' && !Array.isArray(props) && !(props instanceof Node)) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined) continue;
      if (key === 'class' || key === 'className') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'value') {
        // value 可能是 false/0，必须原样写入
        node.value = value;
      } else if (BOOLEAN_PROPS.has(key)) {
        // checked/disabled/selected/hidden 的 false 也要显式赋值
        node[key] = Boolean(value);
      } else if (value === false) {
        continue;
      } else if (value === true) {
        node.setAttribute(key, '');
      } else {
        node.setAttribute(key, value);
      }
    }
  } else if (props !== null && props !== undefined) {
    children.unshift(props);
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

export function debounce(fn, wait = 200) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const TOAST_ICONS = { success: '✓', error: '✕', info: 'i' };

export function toast(message, kind = 'info', duration = 3200) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const node = h(
    'div',
    { class: `toast ${kind}`, role: 'status' },
    h('span', { class: 'ico' }, TOAST_ICONS[kind] || '·'),
    h('span', { text: message }),
  );
  root.appendChild(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  }, duration);
}

export function formatValue(value) {
  if (value === undefined) return '未设置';
  if (typeof value === 'boolean') return value ? '真' : '假';
  if (typeof value === 'string') return value === '' ? '（空）' : value;
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

export function pluralNodes(count) {
  return `${count} 个节点`;
}

export function truncate(text, length = 32) {
  const value = String(text ?? '');
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

export function download_name(title, extension) {
  const safe = (title || 'story')
    .replace(/[^\p{L}\p{N}\-_ ]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  return `${safe || 'story'}.${extension}`;
}
