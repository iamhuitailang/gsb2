/* 通用工具函数（无 DOM 依赖，可在 Node 无头测试中直接 require） */
(function (global) {
  'use strict';

  let idSeq = 1;
  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + (idSeq++).toString(36);
  }

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /** 把输入文本转为合适的 JS 值：true/false/null/数字/字符串 */
  function coerceValue(raw) {
    if (typeof raw !== 'string') return raw;
    const t = raw.trim();
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (t !== '' && !isNaN(Number(t))) return Number(t);
    return raw;
  }

  /** 条件比较：数值按数字比，布尔按布尔比，其余按字符串比 */
  function compare(op, left, right) {
    if (op === '==') return looseEq(left, right);
    if (op === '!=') return !looseEq(left, right);
    const a = Number(left);
    const b = Number(right);
    if (Number.isNaN(a) || Number.isNaN(b)) {
      // 退化到字符串比较，避免静默错误
      const sa = String(left), sb = String(right);
      if (op === '>') return sa > sb;
      if (op === '>=') return sa >= sb;
      if (op === '<') return sa < sb;
      if (op === '<=') return sa <= sb;
      return false;
    }
    switch (op) {
      case '>': return a > b;
      case '>=': return a >= b;
      case '<': return a < b;
      case '<=': return a <= b;
      default: return false;
    }
  }

  function looseEq(a, b) {
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      // 支持布尔值与字符串 'true'/'false' 比较（属性面板输入的就是字符串）
      const norm = (v) => {
        if (typeof v === 'boolean') return v;
        if (v === 'true') return true;
        if (v === 'false') return false;
        return Boolean(v);
      };
      return norm(a) === norm(b);
    }
    if (a === null || b === null) return a === b;
    const na = Number(a), nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && numLike(a) && numLike(b)) return na === nb;
    return String(a) === String(b);
  }

  function numLike(v) {
    return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)));
  }

  function formatValue(v) {
    if (v === null) return 'null';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(self, args), wait);
    };
  }

  function throttle(fn, wait) {
    let last = 0, timer = null;
    return function () {
      const now = Date.now(), remain = wait - (now - last), args = arguments, self = this;
      if (remain <= 0) {
        clearTimeout(timer); timer = null; last = now;
        fn.apply(self, args);
      } else if (!timer) {
        timer = setTimeout(() => { last = Date.now(); timer = null; fn.apply(self, args); }, remain);
      }
    };
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /** 两点距离 */
  function dist(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
  }

  const api = {
    uid, clamp, deepClone, escapeHtml, coerceValue, compare,
    looseEq, formatValue, debounce, throttle, downloadText, dist
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BTUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);
