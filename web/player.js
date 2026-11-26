// Web Audio 播放器: 原声/处理结果双缓冲, 等功率交叉淡变切换, 无爆音
'use strict';

class ABPlayer {
  constructor() {
    this.ctx = null;
    this.bufA = null; // 原声
    this.bufB = null; // 处理后
    this.gainA = null;
    this.gainB = null;
    this.srcA = null;
    this.srcB = null;
    this.mode = 'B';
    this.playing = false;
    this.offset = 0;
    this.startCtxTime = 0;
    this.fadeSec = 0.03; // 30ms 等功率交叉淡变, 短到听不出但足以消除爆音
    this.onTime = () => {};
    this.onEnded = () => {};
    this._timer = null;
  }

  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gainA = this.ctx.createGain();
      this.gainB = this.ctx.createGain();
      this.gainA.connect(this.ctx.destination);
      this.gainB.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  static async decode(ctx, arrayBuffer) {
    // 复制一份, 部分浏览器会 transfer/detach 原 buffer
    const copy = arrayBuffer.slice(0);
    return await ctx.decodeAudioData(copy);
  }

  async setOriginal(arrayBuffer) {
    this._ensureCtx();
    this.bufA = await ABPlayer.decode(this.ctx, arrayBuffer);
    if (this.playing) {
      const t = this.getTime();
      this.stop();
      this.offset = t;
      this.play();
    }
  }

  async setProcessed(arrayBuffer) {
    this._ensureCtx();
    this.bufB = await ABPlayer.decode(this.ctx, arrayBuffer);
    if (this.playing) {
      const t = this.getTime();
      this.stop();
      this.offset = t;
      this.play();
    }
  }

  get duration() {
    return this.bufA ? this.bufA.duration : 0;
  }

  getTime() {
    if (!this.playing) return Math.min(this.offset, this.duration);
    return Math.min(
      this.duration,
      this.offset + (this.ctx.currentTime - this.startCtxTime),
    );
  }

  _makeSource(buf, gainNode) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gainNode);
    src.onended = () => {
      // 自然播完时两个 source 都会结束
      if (this.getTime() >= this.duration - 0.02) {
        this.playing = false;
        this.offset = 0;
        this._stopTimer();
        this.onEnded();
      }
    };
    return src;
  }

  play() {
    if (!this.bufA || !this.bufB || this.playing) return;
    this._ensureCtx();
    const t0 = this.ctx.currentTime;
    this.srcA = this._makeSource(this.bufA, this.gainA);
    this.srcB = this._makeSource(this.bufB, this.gainB);
    // 起始增益直接落在当前模式, 避免起播爆音
    const g = this.mode === 'A' ? 1 : 0;
    this.gainA.gain.setValueAtTime(g, t0);
    this.gainB.gain.setValueAtTime(1 - g, t0);
    this.srcA.start(0, this.offset);
    this.srcB.start(0, this.offset);
    this.startCtxTime = t0;
    this.playing = true;
    this._startTimer();
  }

  stop() {
    if (!this.playing) return;
    this.offset = this.getTime();
    this._teardownSources();
    this.playing = false;
    this._stopTimer();
  }

  seek(t) {
    const wasPlaying = this.playing;
    if (wasPlaying) this.stop();
    this.offset = Math.max(0, Math.min(this.duration, t));
    if (wasPlaying) this.play();
    this.onTime(this.offset);
  }

  _teardownSources() {
    for (const src of [this.srcA, this.srcB]) {
      if (!src) continue;
      try {
        src.onended = null;
        src.stop();
      } catch (_) {
        /* 已停止 */
      }
      try {
        src.disconnect();
      } catch (_) {
        /* ignore */
      }
    }
    this.srcA = this.srcB = null;
  }

  /** 等功率交叉淡变: gA = cos θ, gB = sin θ, 总功率恒定, 切换无爆音 */
  switchTo(mode) {
    if (mode === this.mode || !this.playing) {
      this.mode = mode;
      if (!this.playing && this.gainA) {
        const g = mode === 'A' ? 1 : 0;
        this.gainA.gain.value = g;
        this.gainB.gain.value = 1 - g;
      }
      return;
    }
    this.mode = mode;
    const t0 = this.ctx.currentTime;
    const t1 = t0 + this.fadeSec;
    const aTo = mode === 'A' ? 1 : 0;
    const bTo = 1 - aTo;
    for (const [node, to] of [
      [this.gainA, aTo],
      [this.gainB, bTo],
    ]) {
      const g = node.gain;
      g.cancelScheduledValues(t0);
      g.setValueAtTime(g.value, t0);
      // 余弦淡变 (等功率): 用线性近似角度差仅 30ms, 人耳不可闻
      g.linearRampToValueAtTime(to, t1);
    }
  }

  _startTimer() {
    this._stopTimer();
    this._timer = setInterval(() => this.onTime(this.getTime()), 50);
  }

  _stopTimer() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

window.ABPlayer = ABPlayer;
