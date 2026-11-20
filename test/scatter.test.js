import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTerrain, Terrain } from '../src/core/terrain.js';
import { PaintMask } from '../src/core/mask.js';
import { ScatterLayer } from '../src/core/scatter.js';
import { DEFAULT_RULES, createRule, pickWeightedRule, ruleToJSON, ruleFromJSON } from '../src/core/rules.js';
import { mulberry32, randomFor, hashInts } from '../src/core/rng.js';
import { TOOL } from '../src/core/constants.js';
import { saveProject, loadProject, exportInstancesJSON, exportInstancesCSV } from '../src/core/project.js';

function makeWorld(seed = 42, rules = DEFAULT_RULES()) {
  const terrain = generateTerrain({ size: 128, resolution: 65, seed });
  const mask = new PaintMask({ width: terrain.width, depth: terrain.depth, cellSize: 2 });
  const scatter = new ScatterLayer({ terrain, mask, rules, seed });
  return { terrain, mask, rules, scatter };
}

function signature(list) {
  return list
    .map((i) => `${i.cellIndex}:${i.ruleId}@${i.x.toFixed(4)},${i.z.toFixed(4)}`)
    .sort()
    .join('|');
}

test('PRNG 与格点随机完全确定', () => {
  const a = mulberry32(1234);
  const b = mulberry32(1234);
  const seqA = Array.from({ length: 8 }, a);
  const seqB = Array.from({ length: 8 }, b);
  assert.deepEqual(seqA, seqB);
  assert.equal(randomFor(7, 8, 9), randomFor(7, 8, 9));
  assert.notEqual(randomFor(7, 8, 9), randomFor(7, 8, 10));
  assert.ok(hashInts(1) >= 0 && hashInts(1) <= 0xffffffff);
});

test('地形双线性采样与法线合法', () => {
  const t = generateTerrain({ size: 64, resolution: 33 });
  assert.ok(Number.isNaN(t.heightAt(1000, 0)));
  const h = t.heightAt(0, 0);
  assert.equal(typeof h, 'number');
  const n = t.normalAt(3, -4);
  const len = Math.hypot(n.x, n.y, n.z);
  assert.ok(Math.abs(len - 1) < 1e-6);
  const slope = t.slopeAt(3, -4);
  assert.ok(slope >= 0 && slope <= 90);
});

test('遮罩涂抹与双线性采样', () => {
  const m = new PaintMask({ width: 32, depth: 32, cellSize: 1 });
  assert.equal(m.sample(0, 0), 0);
  const region = m.paint({ x: 0, z: 0 }, 5, 1);
  assert.ok(region);
  assert.ok(m.sample(0, 0) > 0.9);
  assert.equal(m.sample(20, 20), 0);
  m.paint({ x: 0, z: 0 }, 5, -1);
  assert.equal(m.sample(0, 0), 0);
});

test('权重选择确定且按比例', () => {
  const r1 = createRule({ id: 'a', weight: 3 });
  const r2 = createRule({ id: 'b', weight: 1 });
  let a = 0;
  for (let i = 0; i < 1000; i++) {
    const r = pickWeightedRule([r1, r2], (i * 2654435761 % 10000) / 10000);
    if (r.id === 'a') a++;
  }
  assert.ok(a > 650 && a < 850, `a 占比应约 75%，实际 ${a / 1000}`);
  assert.equal(pickWeightedRule([], 0.5), null);
});

test('笔刷生成实例且同种子结果完全一致', () => {
  const w1 = makeWorld(42);
  const w2 = makeWorld(42);
  w1.scatter.applyBrush(TOOL.PAINT, { x: 0, z: 0 }, 20);
  w2.scatter.applyBrush(TOOL.PAINT, { x: 0, z: 0 }, 20);
  w1.scatter.flushDirty();
  w2.scatter.flushDirty();
  const s1 = signature(w1.scatter.getAllInstances());
  const s2 = signature(w2.scatter.getAllInstances());
  assert.equal(s1, s2);
  assert.ok(w1.scatter.getStats().total > 50);
});

test('不同种子产生不同分布', () => {
  const w1 = makeWorld(1);
  const w2 = makeWorld(2);
  w1.scatter.applyBrush(TOOL.PAINT, { x: 0, z: 0 }, 25);
  w2.scatter.applyBrush(TOOL.PAINT, { x: 0, z: 0 }, 25);
  assert.notEqual(signature(w1.scatter.flushDirty() && w1.scatter.getAllInstances()),
    signature(w2.scatter.flushDirty() && w2.scatter.getAllInstances()));
});

test('相邻帧重复涂抹幂等，不重复堆放', () => {
  const { scatter } = makeWorld();
  for (let frame = 0; frame < 10; frame++) {
    scatter.applyBrush(TOOL.PAINT, { x: 5, z: -3 }, 12);
  }
  scatter.flushDirty();
  const countOnce = scatter.getStats().total;

  const w2 = makeWorld();
  w2.scatter.applyBrush(TOOL.PAINT, { x: 5, z: -3 }, 12);
  w2.scatter.flushDirty();
  assert.equal(countOnce, w2.scatter.getStats().total);
});

test('实例间距满足每条规则的 spacing（含跨规则）', () => {
  const { scatter } = makeWorld();
  scatter.applyBrush(TOOL.PAINT, { x: 0, z: 0 }, 40);
  scatter.flushDirty();
  const rulesById = new Map(DEFAULT_RULES().map((r) => [r.id, r]));
  const all = scatter.getAllInstances();
  // 暴力两两检查（实例规模可控）
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      const minSpacing = Math.min(rulesById.get(a.ruleId).spacing, rulesById.get(b.ruleId).spacing);
      assert.ok(d >= minSpacing - 1e-9,
        `间距冲突 ${a.ruleId}/${b.ruleId}: d=${d.toFixed(3)} < ${minSpacing}`);
    }
  }
});

test('分块边界连续：逐块重建 == 全量评估', () => {
  const w = makeWorld();
  // 跨越多个 chunk 的大面积笔刷
  for (const [x, z] of [[-30, -30], [0, 0], [30, 30], [-30, 30], [30, -30]]) {
    w.scatter.applyBrush(TOOL.PAINT, { x, z }, 22);
  }
  // 每次只 flush 一块，模拟真实增量节奏
  let changes;
  do {
    changes = w.scatter.flushDirty(1);
  } while (changes.length > 0);
  const chunked = signature(w.scatter.getAllInstances());

  // 参照：一次性构建所有块（padding 行为相同）
  const w2 = makeWorld();
  for (const [x, z] of [[-30, -30], [0, 0], [30, 30], [-30, 30], [30, -30]]) {
    w2.scatter.applyBrush(TOOL.PAINT, { x, z }, 22);
  }
  w2.scatter.flushDirty();
  assert.equal(chunked, signature(w2.scatter.getAllInstances()));
});

test('规则变化只更新受影响（含已绘制）块，未触碰区域不产生实例', () => {
  const { scatter } = makeWorld();
  scatter.applyBrush(TOOL.PAINT, { x: -40, z: 0 }, 10);
  scatter.flushDirty();
  const before = scatter.getStats().total;
  assert.ok(before > 0);

  const newRules = DEFAULT_RULES().map((r) => ({
    ...r,
    density: r.density * 2,
    spacing: r.spacing * 0.5, // 同步放松间距，否则数量会被 spacing 物理上限卡住
  }));
  scatter.invalidateRules(newRules);
  // 只有之前构建过的块标脏
  assert.ok(scatter.dirtyChunks.size > 0);
  scatter.flushDirty();
  const after = scatter.getStats().total;
  assert.ok(after > before, '密度翻倍且间距减半后实例应变多');

  // 未刷过的区域仍然没有实例
  const far = scatter.getAllInstances().filter((i) => i.x > 20);
  assert.equal(far.length, 0);
});

test('擦除后区域无实例，重刷可恢复且结果一致', () => {
  const { scatter } = makeWorld();
  scatter.applyBrush(TOOL.PAINT, { x: 0, z: 0 }, 20);
  scatter.flushDirty();
  const full = signature(scatter.getAllInstances());

  scatter.applyBrush(TOOL.ERASE, { x: 0, z: 0 }, 8);
  scatter.flushDirty();
  const erased = scatter.getAllInstances();
  assert.ok(erased.every((i) => Math.hypot(i.x, i.z) > 8 - 0.5));

  scatter.applyBrush(TOOL.PAINT, { x: 0, z: 0 }, 20);
  scatter.flushDirty();
  assert.equal(signature(scatter.getAllInstances()), full);
});

test('替换只改模型不改位置', () => {
  // 用与针叶树相同密度/间距、但环境约束极宽松的规则作为替换目标，
  // 不改变格网尺寸，保证替换前后候选点位置一一对应
  const rules = DEFAULT_RULES();
  rules.push(createRule({
    id: 'target', name: '替换目标', kind: 'tree',
    weight: 1, density: 0.08, spacing: 2.4,
    tiltMax: 90, slopeRange: [0, 90], heightRange: [-Infinity, Infinity],
  }));
  const { scatter } = makeWorld(42, rules);
  scatter.applyBrush(TOOL.PAINT, { x: 0, z: 0 }, 18);
  scatter.flushDirty();
  const beforePos = new Set(
    scatter.getAllInstances().map((i) => `${i.x.toFixed(4)},${i.z.toFixed(4)}`),
  );

  scatter.applyBrush(TOOL.REPLACE, { x: 0, z: 0 }, 18, 'target');
  scatter.flushDirty();
  const after = scatter.getAllInstances();
  assert.ok(after.length > 0);
  assert.ok(after.every((i) => i.ruleId === 'target'));
  // 位置集合不变，只换模型
  const afterPos = new Set(after.map((i) => `${i.x.toFixed(4)},${i.z.toFixed(4)}`));
  assert.deepEqual([...afterPos].sort(), [...beforePos].sort());
});

test('高度/坡度约束生效', () => {
  const rules = [
    createRule({ id: 'flat', density: 0.4, spacing: 0.5, slopeRange: [0, 1], heightRange: [-Infinity, Infinity] }),
  ];
  const { terrain, mask, scatter } = makeWorld(7, rules);
  scatter.applyBrush(TOOL.PAINT, { x: 0, z: 0 }, 30);
  scatter.flushDirty();
  for (const inst of scatter.getAllInstances()) {
    assert.ok(terrain.slopeAt(inst.x, inst.z) <= 1 + 1e-9);
  }
});

test('遮罩阈值过滤且遮罩变化只触发局部重算', () => {
  const rules = DEFAULT_RULES().map((r) => ({ ...r, maskThreshold: 0.5 }));
  const w = makeWorld(9, rules);
  w.scatter.applyBrush(TOOL.PAINT, { x: 0, z: 0 }, 25);
  w.mask.paint({ x: 0, z: 0 }, 12, 1);
  w.scatter.flushDirty();
  const withMask = w.scatter.getStats().total;

  const w2 = makeWorld(9, rules.map((r) => ({ ...r, maskThreshold: 0 })));
  w2.scatter.applyBrush(TOOL.PAINT, { x: 0, z: 0 }, 25);
  w2.scatter.flushDirty();
  assert.ok(w2.scatter.getStats().total > withMask);

  // 遮罩改动只标脏相交块
  const beforeDirty = w.scatter.dirtyChunks.size;
  const region = w.mask.paint({ x: 30, z: 30 }, 5, 1);
  w.scatter.markRegionDirty(region);
  const touched = w.scatter.dirtyChunks.size;
  assert.ok(touched <= beforeDirty + 4, '远侧遮罩改动只影响少数块');
});

test('存档往返：地形引用、规则、实例位置完全恢复', () => {
  const w = makeWorld(123);
  w.scatter.applyBrush(TOOL.PAINT, { x: -10, z: 8 }, 22);
  w.scatter.applyBrush(TOOL.ERASE, { x: -10, z: 8 }, 5);
  w.scatter.flushDirty();
  const original = w.scatter.getAllInstances();
  const project = saveProject({
    name: 't', terrain: w.terrain, mask: w.mask, scatter: w.scatter, rules: w.rules,
  });
  const json = JSON.parse(JSON.stringify(project)); // 模拟落盘
  const restored = loadProject(json);

  assert.equal(restored.terrain.width, w.terrain.width);
  assert.equal(restored.terrain.heightAt(1.23, -4.56), w.terrain.heightAt(1.23, -4.56));
  assert.deepEqual(restored.rules.map((r) => r.id), w.rules.map((r) => r.id));

  const got = restored.scatter.getAllInstances();
  assert.equal(got.length, original.length);
  assert.equal(signature(got), signature(original));
  // 恢复后再次确定性重算仍一致
  restored.scatter.flushDirty();
  assert.equal(signature(restored.scatter.getAllInstances()), signature(original));
});

test('实例清单导出 JSON / CSV 格式正确', () => {
  const { scatter, rules } = makeWorld();
  scatter.applyBrush(TOOL.PAINT, { x: 0, z: 0 }, 15);
  scatter.flushDirty();
  const count = scatter.getStats().total;

  const json = JSON.parse(exportInstancesJSON(scatter, rules));
  assert.equal(json.format, 'vegetation-instances');
  assert.equal(json.count, count);
  assert.ok(json.instances[0].position);
  assert.ok('quaternion' in json.instances[0]);

  const csv = exportInstancesCSV(scatter, rules);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'id,model,kind,posX,posY,posZ,rotationYDeg,scale,normalX,normalY,normalZ');
  assert.equal(lines.length - 1, count);
});

test('规则序列化往返：±Infinity 海拔约束不丢失', () => {
  const rule = createRule({ id: 'inf', heightRange: [-Infinity, Infinity] });
  const json = ruleToJSON(rule);
  // JSON 文本里必须是有限数而不是 null
  const text = JSON.stringify(json);
  assert.ok(!text.includes('null'));
  const back = ruleFromJSON(JSON.parse(text));
  assert.equal(back.heightRange[0], -Infinity);
  assert.equal(back.heightRange[1], Infinity);
  assert.equal(back.id, 'inf');
});

test('恢复快照后同种子重算，所有已绘制块结果保持一致', () => {
  const w = makeWorld(77);
  for (const [x, z] of [[-40, -40], [0, 0], [40, 40], [-40, 40]]) {
    w.scatter.applyBrush(TOOL.PAINT, { x, z }, 20);
  }
  w.scatter.flushDirty();
  const project = JSON.parse(JSON.stringify(
    saveProject({ name: 't', terrain: w.terrain, mask: w.mask, scatter: w.scatter, rules: w.rules }),
  ));
  const restored = loadProject(project);
  const before = signature(restored.scatter.getAllInstances());

  // 模拟用户在 UI 里重新应用相同种子：每个含绘制格的块都必须被纳入重算
  restored.scatter.setSeed(restored.scatter.seed);
  assert.ok(restored.scatter.dirtyChunks.size >= restored.scatter.chunks.size);
  restored.scatter.flushDirty();
  assert.equal(signature(restored.scatter.getAllInstances()), before);
});
