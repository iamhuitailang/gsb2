/*
 * engine.js —— Web Audio 播放引擎（浏览器专用）
 *
 * 设计要点：
 * 1. 选中区间按当前模式/速度整段离线渲染成 AudioBuffer，再用
 *    AudioBufferSourceNode.loop 循环。渲染长度已归一化，循环误差
 *    每圈有界（见 play-math.js），不会越放越偏。
 * 2. 切换速度/模式时：先记录当前"源时间"，立刻 stop(0) 旧声源
 *    （不等其自然衰减，杜绝回头/跳转后旧位置声音拖一截），
 *    重新渲染后按同一源时间换算新输出偏移继续播放。
 * 3. 音量 GainNode 与选中区间不随模式切换变化，两种变速对照时
 *    完全共用同一套设置。
 */
(function (root) {
  'use strict';

  const FADE_SEC = 0.002; // 渲染区间首尾 2ms 淡入淡出，消除循环回绕爆音

  function createCtx() {
    const g = typeof globalThis !== 'undefined' ? globalThis : root;
    const Ctor = g.AudioContext || g.webkitAudioContext;
    if (!Ctor) throw new Error('当前浏览器不支持 Web Audio API');
    return new Ctor();
  }

  class PlayerEngine {
    constructor() {
      this.ctx = createCtx();
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = 0.8;
      this.gainNode.connect(this.ctx.destination);

      this.source = null;        // { sampleRate, channels, frames }
      this.region = null;        // { start, end } 源采样点
      this.mode = 'pitch';
      this.rate = 0.5;
      this.loop = true;
      this.volume = 0.8;

      this.rendered = null;      // { buffer, sourceFrames, outputFrames, mode, rate }
      this.node = null;
      this.playing = false;
      this.startCtxTime = 0;
      this.startOutFrame = 0;
      this._gen = 0;             // 代数令牌：废弃旧节点的 onended 回调
      this._listeners = new Set();
    }

    on(fn) { this._listeners.add(fn); }
    _emit(type, payload) {
      for (const fn of this._listeners) {
        try { fn(type, payload); } catch (e) { /* 监听异常不影响引擎 */ }
      }
    }

    /* ---------------- 素材装载 ---------------- */

    loadDecoded(decoded) {
      this.stop();
      const frames = decoded.channels[0].length;
      this.source = {
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
        frames,
      };
      this.region = { start: 0, end: frames };
      this.rendered = null;
      this._emit('loaded');
    }

    loadWav(arrayBuffer) {
      const decoded = WavCodec.decodeWav(arrayBuffer);
      this.loadDecoded(decoded);
      return decoded;
    }

    /* ---------------- 区间与设置（两种模式共用） ---------------- */

    setRegion(start, end) {
      if (!this.source) throw new Error('尚未载入音频');
      start = Math.max(0, Math.floor(start));
      end = Math.min(this.source.frames, Math.floor(end));
      if (end - start < TimeStretch.MIN_FRAMES) {
        throw new Error('选中区间过短：' + (end - start) + ' 个采样点，最少 ' +
          TimeStretch.MIN_FRAMES + ' 个（约 ' +
          (TimeStretch.MIN_FRAMES / this.source.sampleRate).toFixed(3) + ' 秒）');
      }
      const wasPlaying = this.playing;
      this.stop();
      this.region = { start, end };
      this.rendered = null;
      if (wasPlaying) this.play();
      this._emit('region');
    }

    setVolume(v) {
      this.volume = Math.max(0, Math.min(1, v));
      this.gainNode.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
    }

    setLoop(on) { this.loop = !!on; if (this.node) this.node.loop = this.loop; }

    /* ---------------- 渲染 ---------------- */

    _regionChannels() {
      const len = this.region.end - this.region.start;
      return this.source.channels.map((ch) => ch.subarray(this.region.start, this.region.start + len));
    }

    // 离线渲染当前区间；返回 AudioBuffer 与采样数据（导出复用同一份结果）
    renderCurrent() {
      if (!this.source) throw new Error('尚未载入音频');
      const regionFrames = this.region.end - this.region.start;
      const result = TimeStretch.stretch(this._regionChannels(), this.rate, this.mode);

      const buffer = this.ctx.createBuffer(
        result.channels.length, result.outputFrames, this.source.sampleRate);
      for (let c = 0; c < result.channels.length; c++) {
        buffer.copyToChannel(result.channels[c], c);
      }
      applyEdgeFade(buffer, FADE_SEC);

      this.rendered = {
        buffer,
        channels: result.channels,
        sourceFrames: regionFrames,
        outputFrames: result.outputFrames,
        mode: this.mode,
        rate: this.rate,
        sampleRate: this.source.sampleRate,
      };
      return this.rendered;
    }

    /* ---------------- 播放控制 ---------------- */

    async play() {
      if (this.playing) return;
      if (!this.source) throw new Error('尚未载入音频');
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (!this.rendered) this.renderCurrent();

      const gen = this._gen;
      const node = this.ctx.createBufferSource();
      node.buffer = this.rendered.buffer;
      node.loop = this.loop;
      node.connect(this.gainNode);
      const offset = this.startOutFrame / this.rendered.sampleRate;
      node.start(0, offset);
      node.onended = () => {
        if (gen !== this._gen) return; // 已被 stop/重建废弃
        this.playing = false;
        this.node = null;
        this.startOutFrame = this.loop
          ? this.startOutFrame % this.rendered.outputFrames
          : 0;
        this._emit('ended');
      };

      this.node = node;
      this.playing = true;
      this.startCtxTime = this.ctx.currentTime;
      this._emit('play');
    }

    // 立即静音停止：stop(0) 不等衰减，旧声音不会拖到新位置
    stop() {
      this._gen++;
      if (this.node) {
        try { this.node.onended = null; this.node.stop(0); } catch (e) { /* 已停止 */ }
        try { this.node.disconnect(); } catch (e) { /* 忽略 */ }
        this.node = null;
      }
      if (this.playing) {
        this.playing = false;
        this.startOutFrame = 0;
        this._emit('stop');
      }
    }

    // 跳到绝对源采样位置（拖波形/点进度条）
    seek(sourceSample) {
      if (!this.source) return;
      const rel = Math.max(0, Math.min(this.source.frames - 1, sourceSample)) - this.region.start;
      const wasPlaying = this.playing;
      this._haltForRelocate();
      if (!this.rendered) this.renderCurrent();
      this.startOutFrame = PlayMath.sourceToOutput(
        Math.max(0, rel), this.rendered.sourceFrames, this.rendered.outputFrames);
      if (wasPlaying) this.play();
      this._emit('seek');
    }

    // 播放中切速度/模式：按当前源时间继续（需求 3）
    setPlayback(mode, rate) {
      if (!this.source) { this.mode = mode; this.rate = rate; return; }
      const srcRel = this.getSourcePosition() - this.region.start;
      const wasPlaying = this.playing;
      this._haltForRelocate();
      this.mode = mode;
      this.rate = rate;
      this.renderCurrent(); // 同区间重新渲染，音量/区间不变
      this.startOutFrame = PlayMath.sourceToOutput(
        Math.max(0, Math.min(srcRel, this.rendered.sourceFrames - 1)),
        this.rendered.sourceFrames, this.rendered.outputFrames);
      if (wasPlaying) this.play();
      this._emit('playback');
    }

    // 停止旧节点但保留当前位置（与 stop() 的区别：不重置偏移）
    _haltForRelocate() {
      if (this.node) {
        // 先固化当前输出位置，再立刻掐断旧声源
        this.startOutFrame = this._rawOutFrame() %
          (this.rendered ? this.rendered.outputFrames : 1);
        this._gen++;
        try { this.node.onended = null; this.node.stop(0); } catch (e) { /* 已停止 */ }
        try { this.node.disconnect(); } catch (e) { /* 忽略 */ }
        this.node = null;
        this.playing = false;
      }
    }

    _rawOutFrame() {
      if (!this.rendered) return 0;
      if (!this.playing) return this.startOutFrame;
      return this.startOutFrame +
        (this.ctx.currentTime - this.startCtxTime) * this.rendered.sampleRate;
    }

    // 当前绝对源采样位置（含循环折算）
    getSourcePosition() {
      if (!this.rendered) return this.region ? this.region.start : 0;
      const raw = this._rawOutFrame();
      const looped = this.loop
        ? raw % this.rendered.outputFrames
        : Math.min(raw, this.rendered.outputFrames - 1);
      const rel = PlayMath.outputToSource(
        looped, this.rendered.sourceFrames, this.rendered.outputFrames);
      return this.region.start + rel;
    }

    // 已完成的循环圈数（UI 漂移监视用）
    getLoopCount() {
      if (!this.rendered || !this.loop) return 0;
      return Math.floor(this._rawOutFrame() / this.rendered.outputFrames);
    }

    // 本区间循环漂移信息（秒）
    getDriftInfo() {
      if (!this.rendered) return null;
      const loops = this.getLoopCount();
      const perLoop = PlayMath.loopDriftSeconds(
        this.rendered.sourceFrames, this.rate, this.rendered.sampleRate);
      return {
        perLoopSec: perLoop,
        loops,
        accumulatedSec: perLoop * loops,
        outputFrames: this.rendered.outputFrames,
        sourceFrames: this.rendered.sourceFrames,
      };
    }

    /* ---------------- 导出与读回校验 ---------------- */

    // 导出当前区间按当前模式/速度渲染的 WAV（ArrayBuffer）
    exportRegionWav() {
      if (!this.source) throw new Error('尚未载入音频');
      const result = TimeStretch.stretch(this._regionChannels(), this.rate, this.mode);
      const wav = WavCodec.encodeWav(result.channels, this.source.sampleRate);
      return {
        buffer: wav.buffer,
        expected: {
          sampleRate: this.source.sampleRate,
          channels: result.channels.length,
          frames: result.outputFrames,
          regionStart: this.region.start,
          regionEnd: this.region.end,
          rate: this.rate,
          mode: this.mode,
          channelsData: result.channels,
        },
      };
    }

    // 读回导出的 WAV，与"应当导出的内容"逐项核对
    verifyExport(arrayBuffer, expected) {
      const report = { ok: true, checks: [] };
      const check = (name, pass, detail) => {
        report.checks.push({ name, pass, detail });
        if (!pass) report.ok = false;
      };

      let decoded;
      try {
        decoded = WavCodec.decodeWav(arrayBuffer);
      } catch (e) {
        return { ok: false, checks: [{ name: 'WAV 可解析', pass: false, detail: e.message }] };
      }

      check('采样率一致', decoded.sampleRate === expected.sampleRate,
        '导出 ' + decoded.sampleRate + ' Hz / 期望 ' + expected.sampleRate + ' Hz');
      check('声道数一致', decoded.numberOfChannels === expected.channels,
        '导出 ' + decoded.numberOfChannels + ' 声道 / 期望 ' + expected.channels);
      check('帧数一致（循环范围=导出内容长度）',
        decoded.channels[0].length === expected.frames,
        '导出 ' + decoded.channels[0].length + ' 帧 / 期望 ' + expected.frames + ' 帧');

      // 内容逐采样核对（16-bit 量化误差容限 1/32768）
      let maxErr = 0;
      const n = Math.min(decoded.channels[0].length, expected.frames);
      for (let c = 0; c < decoded.numberOfChannels && c < expected.channelsData.length; c++) {
        for (let i = 0; i < n; i++) {
          const err = Math.abs(decoded.channels[c][i] - expected.channelsData[c][i]);
          if (err > maxErr) maxErr = err;
        }
      }
      check('内容与渲染结果一致（16bit 量化容限 2/32768）', maxErr <= 2 / 32768 + 1e-9,
        '最大偏差 ' + maxErr.toExponential(2));

      report.regionSec = {
        start: expected.regionStart / expected.sampleRate,
        end: expected.regionEnd / expected.sampleRate,
      };
      report.durationSec = decoded.channels[0].length / decoded.sampleRate;
      return report;
    }
  }

  function applyEdgeFade(buffer, fadeSec) {
    const fade = Math.max(1, Math.floor(fadeSec * buffer.sampleRate));
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < fade && i < data.length; i++) {
        const g = i / fade;
        data[i] *= g;
        data[data.length - 1 - i] *= g;
      }
    }
  }

  root.PlayerEngine = PlayerEngine;
})(typeof self !== 'undefined' ? self : this);
