/*
 * 确定性随机数工具（UMD，浏览器 / Node 共用）
 * - mulberry32：固定整数种子 -> 完全可复现的随机序列
 * - hashSeed：字符串种子 -> 32 位整数
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.DungeonRNG = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 字符串 -> 32bit 无符号整数（xFNV-1a），用于把文字种子转成数字种子 */
  function hashSeed(str) {
    if (typeof str === 'number' && Number.isFinite(str)) return toUint32(str);
    const s = String(str);
    // 纯数字字符串与对应数字种子归一化，保证 "42" 与 42 结果一致
    if (/^-?\d+$/.test(s.trim())) return toUint32(Number(s.trim()));
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function toUint32(n) {
    return (n | 0) >>> 0;
  }

  /** mulberry32 PRNG，返回一个带 next/range/int/pick/shuffle 的状态对象 */
  function makeRng(seed) {
    let a = hashSeed(seed);
    function next() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return {
      seed: a,
      next,
      /** [min, max) 浮点 */
      range(min, max) {
        return min + next() * (max - min);
      },
      /** [min, max] 闭区间整数 */
      int(min, max) {
        return min + Math.floor(next() * (max - min + 1));
      },
      pick(arr) {
        return arr[Math.floor(next() * arr.length)];
      },
      shuffle(arr) {
        const a2 = arr.slice();
        for (let i = a2.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          const t = a2[i];
          a2[i] = a2[j];
          a2[j] = t;
        }
        return a2;
      },
    };
  }

  return { makeRng, hashSeed };
});
