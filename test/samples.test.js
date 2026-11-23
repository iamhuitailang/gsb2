import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { decodeWav, detectOnsets, encodeWav, mixInto, readWav, tone, writeWav } from '../server/wav.js';
import { buildEnVtt, buildZhSrt, SAMPLE_CUES } from '../scripts/samples.js';
import { parseSubtitles } from '../public/shared/subtitles.js';

const SAMPLE_RATE = 48000;

test('WAV 编码后再解码，采样与时长一致', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wav-test-'));
  const file = path.join(dir, 'a.wav');
  try {
    const samples = tone({ frequency: 440, duration: 0.25, sampleRate: SAMPLE_RATE });
    writeWav(file, samples, { sampleRate: SAMPLE_RATE });
    const decoded = readWav(file);
    assert.equal(decoded.sampleRate, SAMPLE_RATE);
    assert.equal(decoded.channels, 1);
    assert.ok(Math.abs(decoded.duration - 0.25) < 0.001);
    assert.ok(Math.abs(decoded.samples[500] - samples[500]) < 0.001);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('encode/decode 往返保持静音段为零', () => {
  const samples = new Float32Array(SAMPLE_RATE);
  const buffer = encodeWav(samples, { sampleRate: SAMPLE_RATE });
  const decoded = decodeWav(buffer);
  assert.equal(decoded.samples.length, SAMPLE_RATE);
  assert.equal(Math.max(...decoded.samples), 0);
});

test('detectOnsets 找出两段音调的起点', () => {
  const samples = new Float32Array(SAMPLE_RATE * 2);
  mixInto(samples, tone({ frequency: 440, duration: 0.5, sampleRate: SAMPLE_RATE }), 0);
  mixInto(samples, tone({ frequency: 660, duration: 0.5, sampleRate: SAMPLE_RATE }), SAMPLE_RATE);
  const onsets = detectOnsets(samples, { sampleRate: SAMPLE_RATE });
  assert.equal(onsets.length, 2);
  assert.ok(Math.abs(onsets[0] - 0) < 0.02);
  assert.ok(Math.abs(onsets[1] - 1) < 0.02);
});

test('detectOnsets 对纯静音返回空数组', () => {
  const samples = new Float32Array(SAMPLE_RATE);
  assert.deepEqual(detectOnsets(samples, { sampleRate: SAMPLE_RATE }), []);
});

test('示例字幕：中文 SRT 与英文 VTT 时点完全一致', () => {
  const zh = parseSubtitles(buildZhSrt(), { fileName: 'lesson.zh.srt' });
  const en = parseSubtitles(buildEnVtt(), { fileName: 'lesson.en.vtt' });
  assert.equal(zh.cues.length, SAMPLE_CUES.length);
  assert.equal(en.cues.length, SAMPLE_CUES.length);
  assert.deepEqual(
    zh.cues.map((cue) => cue.start),
    en.cues.map((cue) => cue.start),
  );
  assert.deepEqual(
    zh.cues.map((cue) => cue.end),
    en.cues.map((cue) => cue.end),
  );
});

test('示例字幕内容覆盖两种语言', () => {
  const zh = parseSubtitles(buildZhSrt(), { fileName: 'lesson.zh.srt' });
  const en = parseSubtitles(buildEnVtt(), { fileName: 'lesson.en.vtt' });
  assert.equal(zh.cues[0].text, SAMPLE_CUES[0].zh);
  assert.equal(en.cues[0].text, SAMPLE_CUES[0].en);
});
