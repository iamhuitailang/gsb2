import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJs } from './helpers/paths.mjs';

const Samples = loadJs('samples.js');
const AudioAnalyze = loadJs('analyze.js');
const SR = Samples.SR;

test('三个开箱样例均可生成，参数与标注自洽', () => {
  const all = Samples.buildAll();
  assert.deepEqual(all.map((s) => s.id), ['practice', 'sustain', 'accent']);
  for (const s of all) {
    assert.equal(s.sampleRate, Samples.SR);
    assert.equal(s.channels.length, 2);
    assert.ok(s.channels[0].length > Samples.CH_DELAY);
    assert.equal(s.channels[0].length, s.channels[1].length);
    assert.equal(s.markers.channelDelaySec, 0.03);
  }
});

test('练习曲：8 秒、120BPM、8 个小节重音与过门标注', () => {
  const p = Samples.buildPractice();
  assert.equal(p.channels[0].length, Samples.SR * 8);
  assert.equal(p.markers.bpm, 120);
  assert.equal(p.markers.accents.length, 8);
  assert.deepEqual(p.markers.accents[0], 0);
  assert.equal(p.markers.runBar.start, 4);
  assert.equal(p.markers.runBar.end, 6);
  // 信号确实存在
  const peak = Math.max(...p.channels[0].subarray(0, Samples.SR));
  assert.ok(peak > 0.1);
});

test('连续长音样例基频接近标称 C4（261.63Hz）', () => {
  const s = Samples.buildSustain();
  const pitch = AudioAnalyze.estimatePitch(s.channels[0].subarray(SR / 2, SR), Samples.SR);
  assert.ok(pitch);
  assert.ok(Math.abs(pitch.frequency - s.markers.frequency) / s.markers.frequency < 0.01);
});

test('短重音样例标注的两个击点可被分析检出', () => {
  const s = Samples.buildAccent();
  const accents = AudioAnalyze.findAccents(s.channels[0], Samples.SR);
  assert.equal(accents.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.ok(Math.abs(accents[i] - s.markers.accents[i]) < 0.03);
  }
});
