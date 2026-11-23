/*
 * fake-audio-context.mjs —— Node 测试用的最小 Web Audio 假实现
 * 只实现 engine.js 实际用到的接口，并把全局依赖（WavCodec 等）挂到 globalThis。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PUB = new URL('../../public/js/', import.meta.url);

globalThis.WavCodec = require(new URL('wav-codec.js', PUB).pathname);
globalThis.TimeStretch = require(new URL('time-stretch.js', PUB).pathname);
globalThis.PlayMath = require(new URL('play-math.js', PUB).pathname);
globalThis.Samples = require(new URL('samples.js', PUB).pathname);
globalThis.AudioAnalyze = require(new URL('analyze.js', PUB).pathname);

export function loadEngine() {
  // engine.js 在 require 时即读取 globalThis.AudioContext，所以先装假实现
  return require(new URL('engine.js', PUB).pathname);
}

class FakeParam {
  constructor(value) { this.value = value; }
  setTargetAtTime(v) { this.value = v; }
}

class FakeNode {
  constructor(ctx) { this.ctx = ctx; this.onended = null; this.loop = false; }
  connect() {}
  disconnect() {}
  start(when = 0, offset = 0) {
    this.startWhen = when;
    this.offset = offset;
    this.running = true;
    // 立即登记，测试可手动触发 onended
    this.ctx._nodes.push(this);
  }
  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.onended) {
      const cb = this.onended;
      this.onended = null;
      cb();
    }
  }
}

class FakeBuffer {
  constructor(numberOfChannels, length, sampleRate) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this._ch = [];
    for (let c = 0; c < numberOfChannels; c++) this._ch.push(new Float32Array(length));
  }
  getChannelData(c) { return this._ch[c]; }
  copyToChannel(data, c) { this._ch[c].set(data); }
}

export class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.sampleRate = 44100;
    this.destination = {};
    this._nodes = [];
  }
  createGain() {
    const n = new FakeNode(this);
    n.gain = new FakeParam(0.8);
    return n;
  }
  createBuffer(ch, len, sr) { return new FakeBuffer(ch, len, sr); }
  createBufferSource() { return new FakeNode(this); }
  async resume() { this.state = 'running'; }
}

export function installFakeAudio() {
  globalThis.AudioContext = FakeAudioContext;
  globalThis.webkitAudioContext = FakeAudioContext;
}
