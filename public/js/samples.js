/*
 * samples.js —— 开箱试听样例合成（零依赖，浏览器 / Node 通用）
 *
 * 三个样例，全部为 44.1kHz 立体声：
 *   practice : 8 秒 120BPM 练习曲，旋律 + 过门小节，重音落在每拍
 *   sustain  : 2 秒连续长音，用于核对变速后音高是否保持
 *   accent   : 0.8 秒短重音，用于核对重音位置与时长
 *
 * 所有立体声样例的右声道 = 左声道延迟 30ms 并衰减 6dB，
 * 作为"左右声道原有时间关系"的已知参照，处理后可机器核对。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Samples = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SR = 44100;
  const CH_DELAY = Math.round(SR * 0.03); // 右声道相对左声道延迟 30ms
  const CH_GAIN = 0.5;                    // 右声道衰减 6dB

  function mtof(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // 带指数包络的音符写入左声道
  function addNote(left, startSec, durSec, midi, amp) {
    const start = Math.round(startSec * SR);
    const dur = Math.round(durSec * SR);
    const w = 2 * Math.PI * mtof(midi) / SR;
    const attack = Math.min(200, Math.floor(dur * 0.1));
    for (let i = 0; i < dur && start + i < left.length; i++) {
      let env;
      if (i < attack) env = i / attack;
      else env = Math.exp(-3 * (i - attack) / (dur - attack));
      // 基波 + 二次谐波，模拟乐器音色
      left[start + i] += amp * env * (Math.sin(w * i) + 0.3 * Math.sin(2 * w * i));
    }
  }

  // 短促重音（带快速敲击感的衰减脉冲串）
  function addAccent(left, startSec, midi, amp) {
    const start = Math.round(startSec * SR);
    const dur = Math.round(0.12 * SR);
    const w = 2 * Math.PI * mtof(midi) / SR;
    for (let i = 0; i < dur && start + i < left.length; i++) {
      const env = Math.exp(-25 * i / dur);
      left[start + i] += amp * env * (Math.sin(w * i) + 0.5 * Math.sin(3 * w * i));
    }
  }

  // 由单声道左轨派生立体声：右轨延迟 + 衰减（已知时间关系）
  function toStereo(left) {
    const n = left.length;
    const right = new Float32Array(n);
    for (let i = CH_DELAY; i < n; i++) right[i] = left[i - CH_DELAY] * CH_GAIN;
    return [left, right];
  }

  function buildPractice() {
    // 120BPM，每拍 0.5s；8 小节，每小节 4 拍 = 2s，共 8s
    const total = 8;
    const left = new Float32Array(SR * total);
    const beat = 0.5;
    // 旋律走向（MIDI 音高），每拍一个音；第 5 小节为过门（音阶经过句）
    const melody = [
      60, 64, 67, 72, 67, 64, 60, 64, // 小节 1-2
      62, 65, 69, 74, 69, 65, 62, 65, // 小节 3-4
      60, 62, 64, 65, 67, 69, 71, 72, // 小节 5-6 过门：半拍一个的经过句见下
      72, 67, 64, 60, 60, 60, 60, 60, // 小节 7-8
    ];
    const accents = [];
    for (let i = 0; i < melody.length; i++) {
      const isDownbeat = i % 4 === 0;
      addNote(left, i * beat, beat * 0.9, melody[i], isDownbeat ? 0.5 : 0.32);
      if (isDownbeat) accents.push(i * beat); // 每小节第一拍为重音
    }
    // 过门小节（第 5 小节，8s 起算第 8 拍）：半拍一个的快速经过句
    const runStart = 8 * beat;
    for (let k = 0; k < 8; k++) {
      addNote(left, runStart + k * beat * 0.5, beat * 0.42, 60 + k, 0.26);
    }
    return {
      id: 'practice',
      name: '练习曲（120BPM，含过门小节）',
      sampleRate: SR,
      channels: toStereo(left),
      markers: {
        bpm: 120,
        beatSec: beat,
        accents,
        runBar: { start: runStart, end: runStart + 2 },
        channelDelaySec: 0.03,
      },
    };
  }

  function buildSustain() {
    const dur = 2;
    const left = new Float32Array(SR * dur);
    const w = 2 * Math.PI * mtof(60) / SR; // 中央 C 261.63Hz
    const n = left.length;
    for (let i = 0; i < n; i++) {
      // 极慢起音 + 平稳保持，适合测音高
      const env = Math.min(1, i / (SR * 0.05));
      left[i] = 0.4 * env * (Math.sin(w * i) + 0.25 * Math.sin(2 * w * i));
    }
    return {
      id: 'sustain',
      name: '连续长音（C4，2 秒）',
      sampleRate: SR,
      channels: toStereo(left),
      markers: { frequency: mtof(60), channelDelaySec: 0.03 },
    };
  }

  function buildAccent() {
    const dur = 0.8;
    const left = new Float32Array(SR * dur);
    // 0.2s 与 0.55s 处两个短重音，位置已知，便于核对重音是否被挪动
    addAccent(left, 0.2, 67, 0.7);
    addAccent(left, 0.55, 72, 0.6);
    return {
      id: 'accent',
      name: '短重音（0.8 秒，两个击点）',
      sampleRate: SR,
      channels: toStereo(left),
      markers: { accents: [0.2, 0.55], channelDelaySec: 0.03 },
    };
  }

  function buildAll() {
    return [buildPractice(), buildSustain(), buildAccent()];
  }

  return { buildAll, buildPractice, buildSustain, buildAccent, SR, CH_DELAY };
});
