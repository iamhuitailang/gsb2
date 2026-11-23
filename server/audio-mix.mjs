// 服务端音频混音：按统一时间线把每段音轨精确切片、加增益、叠加成 PCM。
// 预览（audio-src WAV + Web Audio）与导出共用同一份增益编排（src/audio.js）。
import path from 'node:path';
import fs from 'node:fs/promises';
import { FFMPEG, run, SAMPLE_DIR, MEDIA_DIR } from './util.mjs';
import { buildAudioPlan, gainAt } from '../src/audio.js';
import { EPS } from '../src/model.js';

export const CHANNELS = 2;
export const DEFAULT_SR = 48000;

const decodeCache = new Map();
const pathCache = new Map();

// 片段里存的是浏览器 URL（如 /media/x.mp4），ffmpeg 需要真实文件路径。
export async function resolveSourcePath(src) {
  const key = String(src || '');
  if (pathCache.has(key)) return pathCache.get(key);
  const base = path.basename(key);
  for (const dir of [SAMPLE_DIR, MEDIA_DIR]) {
    const p = path.join(dir, base);
    try {
      const st = await fs.stat(p);
      if (st.isFile()) {
        pathCache.set(key, p);
        return p;
      }
    } catch { /* next */ }
  }
  pathCache.set(key, null);
  return null;
}

// 把整段源音频解码为交错 f32le（含片头，便于按源时间精确切片）。
export async function decodeFullAudio(file, sampleRate = DEFAULT_SR) {
  const key = `${file}::${sampleRate}`;
  if (decodeCache.has(key)) return decodeCache.get(key);
  const promise = (async () => {
    try {
      const { stdout } = await run(FFMPEG, [
        '-v', 'error', '-i', file, '-vn',
        '-ac', String(CHANNELS), '-ar', String(sampleRate),
        '-f', 'f32le', 'pipe:1',
      ], { maxBuffer: 1024 * 1024 * 1024 });
      return new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
    } catch {
      return new Float32Array(0);
    }
  })();
  decodeCache.set(key, promise);
  return promise;
}

// 在统一时间线上混出 [from, to) 的音频。
export async function mixWindow(project, timeline, from, to, { sampleRate = DEFAULT_SR } = {}) {
  const duration = Math.max(0, to - from);
  const totalFrames = Math.max(0, Math.round(duration * sampleRate));
  const out = new Float32Array(totalFrames * CHANNELS);
  if (totalFrames === 0) return { samples: out, sampleRate, frames: 0, peak: 0 };

  const plan = buildAudioPlan(timeline, project);
  const buffers = new Map();
  for (const span of plan) {
    if (span.silent) continue;
    const row = timeline.clips[span.clipIndex];
    if (!row) continue;
    const segStart = Math.max(from, span.start);
    const segEnd = Math.min(to, span.end);
    if (segEnd - segStart <= EPS) continue;

    if (!buffers.has(row.clip.src)) {
      const file = await resolveSourcePath(row.clip.src);
      buffers.set(row.clip.src, file ? await decodeFullAudio(file, sampleRate) : new Float32Array(0));
    }
    const buf = buffers.get(row.clip.src);
    if (!buf.length) continue;

    const srcStartSec = span.srcOffset + (segStart - span.start);
    const bufFrames = Math.floor(buf.length / CHANNELS);
    const srcIndex = Math.round(srcStartSec * sampleRate);
    const offsetFrames = Math.round((segStart - from) * sampleRate);
    const wantFrames = Math.round((segEnd - segStart) * sampleRate);
    const n = Math.max(0, Math.min(wantFrames, bufFrames - srcIndex, totalFrames - offsetFrames));

    for (let i = 0; i < n; i++) {
      const t = segStart + i / sampleRate;
      const g = gainAt(span.points, t);
      if (g <= 0) continue;
      const si = (srcIndex + i) * CHANNELS;
      const o = (offsetFrames + i) * CHANNELS;
      out[o] += buf[si] * g;
      out[o + 1] += buf[si + 1] * g;
    }
  }

  // 交叠处等功率叠加可能超过 1：整体按峰值限幅，避免爆音。
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const v = Math.abs(out[i]);
    if (v > peak) peak = v;
  }
  if (peak > 0.98) {
    const k = 0.98 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= k;
  }
  return { samples: out, sampleRate, frames: totalFrames, peak };
}

export function encodeWav(samples, sampleRate = DEFAULT_SR) {
  const channels = CHANNELS;
  const bytesPerSample = 2;
  const frames = Math.floor(samples.length / channels);
  const dataSize = frames * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  let p = 44;
  for (let i = 0; i < frames * channels; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), p);
    p += 2;
  }
  return buf;
}

// 供浏览器预览：把整段源的音频转成 16-bit WAV（浏览器 decodeAudioData 可靠解码）。
export async function sourceWav(src, sampleRate = DEFAULT_SR) {
  const file = await resolveSourcePath(src);
  if (!file) return null;
  const buf = await decodeFullAudio(file, sampleRate);
  return encodeWav(buf, sampleRate);
}
