/* 引擎行为验证：node test.js */
'use strict';
const Engine = require('./engine.js');
const Samples = require('./samples.js');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
}

const [loop, bridge, resupply] = Samples.list;

console.log('样例1：环路（双路冗余）');
{
  const h = Engine.replay(loop.scenario, loop.rounds);
  const st = (i) => h[i].state;
  check('R3 占领后 s 归属A且有补给', st(3).nodes.s.owner === 'A' && st(3).nodes.s.unsupplied === 0);
  check('R4 断一条路，s 不掉线（双路冗余）', st(4).nodes.s.unsupplied === 0 && st(4).nodes.s.owner === 'A');
  check('R4 补给路径改走 m2', (Engine.supplyPath(Engine.computeSupply(st(4)), 'A', 's') || []).join('>') === 'a0>m2>s');
  check('R5 两条路全断，s 断供 1/2 且保留归属', st(5).nodes.s.unsupplied === 1 && st(5).nodes.s.owner === 'A');
  check('R6 连续断供达阈值，s 失效转中立', st(6).nodes.s.owner === 'N' && st(6).nodes.s.unsupplied === 0);
}

console.log('样例2：窄桥（咽喉点易主，同轮重核）');
{
  const h = Engine.replay(bridge.scenario, bridge.rounds);
  const st = (i) => h[i].state;
  check('R1 桥易主后 s1、s2 同轮一起断供 1/2',
    st(1).nodes.s1.unsupplied === 1 && st(1).nodes.s2.unsupplied === 1 &&
    st(1).nodes.s1.owner === 'A' && st(1).nodes.s2.owner === 'A');
  check('R2 双双失效转中立', st(2).nodes.s1.owner === 'N' && st(2).nodes.s2.owner === 'N');
  check('R4 桥上 2v2 同归于尽，g 归属不变', st(4).nodes.g.owner === 'B' && st(4).nodes.g.units.A === 0 && st(4).nodes.g.units.B === 0);
  check('R6 夺回桥点 g 归属A', st(6).nodes.g.owner === 'A');
  check('R8 收复 s2 且当轮接通补给', st(8).nodes.s2.owner === 'A' && st(8).nodes.s2.unsupplied === 0);
  check('R9 收复 s1 且当轮接通补给', st(9).nodes.s1.owner === 'A' && st(9).nodes.s1.unsupplied === 0);
}

console.log('样例3：断供后重新接通（同轮恢复计数清零）');
{
  const h = Engine.replay(resupply.scenario, resupply.rounds);
  const st = (i) => h[i].state;
  check('R1 m 易主，s 断供 1/2 归属仍A', st(1).nodes.s.unsupplied === 1 && st(1).nodes.s.owner === 'A');
  check('R2 夺回 m，s 当轮恢复补给、计数清零', st(2).nodes.s.unsupplied === 0 && st(2).nodes.s.owner === 'A');
  check('R2 事件含“恢复补给”说明', h[2].events.some(e => e.phase === '补给' && e.text.includes('恢复补给')));
  check('R3 路段封锁再次断供 1/2', st(3).nodes.s.unsupplied === 1);
  check('R4 无人救援，s 失效转中立', st(4).nodes.s.owner === 'N');
}

console.log('基地失守：受影响据点同轮重核');
{
  const sc = {
    config: { supplyThreshold: 2 },
    nodes: [
      { id: 'a0', x: 0, y: 0, kind: 'base', baseOf: 'A', owner: 'A', units: {} },
      { id: 's', x: 1, y: 0, kind: 'strong', owner: 'A' },
      { id: 'b0', x: 0, y: 1, kind: 'base', baseOf: 'B', owner: 'B', units: { B: 2 } },
    ],
    edges: [{ a: 'a0', b: 's' }, { a: 'b0', b: 'a0' }],
  };
  const h = Engine.replay(sc, [['B move b0 a0 2', 'B capture a0']]);
  check('A基地被占当轮，s 立即断供 1/2', h[1].state.nodes.s.unsupplied === 1 && h[1].state.nodes.s.owner === 'A');
  check('断供原因标注为基地失守', h[1].events.some(e => e.text.includes('基地失守')));
}

console.log('重放一致性（确定性）');
{
  for (const s of Samples.list) {
    const h1 = Engine.replay(s.scenario, s.rounds);
    const h2 = Engine.replay(s.scenario, s.rounds);
    const same = Engine.stableStringify(h1) === Engine.stableStringify(h2);
    check(`「${s.name}」两次重放结果一致`, same);
  }
  // 导出→读入→重跑，结果一致
  const exported = JSON.stringify({ scenario: resupply.scenario, rounds: resupply.rounds });
  const imported = JSON.parse(exported);
  const a = Engine.replay(resupply.scenario, resupply.rounds);
  const b = Engine.replay(imported.scenario, imported.rounds);
  check('导出/读入后重跑结果一致', Engine.stableStringify(a) === Engine.stableStringify(b));
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
