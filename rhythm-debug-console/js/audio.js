/*!
 * audio.js —— 全部声音由 Web Audio 振荡器/噪声实时合成，无任何音频文件。
 *  - 节拍器：每拍短促 click，小节首拍加重音
 *  - 音符提示音：单点/长按头部、长按尾部各一种音色
 *  - 判定音：完美 / 良好 / 漏拍 / 提前松开
 */
(function (global) {
  'use strict';

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.scheduled = []; // 已调度的振荡器节点，停止时统一回收
      this.enabled = true;
    }

    ensure() {
      if (!this.ctx) {
        const AC = global.AudioContext || global.webkitAudioContext;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }

    now() { return this.ensure().currentTime; }

    /** 基础合成：振荡器 + 指数衰减包络。 */
    tone(freq, when, dur, type, peakGain) {
      if (!this.enabled) return;
      const ctx = this.ensure();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, when);
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(peakGain || 0.2, when + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      osc.connect(g).connect(this.master);
      osc.start(when);
      osc.stop(when + dur + 0.02);
      this.scheduled.push(osc);
      osc.onended = () => {
        const i = this.scheduled.indexOf(osc);
        if (i >= 0) this.scheduled.splice(i, 1);
      };
    }

    /** 噪声脉冲（模拟鼓边/漏拍的低沉击打）。 */
    noise(when, dur, peakGain, filterFreq) {
      if (!this.enabled) return;
      const ctx = this.ensure();
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = filterFreq || 800;
      const g = ctx.createGain();
      g.gain.setValueAtTime(peakGain || 0.25, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      src.connect(filter).connect(g).connect(this.master);
      src.start(when);
      src.stop(when + dur);
    }

    // ---- 节拍器 ----
    metronome(when, accent) {
      if (accent) this.tone(1568, when, 0.06, 'square', 0.12); // G6 重音
      else this.tone(1046, when, 0.04, 'square', 0.06);       // C6 普通拍
    }

    // ---- 音符提示音 ----
    cueTap(when) { this.tone(880, when, 0.09, 'triangle', 0.18); }
    cueHoldHead(when) { this.tone(660, when, 0.1, 'triangle', 0.18); }
    cueHoldEnd(when) { this.tone(1320, when, 0.12, 'sine', 0.16); }

    // ---- 判定反馈音 ----
    judgeSound(judgment, when) {
      switch (judgment) {
        case 'perfect': this.tone(1318, when, 0.12, 'sine', 0.2); break;      // E6 清脆
        case 'good': this.tone(988, when, 0.12, 'sine', 0.16); break;         // B5
        case 'complete': this.tone(1568, when, 0.18, 'sine', 0.2); break;     // G6 完成
        case 'early': this.tone(440, when, 0.14, 'sawtooth', 0.1); break;     // A4 干涩
        case 'miss': this.noise(when, 0.18, 0.28, 500); break;                // 低频噪声
      }
    }

    stopAll() {
      for (const osc of this.scheduled) {
        try { osc.stop(); } catch (e) { /* 已结束 */ }
      }
      this.scheduled = [];
    }
  }

  global.AudioEngine = AudioEngine;
})(window);
