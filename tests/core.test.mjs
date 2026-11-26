/*
 * core.test.mjs — core.js 纯逻辑单测（node --test，无需浏览器）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../js/core.js');

const eye = (fps, frameCount, timeOffset = 0) => ({ fps, frameCount, timeOffset });

test('timeToFrame / frameToTime 互逆', () => {
  assert.equal(C.timeToFrame(1, 25), 25);
  assert.equal(C.frameToTime(25, 25), 1);
  assert.equal(C.timeToFrame(0.04, 25), 1);
});

test('formatTimecode', () => {
  assert.equal(C.formatTimecode(0, 25), '00:00:00:00');
  assert.equal(C.formatTimecode(1, 25), '00:00:01:00');
  assert.equal(C.formatTimecode(3661.5, 25), '01:01:01:13');
});

test('buildMasterGrid 覆盖两路并集', () => {
  const g = C.buildMasterGrid([eye(25, 100, 0), eye(25, 100, 0.2)], 25);
  // 最晚结束 = 0.2 + 4 = 4.2s -> 帧 0..104
  assert.equal(g.frameCount, 105);
  assert.equal(g.lastFrame, 104);
});

test('eyeValidRange 半开帧窗口', () => {
  // 100 帧 @25fps，无偏移：有效主帧 0..99
  const r = C.eyeValidRange(eye(25, 100, 0), 25);
  assert.deepEqual(r, { lo: 0, hi: 100 });
  // 晚 0.2s（5 帧）：显示窗口整体后移 5
  const r2 = C.eyeValidRange(eye(25, 100, 0.2), 25);
  assert.deepEqual(r2, { lo: 5, hi: 105 });
  // 提前 0.16s（-4 帧）
  const r3 = C.eyeValidRange(eye(25, 100, -0.16), 25);
  assert.deepEqual(r3, { lo: 0, hi: 96 });
});

test('commonRanges 求两路交集', () => {
  const grid = { frameCount: 110 };
  const r = C.commonRanges(grid, eye(25, 100, 0), eye(25, 100, 0.2), 25);
  assert.deepEqual(r.left, { lo: 0, hi: 100 });
  assert.deepEqual(r.right, { lo: 5, hi: 105 });
  assert.deepEqual(r.common, { lo: 5, hi: 100 });
});

test('eyeFrameAt 帧映射与缺帧', () => {
  const e = eye(25, 100, 0.2);
  // 主帧 0：eyeT = -0.2 -> 帧 -5，缺帧
  assert.equal(C.eyeFrameAt(0, 25, e).available, false);
  // 主帧 5：eyeT = 0 -> 帧 0
  const f5 = C.eyeFrameAt(5, 25, e);
  assert.equal(f5.frame, 0);
  assert.equal(f5.available, true);
  // 主帧 104：eyeT=3.96 -> 帧 99，最后一帧
  assert.equal(C.eyeFrameAt(104, 25, e).frame, 99);
  // 主帧 105：越界
  assert.equal(C.eyeFrameAt(105, 25, e).available, false);
});

test('不同帧率混合（24 vs 25）', () => {
  const e24 = eye(24, 96, 0); // 4s
  const e25 = eye(25, 100, 0);
  const grid = C.buildMasterGrid([e24, e25], 25);
  const r = C.commonRanges(grid, e24, e25, 25);
  assert.equal(r.common.lo, 0);
  // 24fps 末帧 95 的显示窗口到 4 - 1/48 = 3.9792s -> ceil(25*3.9792)=100
  assert.equal(r.common.hi, 100);
  // 主帧 50（2s）-> 24fps 本地帧 48
  assert.equal(C.eyeFrameAt(50, 25, e24).frame, 48);
});

test('标记创建 / 失效判定', () => {
  const eyes = {
    left: { sig: 'L', width: 640, height: 360, timeOffset: 0, verticalOffset: 0 },
    right: { sig: 'R', width: 640, height: 360, timeOffset: 0, verticalOffset: 0 }
  };
  const m = C.createMarker(1, 30, 25, eyes, {
    left: { x: 100, y: 100 }, right: { x: 103, y: 116 }
  });
  assert.equal(C.markerState(m, 25, eyes), 'valid');
  assert.deepEqual(C.markerDeviation(m, eyes), {
    dx: 3, dy: 16, dxPct: 0.47, dyPct: 4.44, dxNorm: 0.47, dyNorm: 4.44
  });

  eyes.right.verticalOffset = -16; // 右眼向下修正 16px
  assert.equal(C.markerState(m, 25, eyes), 'valid', '垂直偏移不失效');
  assert.equal(C.markerDeviation(m, eyes).dy, 0);

  eyes.right.timeOffset = 0.04;
  assert.equal(C.markerState(m, 25, eyes), 'stale', '时间偏移失效');
  eyes.right.timeOffset = 0;

  eyes.right.sig = 'R2';
  assert.equal(C.markerState(m, 25, eyes), 'stale', '换素材失效');
  eyes.right.sig = 'R';

  assert.equal(C.markerState(m, 30, eyes), 'stale', '改主帧率失效');
});

test('归一化偏差在不同分辨率下仍可比', () => {
  const eyes = {
    left: { sig: 'L', width: 640, height: 360, timeOffset: 0, verticalOffset: 0 },
    right: { sig: 'R', width: 1280, height: 720, timeOffset: 0, verticalOffset: 0 }
  };
  const m = C.createMarker(1, 0, 25, eyes, {
    left: { x: 320, y: 180 }, right: { x: 640, y: 360 }
  });
  const d = C.markerDeviation(m, eyes);
  assert.equal(d.dxNorm, 0, '同位置归一化 dx=0');
  assert.equal(d.dyNorm, 0, '同位置归一化 dy=0');
  assert.ok(d.dx !== 0, '像素差随分辨率不同而不同');
});

test('createMarker 兼容带 .source 的 app 状态形态（不产生 NaN）', () => {
  // app.js 传入的 eyes：尺寸挂在 .source 上，偏移挂在眼对象上
  const eyes = {
    left: { source: { width: 640, height: 360 }, timeOffset: 0, verticalOffset: 0 },
    right: { source: { width: 640, height: 360 }, timeOffset: 0, verticalOffset: 0 }
  };
  const m = C.createMarker(1, 5, 25, eyes, {
    left: { x: 100, y: 100 }, right: { x: 104, y: 116 }
  });
  assert.deepEqual(m.sourceSize, {
    left: { w: 640, h: 360 }, right: { w: 640, h: 360 }
  });
  const d = C.markerDeviation(m, eyes);
  assert.ok(Number.isFinite(d.dxPct) && Number.isFinite(d.dyPct), '百分比为有限数');
  assert.equal(d.dy, 16);
  assert.equal(d.dyPct, C.round2(16 / 360 * 100));
});
