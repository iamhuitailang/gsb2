/* toast.js — 轻量通知 */
(function (global) {
  'use strict';

  var root = null;
  function ensureRoot() {
    if (!root) root = document.getElementById('toastRoot');
    return root;
  }

  function toast(message, type, duration) {
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = message;
    ensureRoot().appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(16px)';
      setTimeout(function () { el.remove(); }, 320);
    }, duration || 2600);
  }

  global.Toast = {
    info: function (m) { toast(m, 'info'); },
    success: function (m) { toast(m, 'success'); },
    warn: function (m) { toast(m, 'warn', 3400); },
    error: function (m) { toast(m, 'error', 3800); }
  };
})(window);
