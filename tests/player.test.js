import test from 'node:test';
import assert from 'node:assert/strict';

import {
  frameIndexAt,
  frameStarts,
  LoopClock,
  totalDuration,
} from '../src/core/player.js';

const frames = [
  { duration: 100 },
  { duration: 250 },
  { duration: 50 },
];

test('frameStarts 与总时长按每帧时长累计', () => {
  assert.deepEqual(frameStarts(frames), [0, 100, 350]);
  assert.equal(totalDuration(frames), 400);
});

test('frameIndexAt 按非等时长求当前帧并循环回绕', () => {
  assert.equal(frameIndexAt(frames, 0), 0);
  assert.equal(frameIndexAt(frames, 99), 0);
  assert.equal(frameIndexAt(frames, 100), 1);
  assert.equal(frameIndexAt(frames, 349), 1);
  assert.equal(frameIndexAt(frames, 350), 2);
  assert.equal(frameIndexAt(frames, 399), 2);
  // 回绕到第二圈
  assert.equal(frameIndexAt(frames, 400), 0);
  assert.equal(frameIndexAt(frames, 500), 1);
  // 负数当作 0
  assert.equal(frameIndexAt(frames, -10), 0);
  assert.equal(frameIndexAt([], 100), -1);
});

test('LoopClock 按每帧时长推进并在末尾回绕', () => {
  const clock = new LoopClock(frames);
  clock.play();
  clock.tick(0);
  assert.equal(clock.currentFrame, 0);
  clock.tick(120); // 进入第 2 帧（100–350ms）
  assert.equal(clock.currentFrame, 1);
  clock.tick(300); // 累计 420ms → 回绕到第 1 帧
  assert.equal(clock.currentFrame, 0);
  assert.equal(clock.playCount, 1);
});

test('LoopClock 非循环模式停在最后一帧并暂停', () => {
  const clock = new LoopClock(frames);
  clock.loop = false;
  clock.play();
  clock.tick(1000);
  assert.equal(clock.playing, false);
  assert.equal(clock.currentFrame, 2);
});

test('LoopClock 暂停时不推进', () => {
  const clock = new LoopClock(frames);
  const before = { frame: clock.currentFrame, time: clock.timeMs };
  clock.tick(999);
  assert.equal(clock.currentFrame, before.frame);
  assert.equal(clock.timeMs, before.time);
});

test('seekToFrame 把时间定位到该帧起点', () => {
  const clock = new LoopClock(frames);
  clock.seekToFrame(2);
  assert.equal(clock.currentFrame, 2);
  assert.equal(clock.timeMs, 350);
});
