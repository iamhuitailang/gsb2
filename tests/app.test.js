/* 应用层测试：增量重算、保存/载入、版本变化定位（用轻量 DOM 桩加载 app.js） */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

require(path.join(__dirname, '..', 'js', 'engine.js'));
const E = globalThis.TileEngine;

// app.js/demo.js 只在初始化时用到 window，给一个最小桩
const sandbox = { globalThis, console, setTimeout, clearTimeout };
sandbox.window = sandbox;
sandbox.TileEngine = E;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'demo.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8'), sandbox);
const App = sandbox.TileApp;
const Demo = sandbox.TileDemo;

function fresh() {
  App.init(Demo.makeDefaultRules(), Demo.makeDemoGrid(), 123);
  return App;
}

test('初始化后所有非空格都有评估结果，缺项格被正确识别', () => {
  const app = fresh();
  let filled = 0;
  for (let y = 0; y < app.grid.h; y++) {
    for (let x = 0; x < app.grid.w; x++) {
      if (app.grid.get(x, y)) {
        filled++;
        assert.ok(app.evalCache.has(app.grid.idx(x, y)));
      }
    }
  }
  assert.ok(filled > 20);
  const { missing, conflicts } = app.scanProblems();
  assert.ok(missing.length > 0, '演示数据故意包含缺项');
  assert.ok(conflicts.length > 0, '演示数据故意包含同优先级冲突');
});

test('局部编辑只重算受影响格，其它格对象保持不变', () => {
  const app = fresh();
  // 在演示地图右上角空地画一个草地（该格 8 邻居均为空 → 掩码 0）
  const x = 19, y = 0;
  assert.equal(app.grid.get(x, y), null);
  // 远处选一个确有地表的格（草地内部 (3,2)）
  const untouchedIdx = app.grid.idx(3, 2);
  const before = app.evalCache.get(untouchedIdx);
  assert.ok(before);

  app.pushHistory('test');
  // applyStrokeDirect 内部已做增量重算
  app.applyStrokeDirect([[x, y]], 'grass');

  const affected = E.affectedCells(app.grid, [[x, y]]);
  assert.ok(affected.has(app.grid.idx(x, y)));
  assert.ok(!affected.has(untouchedIdx), '远处格不应被重算');
  assert.equal(app.evalCache.get(untouchedIdx), before, '未受影响格保持原评估对象');
  assert.ok(app.evalCache.has(app.grid.idx(x, y)));

  // 新画格无同类邻居，掩码应为 0
  const ev = app.evalCache.get(app.grid.idx(x, y));
  assert.ok(ev);
  assert.equal(ev.terrain, 'grass');
  assert.equal(ev.mask, 0);
});

test('擦除后该格从缓存移除，撤销可恢复且外观评估一致', () => {
  const app = fresh();
  const x = 3, y = 2;
  assert.ok(app.grid.get(x, y));
  const before = app.evalCache.get(app.grid.idx(x, y));
  app.applyStroke([[x, y]], null);
  assert.equal(app.grid.get(x, y), null);
  assert.ok(!app.evalCache.has(app.grid.idx(x, y)));

  app.undo();
  assert.equal(app.grid.get(x, y), before.terrain);
  const after = app.evalCache.get(app.grid.idx(x, y));
  assert.equal(after.tileId, before.tileId);
  assert.equal(after.rot, before.rot);
  assert.equal(after.variantId, before.variantId);
});

test('填充只改连通区域（内洞内外互不影响）', () => {
  const app = fresh();
  // 找一个水域格做填充目标前，先统计填充前草地数量
  const grassBefore = app.grid.cells.filter((c) => c === 'grass').length;
  const wx = 2, wy = 12; // 演示地图左下角水域
  assert.equal(app.grid.get(wx, wy), 'water');
  app.applyFill(wx, wy, 'stone');
  const waterLeft = app.grid.cells.filter((c) => c === 'water').length;
  assert.equal(waterLeft, 0, '全部水域（连通）应被替换');
  const grassAfter = app.grid.cells.filter((c) => c === 'grass').length;
  assert.equal(grassAfter, grassBefore, '草地不应被填充影响');
});

test('地图保存/载入：同版本完全一致；改规则后逐格报告变化位置', () => {
  const app = fresh();
  const mapJson = app.serializeMap();
  const r1 = app.loadMap(mapJson);
  assert.equal(r1.sameVersion, true);
  assert.equal(r1.warnings.length, 0);

  // 改一个图块编号制造版本差异。选演示地图里实际出现的 water/outer shape 1
  const slot = app.rules.tiles.water.outer[1];
  const oldTile = slot.tileId;
  assert.ok(oldTile != null);
  slot.tileId = oldTile + 50000;
  app.rulesMutated();

  const r2 = app.loadMap(mapJson);
  assert.equal(r2.sameVersion, false);
  assert.ok(r2.warnings.length > 0, '应逐格列出变化位置');
  const sample = r2.warnings[0];
  assert.ok(typeof sample.x === 'number' && typeof sample.y === 'number');
  assert.equal(sample.before.tileId, oldTile);
  assert.equal(sample.after.tileId, oldTile + 50000);
});

test('规则保存/载入保持版本号一致', () => {
  const app = fresh();
  const json = app.serializeRules();
  const versionBefore = app.rules._version;
  const r = app.loadRules(json);
  assert.equal(r.newVersion, versionBefore);
  assert.equal(app.rules._version, versionBefore);
});

test('CSV 导出包含每格编号与旋转角度', () => {
  const app = fresh();
  const csv = app.exportTileTable();
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'x,y,terrain,tileId,rotDeg,variantId,cat,shape,missing');
  const filled = app.grid.cells.filter(Boolean).length;
  assert.equal(lines.length - 1, filled);
  const row = lines[1].split(',');
  assert.equal(row.length, 9);
  assert.ok(['0', '90', '180', '270'].includes(row[4]));
});

test('固定种子：重复评估结果稳定，改种子后变体可能变化', () => {
  const app = fresh();
  const a = E.evaluateCell(app.rules, app.grid, 3, 3, 777);
  const b = E.evaluateCell(app.rules, app.grid, 3, 3, 777);
  assert.deepEqual(
    { t: a.tileId, r: a.rot, v: a.variantId },
    { t: b.tileId, r: b.rot, v: b.variantId },
  );
});
