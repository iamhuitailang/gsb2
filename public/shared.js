export const ANSWER_LABELS = { pass: '合格', fail: '不合格', na: '不适用' };

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

const pad = (n) => String(n).padStart(2, '0');

export function fmtClock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let toastTimer = 0;
export function toast(message, kind = 'info', ms = 4200) {
  const stack = $('#toasts');
  if (!stack) return;
  const node = document.createElement('div');
  node.className = `toast ${kind === 'info' ? '' : kind}`.trim();
  node.textContent = message;
  stack.append(node);
  toastTimer += 1;
  const id = toastTimer;
  setTimeout(() => node.remove(), ms);
  if (stack.children.length > 4) stack.firstElementChild.remove();
  return id;
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export class OfflineError extends Error {
  constructor(message = '当前离线') {
    super(message);
    this.name = 'OfflineError';
    // queue-core 用 kind 判断，避免与 DOM 层耦合。
    this.kind = 'offline';
  }
}

export class ApiError extends Error {
  constructor(status, payload = {}) {
    super(payload.message || `请求失败（${status}）`);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload.error || 'REQUEST_FAILED';
    this.payload = payload;
  }
}

/**
 * Thin fetch wrapper. `offline` is injected so callers can simulate being
 * disconnected for one tab without touching the server.
 */
export async function request(path, { method = 'GET', body, actor = 'li', offline = false } = {}) {
  if (offline) throw new OfflineError();
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        'x-actor': actor,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new OfflineError('无法连接服务端');
  }
  let payload = {};
  try {
    payload = await res.json();
  } catch {
    payload = {};
  }
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

export function draftId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function readStore(key, session = false) {
  try {
    const raw = (session ? sessionStorage : localStorage).getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeStore(key, value, session = false) {
  try {
    (session ? sessionStorage : localStorage).setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
