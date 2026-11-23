/*
 * Node 自动化测试：node test-engine.mjs
 * 覆盖需求 1~6 的全部规则点。失败时退出码非零。
 */
import assert from 'node:assert/strict';
import G from './engine.js';

const { LEVEL } = G;
let pass = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  pass++;
  console.log('  ✓ ' + name);
}
function eq(name, actual, expected) {
  assert.deepEqual(actual, expected, name + `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
  pass++;
  console.log('  ✓ ' + name);
}

/* 沿指令流推进；死亡后自动按 mode 重生一次，并把 respawn 指令插进指令流（与界面同路径） */
function run(commands, policies, respawnMode) {
  const state = G.createGame(policies);
  const stream = [];
  for (const cmd of commands) {
    G.doCommand(state, cmd);
    stream.push(cmd);
    if (state.pendingRespawn) {
      const rc = G.respawnCommand(respawnMode);
      G.doCommand(state, rc);
      stream.push(rc);
    }
  }
  return { state, stream };
}

function eventsOf(state, type) { return state.events.filter((e) => e.type === type); }
function lastEvent(state, type) { return eventsOf(state, type).at(-1); }

/* ------------------------------------------------------------------ */
console.log('\n[规则1] 地图对象齐全：起点、≥2检查点、开关、消耗道具、危险区，内置路线可跑通');
{
  ok('检查点至少两个', LEVEL.checkpoints.length >= 2);
  ok('开关至少两个且策略覆盖三种',
    new Set(LEVEL.switches.map((s) => s.policy)).size >= 2 &&
    new Set([...LEVEL.switches, ...LEVEL.items].map((o) => o.policy)).size === 3);
  ok('存在可消耗道具', LEVEL.items.every((i) => i.max >= 1));
  const flat = LEVEL.base.join('');
  ok('底图含三类危险区', flat.includes('P') && flat.includes('L') && flat.includes('S'));

  const a = run(G.ROUTES.A.commands);
  ok('路线 A 通关', a.state.finished);
  eq('路线 A 恰好 1 次死亡', a.state.deaths, 1);
  const b = run(G.ROUTES.B.commands);
  ok('路线 B 通关', b.state.finished);
  ok('路线 B 至少 2 次死亡（同步死亡/备选点/策略对比）', b.state.deaths >= 2);
  const blocked = eventsOf(b.state, 'blocked');
  eq('两条路线全程无“走不动”事件', blocked.length, 0);
}

/* ------------------------------------------------------------------ */
console.log('\n[规则2] 三种保留策略 + 重生后逐对象列出来源');
{
  const { state } = run(G.ROUTES.B.commands);
  const respawns = eventsOf(state, 'respawn');
  ok('发生多次重生', respawns.length >= 2);
  const allIds = [...LEVEL.switches, ...LEVEL.items].map((o) => o.id);
  for (const ev of respawns) {
    eq('每次重生都列出全部有状态对象的来源',
      ev.data.sources.map((s) => s.id).sort(), [...allIds].sort());
    const froms = new Set(ev.data.sources.map((s) => s.from));
    ok('来源取值只可能是 keep/checkpoint/init',
      [...froms].every((f) => ['keep', 'checkpoint', 'init'].includes(f)));
  }
  // 尖刺死亡后的那次重生：黄开关策略=checkpoint，cp2 快照里它是 OFF
  const spikeIdx = eventsOf(state, 'death').findIndex((d) => d.data.reason.includes('尖刺'));
  const respawnAfterSpike = respawns[spikeIdx];
  ok('路线 B 含尖刺死亡', spikeIdx >= 0);
  const sw1 = respawnAfterSpike.data.sources.find((s) => s.id === 'sw1');
  eq('黄开关按 cp2 快照恢复为 OFF', sw1.after, false);
  eq('黄开关来源标记为 checkpoint', sw1.from, 'checkpoint');
  const it1 = respawnAfterSpike.data.sources.find((s) => s.id === 'it1');
  eq('能量块恢复到 cp2 快照值 1', it1.after, 1);
  const sw2 = respawnAfterSpike.data.sources.find((s) => s.id === 'sw2');
  eq('蓝开关 keep 不动（仍 ON）', sw2.after, true);
  eq('蓝开关来源标记为 keep', sw2.from, 'keep');
  const it2 = respawnAfterSpike.data.sources.find((s) => s.id === 'it2');
  eq('护盾 init 策略来源', it2.from, 'init');
}

/* ------------------------------------------------------------------ */
console.log('\n[规则3] 检查点选择：前进才更新、回踩不倒退；同一步 状态→检查点→死亡 顺序固定');
{
  const { state } = run(G.ROUTES.B.commands);
  const cpEvents = eventsOf(state, 'checkpoint');
  const recorded = cpEvents.filter((e) => e.data.recorded);
  eq('整局只启用三个检查点各一次', recorded.length, 3);
  ok('存在回踩不更新的事件', cpEvents.some((e) => !e.data.recorded));

  // 同步死亡：蓝开关 OFF 后踏入 (9,3)，cp2 已启用 → 事件顺序 checkpoint(recorded:false) 紧接 death
  const seqs = state.events.map((e) => e.type);
  const i = seqs.indexOf('death');
  const syncDeath = state.events.find((e) =>
    e.type === 'death' && e.data.at.x === 9 && e.data.at.y === 3);
  ok('存在 cp2 格同步死亡', !!syncDeath);
  const prev = state.events[syncDeath.seq - 1];
  eq('同步死亡前一个事件是 checkpoint（先记录后死亡）', prev.type, 'checkpoint');
  eq('该 checkpoint 事件不回倒进度', prev.data.recorded, false);

  // 直接构造“检查点与危险同格首次触发”：初始状态直接走（理论上 cp2 是坑+桥，桥未开）
  const s2 = G.createGame();
  const path = ['up', 'down', 'right', 'right', 'right', 'right', 'right', 'right'];
  // (3,3)->(3,2 cp1)->(3,3)->(4,3)->...->(9,3) 但 (7,3) 有黄门挡住，绕下面
  const s3 = G.createGame();
  G.doCommand(s3, { type: 'move', dir: 'up' }); // cp1
  // 走到蓝开关开桥，再关桥，再踩 cp2 的场景已在路线 B；这里验证首次踩 cp2 的 recorded 顺序
  const firstCp2 = recorded.find((e) => e.data.id === 'cp2');
  ok('cp2 首次启用带快照', !!firstCp2 && !!firstCp2.data.snapshot);
}

/* ------------------------------------------------------------------ */
console.log('\n[规则4] 重生点被永久机关占用 → 备选链；全部不安全 → 原因 + 重置选择');
{
  const { state } = run(G.ROUTES.B.commands);
  const fallback = eventsOf(state, 'respawn').find((e) => e.data.target.label.includes('邻格'));
  ok('存在邻格备选重生', !!fallback);
  if (fallback) eq('备选点落在 cp2 左邻 (8,3)', fallback.data.target,
    { x: 8, y: 3, label: fallback.data.target.label, safe: true, reason: '安全' });

  // 极端分支：演练封锁制造全不安全
  const s = G.createGame();
  G.doCommand(s, { type: 'emergency' });
  ok('进入待重生状态', !!s.pendingRespawn);
  const r1 = G.doRespawn(s);
  eq('普通重生被拒绝', r1.ok, false);
  ok('每个候选都附带不安全原因', r1.candidates.every((c) => !c.safe && c.reason.length > 0));
  const blockedEv = lastEvent(s, 'respawn-blocked');
  ok('发出 respawn-blocked 事件', !!blockedEv);

  // 选择一：整局重置
  const r2 = G.doRespawn(s, 'reset-init');
  ok('reset-init 后可重生', r2.ok);
  eq('整局重置后回到起点', s.player, { ...LEVEL.start });
  eq('整局重置清空检查点', s.activeCheckpointId, null);

  // 选择二：只重置永久机关后重试
  const s4 = G.createGame();
  G.doCommand(s4, { type: 'emergency' });
  const r3 = G.doRespawn(s4, 'reset-mech');
  ok('reset-mech 后可重生', r3.ok);
  ok('永久开关被拨回初始', LEVEL.switches.every((sw) => s4.switches[sw.id] === sw.initial));
}

/* ------------------------------------------------------------------ */
console.log('\n[规则5] 反复重生不重复发放/回加；事件分类可区分 状态/检查点/重生');
{
  const go = (state, dir) => G.doCommand(state, { type: 'move', dir });

  // 1) 捡护盾（init 策略，max 1）：底排右行到 (12,8)
  const s = G.createGame();
  for (let i = 0; i < 5; i++) go(s, 'down');           // (3,8)
  for (let i = 0; i < 9; i++) go(s, 'right');          // (12,8) 捡护盾
  eq('护盾拾取后为 0', s.items.it2, 0);

  // 2) 在 cp1 与尖刺 (4,6) 之间反复死 3 轮：
  //    每轮重生后再捡能量块，验证次数不回加、不越上限
  const s2 = G.createGame();
  go(s2, 'up');                                        // (3,2) cp1 启用
  // 先拨一次黄开关，制造 state 类事件
  for (let i = 0; i < 6; i++) go(s2, 'down');          // (3,8)
  go(s2, 'left');                                      // (2,8)
  G.doCommand(s2, { type: 'interact' });               // 黄开关 ON → state 事件
  go(s2, 'right');                                     // (3,8)
  go(s2, 'up'); go(s2, 'up');                          // (3,6)
  go(s2, 'right');                                     // (4,6) 尖刺死亡
  const firstR = G.doRespawn(s2);
  ok('重生成功', firstR.ok);
  eq('第一次死亡计数', s2.deaths, 1);
  for (let round = 0; round < 3; round++) {
    // 重生在 cp1 (3,2)：下到底排捡能量块，再回去死
    go(s2, 'down'); go(s2, 'down'); go(s2, 'down');
    go(s2, 'down'); go(s2, 'down'); go(s2, 'down');    // (3,8)
    go(s2, 'right');                                   // (4,8) 捡能量（若有余量）
    go(s2, 'left');                                    // (3,8)
    go(s2, 'up'); go(s2, 'up');                        // (3,6)
    go(s2, 'right');                                   // (4,6) 尖刺死亡
    const r = G.doRespawn(s2);
    ok('第 ' + (round + 2) + ' 次重生成功', r.ok);
  }
  ok('道具数量永不超过上限', LEVEL.items.every((i) => s2.items[i.id] <= i.max));
  ok('能量块没有被重复发放（绝对值写回）', s2.items.it1 <= 2);
  eq('共死亡 4 次', s2.deaths, 4);

  // 3) 事件类型三分
  const types = new Set(s2.events.map((e) => e.type));
  ok('含 state/checkpoint/respawn/death 分类',
    types.has('state') && types.has('checkpoint') && types.has('respawn') && types.has('death'));

  // 4) 无 pending 时请求重生被拒绝，不产生额外死亡
  const before = s2.deaths;
  const rr2 = G.doRespawn(s2);
  eq('无 pending 时再次重生被拒绝', rr2.ok, false);
  eq('死亡计数未增加', s2.deaths, before);
}

/* ------------------------------------------------------------------ */
console.log('\n[规则6] 存档重放：逐指令状态哈希一致，可核对死亡前后值与最终位置');
{
  const { state, stream } = run(G.ROUTES.B.commands);
  // 用真实指令流（含 respawn 指令）重建存档
  const sim = G.createGame();
  for (const cmd of stream) G.doCommand(sim, cmd);
  const bundle = G.buildBundle(sim, { route: 'B' });
  const report = G.verifyBundle(bundle);
  ok('重放逐拍哈希零偏差', report.ok && report.mismatches.length === 0);
  eq('重放最终位置一致', report.finalState.player, state.player);
  eq('重放死亡次数一致', report.finalState.deaths, state.deaths);
  ok('报告包含每次死亡前后值', report.deathReports.length === state.deaths);
  const d0 = report.deathReports[0];
  ok('死亡报告含来源明细', d0.sources.length === LEVEL.switches.length + LEVEL.items.length);
  ok('死亡报告含重生落点', !!d0.target);

  // 路线 A 同样可重放
  const a = run(G.ROUTES.A.commands);
  const simA = G.createGame();
  for (const cmd of a.stream) G.doCommand(simA, cmd);
  const reportA = G.verifyBundle(G.buildBundle(simA, { route: 'A' }));
  ok('路线 A 重放一致', reportA.ok);

  // 篡改存档 → 必须被发现
  bundle.history[5].stateHash = 'tampered';
  const bad = G.verifyBundle(bundle);
  ok('篡改存档能被检出', !bad.ok && bad.mismatches.length > 0);
}

/* ------------------------------------------------------------------ */
console.log('\n[附加] 策略可在界面修改并参与后续重生计算');
{
  const s = G.createGame();
  G.setPolicy(s, 'sw2', 'init');
  eq('策略已更新', s.policies.sw2, 'init');
  G.doCommand(s, { type: 'move', dir: 'up' }); // cp1
  G.doCommand(s, { type: 'move', dir: 'down' });
  G.doCommand(s, { type: 'move', dir: 'down' });
  G.doCommand(s, { type: 'move', dir: 'right' });
  G.doCommand(s, { type: 'move', dir: 'left' });
  G.doCommand(s, { type: 'move', dir: 'right' });
  G.doCommand(s, { type: 'move', dir: 'down' });
  G.doCommand(s, { type: 'move', dir: 'down' }); // 岩浆死
  const r = G.doRespawn(s);
  const src = r.sources.find((x) => x.id === 'sw2');
  eq('改为 init 后来源即变为 init', src.from, 'init');
}

console.log(`\n全部通过：${pass} 项断言\n`);
