/*
 * audio-engine.js — Web Audio 播放引擎
 * 监听链路与分析链路分离：
 *   - 监听源按当前试听模式（立体声/左/右/单声道）路由到耳机；
 *   - 分析源始终播放完整立体声，保证表桥永远显示真实 L/R/M，
 *     不会因“左声道独奏路由到双耳”而让右表桥误显示。
 */
(function (root) {
  'use strict';

  function AudioEngine() {
    this.ctx = null;
    this.left = null;
    this.right = null;
    this.sampleRate = 0;
    this.mode = 'stereo';
    this.compEnabled = true;
    this.compGainLinear = 1;
    this.playing = false;
    this.startTime = 0;        // ctx.currentTime 基准
    this.startOffset = 0;      // 起播偏移（秒）
    this.pausedAt = 0;
    this.loopStart = null;
    this.loopEnd = null;
    this.monitorSource = null;
    this.analysisSource = null;
    this.onEnded = null;
  }

  AudioEngine.prototype._ensureCtx = function () {
    if (!this.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();

      this.compGainNode = this.ctx.createGain();
      this.splitter = this.ctx.createChannelSplitter(2);
      this.analyserL = this.ctx.createAnalyser();
      this.analyserR = this.ctx.createAnalyser();
      this.analyserL.fftSize = 2048;
      this.analyserR.fftSize = 2048;
      this.timeL = new Float32Array(this.analyserL.fftSize);
      this.timeR = new Float32Array(this.analyserR.fftSize);

      // 分析链路：立体声源 → 分配器 → 两个分析器（不发声）
      this.analysisBus = this.ctx.createGain();
      this.analysisBus.gain.value = 0; // 静音但仍过分析器
      this.analysisBus.connect(this.splitter);
      this.splitter.connect(this.analyserL, 0);
      this.splitter.connect(this.analyserR, 1);
      this.analysisBus.connect(this.ctx.destination); // gain=0，仅保证图被驱动

      // 监听链路：模式源 → 补偿增益 → 耳机
      this.compGainNode.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  };

  AudioEngine.prototype.setTrack = function (left, right, sampleRate) {
    this._ensureCtx(); // 上下文懒加载：建缓冲前必须就绪
    var pos = this.getPosition();
    var wasPlaying = this.playing;
    this._stopSources();
    this.left = left;
    this.right = right;
    this.sampleRate = sampleRate;
    this.duration = left.length / sampleRate;
    this.stereoBuffer = this._makeStereoBuffer(left, right);
    if (wasPlaying) this.play(Math.min(pos, this.duration));
  };

  AudioEngine.prototype._makeStereoBuffer = function (left, right) {
    var buf = this.ctx.createBuffer(2, left.length, this.sampleRate);
    buf.copyToChannel(left, 0);
    buf.copyToChannel(right, 1);
    return buf;
  };

  AudioEngine.prototype._makeModeBuffer = function () {
    var n = this.left.length;
    var buf = this.ctx.createBuffer(2, n, this.sampleRate);
    var ch0 = buf.getChannelData(0);
    var ch1 = buf.getChannelData(1);
    if (this.mode === 'stereo') {
      buf.copyToChannel(this.left, 0);
      buf.copyToChannel(this.right, 1);
      return buf;
    }
    var src;
    if (this.mode === 'left') src = this.left;
    else if (this.mode === 'right') src = this.right;
    else { // mono：(L+R)/2 后同时送两耳
      src = new Float32Array(n);
      for (var i = 0; i < n; i++) src[i] = (this.left[i] + this.right[i]) * 0.5;
    }
    ch0.set(src);
    ch1.set(src);
    return buf;
  };

  AudioEngine.prototype.setMode = function (mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (this.playing) {
      var pos = this.getPosition();
      this._stopSources();
      this.play(pos);
    }
  };

  AudioEngine.prototype.setCompensation = function (enabled, gainLinear) {
    this.compEnabled = enabled;
    if (gainLinear !== undefined) this.compGainLinear = gainLinear;
    if (this.ctx) {
      this.compGainNode.gain.setTargetAtTime(
        enabled ? this.compGainLinear : 1, this.ctx.currentTime, 0.01);
    }
  };

  AudioEngine.prototype.setCompGain = function (gainLinear) {
    this.compGainLinear = gainLinear;
    if (this.ctx && this.compEnabled) {
      this.compGainNode.gain.setTargetAtTime(gainLinear, this.ctx.currentTime, 0.01);
    }
  };

  /** 开关切换时立即应用（不做平滑），避免等响补偿状态显示与实际增益不一致 */
  AudioEngine.prototype.applyCompNow = function () {
    if (!this.ctx) return;
    this.compGainNode.gain.value = this.compEnabled ? this.compGainLinear : 1;
    this.compGainNode.gain.setTargetAtTime(
      this.compEnabled ? this.compGainLinear : 1, this.ctx.currentTime, 0.01);
  };

  AudioEngine.prototype.setLoop = function (startSec, endSec) {
    this.loopStart = startSec;
    this.loopEnd = endSec;
  };

  AudioEngine.prototype.play = function (offsetSec) {
    this._ensureCtx();
    if (!this.left) return;
    this._stopSources();
    var offset = offsetSec != null ? offsetSec
      : (this.playing ? this.getPosition() : (this.pausedAt || 0));
    offset = Math.max(0, Math.min(offset, this.duration - 0.001));

    this.monitorSource = this.ctx.createBufferSource();
    this.monitorSource.buffer = this._makeModeBuffer();
    this.monitorSource.connect(this.compGainNode);

    this.analysisSource = this.ctx.createBufferSource();
    this.analysisSource.buffer = this.stereoBuffer;
    this.analysisSource.connect(this.analysisBus);

    // 记录自然结束时刻：onended 触发时若已到该时刻且仍在播放，才算自然播完
    // （主动换源/停止会先把 playing 置 false 或更新 expectedEndTime）
    this.expectedEndTime = this.ctx.currentTime + (this.duration - offset);
    var self = this;
    this.monitorSource.onended = function () {
      if (self.playing && self.ctx.currentTime >= self.expectedEndTime - 0.02) {
        self.playing = false;
        self.pausedAt = 0;
        if (self.onEnded) self.onEnded();
      }
    };

    this.startTime = this.ctx.currentTime;
    this.startOffset = offset;
    this.monitorSource.start(0, offset);
    this.analysisSource.start(0, offset);
    this.playing = true;
  };

  AudioEngine.prototype.pause = function () {
    if (!this.playing) return;
    this.pausedAt = this.getPosition();
    this._stopSources();
    this.playing = false;
  };

  AudioEngine.prototype.stop = function () {
    this._stopSources();
    this.playing = false;
    this.pausedAt = 0;
  };

  AudioEngine.prototype._stopSources = function () {
    if (this.monitorSource) {
      try { this.monitorSource.onended = null; this.monitorSource.stop(); } catch (e) {}
      this.monitorSource = null;
    }
    if (this.analysisSource) {
      try { this.analysisSource.stop(); } catch (e) {}
      this.analysisSource = null;
    }
  };

  AudioEngine.prototype.getPosition = function () {
    if (!this.ctx || !this.left) return 0;
    if (!this.playing) return this.pausedAt || 0;
    return this.startOffset + (this.ctx.currentTime - this.startTime);
  };

  /** 由外部 requestAnimationFrame 调用：处理选区循环与自然越界 */
  AudioEngine.prototype.tick = function () {
    if (!this.playing) return this.getPosition();
    var pos = this.getPosition();
    if (this.loopEnd != null && pos >= this.loopEnd) {
      this.play(this.loopStart);
      return this.loopStart;
    }
    return pos;
  };

  /** 实时时域数据（真实左右声道，与试听模式无关） */
  AudioEngine.prototype.getTimeDomain = function () {
    if (!this.ctx) return null;
    this.analyserL.getFloatTimeDomainData(this.timeL);
    this.analyserR.getFloatTimeDomainData(this.timeR);
    return { l: this.timeL, r: this.timeR };
  };

  AudioEngine.prototype.isPlaying = function () { return this.playing; };

  root.AudioEngine = AudioEngine;
})(window);
