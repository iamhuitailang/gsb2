/* Node 测试：node --test tests/engine.test.js（无第三方依赖） */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require(path.join(__dirname, '..', 'js', 'engine.js'));
const E = globalThis.TileEngine;

test('256 种掩码全部落入注册表，且旋转后可还原原掩码（相关位）', () => {
  let covered = 0;
  for (const shape of E.registry.list) {
    for (const mask of shape.masks) {
      covered++;
      const c = E.canonicalize(mask);
      assert.equal(c.cat, shape.cat);
      assert.equal(c.key, shape.key);
      // 原掩码顺时针旋转 rot 次、剥离无关斜向后必须等于规范掩码
      const stripped = (() => {
        // 复刻引擎内部剥离逻辑：两侧正向都同类的斜向为无关位
        let out = mask & 0x0f;
        for (const d of [4, 5, 6, 7]) {
          const [a, b] = E.DIAG_CARD[d];
          const both = (mask & (1 << a)) && (mask & (1 << b));
          if (!both && (mask & (1 << d))) out |= 1 << d;
        }
        return out;
      })();
      assert.equal(E.rotateMask(stripped, c.rot), shape.canonMask);
      // 正向位必须能精确还原
      assert.equal(E.rotateMask(shape.canonMask, (4 - c.rot) % 4) & 0x0f, mask & 0x0f);
    }
  }
  assert.equal(covered, 256);
});

test('类别与正向邻居数对应', () => {
  for (let mask = 0; mask < 256; mask++) {
    const cardN = E.popcount(mask & 0x0f);
    const c = E.canonicalize(mask);
    const want = { 0: 'isolated', 1: 'edge', 4: 'interior', 3: 'inner' };
    if (want[cardN]) assert.equal(c.cat, want[cardN], `mask=${mask}`);
    if (cardN === 2) {
      const card = mask & 0x0f;
      const pair = [0, 1, 2, 3].filter((d) => card & (1 << d));
      const adjacent = ((pair[1] - pair[0] + 4) % 4) !== 2;
      assert.equal(c.cat, adjacent ? 'outer' : 'connector', `mask=${mask}`);
    }
  }
});

test('规范帧朝向正确', () => {
  for (const shape of E.registry.list) {
    const m = shape.canonMask;
    const card = m & 0x0f;
    if (shape.cat === 'edge') assert.equal(card, 0x1);              // 唯一正向 = N
    if (shape.cat === 'outer') assert.equal(card, 0x3);             // N,E
    if (shape.cat === 'connector') assert.equal(card, 0xa);         // E,W
    if (shape.cat === 'inner') assert.equal(card, 0xe);             // 缺 N
  }
});

test('同掩码稳定得到相同图块形态（旋转等价类一致）', () => {
  const a = E.canonicalize(0b00000011); // N,E 邻接
  const b = E.canonicalize(E.rotateMask(0b00000011, 2));
  assert.equal(a.cat, 'outer');
  assert.equal(b.cat, 'outer');
  assert.equal(a.key, b.key);
  assert.equal(b.rot, (a.rot + 2) % 4);
});

test('斜向差异不会被错误归并（相关斜向各自成形态）', () => {
  // interior：四接时所有斜向都无关，只有 1 种形态（16 个掩码共享）
  assert.equal(E.registry.shapes.interior.length, 1);
  assert.equal(E.registry.shapes.interior[0].masks.length, 16);
  // inner：缺口处 1 个相关斜向，有/无两种
  assert.ok(E.registry.shapes.inner.length >= 2);
  // outer：外角处 1 个相关斜向
  assert.ok(E.registry.shapes.outer.length >= 2);
  // edge：缺口侧 2 个相关斜向 → 4 种（对称时旋转后同帧，形态数 >= 4）
  assert.ok(E.registry.shapes.edge.length >= 4);
  // isolated：无正向、4 个斜向全部相关，形态最多
  assert.ok(E.registry.shapes.isolated.length >= E.registry.shapes.interior.length);
});

function fullRules() {
  const rules = E.emptyRuleset();
  rules.terrains = [{ id: 'a', name: '甲', color: '#58b368' }];
  E.ensureTerrainSlots(rules, 'a');
  let id = 1;
  for (const cat of E.CAT_ORDER) {
    E.registry.shapes[cat].forEach((s, si) => {
      rules.tiles.a[cat][si].tileId = id++;
    });
  }
  return rules;
}

test('evaluateCell：内部/边/外角/内角/孤立判定与旋转', () => {
  const rules = fullRules();

  // edge（单接）：从单行墙上突出一格，端头只有一个正向同类
  const wall = new E.Grid(11, 3);
  for (let x = 0; x < 11; x++) wall.set(x, 1, 'a');
  wall.set(5, 0, 'a'); // 端头 (5,0)：只接 S
  const tip = E.evaluateCell(rules, wall, 5, 0, 1);
  assert.equal(tip.cat, 'edge');
  assert.equal(tip.rot, 2); // 唯一正向 S，顺时针转 2 次到 N

  wall.set(0, 0, 'a'); // 端头 (0,0)：只接 E（(0,1) 仍在墙上）
  const tipE = E.evaluateCell(rules, wall, 0, 0, 1);
  assert.equal(tipE.cat, 'edge');
  assert.equal(tipE.rot, 2); // E 顺时针转 2 次（180°）到 N

  // connector（对边贯通）：单行墙中间格
  const mid = E.evaluateCell(rules, wall, 8, 1, 1);
  assert.equal(mid.cat, 'connector');

  // 3x3 实心块：中心 interior，角点 outer，边中格因斜向也同类而属于 inner
  const g = new E.Grid(5, 5);
  for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) g.set(x, y, 'a');
  const center = E.evaluateCell(rules, g, 2, 2, 1);
  assert.equal(center.cat, 'interior');
  assert.equal(center.rot, 0);
  assert.equal(center.missing, false);

  const corner = E.evaluateCell(rules, g, 1, 1, 1);
  assert.equal(corner.cat, 'outer');
  assert.equal(corner.missing, false);

  const topMid = E.evaluateCell(rules, g, 2, 1, 1);
  assert.equal(topMid.cat, 'inner');

  // 真正的三接内角：中心格只有 N/E/S 三个正向同类（缺 W）
  const innerGrid = new E.Grid(3, 3);
  innerGrid.set(1, 0, 'a');
  innerGrid.set(1, 1, 'a'); innerGrid.set(2, 1, 'a');
  innerGrid.set(1, 2, 'a');
  const inner = E.evaluateCell(rules, innerGrid, 1, 1, 1);
  assert.equal(inner.cat, 'inner');
  assert.equal(inner.rot, 1); // 缺 W：W(bit3) 顺时针转 1 次到达 N(bit0)，得到规范帧（缺 N）
});

test('孤立格判定为 isolated', () => {
  const g = new E.Grid(3, 3);
  g.set(1, 1, 'a');
  const rules = fullRules();
  const ev = E.evaluateCell(rules, g, 1, 1, 1);
  assert.equal(ev.cat, 'isolated');
  assert.equal(ev.rot, 0);
});

test('缺项：未配置槽位返回 missing=true 且无 tileId', () => {
  const g = new E.Grid(3, 1);
  g.set(0, 0, 'a'); g.set(1, 0, 'a'); g.set(2, 0, 'a');
  const rules = fullRules();
  const before = E.evaluateCell(rules, g, 0, 0, 1);
  assert.equal(before.missing, false);
  // 清掉 edge 第 0 形态
  rules.tiles.a.edge[0].tileId = null;
  const after = E.evaluateCell(rules, g, 0, 0, 1);
  assert.equal(after.missing, true);
  assert.equal(after.cat, 'edge');
});

test('自定义规则按优先级覆盖自动形态', () => {
  const g = new E.Grid(3, 3);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) g.set(x, y, 'a');
  const rules = fullRules();
  rules.customRules = [
    { id: 'low', terrain: 'a', priority: 5, match: [-1, -1, -1, -1, -1, -1, -1, -1], tileId: 900, rot: 2, variantIds: [] },
    { id: 'high', terrain: 'a', priority: 9, match: [-1, -1, -1, -1, -1, -1, -1, -1], tileId: 901, rot: 1, variantIds: [] },
  ];
  const ev = E.evaluateCell(rules, g, 1, 1, 1);
  assert.equal(ev.hit.kind, 'custom');
  assert.equal(ev.hit.ruleId, 'high');
  assert.equal(ev.tileId, 901);
  assert.equal(ev.rot, 1);
});

test('同优先级冲突可定位', () => {
  const g = new E.Grid(1, 1);
  g.set(0, 0, 'a');
  const rules = fullRules();
  rules.customRules = [
    { id: 'r1', terrain: 'a', priority: 7, match: [-1, -1, -1, -1, -1, -1, -1, -1], tileId: 1, rot: 0, variantIds: [] },
    { id: 'r2', terrain: 'a', priority: 7, match: [-1, -1, -1, -1, -1, -1, -1, -1], tileId: 2, rot: 0, variantIds: [] },
  ];
  const ev = E.evaluateCell(rules, g, 0, 0, 1);
  assert.deepEqual(ev.conflictRuleIds.sort(), ['r1', 'r2']);
});

test('固定种子下变体可复现，不同坐标可得到不同变体', () => {
  // 10x5 实心块，中间行全部为 interior（四接），会用到 interior 变体
  const g = new E.Grid(10, 5);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 10; x++) g.set(x, y, 'a');
  const rules = fullRules();
  const slot = rules.tiles.a.interior[0];
  slot.variantIds = ['v1', 'v2', 'v3'];

  const xs = Array.from({ length: 8 }, (_, i) => i + 1);
  const first = xs.map((x) => E.evaluateCell(rules, g, x, 2, 42).variantId);
  const second = xs.map((x) => E.evaluateCell(rules, g, x, 2, 42).variantId);
  assert.deepEqual(first, second); // 可复现
  assert.ok(first.every((v) => ['v1', 'v2', 'v3'].includes(v)));
  assert.ok(new Set(first).size > 1, '变体应在格间分布');

  const otherSeed = xs.map((x) => E.evaluateCell(rules, g, x, 2, 99).variantId);
  assert.notDeepEqual(first, otherSeed); // 换种子结果可变化
});

test('增量重算：受影响集合只含改动格及其 8 邻居', () => {
  const g = new E.Grid(5, 5);
  g.set(2, 2, 'a');
  const affected = E.affectedCells(g, [[2, 2]]);
  assert.equal(affected.size, 9);
  assert.ok(affected.has(g.idx(1, 1)));
  assert.ok(affected.has(g.idx(3, 3)));
  assert.ok(!affected.has(g.idx(0, 0)));
});

test('floodFill 只走正向四邻接，内洞内外不连通', () => {
  // 5x5 外环
  const g = new E.Grid(5, 5);
  for (let i = 0; i < 5; i++) { g.set(i, 0, 'a'); g.set(i, 4, 'a'); g.set(0, i, 'a'); g.set(4, i, 'a'); }
  const outer = E.floodFill(g, 0, 0);
  assert.equal(outer.size, 16);          // 外环 16 格
  g.set(2, 2, 'a');                      // 洞里放一个孤立格
  const inner = E.floodFill(g, 2, 2);
  assert.equal(inner.size, 1);
  assert.ok(!outer.has(g.idx(2, 2)));
});

test('规则版本：内容相同则版本相同，改动后变化', () => {
  const r1 = fullRules();
  const r2 = fullRules();
  assert.equal(E.ruleVersion(r1), E.ruleVersion(r2));
  r2.tiles.a.edge[0].tileId = 9999;
  assert.notEqual(E.ruleVersion(r1), E.ruleVersion(r2));
});

test('掩码匹配：1/0/-1 语义正确', () => {
  assert.ok(E.ruleMatches([1, -1, -1, -1, -1, -1, -1, -1], 0b1));
  assert.ok(!E.ruleMatches([1, -1, -1, -1, -1, -1, -1, -1], 0b10));
  assert.ok(E.ruleMatches([0, -1, -1, -1, -1, -1, -1, -1], 0b10));
  assert.ok(E.ruleMatches([-1, -1, -1, -1, -1, -1, -1, -1], 0b11111111));
});
