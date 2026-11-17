/**
 * 公共模块：模拟断网、本地草稿队列（localStorage）、轻量 toast。
 * 检查员页面与主管页面共用。
 */

export const EMPLOYEE_ID = 'e1';
const ONLINE_KEY = 'demo:inspectorOnline'; // 断网模拟只作用于检查员自己的页面
const OUTBOX_KEY = 'demo:outbox';
const CACHE_KEY = 'demo:checkpointCache';

export class OfflineError extends Error {
  constructor() {
    super('当前处于模拟断网状态，请求未发出，草稿已保存在本机');
    this.name = 'OfflineError';
    this.offline = true;
  }
}

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error ?? `请求失败（HTTP ${status}）`);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

/** 检查员页面的模拟网络状态（主管页面不受影响，始终在线） */
export function isOnline() {
  return localStorage.getItem(ONLINE_KEY) !== '0';
}

export function setOnline(online) {
  localStorage.setItem(ONLINE_KEY, online ? '1' : '0');
}

/**
 * 统一请求出口：断网模拟开启时直接失败，请求不会到达服务端。
 */
export async function apiFetch(path, options = {}) {
  if (!isOnline()) throw new OfflineError();

  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    // 真实网络异常也按离线处理（演示环境通常不会走到这里）
    throw new OfflineError();
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

// ---------------------------------------------------------------------------
// 本地草稿队列
// 状态：queued 待发送 | blocked 需用户处理（权限不足等）| synced 已入库
// ---------------------------------------------------------------------------
export function loadOutbox() {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY)) ?? [];
  } catch {
    return [];
  }
}

function persistOutbox(items) {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
}

export function addOutboxItem(item) {
  const items = loadOutbox();
  items.unshift(item);
  persistOutbox(items);
  return item;
}

export function updateOutboxItem(draftId, patch) {
  const items = loadOutbox();
  const idx = items.findIndex((i) => i.draftId === draftId);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...patch };
  persistOutbox(items);
  return items[idx];
}

export function getOutboxItem(draftId) {
  return loadOutbox().find((i) => i.draftId === draftId) ?? null;
}

export function removeOutboxItem(draftId) {
  persistOutbox(loadOutbox().filter((i) => i.draftId !== draftId));
}

// 检查点资料的本机缓存：断网后仍可查看任务与资料
export function cacheCheckpoints(checkpoints) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(checkpoints));
}

export function loadCachedCheckpoints() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// toast
// ---------------------------------------------------------------------------
let toastTimer;
export function toast(message, kind = '') {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast';
  }, 2800);
}

export function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`;
}
