import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDocument } from '../public/js/core/model.js';
import { coverageStats } from '../public/js/core/layout.js';
import { DEMO_DURATION, demoProject, synthesizeDemoAudio } from '../public/js/demo/synth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const samplePath = path.resolve(__dirname, '..', 'public', 'samples', 'demo-project.json');
const wavPath = path.resolve(__dirname, '..', 'public', 'samples', 'demo-interview.wav');

test('示例工程文档可被规范化', () => {
  const doc = normalizeDocument(demoProject());
  assert.equal(doc.timeUnit, 'seconds');
  assert.ok(doc.regions.length >= 8);
  assert.equal(doc.audio.duration, DEMO_DURATION);
  assert.equal(doc.audio.source, 'sample');
  assert.equal(doc.audio.sampleId, 'demo-interview');
});

test('示例包含重叠区间与空白区间', () => {
  const doc = normalizeDocument(demoProject());
  const stats = coverageStats(doc.regions, doc.audio.duration);
  assert.ok(stats.overlapCount >= 1, '应至少有一处重叠');
  assert.ok(stats.gaps.length >= 2, '应至少有两段空白');
  const speakers = new Set(doc.regions.map((region) => region.speakerId).filter(Boolean));
  assert.ok(speakers.size >= 2, '应覆盖多位说话人');
  const confidences = new Set(doc.regions.map((region) => region.confidence));
  assert.ok(confidences.has('uncertain') || confidences.has('inaudible'), '应包含不确定片段');
  assert.ok(doc.regions.some((region) => region.note.length > 0), '应包含备注');
});

test('合成音频长度与振幅符合预期', () => {
  const samples = synthesizeDemoAudio({ sampleRate: 8000, duration: 2 });
  assert.equal(samples.length, 16000);
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  assert.ok(peak <= 1);
  assert.ok(peak > 0.05, '示例音频应有可听内容');
  assert.ok(samples.some((value) => value !== 0));
});

test('合成结果是确定性的（同样参数得到同样音频）', () => {
  const a = synthesizeDemoAudio({ sampleRate: 4000, duration: 1 });
  const b = synthesizeDemoAudio({ sampleRate: 4000, duration: 1 });
  assert.deepEqual(Array.from(a), Array.from(b));
});

test('落盘的样例音频（若已生成）是合法 WAV 且时长一致', (t) => {
  if (!fs.existsSync(wavPath)) {
    t.skip('未生成 WAV 文件；应用内示例为实时合成，不需要这些文件');
    return;
  }
  const buffer = fs.readFileSync(wavPath);
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  const sampleRate = buffer.readUInt32LE(24);
  const channels = buffer.readUInt16LE(22);
  const bits = buffer.readUInt16LE(34);
  const dataSize = buffer.readUInt32LE(40);
  assert.equal(channels, 1);
  assert.equal(bits, 16);
  const duration = dataSize / (sampleRate * channels * (bits / 8));
  assert.ok(Math.abs(duration - DEMO_DURATION) < 0.01);
  if (fs.existsSync(samplePath)) {
    const doc = normalizeDocument(JSON.parse(fs.readFileSync(samplePath, 'utf8')));
    assert.ok(Math.abs(duration - doc.audio.duration) < 0.01);
  }
});
