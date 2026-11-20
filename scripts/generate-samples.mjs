#!/usr/bin/env node
/**
 * 把浏览器端同款合成器渲染成 WAV 文件，便于用其他工具检查示例。
 *
 * 用法：node scripts/generate-samples.mjs [输出目录]
 * 默认输出到 public/samples/。
 *
 * 注意：应用本身不依赖这些文件——页面内的示例是实时合成的。
 * 这个脚本只是把同一份音频落盘，方便外部核对或用其他播放器试听。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEMO_DURATION,
  DEMO_FILE_NAME,
  DEMO_SAMPLE_RATE,
  demoProject,
  synthesizeDemoAudio,
} from '../public/js/demo/synth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outputDir = path.resolve(process.argv[2] || path.join(repoRoot, 'public', 'samples'));

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] < 0 ? samples[i] * 0x8000 : samples[i] * 0x7fff;
    buffer.writeInt16LE(Math.round(clamp(value, -32768, 32767)), 44 + i * 2);
  }
  return buffer;
}

const samples = synthesizeDemoAudio({ sampleRate: DEMO_SAMPLE_RATE, duration: DEMO_DURATION });
const wav = encodeWav(samples, DEMO_SAMPLE_RATE);
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, DEMO_FILE_NAME), wav);

const project = demoProject({ now: Date.now() });
project.audio.sizeBytes = wav.length;
fs.writeFileSync(path.join(outputDir, 'demo-project.json'), `${JSON.stringify(project, null, 2)}\n`);

console.log(`已生成样例音频：${path.join(outputDir, DEMO_FILE_NAME)} (${(wav.length / 1024 / 1024).toFixed(2)} MB, ${DEMO_DURATION}s)`);
console.log(`已生成样例标注：${path.join(outputDir, 'demo-project.json')}（${project.regions.length} 个区间）`);
