// 播放器：干/湿两条 BufferSource 接各自 GainNode 汇总到 master。
// 三个模式只改增益、不动 source；seek 对两条 source 用同一偏移，杜绝第一声错位。
(function (root) {
  const RL = root.RoomLab || (root.RoomLab = {});

  class StemPlayer {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.gainDry = null;
      this.gainWet = null;
      this.srcDry = null;
      this.srcWet = null;
      this.buf = null;
      this.startCtxTime = 0;
      this.offsetSec = 0;
      this.playing = false;
      this.mode = 'mix';
      this.wetGain = 1;
      this.onEnded = null;
      this.onTick = null;
      this._raf = null;
    }

    _ensureCtx() {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.gain.value = 1;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    // 载入一次渲染结果（干/湿同源、等长）
    load(rendered) {
      this.stop();
      this._ensureCtx();
      const sr = rendered.sampleRate;
      const mk = (channels) => {
        const b = this.ctx.createBuffer(channels.length, channels[0].length, sr);
        channels.forEach((c, i) => b.copyToChannel(c, i));
        return b;
      };
      this.dryBuf = mk(rendered.dry);
      this.wetBuf = mk(rendered.wet);
      this.duration = rendered.dry[0].length / sr;
      this.offsetSec = 0;
    }

    _applyGains() {
      if (!this.gainDry) return;
      const g = this.wetGain;
      const vals = {
        dry: this.mode === 'wet' ? 0 : 1,
        wet: this.mode === 'dry' ? 0 : g,
      };
      // 直接写 value：模式切换是增益路由变化，两条信号同源，不会产生爆音；
      // 同时保证切换后读取 gain.value 立即反映新模式（自动化测试与 UI 状态一致）
      this.gainDry.gain.value = vals.dry;
      this.gainWet.gain.value = vals.wet;
    }

    setMode(mode) {
      this.mode = mode;
      this._applyGains();
    }

    setWetGain(g) {
      this.wetGain = g;
      this._applyGains();
    }

    play(offset) {
      this._ensureCtx();
      this._teardownSources();
      if (offset != null) this.offsetSec = Math.min(offset, this.duration);
      const at = this.ctx.currentTime;

      this.gainDry = this.ctx.createGain();
      this.gainWet = this.ctx.createGain();
      this.gainDry.connect(this.master);
      this.gainWet.connect(this.master);

      this.srcDry = this.ctx.createBufferSource();
      this.srcWet = this.ctx.createBufferSource();
      this.srcDry.buffer = this.dryBuf;
      this.srcWet.buffer = this.wetBuf;
      this.srcDry.connect(this.gainDry);
      this.srcWet.connect(this.gainWet);
      this._applyGains();

      this.srcDry.onended = () => {
        if (this.playing && this.onEnded) this.onEnded();
      };
      this.srcDry.start(0, this.offsetSec);
      this.srcWet.start(0, this.offsetSec); // 同一偏移，两条 source 采样对齐
      this.startCtxTime = at;
      this.playing = true;
      this._loop();
    }

    pause() {
      if (!this.playing) return;
      this.offsetSec = this.position();
      this._teardownSources();
      this.playing = false;
    }

    // 停止：立即断开并丢弃 source —— 上一轮的回声不会残留
    stop() {
      this._teardownSources();
      this.playing = false;
      this.offsetSec = 0;
    }

    seek(sec) {
      const wasPlaying = this.playing;
      this.offsetSec = Math.min(Math.max(0, sec), this.duration);
      if (wasPlaying) this.play(this.offsetSec);
    }

    _teardownSources() {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = null;
      for (const [src, gain] of [[this.srcDry, this.gainDry], [this.srcWet, this.gainWet]]) {
        if (!src) continue;
        try { src.onended = null; src.stop(); } catch (e) { /* 已停止 */ }
        try { src.disconnect(); } catch (e) { /* ignore */ }
      }
      try { this.gainDry && this.gainDry.disconnect(); } catch (e) { /* ignore */ }
      try { this.gainWet && this.gainWet.disconnect(); } catch (e) { /* ignore */ }
      this.srcDry = this.srcWet = null;
      this.gainDry = this.gainWet = null;
    }

    position() {
      if (!this.playing) return this.offsetSec;
      return Math.min(this.duration, this.offsetSec + (this.ctx.currentTime - this.startCtxTime));
    }

    _loop() {
      if (!this.playing) return;
      if (this.onTick) this.onTick(this.position());
      this._raf = requestAnimationFrame(() => this._loop());
    }
  }

  RL.StemPlayer = StemPlayer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
