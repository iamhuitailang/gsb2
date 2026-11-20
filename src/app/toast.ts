let toastTimer: number | undefined;

export function showToast(message: string, kind: 'info' | 'error' = 'info', ms = 2200): void {
  const host = document.getElementById('toast');
  if (!host) return;
  host.textContent = message;
  host.classList.toggle('is-error', kind === 'error');
  host.classList.add('is-visible');
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    host.classList.remove('is-visible');
  }, ms);
}
