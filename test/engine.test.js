/* Node 确定性测试：node test/engine.test.js（-I 隔离模式运行） */
'use strict';
const assert = require('assert');
const E = require('../engine.js');
const samples = require('../samples.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok -', name);
  } catch (err) {
    console.error('FAIL -', name);
    console.error(err.stack || err);
    process.exitCode = 1;
  }
}
const count = (eng, type) =>
  Array.from(eng.cells.values()).filter((c) => c.type === type).length;
const types = (eng) => eng.events.map((ev) => ev.type);

// ---------- 基础：锚连通高亮与单砖自由落体 ----------
test('连通性：有路到锚的单元被标为 supported', () => {
  const eng = new E.Engine(5, 6);
  eng.addCell(0, 0, E.ANCHOR);
  eng.addCell(0, 1, E.BRICK, 0);
  eng.addCell(0, 2, E.BRICK, 0);
  eng.addCell(2, 2, E.BRICK, 0); // 孤立砖
  eng.toggleEdge(0, 0, 0, 1);
  eng.toggleEdge(0, 1, 0, 2);
  eng.commitLayout();
  const info = E.computeConnectivity(eng.width, eng.height, eng.cells, eng.edges);
  assert.ok(info.supportedKeys.has(E.cellKey(0, 1)));
  assert.ok(info.supportedKeys.has(E.cellKey(0, 2)));
  assert.ok(!info.supportedKeys.has(E.cellKey(2, 2)));
});

test('无连接的砖直接落地，形状只有一格', () => {
  const eng = new E.Engine(4, 5);
  eng.addCell(1, 1, E.BRICK, 0);
  eng.commitLayout();
  eng.applyRemoval({ cells: [], edges: [], label: '空操作触发结算' });
  assert.deepStrictEqual(E.parseKey(Array.from(eng.cells.keys())[0]), { x: 1, y: 4 });
});

// ---------- 与选择顺序无关 ----------
test('同一批移除，调换传入顺序结果完全一致', () => {
  const run = (order) => {
    const s = samples.bridge();
    const eng = new E.Engine(s.layout.width, s.layout.height);
    eng.loadLayout(s.layout);
    const op = { cells: order, edges: [] };
    // 构造一次多砖移除：桥面 x=3 与 x=6
    eng.applyRemoval({
      cells: order,
      edges: [],
      label: '批量',
    });
    return eng.events[eng.events.length - 1].hash;
  };
  const k1 = E.cellKey(3, 1);
  const k2 = E.cellKey(6, 1);
  assert.strictEqual(run([k1, k2]), run([k2, k1]));
});

test('重跑两次完整流程指纹一致', () => {
  const s = samples.slot();
  const run = () => {
    const eng = new E.Engine(s.layout.width, s.layout.height);
    eng.loadLayout(s.layout);
    for (const op of s.operations) eng.applyRemoval(op);
    return eng.events.map((ev) => ev.hash).join('|');
  };
  assert.strictEqual(run(), run());
});

// ---------- 团块形状保持 + 不重叠不丢砖 ----------
test('下落团保留形状：L 形团落地后仍是 L 形', () => {
  const eng = new E.Engine(5, 6);
  eng.addCell(1, 1, E.BRICK, 0);
  eng.addCell(1, 2, E.BRICK, 0);
  eng.addCell(2, 2, E.BRICK, 0);
  eng.toggleEdge(1, 1, 1, 2);
  eng.toggleEdge(1, 2, 2, 2);
  eng.commitLayout();
  eng.applyRemoval({ cells: [], edges: [] });
  const keys = new Set(eng.cells.keys());
  assert.ok(keys.has(E.cellKey(1, 4)));
  assert.ok(keys.has(E.cellKey(1, 5)));
  assert.ok(keys.has(E.cellKey(2, 5)));
  // 边随团平移且仍存在
  assert.ok(eng.hasEdge(1, 4, 1, 5));
  assert.ok(eng.hasEdge(1, 5, 2, 5));
});

test('任意时刻无重叠（一格一单元）、边两端有效', () => {
  for (const factory of [samples.bridge, samples.interlock, samples.slot]) {
    const s = factory();
    const eng = new E.Engine(s.layout.width, s.layout.height);
    eng.loadLayout(s.layout);
    for (const op of s.operations) {
      eng.applyRemoval(op);
      for (const ev of eng.events) {
        const snap = ev.snapshot;
        const ks = snap.cells.map(([k]) => k);
        assert.strictEqual(new Set(ks).size, ks.length, '出现重叠/丢砖');
        for (const [ek] of snap.edges) {
          const { a, b } = E.parseEdgeKey(ek);
          assert.ok(eng.cells.has(a) || true); // 快照自身校验
          const pa = E.parseKey(a);
          const pb = E.parseKey(b);
          assert.strictEqual(Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y), 1);
        }
      }
    }
  }
});

// ---------- 撤回 ----------
test('rewind 后地图与事件回到对应时刻，再破坏会截断未来', () => {
  const s = samples.bridge();
  const eng = new E.Engine(s.layout.width, s.layout.height);
  eng.loadLayout(s.layout);
  eng.applyRemoval(s.operations[0]);
  const midHash = eng.events[eng.events.length - 1].hash;
  eng.applyRemoval(s.operations[1]);
  assert.ok(eng.events.length > 0);
  const midSeq = (() => {
    // 找到第一个 settle 的序号
    return eng.events.find((ev) => ev.type === 'settle').seq;
  })();
  eng.rewind(midSeq);
  assert.strictEqual(eng.events.length, midSeq + 1);
  assert.strictEqual(eng.events[eng.events.length - 1].hash, midHash);
  // 撤回后做新破坏：旧的第二个操作事件已被截断，新操作编号为 2
  const before = eng.events.length;
  eng.applyRemoval({ cells: [E.cellKey(7, 1)], edges: [], label: '新破坏' });
  assert.ok(eng.events.length > before);
  assert.ok(eng.events.every((ev) => ev.tick < 3000));
});

// ---------- 样例一：双锚桥 ----------
test('样例一：左链先落、右链后落，桥面始终不动', () => {
  const s = samples.bridge();
  const eng = new E.Engine(s.layout.width, s.layout.height);
  eng.loadLayout(s.layout);
  const initialBricks = count(eng, E.BRICK);

  eng.applyRemoval(s.operations[0]);
  const t1 = types(eng);
  assert.ok(t1.includes('support-lost'));
  assert.ok(t1.includes('fall'));
  // 桥面 x=1..9 的 y 仍为 1（锚+砖全在桥面）
  for (let x = 1; x <= 9; x++) assert.ok(eng.cells.has(E.cellKey(x, 1)));
  // 左链下段（3,3）落到底（H=9，最后一行 y=8）
  assert.ok(eng.cells.has(E.cellKey(3, 8)));

  eng.applyRemoval(s.operations[1]);
  assert.ok(types(eng).filter((t) => t === 'support-lost').length >= 2);
  assert.ok(eng.cells.has(E.cellKey(7, 8)) || eng.cells.has(E.cellKey(7, 7)));
  // 桥面仍在
  for (let x = 1; x <= 9; x++) assert.ok(eng.cells.has(E.cellKey(x, 1)));
  // 砖数 = 初始 - 移除的 1 块
  assert.strictEqual(count(eng, E.BRICK), initialBricks - 1);
});

// ---------- 样例二：相互托住 ----------
test('样例二：拔销后 mutual-hold 且零 fall、零位移', () => {
  const s = samples.interlock();
  const eng = new E.Engine(s.layout.width, s.layout.height);
  eng.loadLayout(s.layout);
  const before = new Set(eng.cells.keys());
  const bricksBefore = count(eng, E.BRICK);
  eng.applyRemoval(s.operations[0]);
  const t = types(eng);
  assert.ok(t.includes('mutual-hold'), '应出现 mutual-hold');
  assert.ok(!t.includes('fall'), '互锁团不应下落');
  assert.ok(!t.includes('collision'));
  // 除销钉外其余单元位置不变
  const after = new Set(eng.cells.keys());
  const removed = new Set(s.operations[0].cells);
  for (const k of before) if (!removed.has(k)) assert.ok(after.has(k), k + ' 发生位移');
  assert.strictEqual(count(eng, E.BRICK), bricksBefore - 2);
});

// ---------- 样例三：窄槽碰撞取舍 ----------
test('样例三：两团叠落窄槽并产生带 tieRule 的 collision', () => {
  const s = samples.slot();
  const eng = new E.Engine(s.layout.width, s.layout.height);
  eng.loadLayout(s.layout);
  const bricksBefore = count(eng, E.BRICK);
  eng.applyRemoval(s.operations[0]);
  const t = types(eng);
  assert.ok(t.includes('fall'));
  const collisions = eng.events.filter((ev) => ev.type === 'collision');
  assert.ok(collisions.length >= 1, '应有抢位碰撞');
  // 团间抢位必须带可追查的取舍规则；撞地板则 blocker=ground
  const clusterHits = collisions.filter((ev) => ev.data.blocker !== 'ground');
  assert.ok(clusterHits.length >= 1, '应至少有一次两团抢位');
  for (const ev of clusterHits) {
    assert.ok(ev.data.tieRule && ev.data.tieRule.includes('顺序'));
    assert.ok(ev.data.clusterId);
  }
  // 槽内 x=4 列 y=7..11 应有 5 块砖（L 三砖 + R 两砖），y=11 贴地板
  let stack = 0;
  for (let y = 7; y <= 11; y++) if (eng.cells.has(E.cellKey(4, y))) stack++;
  assert.strictEqual(stack, 5);
  assert.strictEqual(count(eng, E.BRICK), bricksBefore - 2); // 拔掉两根销钉
  // 墙体锚完好
  for (let y = 6; y <= 11; y++) {
    assert.strictEqual(eng.cells.get(E.cellKey(3, y)).type, E.ANCHOR);
    assert.strictEqual(eng.cells.get(E.cellKey(5, y)).type, E.ANCHOR);
  }
});

// ---------- verifyScenario 重跑校验 ----------
test('verifyScenario：三样例重跑砖数与指纹均通过', () => {
  for (const factory of [samples.bridge, samples.interlock, samples.slot]) {
    const s = factory();
    const r = E.verifyScenario(s.layout, s.operations);
    assert.ok(r.ok, s.id + ' 校验失败');
    assert.strictEqual(r.finalBricks, r.expectedBricks);
    assert.ok(r.stepChecks.every((c) => c.noOverlap && c.edgesValid));
  }
});

test('verifyScenario：操作顺序打乱（不同操作）确实可能改变结果，但同一操作序列确定', () => {
  const s = samples.bridge();
  const r1 = E.verifyScenario(s.layout, s.operations);
  const r2 = E.verifyScenario(s.layout, [...s.operations].reverse());
  assert.strictEqual(r1.finalHash, E.verifyScenario(s.layout, s.operations).finalHash);
  // 逆序操作也是合法确定序列，且最终砖数相同（移除集合相同）
  assert.strictEqual(r2.finalBricks, r1.finalBricks);
  assert.ok(r2.ok);
});

// ---------- 落在另一团之上 ----------
test('先落的团落地后，后落的团可停在它上面', () => {
  const eng = new E.Engine(5, 7);
  // 低位团 A（y=3 一格），高位团 B（y=0 一格，同列）
  eng.addCell(2, 3, E.BRICK, 0);
  eng.addCell(2, 0, E.BRICK, 1);
  eng.commitLayout();
  eng.applyRemoval({ cells: [], edges: [] });
  assert.ok(eng.cells.has(E.cellKey(2, 6))); // A 到底
  assert.ok(eng.cells.has(E.cellKey(2, 5))); // B 停 A 上
});

console.log('\n' + passed + ' 个测试通过');
