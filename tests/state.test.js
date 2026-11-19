import test from 'node:test';
import assert from 'node:assert/strict';

import { AppState } from '../src/app/state.js';
import { createProject, serializeProject } from '../src/core/project.js';
import { getPixel } from '../src/core/raster.js';
import { fitZoomFor, pixelFromClient } from '../src/ui/render.js';

function makeState() {
  return new AppState(createProject({ width: 16, height: 16, name: '测试' }));
}

function celReader(state, frameId = state.selection.frameId, layerId = state.selection.layerId) {
  const frame = state.project.frames.find((f) => f.id === frameId);
  const cel = frame.cels[layerId];
  return (x, y) => getPixel(cel, state.project.width, state.project.height, x, y);
}

function stroke(state, points) {
  const [first, ...rest] = points;
  state.pointerDown(first.x, first.y);
  for (const p of rest) state.pointerMove(p.x, p.y);
  state.pointerUp();
}

test('连续绘画合并为一步撤销', () => {
  const state = makeState();
  state.setColor('#ff0000');
  stroke(state, [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }]);
  const read = celReader(state);
  assert.deepEqual(read(1, 1), [255, 0, 0, 255]);
  assert.deepEqual(read(5, 5), [255, 0, 0, 255]);
  assert.equal(state.history.depth, 1);

  state.undo();
  assert.equal(celReader(state)(1, 1)[3], 0);
  assert.equal(state.history.depth, 0);

  state.redo();
  assert.deepEqual(celReader(state)(1, 1), [255, 0, 0, 255]);
});

test('切换帧后撤销只影响历史里记录的那一帧', () => {
  const state = makeState();
  state.setColor('#00ff00');
  const frameA = state.selection.frameId;
  stroke(state, [{ x: 2, y: 2 }]);

  state.addFrame({ duplicate: false });
  const frameB = state.selection.frameId;
  assert.notEqual(frameB, frameA);

  state.setColor('#0000ff');
  stroke(state, [{ x: 8, y: 8 }]);
  assert.deepEqual(celReader(state)(8, 8), [0, 0, 255, 255]);

  state.selectFrame(frameA);
  state.setColor('#ff00ff');
  stroke(state, [{ x: 3, y: 3 }]);
  assert.deepEqual(celReader(state)(3, 3), [255, 0, 255, 255]);

  // 撤销一次：只撤销 A 上的洋红笔划；撤销后选择回到 A
  state.undo();
  assert.equal(state.selection.frameId, frameA, '撤销后应回到操作发生的帧');
  assert.equal(celReader(state)(3, 3)[3], 0);
  assert.deepEqual(celReader(state)(2, 2), [0, 255, 0, 255]);

  state.selectFrame(frameB);
  assert.deepEqual(celReader(state)(8, 8), [0, 0, 255, 255], 'B 帧不应被误改');
});

test('撤销/重做帧结构变化（插入/删除）后帧列表与选择均正确', () => {
  const state = makeState();
  state.setColor('#ff0000');
  stroke(state, [{ x: 1, y: 1 }]);
  const firstId = state.selection.frameId;

  state.addFrame({ duplicate: false });
  assert.equal(state.project.frames.length, 2);
  const secondId = state.selection.frameId;

  state.deleteFrame(firstId);
  assert.equal(state.project.frames.length, 1);
  assert.equal(state.selection.frameId, secondId);

  state.undo(); // 恢复删除
  assert.equal(state.project.frames.length, 2);
  assert.ok(state.project.frames.some((f) => f.id === firstId));

  state.undo(); // 撤销插入
  assert.equal(state.project.frames.length, 1);
  assert.equal(state.selection.frameId, firstId);

  state.undo(); // 撤销笔划
  assert.equal(celReader(state, firstId)(1, 1)[3], 0);

  state.redo();
  state.redo();
  assert.equal(state.project.frames.length, 2);
  state.redo();
  assert.equal(state.project.frames.length, 1);
});

test('调整帧顺序可以撤销', () => {
  const state = makeState();
  state.addFrame({ duplicate: false });
  state.addFrame({ duplicate: false });
  const ids = state.project.frames.map((f) => f.id);
  state.moveFrame(ids[0], 2);
  assert.deepEqual(state.project.frames.map((f) => f.id), [ids[1], ids[2], ids[0]]);
  state.undo();
  assert.deepEqual(state.project.frames.map((f) => f.id), ids);
});

test('锁定/隐藏图层阻止绘制', () => {
  const state = makeState();
  const layerId = state.selection.layerId;
  state.toggleLayerLocked(layerId);
  state.setColor('#ff0000');
  const depth = state.history.depth;
  state.pointerDown(1, 1);
  state.pointerUp();
  assert.equal(state.history.depth, depth, '锁定时不应产生笔划历史');
  assert.equal(celReader(state)(1, 1)[3], 0);

  state.toggleLayerLocked(layerId);
  state.toggleLayerVisible(layerId);
  const before = state.history.depth;
  state.pointerDown(1, 1);
  state.pointerUp();
  assert.equal(state.history.depth, before, '隐藏图层上不应产生笔划历史');
  assert.equal(celReader(state)(1, 1)[3], 0);
});

test('橡皮与填充可撤销', () => {
  const state = makeState();
  state.setColor('#334455');
  stroke(state, [{ x: 0, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 15 }, { x: 0, y: 15 }, { x: 0, y: 0 }]);
  state.setTool('fill');
  state.setColor('#ffcd75');
  state.pointerDown(8, 8);
  state.pointerUp();
  assert.deepEqual(celReader(state)(8, 8), [255, 205, 117, 255]);

  state.undo();
  assert.equal(celReader(state)(8, 8)[3], 0);

  state.setTool('eraser');
  state.pointerDown(0, 0);
  state.pointerMove(15, 0);
  state.pointerUp();
  assert.equal(celReader(state)(7, 0)[3], 0);
  state.undo();
  assert.ok(celReader(state)(7, 0)[3] > 0);
});

test('调色板换色：不勾选时画布像素不变，勾选时同步替换', () => {
  const state = makeState();
  const colorId = state.project.palette[0].id;
  const oldHex = state.project.palette[0].hex;
  state.setColor(oldHex);
  stroke(state, [{ x: 2, y: 2 }, { x: 6, y: 2 }]);
  const pixelsBefore = state.countColorPixels(oldHex);
  assert.ok(pixelsBefore > 0);

  state.editPaletteColor(colorId, '#123456', { replaceExisting: false });
  assert.equal(state.countColorPixels(oldHex), pixelsBefore, '未勾选时画布像素应保持原色');
  assert.equal(state.countColorPixels('#123456'), 0);
  state.undo();

  state.editPaletteColor(colorId, '#123456', { replaceExisting: true });
  assert.equal(state.countColorPixels('#123456'), pixelsBefore);
  assert.equal(state.countColorPixels(oldHex), 0);

  state.undo();
  assert.equal(state.countColorPixels(oldHex), pixelsBefore);
});

test('缩放画布的坐标换算落在正确像素', () => {
  const rect = { left: 100, top: 50, width: 480, height: 480 };
  assert.deepEqual(pixelFromClient(100, 50, rect, 48, 48), { x: 0, y: 0 });
  assert.deepEqual(pixelFromClient(100 + 479, 50 + 479, rect, 48, 48), { x: 47, y: 47 });
  // 每像素 10px：偏移 15px 落在第 1 个像素
  assert.deepEqual(pixelFromClient(100 + 15, 50 + 25, rect, 48, 48), { x: 1, y: 2 });
  // 画布外
  assert.equal(pixelFromClient(99, 50, rect, 48, 48), null);
  assert.equal(pixelFromClient(100, 50 + 480, rect, 48, 48), null);
});

test('适应窗口取整数倍缩放', () => {
  assert.equal(fitZoomFor({ width: 480, height: 480 }, { width: 48, height: 48 }, 0), 10);
  assert.equal(fitZoomFor({ width: 100, height: 100 }, { width: 48, height: 48 }, 48), 1);
});

test('新建/导入会重置历史', () => {
  const state = makeState();
  state.setColor('#ff0000');
  stroke(state, [{ x: 2, y: 2 }]);
  assert.ok(state.history.canUndo);
  state.newProject({ width: 10, height: 10, name: '新工程' });
  assert.equal(state.history.canUndo, false);
  assert.equal(state.project.width, 10);
  assert.equal(state.project.frames.length, 1);
});

test('导入工程后选择与帧时长同步', () => {
  const source = new AppState(createProject({ width: 12, height: 12, name: '源' }));
  source.addFrame({ duplicate: false });
  source.setDuration(250);
  const text = serializeProject(source.project);
  const target = makeState();
  target.loadProjectText(text);
  assert.equal(target.project.frames.length, 2);
  assert.equal(target.project.frames[1].duration, 250);
  assert.ok(target.selection.frameId);
  assert.ok(target.selection.layerId);
});

test('有未提交的笔划时撤销会回滚到笔划前', () => {
  const state = makeState();
  state.setColor('#ff0000');
  state.pointerDown(1, 1);
  state.pointerMove(4, 1);
  assert.deepEqual(celReader(state)(2, 1), [255, 0, 0, 255]);
  state.undo();
  assert.equal(celReader(state)(2, 1)[3], 0);
  assert.equal(state.stroke, null);
});

test('删除非当前帧不会移动当前选择', () => {  const state = makeState();
  state.addFrame({ duplicate: false });
  state.addFrame({ duplicate: false });
  const [a, b, c] = state.project.frames.map((f) => f.id);
  state.selectFrame(c);
  state.deleteFrame(a);
  assert.equal(state.project.frames.length, 2);
  assert.equal(state.selection.frameId, c, '删掉别的帧后仍停留在当前帧');
  assert.deepEqual(state.project.frames.map((f) => f.id), [b, c]);
});

test('删除非当前图层不会移动当前图层选择', () => {
  const state = makeState();
  const first = state.selection.layerId;
  state.addLayer();
  const second = state.selection.layerId;
  assert.notEqual(first, second);
  state.deleteLayer(first);
  assert.equal(state.project.layers.length, 1);
  assert.equal(state.selection.layerId, second, '删掉别的图层后仍停留在当前图层');
  state.undo();
  assert.equal(state.project.layers.length, 2);
  // 撤销后回到删除前的图层选择
  assert.ok(state.project.layers.some((l) => l.id === second));
});

test('切换帧会结束进行中的笔划，避免写到错误的帧', () => {
  const state = makeState();
  state.setColor('#ff0000');
  state.pointerDown(1, 1);
  state.pointerMove(3, 1);
  const frameA = state.selection.frameId;
  state.addFrame({ duplicate: false });
  const frameB = state.selection.frameId;
  // 继续移动指针，不应在 B 上产生像素
  state.pointerMove(10, 10);
  assert.equal(celReader(state, frameB)(10, 10)[3], 0);
  // A 上保留了已完成的那一段
  assert.deepEqual(celReader(state, frameA)(2, 1), [255, 0, 0, 255]);
});
