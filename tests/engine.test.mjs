/* Node 验证：核心碰撞规则、分析器与试玩同引擎一致性、演示关卡可达性。
   运行：node tests/engine.test.mjs （浏览器脚本用全局命名空间，这里用 vm 加载） */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { window: {}, console, Math, JSON, Date };
sandbox.window.JR = sandbox.JR = {};
vm.createContext(sandbox);
for (const f of ['constants.js', 'geometry.js', 'physics.js', 'analyzer.js', 'level.js']) {
  vm.runInContext(readFileSync(join(root, 'js', f), 'utf8'), sandbox, { filename: f });
}
const { JR } = sandbox;

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}

// ---------- 1. 撞头：向上碰到实心障碍底面后速度清零并下落 ----------
{
  console.log('撞头规则');
  const lvl = JR.geom.makeLevel();
  lvl.entities = [
    { id: 'p', type: 'platform', x: 0, y: 200, w: 200, h: 20 },
    { id: 'c', type: 'overhead', x: 0, y: 120, w: 200, h: 20 },
    { id: 's', type: 'start', x: 20, y: 136, w: 40, h: 64 },
  ];
  const params = { ...JR.DEFAULT_PARAMS_A };
  const st = JR.physics.spawnState(lvl, params);
  // 起跳并全程按住
  let bonkSeen = false;
  for (let i = 0; i < 120; i++) {
    const evs = JR.physics.step(lvl, params, st, { left: false, right: false, jumpPressed: i === 0, jumpHeld: i < 13, drop: false });
    if (evs.some((e) => e.kind === 'bonk')) bonkSeen = true;
  }
  assert(bonkSeen, '起跳弧线撞到上方障碍产生 bonk 事件');
  assert(st.y + st.h > 80 && st.y < 200, '撞头后角色停在障碍下方且未穿过障碍');
}

// ---------- 2. 薄平台：从下往上穿过，向下落可接住 ----------
{
  console.log('薄平台规则');
  const lvl = JR.geom.makeLevel();
  lvl.entities = [
    { id: 'thin', type: 'platform', x: 0, y: 236, w: 200, h: 8, oneWay: true },
    { id: 'floor', type: 'platform', x: 0, y: 300, w: 200, h: 20 },
    { id: 's', type: 'start', x: 20, y: 236, w: 40, h: 64 },
  ];
  const params = { ...JR.DEFAULT_PARAMS_A };
  const st = JR.physics.spawnState(lvl, params);
  let crossedUp = false;
  for (let i = 0; i < 40; i++) {
    JR.physics.step(lvl, params, st, { left: false, right: false, jumpPressed: i === 0, jumpHeld: i < 13, drop: false });
    if (st.y + st.h < 150) crossedUp = true;
  }
  assert(crossedUp, '起跳从下方穿过薄平台');
  let landed = false;
  for (let i = 0; i < 120; i++) {
    JR.physics.step(lvl, params, st, { left: false, right: false, jumpPressed: false, jumpHeld: false, drop: false });
    if (st.grounded && st.groundId === 'thin') { landed = true; break; }
  }
  assert(landed, '下落时被薄平台接住并站稳');
}

// ---------- 3. 贴边容差：重叠不足 4px 时滑落 ----------
{
  console.log('贴边容差');
  const lvl = JR.geom.makeLevel();
  lvl.entities = [
    { id: 'p', type: 'platform', x: 100, y: 200, w: 40, h: 16 },
    { id: 's', type: 'start', x: 0, y: 300, w: 40, h: 64 },
  ];
  const params = { ...JR.DEFAULT_PARAMS_A };
  // 角色宽 20：平台左缘 x=100，角色右缘 x+20。
  // 3px 重叠 → 右缘 103 → x=83；4px 重叠 → 右缘 104 → x=84。
  const st = JR.physics.spawnState(lvl, params);
  st.x = 83;
  st.y = 200 - params.height - 4;
  st.vy = 0;
  st.grounded = false;
  st.groundId = null;
  let slipSeen = false;
  for (let i = 0; i < 30; i++) {
    const evs = JR.physics.step(lvl, params, st, { left: false, right: false, jumpPressed: false, jumpHeld: false, drop: false });
    if (evs.some((e) => e.kind === 'edgeSlip')) slipSeen = true;
  }
  assert(slipSeen && !st.grounded, '重叠 3px < 容差 4px：edgeSlip 且不站稳');

  const st2 = JR.physics.spawnState(lvl, params);
  st2.x = 84; // 重叠 4px
  st2.y = 200 - params.height - 4;
  st2.vy = 0;
  st2.grounded = false;
  st2.groundId = null;
  for (let i = 0; i < 30; i++) {
    JR.physics.step(lvl, params, st2, { left: false, right: false, jumpPressed: false, jumpHeld: false, drop: false });
  }
  assert(st2.grounded && st2.groundId === 'p', '重叠 4px = 容差：成功站稳');
}

// ---------- 4. 分析器与试玩同引擎：分析器给的策略手动重放必须落地同一平台 ----------
{
  console.log('分析/试玩一致性');
  const lvl = JR.demo.demoLevel();
  const params = { ...JR.DEFAULT_PARAMS_A };
  const res = JR.analyzer.analyze(lvl, params);
  let checked = 0;
  for (const agg of res.platforms.filter((p) => p.reachable).slice(0, 3)) {
    const { strategy } = agg.bestRun.run;
    const gen = JR.analyzer.makeInputGen(strategy);
    const initial = (() => {
      // 与分析器相同的边缘出生点 + 助跑初速度
      const st = JR.physics.spawnState(lvl, params);
      const start = lvl.entities.find((e) => e.type === 'start');
      st.x = strategy.dir > 0 ? start.x + start.w - params.width - 0.5 : start.x + 0.5;
      st.vx = strategy.dir * params.moveSpeed * strategy.v0;
      st.facing = strategy.dir;
      return st;
    })();
    const replay = JR.physics.simulate(lvl, params, initial, gen);
    const land = (() => {
      for (let i = 1; i < replay.frames.length; i++) if (replay.frames[i].grounded) return replay.frames[i].groundId;
      return null;
    })();
    assert(land === agg.entityId, `策略重放落脚 ${land} 与分析结果 ${agg.entityId} 一致`);
    checked++;
  }
  assert(checked >= 2, `至少验证了 ${checked} 个可达平台的重放一致性`);
}

// ---------- 5. 演示关卡：标准参数可达性与弱弹跳差异 ----------
{
  console.log('演示关卡连通性');
  const lvl = JR.demo.demoLevel();
  const resA = JR.analyzer.analyze(lvl, { ...JR.DEFAULT_PARAMS_A });
  const resB = JR.analyzer.analyze(lvl, { ...JR.DEFAULT_PARAMS_B });
  console.log('    A 可达:', [...resA.reachableIds].join(','), ' 撞头阻挡:', [...resA.bonkIds].join(','));
  console.log('    B 可达:', [...resB.reachableIds].join(','), ' 撞头阻挡:', [...resB.bonkIds].join(','));
  assert(resA.reachableIds.size >= 3, '标准参数至少可达 3 个平台（矮阶/低顶后/远台之一）');
  const diff = JR.analyzer.diffConnectivity(lvl, resA, resB);
  assert(diff.lost.length >= 1, `弱弹跳参数丢失至少 1 处连通性（实际丢失 ${diff.lost.length}）`);

  // 低顶：必须存在"幽灵能到、真实撞头"的阻挡
  const totalBonkRuns = resA.runs.filter((r) => r.real.events.some((e) => e.kind === 'bonk')).length;
  assert(totalBonkRuns > 0, `低顶障碍造成 ${totalBonkRuns} 条策略撞头`);

  // 目标平台（demoLevel 已把远台设为 targetId）
  const judgeA = JR.analyzer.judgeTarget(lvl, { ...JR.DEFAULT_PARAMS_A }, resA);
  const judgeB = JR.analyzer.judgeTarget(lvl, { ...JR.DEFAULT_PARAMS_B }, resB);
  console.log('    目标判定 A:', judgeA.ok ? '可达' : judgeA.reason, ' B:', judgeB.ok ? '可达' : judgeB.reason);
  assert(judgeA.ok, '标准参数对远台目标给出可行跳法');
  assert(!judgeB.ok, '弱弹跳参数对远台目标给出跳不过原因：' + judgeB.text);
}

// ---------- 6. 确定性：同输入两次模拟轨迹完全相同 ----------
{
  console.log('确定性');
  const lvl = JR.demo.demoLevel();
  const params = { ...JR.DEFAULT_PARAMS_A };
  const gen = (i) => ({ left: false, right: i >= 10, jumpPressed: i === 10, jumpHeld: i >= 10 && i < 22, drop: false });
  const r1 = JR.physics.simulate(lvl, params, JR.physics.spawnState(lvl, params), gen);
  const r2 = JR.physics.simulate(lvl, params, JR.physics.spawnState(lvl, params), gen);
  assert(JSON.stringify(r1.frames) === JSON.stringify(r2.frames), '相同输入两次模拟逐帧一致');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
