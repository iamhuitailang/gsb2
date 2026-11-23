/*
 * samples.js — 内置测试样例生成（48 kHz，8 秒，首尾各带 0.2 秒静音）
 * 纯离线生成，不依赖任何音频文件。
 * UMD：浏览器挂到 window.Samples，Node 下 module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Samples = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SR = 48000;
  var DUR = 8;
  var EDGE = Math.round(SR * 0.2);   // 首尾静音帧数

  function alloc() {
    var n = SR * DUR;
    return { n: n, left: new Float32Array(n), right: new Float32Array(n) };
  }

  function tone(t, freq, amp) {
    return amp * Math.sin(2 * Math.PI * freq * t);
  }

  /** 淡入淡出包络，避免咔哒声；首尾静音区天然为 0 */
  function env(i, n) {
    var fade = Math.round(SR * 0.03);
    if (i < EDGE || i >= n - EDGE) return 0;
    var p = i - EDGE;
    var body = n - 2 * EDGE;
    if (p < fade) return p / fade;
    if (p > body - fade) return (body - p) / fade;
    return 1;
  }

  function finalize(buf, baseL, baseR) {
    for (var i = 0; i < buf.n; i++) {
      var e = env(i, buf.n);
      // 轻微幅度调制，让相关度/表桥有变化，避免过于“死板”
      var mod = 1 + 0.08 * Math.sin(2 * Math.PI * 1.7 * i / SR);
      buf.left[i] = baseL(i, buf.n) * e * mod;
      buf.right[i] = baseR(i, buf.n) * e * mod;
    }
    return { sampleRate: SR, left: buf.left, right: buf.right };
  }

  /** 1. 同相：左右完全相同的 220 Hz + 880 Hz 混合音 */
  function inphase() {
    var buf = alloc();
    return finalize(buf, function (i) {
      var t = i / SR;
      return tone(t, 220, 0.55) + tone(t, 880, 0.28);
    }, function (i) {
      var t = i / SR;
      return tone(t, 220, 0.55) + tone(t, 880, 0.28);
    });
  }

  /** 2. 反相：右声道是左声道的精确极性反转，折叠后几乎全静（含高/中/低三个频带） */
  function antiphase() {
    var buf = alloc();
    var sig = function (i) {
      var t = i / SR;
      return tone(t, 180, 0.45) + tone(t, 900, 0.28) + tone(t, 6000, 0.22);
    };
    return finalize(buf, sig, function (i) { return -sig(i); });
  }

  /**
   * 3. 部分频带抵消：120 Hz 低频与 1 kHz 中频同相，5 kHz 高频反相。
   *    折叠后高频几乎消失，低/中频保留 —— 用来区分“频带消失”和“整体变小”。
   */
  function bandCancel() {
    var buf = alloc();
    var sig = function (i) {
      var t = i / SR;
      return tone(t, 120, 0.5) + tone(t, 1000, 0.3) + tone(t, 5000, 0.26);
    };
    var rSig = function (i) {
      var t = i / SR;
      // 仅高频取反
      return tone(t, 120, 0.5) + tone(t, 1000, 0.3) - tone(t, 5000, 0.26);
    };
    return finalize(buf, sig, rSig);
  }

  /** 4. 单边静音：只有左声道有 330 Hz + 1.5 kHz 内容，右声道全程为零 */
  function oneSided() {
    var buf = alloc();
    return finalize(buf, function (i) {
      var t = i / SR;
      return tone(t, 330, 0.5) + tone(t, 1500, 0.28);
    }, function () { return 0; });
  }

  var DEFS = [
    {
      key: 'inphase',
      name: '同相样例',
      description: '左右完全相同，相关度接近 +1，折叠单声道无损失。',
      build: inphase,
    },
    {
      key: 'antiphase',
      name: '反相样例',
      description: '右声道极性反转，折叠后几乎全静音，属于整体变小。',
      build: antiphase,
    },
    {
      key: 'bandcancel',
      name: '部分频带抵消样例',
      description: '5 kHz 高频反相、低中频同相，折叠后仅高频消失。',
      build: bandCancel,
    },
    {
      key: 'onesided',
      name: '单边静音样例',
      description: '只有左声道有声音，右声道全程静音，触发单边提示。',
      build: oneSided,
    },
  ];

  function generate(key) {
    var def = DEFS.filter(function (d) { return d.key === key; })[0];
    if (!def) throw new Error('未知样例：' + key);
    var audio = def.build();
    return {
      key: key,
      name: def.name,
      description: def.description,
      sampleRate: audio.sampleRate,
      left: audio.left,
      right: audio.right,
    };
  }

  return { generate: generate, DEFS: DEFS, SAMPLE_RATE: SR, DURATION: DUR };
});
