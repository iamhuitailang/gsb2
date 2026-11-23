/* 确定性伪随机数发生器：mulberry32。
 * 相同种子产生相同序列，保证模拟可复现。 */
(function (global) {
  'use strict';

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* 把任意字符串/数字种子规范化为 32 位无符号整数 */
  function normalizeSeed(seed) {
    if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
    const s = String(seed == null ? '' : seed);
    let h = 2166136261 >>> 0; // FNV-1a
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  global.RNG = { mulberry32, normalizeSeed };
})(window);
