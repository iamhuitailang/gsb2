// 轻量 DOM 与媒体工具。
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function debounce(fn, ms = 120) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function fmt(sec, d = 3) {
  return Number.isFinite(sec) ? sec.toFixed(d) : '—';
}

export function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

export function toast(message, kind = '') {
  const host = $('#toasts');
  if (!host) return;
  const el = h('div', { class: `toast ${kind}` }, message);
  host.append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s ease, transform .25s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, kind === 'bad' ? 6500 : 3800);
}

export function openModal(title, node) {
  $('#modalTitle').textContent = title;
  const body = clear($('#modalBody'));
  body.append(node);
  $('#modalBackdrop').hidden = false;
}

export function closeModal() {
  $('#modalBackdrop').hidden = true;
}

// 载入视频元素（用于逐帧绘制）。加载失败时抛错。
export function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.playsInline = true;
    v.src = url;
    const done = () => { cleanup(); resolve(v); };
    const fail = () => { cleanup(); reject(new Error(`无法加载视频 ${url}`)); };
    const cleanup = () => {
      v.removeEventListener('loadeddata', done);
      v.removeEventListener('error', fail);
    };
    v.addEventListener('loadeddata', done, { once: true });
    v.addEventListener('error', fail, { once: true });
  });
}

// 等待某个 seek 完成；有些浏览器在 seek 到当前时间时不会触发 seeked。
export function seekVideo(video, t) {
  return new Promise((resolve) => {
    const target = Math.max(0, Math.min(t, Math.max(0, (video.duration || 0) - 0.001)));
    if (Math.abs(video.currentTime - target) < 1e-4 && video.readyState >= 2) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 900);
    video.addEventListener('seeked', finish);
    try { video.currentTime = target; } catch { finish(); }
  });
}

export async function apiJson(path, opts = {}) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(body?.error || `请求失败 ${res.status}`);
    err.body = body;
    err.status = res.status;
    throw err;
  }
  return body;
}

export function downloadUrl(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name || '';
  document.body.append(a);
  a.click();
  a.remove();
}
