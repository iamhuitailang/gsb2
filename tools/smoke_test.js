#!/usr/bin/env node
/* 编辑器核心逻辑冒烟测试（Node，无浏览器）。
 * 用法: node tools/smoke_test.js
 * 覆盖：笔刷合并为一次编辑、撤销/重做、扩容坐标锚定、地图扩展/裁切、
 *       裁切预览只读、序列化往返、跨图层撤销不串层。 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const ctx = { console, window: {}, setTimeout, localStorage: null };
vm.createContext(ctx);
for (const f of ['tileset.js', 'model.js', 'history.js', 'io.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'js', f), 'utf8'), ctx, { filename: f });
}

vm.runInContext(`
const assert = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); };
const findTile = (layer, id) => {
  const out = [];
  for (let r = 0; r < layer.rows; r++) for (let c = 0; c < layer.cols; c++)
    if (layer.tiles[r * layer.cols + c] === id)
      out.push({ x: layer.originX + c * layer.cellSize, y: layer.originY + r * layer.cellSize });
  return out;
};

const level = createLevel('test', 16, 20, 10);
const layer = createLayer('L1', 16);
level.layers.push(layer);

// 一次连续笔刷 = 一条历史
const col = makeChangeCollector();
col.set(layer, 5, 5, 7); col.set(layer, 6, 5, 7); col.set(layer, 7, 5, 7);
col.commit(layer.id);
assert(History.undoStack.length === 1, '一次笔刷应只产生一条历史');
assert(layerTileAt(layer, 5, 5) === 7, '格子写入');

History.undo(level);
assert(layerTileAt(layer, 5, 5) === 0, '撤销还原');
History.redo(level);
assert(layerTileAt(layer, 5, 5) === 7, '重做还原');

// 同一次笔刷中触发扩容（格子坐标平移），撤销仍精确还原（世界坐标锚定）
const w7 = findTile(layer, 7).map(p => p.x + ',' + p.y).sort();
const col2 = makeChangeCollector();
col2.set(layer, 8, 5, 9);
col2.set(layer, -3, -2, 10); // 向左/上扩容
col2.commit(layer.id);
History.undo(level);
assert(findTile(layer, 9).length === 0 && findTile(layer, 10).length === 0, '扩容后撤销');
const w7b = findTile(layer, 7).map(p => p.x + ',' + p.y).sort();
assert(JSON.stringify(w7) === JSON.stringify(w7b), '扩容不改变已有格子世界坐标');
History.redo(level);
assert(findTile(layer, 9).length === 1 && findTile(layer, 10).length === 1, '扩容后重做');

// 地图边缘扩展/裁切：已有图块随关卡原点平移，格子下标不变
const before9 = findTile(layer, 9)[0];
const snapBefore = cloneLevel(level);
resizeLevel(level, { left: 2, right: 0, top: -1, bottom: 0 }, true);
History.push({ kind: 'resize', before: snapBefore, after: cloneLevel(level) });
assert(level.width === 22 && level.height === 9, '尺寸调整');
const after9 = findTile(layer, 9)[0];
assert(after9.x === before9.x + 32 && after9.y === before9.y - 16, '扩展后图块与关卡范围保持对应');

History.undo(level);
assert(level.width === 20 && level.height === 10, '撤销尺寸调整');
const back9 = findTile(level.layers[0], 9)[0]; // 快照恢复后图层是新对象
assert(before9.x === back9.x && before9.y === back9.y, '撤销后坐标还原');
History.redo(level);
const layerR = level.layers[0];

// 裁切预览只读，且能报告将被裁掉的格子
const tilesBefore = layerR.tiles.join(',');
const preview = resizeLevel(level, { left: 0, right: -18, top: 0, bottom: 0 }, false);
assert(preview && preview.removed.length > 0, '预览报告裁掉格子');
assert(layerR.tiles.join(',') === tilesBefore, '预览不修改数据');

// 裁切真正删除界外格子
resizeLevel(level, { left: 0, right: -18, top: 0, bottom: 0 }, true);
assert(level.width === 4, '裁切宽度');
assert(findTile(layerR, 7).length === 0, '界外格子被裁掉');

// 序列化往返
const json = JSON.stringify(serializeLevel(level));
const { level: lvl2, errors } = deserializeLevel(JSON.parse(json));
assert(lvl2, '反序列化: ' + errors.join(','));
assert(lvl2.layers[0].tiles.every((v, i) => v === layerR.tiles[i]), '序列化往返图块一致');
assert(lvl2.width === level.width && lvl2.height === level.height, '序列化往返尺寸一致');

// 坏数据被拒绝
const bad = deserializeLevel({ format: 'gsb2-level', version: 1, tileSize: 16, width: 4, height: 4,
  layers: [{ id: 'a', name: 'x', cellSize: 16, origin: [0,0], cols: 2, rows: 2, tiles: [1,2,3] }] });
assert(bad.level === null && bad.errors.length > 0, '校验拒绝 tiles 长度不符的数据');

// 切换图层后撤销不串层
const layer2 = createLayer('L2', 32);
level.layers.push(layer2);
const colB = makeChangeCollector();
colB.set(layer2, 1, 1, 4);
colB.commit(layer2.id);
const colC = makeChangeCollector();
colC.set(layerR, 0, 0, 6);
colC.commit(layerR.id);
History.undo(level); // 撤 L1 的笔刷
assert(layerTileAt(layerR, 0, 0) === 0, '撤销作用于记录的图层 L1');
assert(layerTileAt(layer2, 1, 1) === 4, 'L2 不受影响');
History.undo(level); // 撤 L2 的笔刷
assert(layerTileAt(layer2, 1, 1) === 0, '撤销作用于记录的图层 L2');

console.log('SMOKE OK: 全部核心逻辑测试通过');
`, ctx);
