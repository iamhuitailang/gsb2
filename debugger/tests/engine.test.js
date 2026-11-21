/* 纯 Node 运行：node tests/engine.test.js */
'use strict';
const path = require('path');
const Engine = require(path.join(__dirname, '..', 'js', 'engine.js'));
// presets.js 是浏览器 UMD，伪造 self 后加载
global.self = global;
require(path.join(__dirname, '..', 'js', 'presets.js'));
const { Presets } = global.ASDebug;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

const TICK = Engine.TICK;

group('1. 确定性 / 可复现', () => {
  const c = Presets.configA();
  const tl = Presets.TIMELINES.movingJump;
  const r1 = Engine.simulate(c, tl);
  const r2 = Engine.simulate(c, tl);
  check('重复仿真帧序列完全一致', JSON.stringify(r1.frames) === JSON.stringify(r2.frames));
  check('重复仿真事件序列完全一致', JSON.stringify(r1.events) === JSON.stringify(r2.events));
  check('任意 tick 定位结果可复现（seek 语义）',
    JSON.stringify(r1.frames[73]) === JSON.stringify(r2.frames[73]));
  check('跨循环边界后第 0 帧仍可复现',
    JSON.stringify(Engine.simulate(c, tl).frames[0]) === JSON.stringify(r1.frames[0]));
  check('总 tick 数 = round(loopSec/TICK)', r1.tickCount === Math.round(tl.loopSec / TICK));
});

group('2. 时间线预处理（含循环边界 release 回绕）', () => {
  const grid = Engine.buildInputGrid({ loopSec: 1, intervals: [{ button: 'b', start: 0, end: 1 }] });
  check('整段按住：tick0 有 press', grid.pressed[0].has('b'));
  check('整段按住：tick0 有回绕的 release', grid.released[0].has('b'));
  check('整段按住：末 tick 仍 held', grid.held[grid.tickCount - 1].has('b'));
  const g2 = Engine.buildInputGrid({ loopSec: 1, intervals: [{ button: 'b', start: 0.1, end: 0.2 }] });
  check('区间中 tick 为 held 且无 press/release', g2.held[9].has('b') && !g2.pressed[9].size);
});

group('3. 优先级与同 tick 多条件命中', () => {
  const c = Presets.configA();
  const tl = {
    loopSec: 2,
    intervals: [
      { button: 'move', start: 0.2, end: 1.0 },
      { button: 'jump', start: 0.2, end: 0.3 }, // 与 move 同 tick 按下
    ],
  };
  const r = Engine.simulate(c, tl);
  const ev = r.events.find((e) => e.type === 'condition-eval' && e.matches.length > 1);
  check('存在同 tick 多条件命中事件', !!ev, r.events.map((e) => e.type));
  check('命中事件列出全部满足条件与优先级', ev && ev.matches.length >= 2);
  check('按最高优先级选定 jump 切换', ev && ev.winner === c.transitions.find((t) => t.name === '站立→起跳').id);
  check('落败条件被记录', ev && ev.losers.length >= 1);
  check('实际进入 jump 状态', r.frames[ev.tick + 1].state === 'jump');
});

group('4. 移动中起跳：从 walk 进入 jump', () => {
  const r = Engine.simulate(Presets.configA(), Presets.TIMELINES.movingJump);
  const walkTick = r.firstEntry['walk'];
  const jumpTick = r.firstEntry['jump'];
  check('先进入 walk 再进入 jump', walkTick !== undefined && jumpTick > walkTick);
  const tr = r.events.find((e) => e.type === 'transition' && e.to === 'jump');
  check('起跳切换事件存在且源为 walk', tr && tr.from === 'walk', tr);
});

group('5. 过早松键：jump→fall', () => {
  const r = Engine.simulate(Presets.configA(), Presets.TIMELINES.earlyRelease);
  check('进入 fall（早松键坠落）状态', r.firstEntry['fall'] !== undefined);
  const tr = r.events.find((e) => e.type === 'transition' && e.to === 'fall');
  check('fall 由 jump 的 release 条件触发', tr && tr.from === 'jump');
});

group('6. 过渡中请求：丢弃（A） vs 打断/排队（B）', () => {
  // 6a. 混合期打断：A 丢弃，B 打断
  const rA = Engine.simulate(Presets.configA(), Presets.TIMELINES.brakeQueue);
  const rB = Engine.simulate(Presets.configB(), Presets.TIMELINES.brakeQueue);
  check('A 出现 request-discarded', rA.events.some((e) => e.type === 'request-discarded'));
  const disc = rA.events.find((e) => e.type === 'request-discarded');
  check('丢弃事件说明阻挡的活动过渡与剩余混合时间',
    disc && disc.activeTransition && disc.blendRemaining >= 0, disc);
  check('B 同场景出现 blend-interrupted',
    rB.events.some((e) => e.type === 'blend-interrupted'));

  // 6b. 不可打断混合窗口：A 丢弃，B 排队并在窗口结束后受理
  const qA = Engine.simulate(Presets.configA(), Presets.TIMELINES.walkQueue);
  const qB = Engine.simulate(Presets.configB(), Presets.TIMELINES.walkQueue);
  check('A 在落地混合期丢弃移动请求',
    qA.events.some((e) => e.type === 'request-discarded' && e.transitionId));
  check('B 将请求排队（queued 事件）', qB.events.some((e) => e.type === 'queued'));
  const queued = qB.events.filter((e) => e.type === 'queued').map((e) => e.transitionId);
  const accepted = qB.events.filter((e) => e.type === 'transition' && e.source === 'queued');
  check('B 排队请求被受理（source=queued）',
    queued.every((id) => accepted.some((a) => a.transitionId === id)));
  check('B 受理发生在排队之后', accepted[0].tick > qB.events.find((e) => e.type === 'queued').tick);
});

group('7. 打断时从当前视觉姿态继续', () => {
  const r = Engine.simulate(Presets.configB(), Presets.TIMELINES.brakeQueue);
  const intr = r.events.find((e) => e.type === 'blend-interrupted');
  check('记录 blend-interrupted', !!intr);
  if (intr) {
    const f = r.frames[intr.tick];
    check('打断后新混合的起始姿态存在（插值帧）', !!f.pose && Object.keys(f.pose).length > 0);
    check('打断后帧标记 blending', !!f.blending);
    check('打断事件记录被谁打断', !!intr.by);
  }
});

group('8. 排队超时丢弃', () => {
  const c = Presets.configB();
  c.transitions.forEach((t) => { if (t.blockMode === 'queue') t.queueMaxWait = 0.02; });
  const r = Engine.simulate(c, Presets.TIMELINES.walkQueue);
  check('出现 queue-timeout 事件', r.events.some((e) => e.type === 'queue-timeout'));
  const to = r.events.find((e) => e.type === 'queue-timeout');
  check('超时事件带等待时长', to && to.waited >= 0.02, to);
  check('超时后不再被受理',
    !r.events.some((e) => e.type === 'transition' && e.source === 'queued'));
});

group('9. 静态分析：不可达 / 遮蔽 / 悬空引用', () => {
  const lintA = Engine.lintConfig(Presets.configA());
  check('hurt 不可达被检出', lintA.issues.some((i) => i.code === 'unreachable-state' && i.refs[0] === 'hurt'));
  check('正常配置无 shadowed', !lintA.issues.some((i) => i.code === 'shadowed'));

  const lintC = Engine.lintConfig(Presets.configC());
  const sh = lintC.issues.find((i) => i.code === 'shadowed');
  check('configC 检出条件遮蔽', !!sh);
  check('遮蔽指向受害切换与高优先级切换', sh && sh.victim && sh.by);

  const bad = Presets.configA();
  bad.transitions.push({ id: 'x', from: 'idle', to: 'ghost', gates: [], priority: 1, enabled: true, blendDuration: 0.1 });
  const lintBad = Engine.lintConfig(bad);
  check('目标状态不存在被检出', lintBad.issues.some((i) => i.code === 'bad-to'));
  check('空条件被警告', lintBad.issues.some((i) => i.code === 'empty-gates'));
});

group('10. 条件覆盖（subsumption）逻辑', () => {
  check('无条件(always)覆盖无条件', Engine.conditionCovers([{ kind: 'always' }], [{ kind: 'always' }]));
  check('短 minSec 条件覆盖长 minSec', Engine.conditionCovers(
    [{ kind: 'state-age', minSec: 0.1 }], [{ kind: 'state-age', minSec: 0.3 }]));
  check('长 minSec 不覆盖短 minSec', !Engine.conditionCovers(
    [{ kind: 'state-age', minSec: 0.3 }], [{ kind: 'state-age', minSec: 0.1 }]));
  check('按住 move 不覆盖 按下 move（不同触发类型）', !Engine.conditionCovers(
    [{ kind: 'btn-held', button: 'move' }], [{ kind: 'btn-press', button: 'move' }]));
});

group('11. 有限动作播完出口与末帧保持', () => {
  const c = Presets.configA();
  const r = Engine.simulate(c, Presets.TIMELINES.movingJump);
  check('jump 播完经 land 回到 idle',
    r.firstEntry['land'] !== undefined &&
    r.events.some((e) => e.type === 'transition' && e.from === 'land' && e.to === 'idle'));
  // land 是有限动作，末帧 localT=1
  const lastLand = r.frames.filter((f) => f.state === 'land').pop();
  check('有限动作末帧 localT=1', lastLand && lastLand.localT === 1);
});

group('12. 编辑影响面分析', () => {
  const c = Presets.configA();
  const t = c.transitions.find((x) => x.name === '走路→刹停');
  const impact = Engine.impactOfEdit(c, t.id);
  check('影响面包含源/目标状态', impact.states.includes('walk') && impact.states.includes('brake'));
  check('影响面返回失效切换列表（数组）', Array.isArray(impact.dead));
});

group('13. A/B 同输入对比：进入时间存在差异或行为差异', () => {
  const tl = Presets.TIMELINES.brakeQueue;
  const rA = Engine.simulate(Presets.configA(), tl);
  const rB = Engine.simulate(Presets.configB(), tl);
  const diff = JSON.stringify(rA.frames.map((f) => f.state)) !==
    JSON.stringify(rB.frames.map((f) => f.state));
  check('两套配置在该输入下状态轨迹不同', diff);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
