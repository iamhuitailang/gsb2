import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJs } from './helpers/paths.mjs';

const AudioAnalyze = loadJs('analyze.js');
const Samples = loadJs('samples.js');

const SR = Samples.SR;

test('基频估计：合成正弦波频率误差 < 1%', () => {
  for (const f of [110, 261.63, 440, 880]) {
    const n = SR; // 1 秒
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / SR);
    const p = AudioAnalyze.estimatePitch(x, SR);
    assert.ok(p);
    assert.ok(Math.abs(p.frequency - f) / f < 0.01, f + 'Hz 检出 ' + p.frequency.toFixed(1));
  }
});

test('静音返回 null，不伪造音高', () => {
  assert.equal(AudioAnalyze.estimatePitch(new Float32Array(SR), SR), null);
});

test('重音检出：短重音样例的两个击点定位误差 < 30ms', () => {
  const s = Samples.buildAccent();
  const accents = AudioAnalyze.findAccents(s.channels[0], SR);
  assert.equal(accents.length, 2);
  assert.ok(Math.abs(accents[0] - 0.2) < 0.03);
  assert.ok(Math.abs(accents[1] - 0.55) < 0.03);
});

test('声道延迟估计：右声道延迟 30ms 可被检出（亚采样精度）', () => {
  const s = Samples.buildSustain();
  const lag = AudioAnalyze.estimateChannelLag(s.channels[0], s.channels[1], SR);
  assert.ok(Math.abs(lag.lagSamples - Samples.CH_DELAY) < 1,
    'lag=' + lag.lagSamples + ' 期望 ' + Samples.CH_DELAY);
  assert.ok(Math.abs(lag.lagSec - 0.03) < 1 / SR);
});

test('regionStats 汇总字段完整', () => {
  const s = Samples.buildAccent();
  const stats = AudioAnalyze.regionStats(s.channels, SR);
  assert.equal(stats.frames, s.channels[0].length);
  assert.ok(stats.accentsSec.length >= 2);
  assert.ok(stats.channelLag);
  assert.ok(stats.durationSec > 0);
});
