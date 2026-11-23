import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJs } from './helpers/paths.mjs';

const PlayMath = loadJs('play-math.js');

test('位置映射互逆：sourceToOutput 与 outputToSource 往返误差 < 1 采样', () => {
  const src = 10000;
  const rate = 0.5;
  const out = Math.round(src / rate); // 20000
  for (const srcFrame of [0, 1234, 5000, 9999]) {
    const o = PlayMath.sourceToOutput(srcFrame, src, out);
    const back = PlayMath.outputToSource(o, src, out);
    assert.ok(Math.abs(back - srcFrame) < 1, 'src=' + srcFrame + ' back=' + back);
  }
});

test('循环漂移：每圈误差 <= 半个输出采样，且 N 圈线性累计', () => {
  const src = 7777; // 故意选不能被 rate 整除的长度
  const sr = 44100;
  for (const rate of [0.25, 0.5, 0.75, 1.5, 2, 4]) {
    const perLoop = PlayMath.loopDriftSeconds(src, rate, sr);
    // round() 与理想值之差不超过 0.5 个输出帧
    assert.ok(Math.abs(perLoop) <= 0.5 / sr + 1e-12, 'rate=' + rate);
    const acc200 = PlayMath.accumulatedDrift(src, rate, sr, 200);
    assert.ok(Math.abs(acc200 - perLoop * 200) < 1e-12);
  }
});

test('200 圈长循环累计漂移保持在 5ms 以内（不越放越偏）', () => {
  const sr = 44100;
  const region = sr * 2; // 2 秒小节
  for (const rate of [0.25, 0.5, 1, 2, 4]) {
    const acc = PlayMath.accumulatedDrift(region, rate, sr, 200);
    assert.ok(Math.abs(acc) < 0.005, 'rate=' + rate + ' acc=' + acc);
  }
});

test('formatTime 输出 m:ss.mmm', () => {
  assert.equal(PlayMath.formatTime(0), '00:00.000');
  assert.equal(PlayMath.formatTime(65.1234), '01:05.123');
  assert.equal(PlayMath.formatTime(-3), '00:00.000');
});
