import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compositeFrame,
  createProject,
  deserializeProject,
  diffBuffers,
  frameIndexById,
  getCel,
  insertFrame,
  moveFrame,
  replaceColorInProject,
  serializeProject,
  setFrameDuration,
  totalLoopDuration,
} from '../src/core/project.js';
import { colorFromHex, floodFill, getPixel, setPixel } from '../src/core/raster.js';

function pixelAt(buffer, width, x, y) {
  // 缓冲区长度 = width * height * 4，据此反推高度，避免多行缓冲区取错索引。
  const height = buffer.length / (width * 4);
  return getPixel(buffer, width, height, x, y);
}

function withPixel(project, hex, x, y, layerId = project.layers[0].id) {
  setPixel(project.frames[0].cels[layerId], project.width, project.height, x, y, colorFromHex(hex));
}

test('每帧可设置不同停留时间，总时长按帧求和', () => {
  const project = createProject({ width: 8, height: 8 });
  const f1 = project.frames[0];
  setFrameDuration(project, f1.id, 100);
  const f2 = insertFrame(project, { afterIndex: 0 });
  setFrameDuration(project, f2.id, 250);
  assert.equal(totalLoopDuration(project), 350);
});

test('停留时间被钳制在合法范围内', () => {
  const project = createProject({ width: 8, height: 8 });
  const id = project.frames[0].id;
  assert.equal(setFrameDuration(project, id, 1), 10);
  assert.equal(setFrameDuration(project, id, 999999), 60000);
  assert.equal(setFrameDuration(project, id, 123.6), 124);
});

test('插入、复制、移动、删除帧保持顺序正确', () => {
  const project = createProject({ width: 8, height: 8 });
  const first = project.frames[0];
  withPixel(project, '#ff0000', 1, 1);
  const second = insertFrame(project, { afterIndex: 0 });
  const third = insertFrame(project, { afterIndex: 1, duplicate: true });
  assert.equal(project.frames.length, 3);
  // duplicate 复制的是 second（空帧），因此 third 为空
  const thirdCel = third.cels[project.layers[0].id];
  assert.equal(pixelAt(thirdCel, project.width, 1, 1)[3], 0);

  const dupOfFirst = insertFrame(project, { afterIndex: 0, duplicate: true });
  // 现在顺序：first, dupOfFirst, second, third
  assert.equal(frameIndexById(project, dupOfFirst.id), 1);
  assert.equal(pixelAt(dupOfFirst.cels[project.layers[0].id], project.width, 1, 1)[3], 255);

  moveFrame(project, first.id, 3);
  assert.deepEqual(
    project.frames.map((f) => f.id),
    [dupOfFirst.id, second.id, third.id, first.id],
  );
});

test('隐藏图层不参与合成（导出与预览共用）', () => {
  const project = createProject({ width: 4, height: 4 });
  const baseLayer = project.layers[0];
  setPixel(project.frames[0].cels[baseLayer.id], 4, 4, 0, 0, colorFromHex('#00ff00'));
  const top = {
    id: 'layer-top',
    name: '上层',
    visible: true,
    locked: false,
  };
  project.layers.push(top);
  const topCel = new Uint8ClampedArray(4 * 4 * 4);
  setPixel(topCel, 4, 4, 0, 0, colorFromHex('#ff0000'));
  project.frames[0].cels[top.id] = topCel;

  const visible = compositeFrame(project, project.frames[0]);
  assert.deepEqual(pixelAt(visible, 4, 0, 0), [255, 0, 0, 255]);

  top.visible = false;
  const hidden = compositeFrame(project, project.frames[0]);
  assert.deepEqual(pixelAt(hidden, 4, 0, 0), [0, 255, 0, 255]);
  const withHidden = compositeFrame(project, project.frames[0], { includeHidden: true });
  assert.deepEqual(pixelAt(withHidden, 4, 0, 0), [255, 0, 0, 255]);
});

test('调色板换色：可选替换已有像素，并跳过全透明像素', () => {
  const project = createProject({ width: 4, height: 4 });
  withPixel(project, '#ff0000', 0, 0);
  withPixel(project, '#ff0000', 1, 0);
  withPixel(project, '#00ff00', 2, 0);
  // 透明像素的 RGB 即使是红色，也不应被替换成带色
  const celBefore = project.frames[0].cels[project.layers[0].id];
  celBefore[(0 * 4 + 3) * 4] = 255;
  celBefore[(0 * 4 + 3) * 4 + 3] = 0;

  const replaced = replaceColorInProject(project, '#ff0000', '#0000ff');
  assert.equal(replaced, 2);
  // 替换会克隆并替换 cel，必须重新读取
  const cel = project.frames[0].cels[project.layers[0].id];
  assert.notEqual(cel, celBefore);
  assert.deepEqual(pixelAt(cel, 4, 0, 0), [0, 0, 255, 255]);
  assert.deepEqual(pixelAt(cel, 4, 1, 0), [0, 0, 255, 255]);
  assert.deepEqual(pixelAt(cel, 4, 2, 0), [0, 255, 0, 255]);
  assert.equal(pixelAt(cel, 4, 3, 0)[3], 0);
});

test('替换颜色不改动历史快照共享的缓冲区', () => {
  const project = createProject({ width: 4, height: 4 });
  withPixel(project, '#ff0000', 0, 0);
  const celBefore = project.frames[0].cels[project.layers[0].id];
  const snapshotCopy = new Uint8ClampedArray(celBefore);
  replaceColorInProject(project, '#ff0000', '#00ffff');
  // 旧缓冲区保持原样（新的 cel 是新对象）
  assert.notEqual(project.frames[0].cels[project.layers[0].id], celBefore);
  assert.deepEqual(pixelAt(snapshotCopy, 4, 0, 0), [255, 0, 0, 255]);
});

test('差异统计区分为新增 / 移除 / 改色', () => {
  const width = 4;
  const height = 1;
  const prev = new Uint8ClampedArray(width * height * 4);
  const curr = new Uint8ClampedArray(width * height * 4);
  // 0: prev 有 -> curr 无（移除）
  setPixel(prev, width, height, 0, 0, colorFromHex('#ffffff'));
  // 1: prev 无 -> curr 有（新增）
  setPixel(curr, width, height, 1, 0, colorFromHex('#00ff00'));
  // 2: 两边都有但颜色不同
  setPixel(prev, width, height, 2, 0, colorFromHex('#ff0000'));
  setPixel(curr, width, height, 2, 0, colorFromHex('#0000ff'));
  // 3: 相同
  setPixel(prev, width, height, 3, 0, colorFromHex('#123456'));
  setPixel(curr, width, height, 3, 0, colorFromHex('#123456'));

  const info = diffBuffers(prev, curr);
  assert.equal(info.added, 1);
  assert.equal(info.removed, 1);
  assert.equal(info.changed, 1);
  assert.equal(info.total, 3);
  assert.equal(info.overlay[(0 * width + 3) * 4 + 3], 0);
});

test('工程序列化往返保留尺寸、图层、帧与时长', () => {
  const project = createProject({ width: 12, height: 10, name: '测试工程' });
  withPixel(project, '#abcdef', 3, 4);
  setFrameDuration(project, project.frames[0].id, 170);
  const extra = insertFrame(project, { afterIndex: 0, duplicate: true });
  setFrameDuration(project, extra.id, 330);
  project.layers[0].visible = false;

  const restored = deserializeProject(serializeProject(project));
  assert.equal(restored.width, 12);
  assert.equal(restored.height, 10);
  assert.equal(restored.name, '测试工程');
  assert.equal(restored.frames.length, 2);
  assert.equal(restored.layers[0].visible, false);
  assert.equal(totalLoopDuration(restored), 500);
  assert.deepEqual(
    pixelAt(restored.frames[0].cels[restored.layers[0].id], 12, 3, 4),
    [0xab, 0xcd, 0xef, 255],
  );
});

test('导入校验：拒绝错误尺寸、错误长度与超限帧数', () => {
  const project = createProject({ width: 8, height: 8 });
  const doc = JSON.parse(serializeProject(project));
  doc.width = 4;
  assert.throws(() => deserializeProject(JSON.stringify(doc)), /宽度/);

  const doc2 = JSON.parse(serializeProject(project));
  doc2.frames[0].cels[doc2.layers[0].id] = 'AAAA';
  assert.throws(() => deserializeProject(JSON.stringify(doc2)), /像素长度/);

  const doc3 = JSON.parse(serializeProject(project));
  doc3.frames = Array.from({ length: 241 }, () => ({
    id: `f-${Math.random()}`,
    duration: 100,
    cels: doc3.frames[0].cels,
  }));
  assert.throws(() => deserializeProject(JSON.stringify(doc3)), /帧数/);

  assert.throws(() => deserializeProject('not json'), /JSON/);
  assert.throws(() => deserializeProject('{"format":"nope"}'), /格式/);
});

test('油漆桶只填充连通的同色区域', () => {
  const width = 5;
  const height = 5;
  const buffer = new Uint8ClampedArray(width * height * 4);
  // 竖直分隔线，左半和右半不连通
  for (let y = 0; y < height; y += 1) {
    setPixel(buffer, width, height, 2, y, colorFromHex('#000000'));
  }
  const changed = floodFill(buffer, width, height, 0, 0, colorFromHex('#ff0000'));
  assert.equal(changed, 10);
  assert.deepEqual(pixelAt(buffer, width, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(buffer, width, 2, 0), [0, 0, 0, 255]);
  assert.equal(pixelAt(buffer, width, 3, 0)[3], 0);
});

test('取不到 cel 时返回 null，避免误写', () => {
  const project = createProject({ width: 8, height: 8 });
  assert.equal(getCel(project, 'missing-frame', project.layers[0].id), null);
  assert.equal(getCel(project, project.frames[0].id, 'missing-layer'), null);
});
