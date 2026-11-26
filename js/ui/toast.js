/* 轻提示 */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});

  function toast(message, type, duration) {
    const host = document.getElementById('toastHost');
    if (!host) return;
    const el = G.util.h('div', { class: `toast ${type || ''}` }, message);
    host.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 320);
    }, duration || 2400);
  }

  G.toast = toast;
})();
