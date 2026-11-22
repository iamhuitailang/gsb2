/* 通用工具函数，无外部依赖 */
(function (global) {
  'use strict';

  function formatBytes(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[i];
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /**
   * 把文件名转成 ASCII 安全形式：保留字母数字与 ._-，其余字符转写为 _uXXXX。
   * 用于 ZIP 条目名，避免老旧解压工具不识别 UTF-8 标志位；
   * 原始文件名仍完整保留在导出清单 CSV 中。
   */
  function asciiSafeName(name) {
    const out = name.replace(/[^A-Za-z0-9._-]/g, (ch) => {
      const code = ch.charCodeAt(0);
      return '_u' + code.toString(16).padStart(4, '0');
    });
    return out || 'unnamed';
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error('读取文件失败'));
      fr.readAsDataURL(blob);
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /** 串行队列：同一把锁内的任务按提交顺序执行，避免并发编码抢占内存 */
  function createAsyncLock() {
    let tail = Promise.resolve();
    return function run(task) {
      const next = tail.then(task, task);
      tail = next.catch(() => {});
      return next;
    };
  }

  /* ---------------- 模态框 ---------------- */
  function modal({ title, body, kind, actions }) {
    const root = document.getElementById('modal-root');
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal ' + (kind || '');
    box.innerHTML =
      '<h3>' + escapeHtml(title || '') + '</h3>' +
      '<div class="modal-body">' + (typeof body === 'string' ? body : '') + '</div>' +
      '<div class="modal-actions"></div>';
    if (typeof body !== 'string') box.querySelector('.modal-body').appendChild(body);
    const actionBar = box.querySelector('.modal-actions');
    const close = () => mask.remove();
    (actions || [{ label: '知道了', kind: 'primary' }]).forEach((act) => {
      const btn = document.createElement('button');
      btn.textContent = act.label;
      if (act.kind === 'primary') btn.className = 'primary';
      if (act.kind === 'danger') btn.className = 'danger';
      btn.addEventListener('click', () => {
        if (act.onClick) act.onClick(close); else close();
      });
      actionBar.appendChild(btn);
    });
    mask.appendChild(box);
    root.appendChild(mask);
    return { close, box };
  }

  function progressModal(title) {
    const div = document.createElement('div');
    div.style.textAlign = 'center';
    div.innerHTML =
      '<div class="spinner"></div>' +
      '<div class="modal-msg" style="font-size:13px"></div>' +
      '<div class="progress-track"><i style="width:0"></i></div>';
    const m = modal({ title, body: div, actions: [] });
    return {
      set(msg, ratio) {
        div.querySelector('.modal-msg').textContent = msg || '';
        if (ratio !== undefined) {
          div.querySelector('.progress-track > i').style.width = clamp(ratio * 100, 0, 100) + '%';
        }
      },
      close: m.close
    };
  }

  function alertModal(title, msg, kind) {
    return modal({ title, body: '<p>' + escapeHtml(msg) + '</p>', kind: kind || 'err' });
  }

  global.Util = {
    formatBytes, escapeHtml, clamp, uid, asciiSafeName, blobToDataURL, downloadBlob,
    createAsyncLock, modal, progressModal, alertModal
  };
})(window);
