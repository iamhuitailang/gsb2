/* 音频引擎：Web Audio 图形构建、参数平滑、遮挡/混响计算、录音导出 */
'use strict';

const SMOOTH_TAU = 0.06; // 参数平滑时间常数（秒）

class ReverbBus {
  constructor(ctx, masterIn) {
    this.ctx = ctx;
    this.input = ctx.createGain();       // 各声源 wetGain 汇总到这里
    this.convA = ctx.createConvolver();
    this.convB = ctx.createConvolver();
    this.gainA = ctx.createGain();
    this.gainB = ctx.createGain();
    this.output = ctx.createGain();
    this.input.connect(this.convA); this.convA.connect(this.gainA); this.gainA.connect(this.output);
    this.input.connect(this.convB); this.convB.connect(this.gainB); this.gainB.connect(this.output);
    this.output.connect(masterIn);
    this.gainA.gain.value = 1;
    this.gainB.gain.value = 0;
    this.active = 'A';
    this.decay = 0;   // 当前生效的混响衰减时间
    this._irCache = new Map();
    this.convA.buffer = this._makeIR(0.01); // 初始近乎无声
  }

  _makeIR(decay) {
    const key = decay.toFixed(2);
    if (this._irCache.has(key)) return this._irCache.get(key);
    const rate = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * Math.max(0.01, decay)));
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
      }
    }
    if (this._irCache.size > 12) this._irCache.clear();
    this._irCache.set(key, buf);
    return buf;
  }

  // 平滑切换到目标衰减时间；decay<=0 表示无混响
  setDecay(decay) {
    decay = Math.max(0, decay);
    if (Math.abs(decay - this.decay) < 0.01) return;
    this.decay = decay;
    const t = this.ctx.currentTime;
    const inGain = decay > 0 ? this.gainB : this.gainA; // 将要激活的一路
    const outGain = decay > 0 ? this.gainA : this.gainB;
    const inConv = decay > 0 ? this.convB : this.convA;
    inConv.buffer = this._makeIR(Math.max(0.05, decay));
    inGain.gain.setTargetAtTime(1, t, 0.25);
    outGain.gain.setTargetAtTime(0, t, 0.25);
  }
}

/* 声源发声体：负责生成声音素材（全部程序化合成，无需外部音频文件） */
class VoiceGenerator {
  constructor(ctx, sound, outNode) {
    this.ctx = ctx;
    this.nodes = [];
    this.timers = [];
    this.build(sound, outNode);
  }

  _reg(node) { this.nodes.push(node); return node; }

  build(sound, out) {
    const ctx = this.ctx;
    const type = sound.type;
    if (type === 'tone') {
      const osc = this._reg(ctx.createOscillator());
      osc.type = sound.wave || 'sine';
      osc.frequency.value = sound.freq || 440;
      // 轻微颤音，便于听出移动
      const lfo = this._reg(ctx.createOscillator());
      const lfoGain = this._reg(ctx.createGain());
      lfo.frequency.value = 5; lfoGain.gain.value = (sound.freq || 440) * 0.004;
      lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
      osc.connect(out); osc.start(); lfo.start();
    } else if (type === 'beep') {
      const osc = this._reg(ctx.createOscillator());
      osc.type = 'square'; osc.frequency.value = sound.freq || 880;
      const gate = this._reg(ctx.createGain());
      gate.gain.value = 0;
      const lfo = this._reg(ctx.createOscillator());
      lfo.type = 'square'; lfo.frequency.value = sound.rate || 2;
      const lfoGain = this._reg(ctx.createGain());
      lfoGain.gain.value = 0.5;
      const offset = this._reg(ctx.createConstantSource());
      offset.offset.value = 0.5;
      lfo.connect(lfoGain); lfoGain.connect(gate.gain);
      offset.connect(gate.gain);
      osc.connect(gate); gate.connect(out);
      osc.start(); lfo.start(); offset.start();
    } else if (type === 'noise') {
      const src = this._reg(ctx.createBufferSource());
      src.buffer = VoiceGenerator.noiseBuffer(ctx);
      src.loop = true;
      const bp = this._reg(ctx.createBiquadFilter());
      bp.type = 'bandpass';
      bp.frequency.value = sound.bandFreq || 1200;
      bp.Q.value = sound.bandQ || 0.8;
      src.connect(bp); bp.connect(out); src.start();
    } else if (type === 'engine') {
      const osc = this._reg(ctx.createOscillator());
      osc.type = 'sawtooth'; osc.frequency.value = sound.freq || 70;
      const osc2 = this._reg(ctx.createOscillator());
      osc2.type = 'square'; osc2.frequency.value = (sound.freq || 70) * 1.5;
      const g2 = this._reg(ctx.createGain()); g2.gain.value = 0.4;
      const noise = this._reg(ctx.createBufferSource());
      noise.buffer = VoiceGenerator.noiseBuffer(ctx); noise.loop = true;
      const lp = this._reg(ctx.createBiquadFilter());
      lp.type = 'lowpass'; lp.frequency.value = 500;
      const ng = this._reg(ctx.createGain()); ng.gain.value = 0.25;
      noise.connect(lp); lp.connect(ng); ng.connect(out);
      osc.connect(out); osc2.connect(g2); g2.connect(out);
      osc.start(); osc2.start(); noise.start();
    } else if (type === 'melody') {
      // 简单前瞻调度器循环播放音阶
      const outGain = this._reg(ctx.createGain());
      outGain.gain.value = 0.9; outGain.connect(out);
      const notes = sound.notes || [523, 587, 659, 784, 659, 587];
      const spb = 60 / (sound.tempo || 120) / 2; // 八分音符
      let step = 0, nextTime = ctx.currentTime + 0.1;
      const timer = setInterval(() => {
        while (nextTime < ctx.currentTime + 0.3) {
          const osc = ctx.createOscillator();
          osc.type = 'triangle';
          osc.frequency.value = notes[step % notes.length];
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.9, nextTime);
          g.gain.exponentialRampToValueAtTime(0.001, nextTime + spb * 0.95);
          osc.connect(g); g.connect(outGain);
          osc.start(nextTime); osc.stop(nextTime + spb);
          step++; nextTime += spb;
        }
      }, 100);
      this.timers.push(timer);
    }
  }

  dispose() {
    this.timers.forEach(clearInterval);
    this.nodes.forEach(n => {
      try { if (n.stop) n.stop(); } catch (e) { /* 已停止 */ }
      try { n.disconnect(); } catch (e) { /* 已断开 */ }
    });
  }

  static noiseBuffer(ctx) {
    if (!VoiceGenerator._noise) {
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      VoiceGenerator._noise = buf;
    }
    return VoiceGenerator._noise;
  }
}

/* 单个声源的完整音频链路 */
class SourceVoice {
  constructor(engine, srcModel) {
    const ctx = engine.ctx;
    this.engine = engine;
    this.id = srcModel.id;
    this.genGain = ctx.createGain();
    this.panner = ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.occFilter = ctx.createBiquadFilter();
    this.occFilter.type = 'lowpass';
    this.occFilter.frequency.value = 20000;
    this.occGain = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.genGain.connect(this.panner);
    this.panner.connect(this.occFilter);
    this.occFilter.connect(this.occGain);
    this.occGain.connect(this.dryGain); this.dryGain.connect(engine.master);
    this.occGain.connect(this.wetGain); this.wetGain.connect(engine.reverb.input);
    this.generator = new VoiceGenerator(ctx, srcModel.sound, this.genGain);
    // 实时计算结果（供 UI 显示 / 导出）
    this.live = { dist: 0, distGain: 1, panDeg: 0, coneGain: 1, occDb: 0, lpf: 20000, wet: 0 };
  }

  // 每帧根据场景状态更新全部参数（均做平滑处理）
  update(src, listener, walls, zones) {
    const ctx = this.engine.ctx, t = ctx.currentTime;
    const p = this.panner;
    // 距离模型
    p.distanceModel = src.distModel;
    p.refDistance = src.refDistance;
    p.maxDistance = src.maxDistance;
    p.rolloffFactor = src.rolloff;
    // 方向性锥体
    p.coneInnerAngle = src.coneInner;
    p.coneOuterAngle = src.coneOuter;
    p.coneOuterGain = src.coneOuterGain;
    // 位置与朝向（世界坐标 -> 音频坐标：x→x, y→z）
    this._setParam(p.positionX, p.positionY, p.positionZ, src.x, 0, src.y, t);
    this._setParam(p.orientationX, p.orientationY, p.orientationZ,
      Math.cos(src.angle), 0, Math.sin(src.angle), t);

    // 基础音量
    this.genGain.gain.setTargetAtTime(src.muted ? 0 : src.volume, t, SMOOTH_TAU);

    // 纯计算（遮挡 / 混响 / 显示值），与 UI 共用
    const lv = AudioEngine.computeLive(src, listener, walls, zones);
    this.live = lv;
    this.occGain.gain.setTargetAtTime(lv.occFactor, t, SMOOTH_TAU);
    this.occFilter.frequency.setTargetAtTime(lv.lpf, t, SMOOTH_TAU);
    this.wetGain.gain.setTargetAtTime(lv.wet, t, 0.15);
    this.dryGain.gain.setTargetAtTime(1 - lv.wet * 0.5, t, 0.15);
  }

  _setParam(px, py, pz, x, y, z, t) {
    if (px && px.setTargetAtTime) {
      px.setTargetAtTime(x, t, SMOOTH_TAU);
      py.setTargetAtTime(y, t, SMOOTH_TAU);
      pz.setTargetAtTime(z, t, SMOOTH_TAU);
    } else if (this.panner.setPosition) {
      this.panner.setPosition(x, y, z);
    }
  }

  dispose() {
    this.generator.dispose();
    [this.genGain, this.panner, this.occFilter, this.occGain, this.dryGain, this.wetGain]
      .forEach(n => { try { n.disconnect(); } catch (e) {} });
  }
}

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.voices = new Map(); // sourceId -> SourceVoice
    this.enabled = true;
  }

  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      // 录音导出节点
      this.recordDest = this.ctx.createMediaStreamDestination();
      this.master.connect(this.recordDest);
      this.reverb = new ReverbBus(this.ctx, this.master);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  get ready() { return !!this.ctx && this.enabled; }

  /* 每帧同步场景到音频图 */
  sync(scene) {
    if (!this.ready) {
      if (this.ctx) this._teardownVoices();
      return;
    }
    this.ensureContext();
    const t = this.ctx.currentTime;
    const listener = scene.listener;

    // 听者位置/朝向（平滑）
    if (listener) {
      const L = this.ctx.listener;
      const fx = Math.cos(listener.angle), fz = Math.sin(listener.angle);
      if (L.positionX && L.positionX.setTargetAtTime) {
        L.positionX.setTargetAtTime(listener.x, t, SMOOTH_TAU);
        L.positionY.setTargetAtTime(0, t, SMOOTH_TAU);
        L.positionZ.setTargetAtTime(listener.y, t, SMOOTH_TAU);
        L.forwardX.setTargetAtTime(fx, t, SMOOTH_TAU);
        L.forwardY.setTargetAtTime(0, t, SMOOTH_TAU);
        L.forwardZ.setTargetAtTime(fz, t, SMOOTH_TAU);
        L.upX.setTargetAtTime(0, t, SMOOTH_TAU);
        L.upY.setTargetAtTime(1, t, SMOOTH_TAU);
        L.upZ.setTargetAtTime(0, t, SMOOTH_TAU);
      } else if (L.setPosition) {
        L.setPosition(listener.x, 0, listener.y);
        L.setOrientation(fx, 0, fz, 0, 1, 0);
      }
    }

    // 混响区切换（以听者所在区域为准，淡出时回到干声）
    const lz = listener && scene.zones.find(z => Util.pointInCircle(listener.x, listener.y, z.x, z.y, z.r));
    this.reverb.setDecay(lz ? lz.decay : 0);

    // 同步声源 voices
    const ids = new Set(scene.sources.map(s => s.id));
    for (const [id, voice] of this.voices) {
      if (!ids.has(id)) { voice.dispose(); this.voices.delete(id); }
    }
    for (const src of scene.sources) {
      if (!this.voices.has(src.id)) {
        this.voices.set(src.id, new SourceVoice(this, src));
      } else {
        // 声音素材参数变化时重建发声体（简单可靠）
        const v = this.voices.get(src.id);
        if (v._soundSig !== JSON.stringify(src.sound)) {
          v.generator.dispose();
          v.generator = new VoiceGenerator(this.ctx, src.sound, v.genGain);
        }
      }
      const voice = this.voices.get(src.id);
      voice._soundSig = JSON.stringify(src.sound);
      voice.update(src, listener, scene.walls, scene.zones);
    }
  }

  _teardownVoices() {
    for (const v of this.voices.values()) v.dispose();
    this.voices.clear();
  }

  /* 距离衰减模型估算（与 Web Audio 规范一致，用于 UI 显示） */
  static distanceGain(model, d, ref, max, rolloff) {
    d = Math.max(d, ref);
    if (model === 'linear') {
      if (d >= max) return 0;
      return 1 - rolloff * (d - ref) / Math.max(1e-6, max - ref);
    } else if (model === 'exponential') {
      return Math.pow(d / ref, -rolloff);
    }
    return ref / (ref + rolloff * (d - ref)); // inverse
  }

  /* 纯计算：某声源对听者的全部生效参数（音频引擎与 UI 共用，保证显示与听到的严格一致） */
  static computeLive(src, listener, walls, zones) {
    const lv = {
      dist: 0, distGain: 1, panDeg: 0, coneGain: 1,
      occFactor: 1, occDb: 0, lpf: 20000, wet: 0, zoneName: '',
    };
    // 遮挡：声源→听者连线与墙体求交
    let occFactor = 1, lpf = 20000;
    if (listener) {
      for (const w of walls) {
        if (Util.segmentsIntersect(src.x, src.y, listener.x, listener.y, w.x1, w.y1, w.x2, w.y2)) {
          occFactor *= (1 - 0.75 * w.damping);
          lpf *= (1 - 0.85 * w.damping);
        }
      }
    }
    lpf = Util.clamp(lpf, 250, 20000);
    // 混响：听者所在区域为主，声源所在区域为辅
    const zoneOf = (x, y) => zones.find(z => Util.pointInCircle(x, y, z.x, z.y, z.r));
    const lz = listener ? zoneOf(listener.x, listener.y) : null;
    const sz = zoneOf(src.x, src.y);
    const wet = Util.clamp((lz ? lz.wet * 0.8 : 0) + (sz ? sz.wet * 0.4 : 0), 0, 1);
    lv.occFactor = occFactor;
    lv.lpf = lpf;
    lv.wet = wet;
    lv.zoneName = lz ? lz.name : '';
    lv.occDb = 20 * Math.log10(Math.max(1e-4, occFactor));
    if (listener) {
      lv.dist = Util.dist(src.x, src.y, listener.x, listener.y);
      lv.distGain = AudioEngine.distanceGain(src.distModel, lv.dist, src.refDistance, src.maxDistance, src.rolloff);
      const absAng = Math.atan2(src.y - listener.y, src.x - listener.x);
      let rel = absAng - listener.angle;
      while (rel > Math.PI) rel -= 2 * Math.PI;
      while (rel < -Math.PI) rel += 2 * Math.PI;
      lv.panDeg = -rel * 180 / Math.PI; // 屏幕左为正
      const srcToL = Math.atan2(listener.y - src.y, listener.x - src.x);
      let offAxis = Math.abs(srcToL - src.angle) % (2 * Math.PI);
      if (offAxis > Math.PI) offAxis = 2 * Math.PI - offAxis;
      const offDeg = offAxis * 180 / Math.PI;
      if (offDeg <= src.coneInner / 2) lv.coneGain = 1;
      else if (offDeg >= src.coneOuter / 2) lv.coneGain = src.coneOuterGain;
      else lv.coneGain = Util.lerp(1, src.coneOuterGain,
        (offDeg - src.coneInner / 2) / Math.max(1e-6, (src.coneOuter - src.coneInner) / 2));
    }
    return lv;
  }

  /* 回放期间录音，返回 Promise<Blob> */
  recordFor(durationSec) {
    this.ensureContext();
    return new Promise((resolve, reject) => {
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
      const rec = new MediaRecorder(this.recordDest.stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
      rec.onerror = reject;
      rec.start(200);
      setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, durationSec * 1000 + 300);
    });
  }
}
