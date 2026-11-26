import { CONFLICT, HIGH, LOW, UNKNOWN } from '../core.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function valueClass(value) {
  if (value === HIGH) return 'val-1';
  if (value === LOW) return 'val-0';
  if (value === CONFLICT) return 'val-conflict';
  if (value === UNKNOWN) return 'val-null';
  return 'val-na';
}

export function valueText(value) {
  if (value === HIGH) return '1';
  if (value === LOW) return '0';
  if (value === CONFLICT) return '!';
  if (value === UNKNOWN) return '?';
  return '—';
}

export function valueBadge(value) {
  return `<span class="val-badge ${valueClass(value)}">${valueText(value)}</span>`;
}

export function formatClock(iso) {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

export function formatDateTime(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}
