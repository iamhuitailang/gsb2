import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampPoint,
  clampView,
  distanceToSegment,
  fitView,
  hitTestPolygon,
  hitTestRect,
  imageToScreen,
  moveRectHandle,
  normalizeRect,
  pointInPolygon,
  rectToPoints,
  screenToImage,
  zoomViewAt,
} from '../src/geometry.js';

test('screenToImage / imageToScreen 互为逆变换', () => {
  const view = { scale: 1.75, tx: 120, ty: -40 };
  for (const point of [[0, 0], [10, 20], [800, 600], [1234.5, 77.25]]) {
    const screen = imageToScreen(point, view);
    const back = screenToImage(screen, view);
    assert.ok(Math.abs(back[0] - point[0]) < 1e-9);
    assert.ok(Math.abs(back[1] - point[1]) < 1e-9);
  }
});

test('缩放锚点：缩放后光标下的图像坐标保持不变（连续缩放不漂移）', () => {
  let view = { scale: 0.8, tx: 60, ty: 42 };
  const anchor = [512, 300];
  const before = screenToImage(anchor, view);
  for (let i = 0; i < 20; i += 1) {
    view = zoomViewAt(view, anchor, view.scale * 1.15);
    const now = screenToImage(anchor, view);
    assert.ok(Math.abs(now[0] - before[0]) < 1e-9, `x 漂移 ${now[0] - before[0]}`);
    assert.ok(Math.abs(now[1] - before[1]) < 1e-9, `y 漂移 ${now[1] - before[1]}`);
  }
  for (let i = 0; i < 40; i += 1) {
    view = zoomViewAt(view, anchor, view.scale / 1.15);
    const now = screenToImage(anchor, view);
    assert.ok(Math.abs(now[0] - before[0]) < 1e-9);
    assert.ok(Math.abs(now[1] - before[1]) < 1e-9);
  }
});

test('在缩放/平移后的视图里画的点仍然落在正确的图像坐标', () => {
  const view = zoomViewAt({ scale: 1, tx: 0, ty: 0 }, [300, 200], 3.4);
  // 模拟屏幕点击 → 图像坐标 → 再画回屏幕
  const clicked = [300, 200];
  const imagePoint = screenToImage(clicked, view);
  const drawn = imageToScreen(imagePoint, view);
  assert.ok(Math.abs(drawn[0] - clicked[0]) < 1e-9);
  assert.ok(Math.abs(drawn[1] - clicked[1]) < 1e-9);
});

test('fitView 让图片完整落在画布内并保持比例', () => {
  const view = fitView(960, 640, 1200, 700, 20);
  assert.ok(view.scale > 0);
  assert.ok(960 * view.scale <= 1200 - 40 + 1e-9);
  assert.ok(640 * view.scale <= 700 - 40 + 1e-9);
  const center = imageToScreen([480, 320], view);
  assert.ok(Math.abs(center[0] - 600) < 1e-9);
  assert.ok(Math.abs(center[1] - 350) < 1e-9);
});

test('clampView 不会让图片被完全拖出视口', () => {
  const view = clampView({ scale: 1, tx: 99999, ty: -99999 }, 400, 300, 800, 600);
  assert.ok(view.tx <= 800);
  assert.ok(view.ty >= -300);
});

test('clampPoint 把坐标夹到图像边界', () => {
  assert.deepEqual(clampPoint([-10, -5], 100, 80), [0, 0]);
  assert.deepEqual(clampPoint([120, 90], 100, 80), [100, 80]);
  assert.deepEqual(clampPoint([40, 50], 100, 80), [40, 50]);
});

test('normalizeRect 支持任意拖拽方向且不越界', () => {
  const a = normalizeRect([300, 200], [100, 50], 400, 300);
  assert.deepEqual(a, { x: 100, y: 50, width: 200, height: 150 });
  const b = normalizeRect([-50, -50], [999, 999], 400, 300);
  assert.deepEqual(b, { x: 0, y: 0, width: 400, height: 300 });
});

test('矩形在图像边缘拖拽控制点不会产生越界坐标', () => {
  const base = { x: 10, y: 10, width: 80, height: 60 };
  const cases = [
    ['nw', [-999, -999]],
    ['se', [999, 999]],
    ['ne', [999, -999]],
    ['sw', [-999, 999]],
    ['n', [40, -999]],
    ['s', [40, 999]],
    ['e', [999, 40]],
    ['w', [-999, 40]],
  ];
  for (const [handle, point] of cases) {
    const rect = moveRectHandle(base, handle, point, 100, 90);
    assert.ok(rect.x >= 0 && rect.y >= 0, `${handle} 左上越界`);
    assert.ok(rect.x + rect.width <= 100 + 1e-9, `${handle} 右越界`);
    assert.ok(rect.y + rect.height <= 90 + 1e-9, `${handle} 下越界`);
    assert.ok(rect.width >= 2 && rect.height >= 2, `${handle} 尺寸过小`);
  }
});

test('rectToPoints 顺序稳定', () => {
  assert.deepEqual(rectToPoints({ x: 1, y: 2, width: 3, height: 4 }), [
    [1, 2], [4, 2], [4, 6], [1, 6],
  ]);
});

test('pointInPolygon / hitTestPolygon 命中顶点、边与内部', () => {
  const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
  assert.equal(pointInPolygon([50, 50], square), true);
  assert.equal(pointInPolygon([150, 50], square), false);
  assert.deepEqual(hitTestPolygon([100, 100], square, 2).part, 'vertex');
  assert.deepEqual(hitTestPolygon([50, 1], square, 3).part, 'edge');
  assert.deepEqual(hitTestPolygon([50, 50], square, 3).part, 'inside');
  assert.equal(hitTestPolygon([150, 150], square, 3), null);
});

test('hitTestRect 识别控制点与内部', () => {
  const rect = { x: 10, y: 10, width: 100, height: 50 };
  assert.equal(hitTestRect([10, 10], rect, 3).handle, 'nw');
  assert.equal(hitTestRect([50, 50], rect, 3).part, 'inside');
  assert.equal(hitTestRect([200, 200], rect, 3), null);
});

test('distanceToSegment 计算点到线段距离', () => {
  assert.equal(distanceToSegment([0, 5], [0, 0], [10, 0]), 5);
  assert.equal(distanceToSegment([-5, 0], [0, 0], [10, 0]), 5);
  assert.ok(Math.abs(distanceToSegment([0, 10], [0, 0], [10, 10]) - Math.sqrt(50)) < 1e-9);
});
