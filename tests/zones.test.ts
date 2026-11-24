import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSample } from '../src/audio/zones.ts';
import { playbackRateFor } from '../src/audio/notes.ts';
import type { LoadedSample, VelocityLayer } from '../src/types.ts';

function fakeSample(root: number, layer: VelocityLayer, looped = false): LoadedSample {
  return {
    root,
    layer,
    buffer: {} as AudioBuffer,
    loopStart: looped ? 100 : 0,
    loopEnd: looped ? 200 : 0,
    get loopLength() {
      return this.loopEnd - this.loopStart;
    },
  };
}

const roots = [48, 52, 55, 60, 64, 67, 72, 76];
const samples: LoadedSample[] = roots.flatMap((r) => [
  fakeSample(r, 'soft'),
  fakeSample(r, 'hard'),
]);
const THRESHOLD = 80;

test('根音精确命中且力度层正确', () => {
  const choice = chooseSample(60, 100, samples, THRESHOLD);
  assert.equal(choice.usedRoot, 60);
  assert.equal(choice.usedLayer, 'hard');
  assert.equal(choice.playbackRate, 1);
  assert.equal(choice.fallback, false);
  assert.match(choice.reason, /根音精确匹配/);
});

test('低力度走轻敲层', () => {
  const choice = chooseSample(60, 40, samples, THRESHOLD);
  assert.equal(choice.usedLayer, 'soft');
});

test('阈值边界：velocity <= threshold 为轻敲', () => {
  assert.equal(chooseSample(60, 80, samples, THRESHOLD).usedLayer, 'soft');
  assert.equal(chooseSample(60, 81, samples, THRESHOLD).usedLayer, 'hard');
});

test('无精确根音时选最近根音并给出移调倍率', () => {
  // 50 与 48、52 距离相同（各 2 半音）：规则要求取低音根音 48
  const choice = chooseSample(50, 100, samples, THRESHOLD);
  assert.equal(choice.usedRoot, 48);
  assert.equal(choice.playbackRate, playbackRateFor(48, 50));
  assert.match(choice.reason, /移调 2 个半音/);
  assert.equal(choice.fallback, true);
});

test('半音移调倍率为 2^(1/12)', () => {
  const choice = chooseSample(61, 100, samples, THRESHOLD);
  assert.equal(choice.usedRoot, 60);
  assert.ok(Math.abs(choice.playbackRate - Math.pow(2, 1 / 12)) < 1e-9);
});

test('整层缺失时回退另一层并在理由中标注', () => {
  const hardOnly = roots.map((r) => fakeSample(r, 'hard'));
  const choice = chooseSample(60, 30, hardOnly, THRESHOLD);
  assert.equal(choice.usedLayer, 'hard');
  assert.equal(choice.fallback, true);
  assert.match(choice.reason, /轻敲层无可用样本/);
});

test('单个坏样本被移除后就近回退', () => {
  // 移除 60 hard，重敲 60 音应回退到邻近根音
  const broken = samples.filter((s) => !(s.root === 60 && s.layer === 'hard'));
  const choice = chooseSample(60, 110, broken, THRESHOLD);
  assert.notEqual(choice.usedRoot, 60);
  assert.ok([55, 64].includes(choice.usedRoot));
  assert.equal(choice.usedLayer, 'hard');
});

test('没有任何样本时抛错', () => {
  assert.throws(() => chooseSample(60, 100, [], THRESHOLD));
});
