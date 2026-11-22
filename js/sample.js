/*
 * sample.js — 内置双声道试验样音（纯数学生成，无需音频文件）。
 *
 * 时间线（总长 6.0s，48 kHz）：
 *   0.0–0.7s  安静区（仅 -60 dBFS 底噪）
 *   0.8s      左声道孤立短响（60 ms 正弦脉冲 + 指数衰减）
 *   1.15s     右声道孤立短响（同形，便于核对单声道独立增益）
 *   2.0–3.6s  双声道持续强声（880 Hz，-16 dBFS，带 3 Hz 颤动 → 观察压缩“呼吸”）
 *             其中 2.70s 左声道额外插入一个 20 ms 尖峰（-1.4 dBFS）
 *   3.6–5.0s  安静区（观察恢复时间，增益何时完全放开）
 *   5.20s     左声道短响   5.55s 右声道短响
 *   5.7–6.0s  尾部静音（验证导出后首尾静音不缩短）
 */
(function (global) {
  'use strict';

  var SAMPLE_RATE = 48000;
  var DURATION_SEC = 6.0;

  // 供 UI 在波形图上标注的区段
  var SEGMENTS = [
    { start: 0.0, end: 0.7, label: '安静区' },
    { start: 0.78, end: 0.92, label: '左·短响' },
    { start: 1.13, end: 1.27, label: '右·短响' },
    { start: 2.0, end: 3.6, label: '持续强声（左 2.70s 有尖峰）' },
    { start: 3.6, end: 5.0, label: '安静区（看恢复）' },
    { start: 5.18, end: 5.32, label: '左·短响' },
    { start: 5.53, end: 5.67, label: '右·短响' },
    { start: 5.7, end: 6.0, label: '尾部静音' },
  ];

  function generateSample() {
    var n = Math.floor(SAMPLE_RATE * DURATION_SEC);
    var L = new Float32Array(n);
    var R = new Float32Array(n);
    var t, i;

    // 极轻底噪，保证“安静区”不是数学上的纯零（约 -60 dBFS）
    var seed = 20261122;
    function rand() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    }
    var noiseAmp = Math.pow(10, -60 / 20);
    for (i = 0; i < n; i++) {
      L[i] = rand() * noiseAmp;
      R[i] = rand() * noiseAmp;
    }

    function addTone(data, t0, dur, freq, amp, type) {
      var i0 = Math.floor(t0 * SAMPLE_RATE);
      var len = Math.floor(dur * SAMPLE_RATE);
      for (var k = 0; k < len; k++) {
        var ph = (2 * Math.PI * freq * k) / SAMPLE_RATE;
        var s;
        if (type === 'triangle') {
          s = (2 / Math.PI) * Math.asin(Math.sin(ph));
        } else {
          s = Math.sin(ph);
        }
        var idx = i0 + k;
        if (idx < n) data[idx] += amp * s;
      }
    }

    // 带指数衰减包络的短响（模拟“突然响一声”）
    function addPing(data, t0, dur, freq, peakAmp) {
      var i0 = Math.floor(t0 * SAMPLE_RATE);
      var len = Math.floor(dur * SAMPLE_RATE);
      for (var k = 0; k < len; k++) {
        var ph = (2 * Math.PI * freq * k) / SAMPLE_RATE;
        var env = Math.exp(-5 * (k / len)); // 1 → ~0.007
        var idx = i0 + k;
        if (idx < n) data[idx] += peakAmp * env * Math.sin(ph);
      }
    }

    // 1. 孤立短响（前段）
    addPing(L, 0.80, 0.06, 1200, 0.70); // 约 -3 dBFS
    addPing(R, 1.15, 0.06, 1000, 0.60); // 约 -4.4 dBFS

    // 2. 持续强声：880 Hz，-16 dBFS，3 Hz 颤动
    var susAmp = Math.pow(10, -16 / 20);
    var susI0 = Math.floor(2.0 * SAMPLE_RATE);
    var susLen = Math.floor(1.6 * SAMPLE_RATE);
    for (i = 0; i < susLen; i++) {
      var idx = susI0 + i;
      if (idx >= n) break;
      var tt = i / SAMPLE_RATE;
      var trem = 0.85 + 0.15 * Math.sin(2 * Math.PI * 3 * tt);
      var s = susAmp * trem * Math.sin(2 * Math.PI * 880 * tt);
      L[idx] += s;
      R[idx] += s * 0.85; // 右声道略轻，联动/非联动都有差别可看
    }

    // 持续声中的短尖峰（左声道，20 ms，约 -1.4 dBFS）
    addTone(L, 2.70, 0.02, 1760, 0.85);

    // 3. 后段孤立短响
    addPing(L, 5.20, 0.06, 1200, 0.72);
    addPing(R, 5.55, 0.06, 900, 0.66);

    return {
      channelData: [L, R],
      sampleRate: SAMPLE_RATE,
      duration: DURATION_SEC,
      segments: SEGMENTS,
    };
  }

  global.SampleGen = { generateSample: generateSample, SEGMENTS: SEGMENTS };
})(typeof window !== 'undefined' ? window : globalThis);
