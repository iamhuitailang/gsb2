#!/usr/bin/env node
/**
 * 生成 4 个本地示例音频（PCM 16-bit 立体声 WAV，44.1kHz）。
 * 纯 Node 实现、零依赖：鼓组用振荡器+噪声合成，贝斯用锯齿波合成。
 * 输出到 public/samples/，由示例工程引用，全部数据留在本地。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 44100;
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples');
mkdirSync(outDir, { recursive: true });

/** 可复现的随机数（保证每次生成的示例一致） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class StereoBuffer {
  constructor(duration) {
    this.length = Math.ceil(duration * SAMPLE_RATE);
    this.left = new Float32Array(this.length);
    this.right = new Float32Array(this.length);
  }

  /** 在指定时间叠加一个采样（带立体声摆位 -1..1） */
  add(time, sample, pan = 0) {
    const i = Math.round(time * SAMPLE_RATE);
    if (i < 0 || i >= this.length) return;
    const gL = Math.cos(((pan + 1) * Math.PI) / 4);
    const gR = Math.sin(((pan + 1) * Math.PI) / 4);
    this.left[i] += sample * gL;
    this.right[i] += sample * gR;
  }

  addKick(time, rng) {
    const dur = 0.22;
    const n = Math.floor(dur * SAMPLE_RATE);
    const start = Math.round(time * SAMPLE_RATE);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const env = Math.exp(-t * 18);
      const freq = 120 * Math.exp(-t * 25) + 42;
      const s = Math.sin(2 * Math.PI * freq * t) * env * 0.9;
      if (start + i < this.length) {
        this.left[start + i] += s;
        this.right[start + i] += s;
      }
    }
    void rng;
  }

  addSnare(time, rng) {
    const dur = 0.18;
    const n = Math.floor(dur * SAMPLE_RATE);
    const start = Math.round(time * SAMPLE_RATE);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const env = Math.exp(-t * 22);
      const noise = (rng() * 2 - 1) * env * 0.5;
      const tone = Math.sin(2 * Math.PI * 190 * t) * env * 0.25;
      const s = noise + tone;
      if (start + i < this.length) {
        this.left[start + i] += s * 0.9;
        this.right[start + i] += s * 1.1;
      }
    }
  }

  addHat(time, rng, open = false) {
    const dur = open ? 0.22 : 0.05;
    const n = Math.floor(dur * SAMPLE_RATE);
    const start = Math.round(time * SAMPLE_RATE);
    // 简易高通：噪声差分
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const env = Math.exp(-t * (open ? 12 : 55));
      const white = rng() * 2 - 1;
      const hp = white - prev;
      prev = white;
      const s = hp * env * 0.35;
      if (start + i < this.length) {
        this.left[start + i] += s * 1.1;
        this.right[start + i] += s * 0.9;
      }
    }
  }

  addBassNote(time, freq, dur, pan = 0) {
    const n = Math.floor(dur * SAMPLE_RATE);
    const start = Math.round(time * SAMPLE_RATE);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const attack = Math.min(1, t / 0.012);
      const release = Math.min(1, (dur - t) / 0.03);
      const env = Math.max(0, attack * release);
      // 两个失谐锯齿波叠加，低通感由谐波衰减模拟
      const ph = 2 * Math.PI * freq * t;
      const saw = ((((ph / (2 * Math.PI)) % 1) * 2) - 1) * 0.55;
      const saw2 = ((((ph * 1.005 / (2 * Math.PI)) % 1) * 2) - 1) * 0.35;
      const sub = Math.sin(ph) * 0.4;
      const s = (saw + saw2 + sub) * env * 0.32;
      if (start + i < this.length) {
        const gL = Math.cos(((pan + 1) * Math.PI) / 4);
        const gR = Math.sin(((pan + 1) * Math.PI) / 4);
        this.left[start + i] += s * gL;
        this.right[start + i] += s * gR;
      }
    }
  }

  normalize(target = 0.85) {
    let peak = 0;
    for (let i = 0; i < this.length; i++) {
      peak = Math.max(peak, Math.abs(this.left[i]), Math.abs(this.right[i]));
    }
    if (peak === 0) return;
    const gain = target / peak;
    for (let i = 0; i < this.length; i++) {
      this.left[i] *= gain;
      this.right[i] *= gain;
    }
  }
}

function encodeWav(buffer) {
  const frames = buffer.length;
  const dataSize = frames * 2 * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (const ch of [buffer.left[i], buffer.right[i]]) {
      const v = Math.max(-1, Math.min(1, ch));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return Buffer.from(ab);
}

/* ---------------- 鼓组：120 BPM，8 秒 = 16 拍 ---------------- */

function makeDrumLoop(seed, patternB) {
  const rng = mulberry32(seed);
  const buf = new StereoBuffer(8);
  const beat = 0.5; // 120 BPM
  for (let bar = 0; bar < 4; bar++) {
    const barStart = bar * 4 * beat;
    // 四四拍底鼓
    buf.addKick(barStart, rng);
    buf.addKick(barStart + 2 * beat, rng);
    if (patternB && bar % 2 === 1) buf.addKick(barStart + 3.5 * beat, rng);
    // 军鼓在 2、4 拍
    buf.addSnare(barStart + beat, rng);
    buf.addSnare(barStart + 3 * beat, rng);
    // 八分音符踩镲
    for (let h = 0; h < 8; h++) {
      const t = barStart + h * (beat / 2);
      buf.addHat(t, rng, h === 7 && (patternB || bar === 3));
    }
  }
  buf.normalize(0.8);
  return buf;
}

/* ---------------- 贝斯：6 秒乐句 ---------------- */

const NOTE_FREQS = { A1: 55, C2: 65.41, E2: 82.41, G2: 98, A2: 110, F2: 87.31, D2: 73.42 };

function makeBassLine(seed, variantB) {
  const rng = mulberry32(seed);
  const buf = new StereoBuffer(6);
  const step = 0.5; // 八分步进
  const patternA = ['A1', 'A1', 'C2', 'A1', 'E2', 'E2', 'G2', 'E2', 'A1', 'A1', 'C2', 'A1'];
  const patternB = ['A1', 'F2', 'D2', 'F2', 'E2', 'E2', 'G2', 'A2', 'A1', 'F2', 'D2', 'C2'];
  const pattern = variantB ? patternB : patternA;
  for (let i = 0; i < pattern.length; i++) {
    const t = i * step;
    const dur = i % 3 === 2 ? 0.42 : 0.34;
    const pan = (rng() - 0.5) * 0.2;
    buf.addBassNote(t, NOTE_FREQS[pattern[i]], dur, pan);
  }
  buf.normalize(0.82);
  return buf;
}

const files = [
  ['drum-loop-a.wav', makeDrumLoop(101, false)],
  ['drum-loop-b.wav', makeDrumLoop(202, true)],
  ['bass-line-a.wav', makeBassLine(303, false)],
  ['bass-line-b.wav', makeBassLine(404, true)],
];

for (const [name, buffer] of files) {
  writeFileSync(join(outDir, name), encodeWav(buffer));
  console.log(`生成 ${name} (${(buffer.length / SAMPLE_RATE).toFixed(1)}s)`);
}
console.log('全部示例音频已生成到 public/samples/');
