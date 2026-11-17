export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message ?? '请求失败');
    this.status = status;
    this.code = payload?.error?.code ?? 'unknown';
    this.payload = payload;
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  let payload = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    payload = await response.json().catch(() => null);
  }

  if (!response.ok) {
    const error = new ApiError(response.status, payload);
    if (error.code === 'session_revoked' || (error.status === 401 && error.code === 'unauthenticated')) {
      window.dispatchEvent(
        new CustomEvent('session:invalid', {
          detail: {
            code: error.code,
            revokedAt: payload?.error?.revokedAt ?? null,
            revokedByDeviceName: payload?.error?.revokedByDeviceName ?? null,
            revokedReason: payload?.error?.revokedReason ?? null,
          },
        }),
      );
    }
    throw error;
  }
  return payload;
}

export function formatAbsolute(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function formatRelative(iso, now = Date.now()) {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';
  const diff = Math.max(0, now - time);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatAbsolute(iso);
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

export function deviceIcon(kind) {
  if (kind === 'phone' || kind === 'mobile') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.4"/><path d="M10.6 18.4h2.8"/></svg>';
  }
  if (kind === 'tablet') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="2.5" width="15" height="19" rx="2.4"/><path d="M10.8 18.4h2.4"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8.5 20h7M12 16.5V20"/></svg>';
}

export function toast(message, tone = 'info') {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const item = document.createElement('div');
  item.className = `toast toast--${tone}`;
  item.textContent = message;
  host.appendChild(item);
  requestAnimationFrame(() => item.classList.add('is-visible'));
  setTimeout(() => {
    item.classList.remove('is-visible');
    setTimeout(() => item.remove(), 220);
  }, 2600);
}
