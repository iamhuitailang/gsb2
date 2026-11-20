import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_REGION_SECONDS,
  clampRegion,
  formatTimecode,
  parseTimeInput,
  roundSeconds,
} from '../public/js/core/time.js';

test('formatTimecode 使用秒为单位的 mm:ss.mmm', () => {
  assert.equal(formatTimecode(0), '00:00.000');
  assert.equal(formatTimecode(1.2345), '00:01.235');
  assert.equal(formatTimecode(61.5), '01:01.500');
  assert.equal(formatTimecode(3723.004), '1:02:03.004');
  assert.equal(formatTimecode(-5), '00:00.000');
});

test('formatTimecode 支持不同精度', () => {
  assert.equal(formatTimecode(65.4, { decimals: 0 }), '01:05');
  assert.equal(formatTimecode(65.4, { decimals: 1 }), '01:05.4');
});

test('parseTimeInput 解析秒、时间码与中文单位', () => {
  assert.equal(parseTimeInput('12.345'), 12.345);
  assert.equal(parseTimeInput('12.345s'), 12.345);
  assert.equal(parseTimeInput('12.345 秒'), 12.345);
  assert.equal(parseTimeInput('1:02.5'), 62.5);
  assert.equal(parseTimeInput('1:02:03.456'), 3723.456);
  assert.equal(parseTimeInput(3), 3);
  assert.equal(parseTimeInput('abc'), null);
  assert.equal(parseTimeInput('1:70'), null);
  assert.equal(parseTimeInput(''), null);
});

test('roundSeconds 避免浮点尾差', () => {
  assert.equal(roundSeconds(0.1 + 0.2), 0.3);
  assert.equal(roundSeconds(1.00049), 1);
  assert.equal(roundSeconds(1.00051), 1.001);
});

test('clampRegion 限制在音频边界内并保证最短时长', () => {
  assert.deepEqual(clampRegion(-1, 2, 10), { start: 0, end: 2 });
  assert.deepEqual(clampRegion(9.99, 12, 10), { start: 9.98, end: 10 });
  const tiny = clampRegion(3, 3.001, 10);
  assert.ok(tiny.end - tiny.start >= MIN_REGION_SECONDS - 1e-9);
});
