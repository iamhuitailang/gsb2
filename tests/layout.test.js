import test from 'node:test';
import assert from 'node:assert/strict';
import { assignLanes, coverageStats, splitRegion } from '../public/js/core/layout.js';
import { fitView, timeToX, xToTime, zoomAt, clampView, scrollToInclude } from '../public/js/core/view.js';

test('时间与像素来回转换不丢精度', () => {
  const view = { start: 12.345, pxPerSecond: 137.5 };
  for (const time of [0, 0.001, 5.5, 12.345, 60]) {
    const x = timeToX(time, view);
    assert.ok(Math.abs(xToTime(x, view) - time) < 1e-9);
  }
});

test('缩放以光标处时刻为锚点，声音位置不移动', () => {
  const view = { start: 10, pxPerSecond: 100 };
  const width = 1000;
  const anchorX = 420;
  const anchorTime = xToTime(anchorX, view);
  const next = zoomAt(view, anchorX, 2, 60, width);
  const afterTime = xToTime(anchorX, next);
  assert.ok(Math.abs(afterTime - anchorTime) < 1e-9);
  assert.ok(Math.abs(next.pxPerSecond - 200) < 1e-9);
});

test('缩放后时间标注仍精确落在原位置', () => {
  const region = { start: 14.5, end: 17.25 };
  let view = { start: 0, pxPerSecond: 50 };
  const width = 1200;
  for (const factor of [1.5, 4, 0.3, 8]) {
    view = zoomAt(view, 600, factor, 30, width);
    const x1 = timeToX(region.start, view);
    const x2 = timeToX(region.end, view);
    assert.ok(Math.abs(xToTime(x1, view) - region.start) < 1e-6);
    assert.ok(Math.abs(xToTime(x2, view) - region.end) < 1e-6);
  }
});

test('clampView 不越过音频边界', () => {
  const view = clampView({ start: -5, pxPerSecond: 100 }, 20, 800);
  assert.ok(view.start >= 0);
  const end = clampView({ start: 999, pxPerSecond: 100 }, 20, 800);
  assert.ok(end.start + 800 / end.pxPerSecond <= 20 + 1e-9);
  const fit = fitView(20, 800);
  assert.ok(Math.abs(fit.pxPerSecond - 40) < 1e-9);
});

test('scrollToInclude 让区间进入视口', () => {
  const view = { start: 0, pxPerSecond: 100 };
  const next = scrollToInclude(view, 25, 27, 800, 40);
  assert.ok(timeToX(25, next) >= 0);
  assert.ok(timeToX(27, next) <= 800);
});

test('重叠区间分配到不同泳道，不重叠区间可复用', () => {
  const regions = [
    { id: 'a', start: 0, end: 5 },
    { id: 'b', start: 3, end: 8 },
    { id: 'c', start: 6, end: 9 },
  ];
  const { laneById, laneCount } = assignLanes(regions);
  assert.notEqual(laneById.get('a'), laneById.get('b'));
  assert.equal(laneById.get('c'), laneById.get('a'));
  assert.equal(laneCount, 2);
});

test('coverageStats 统计覆盖、重叠与空白', () => {
  const regions = [
    { id: 'a', start: 1, end: 4 },
    { id: 'b', start: 3, end: 6 },
    { id: 'c', start: 8, end: 10 },
  ];
  const stats = coverageStats(regions, 12);
  assert.equal(stats.covered, 7);
  assert.equal(stats.overlap, 1);
  assert.equal(stats.blank, 5);
  assert.deepEqual(stats.gaps, [
    { start: 0, end: 1 },
    { start: 6, end: 8 },
    { start: 10, end: 12 },
  ]);
});

test('splitRegion 只在区间内部生效', () => {
  const region = { id: 'r1', start: 2, end: 6, labelId: 'l', speakerId: null, confidence: 'certain', note: '' };
  let counter = 0;
  const makeId = () => `id${(counter += 1)}`;
  assert.equal(splitRegion(region, 1, makeId), null);
  assert.equal(splitRegion(region, 6, makeId), null);
  const [left, right] = splitRegion(region, 4, makeId);
  assert.equal(left.end, 4);
  assert.equal(right.start, 4);
  assert.notEqual(left.id, right.id);
  assert.equal(left.labelId, region.labelId);
});
