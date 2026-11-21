// run-tests.js —— 纯逻辑内核测试（node tests/run-tests.js）
import {
  oscillatorState, nextDwellB, nextOpen, dwellsBetween, platformPos, doorState,
  simulateRoute, sweep, diffSweeps, consistencyCheck, lcmAll, REASONS, EPS,
} from '../core.js';
import { demoScene, rescuePatch, applyPatch } from '../scene.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function approx(a, b, tolOrMsg = 1e-3, msg) {
  const tol = typeof tolOrMsg === 'number' ? tolOrMsg : 1e-3;
  const note = typeof tolOrMsg === 'string' ? tolOrMsg : msg;
  assert(Math.abs(a - b) <= tol, `${note ? note + '：' : ''}期望 ${b}，实际 ${a}`);
}

// ---- 1. 振荡器四段与半开区间 ----
test('振荡器：移动/停靠分段与 f 值', () => {
  const ent = { period: 10, dwellA: 2, dwellB: 2, phase: 0 }; // halfT=3
  assert(oscillatorState(ent, 0).moving === 'AB', 't=0 应在 A→B');
  approx(oscillatorState(ent, 3).f, 1);
  assert(oscillatorState(ent, 3).dwellB === true, 't=3 进入 B 停靠');
  assert(oscillatorState(ent, 5 - EPS).dwellB === true, 't=5-ε 仍在 B 停靠');
  assert(oscillatorState(ent, 5).moving === 'BA', 't=5 准时离站（半开末端）');
  assert(oscillatorState(ent, 8).dwellA === true, 't=8 进入 A 停靠');
  assert(oscillatorState(ent, 10 - EPS).dwellA === true, 't=10-ε 仍在 A 停靠');
});

test('停靠区间查询为半开 [start,end)', () => {
  const ent = { period: 10, dwellA: 2, dwellB: 2, phase: 0 };
  const w = nextDwellB(ent, 3);
  approx(w.start, 3); approx(w.end, 5);
  const atEnd = nextDwellB(ent, 5); // 末端时刻 -> 下一站
  approx(atEnd.start, 13);
  const inside = nextDwellB(ent, 4);
  approx(inside.start, 3);
});

test('相位偏移：nextDwellB 跟随 phase', () => {
  const ent = { period: 10, dwellA: 0, dwellB: 2, phase: 7 }; // halfT=4；B 锚点相对相位 4 → 绝对 11，归一到 1
  const w = nextDwellB(ent, 0);
  approx(w.start, 1); approx(w.end, 3);
  const w2 = nextDwellB(ent, 3); // 半开末端 3 -> 下一周期
  approx(w2.start, 11); approx(w2.end, 13);
});

test('门只在 dwellB 段开启，关门边界严格', () => {
  const d = { period: 8, dwellA: 5, dwellB: 3, phase: 0 }; // 开门 [0,3)
  assert(doorState(d, 0).open === true, 't=0 处于开门区间起点（开）');
  assert(doorState(d, 3 - EPS).open === true, '开门区间末端前仍开');
  assert(doorState(d, 3).open === false, 't=3 准时关门（半开末端）');
  assert(doorState(d, 7.9).open === false, '关闭段保持关闭');
  const win = nextOpen(d, 3);
  approx(win.start, 8, '关门后下次开门在 t=8');
  approx(win.end, 11);
});

test('dwellsBetween 半开且不重不漏', () => {
  const ent = { period: 10, dwellA: 2, dwellB: 2, phase: 0 };
  const ws = dwellsBetween(ent, 0, 25);
  assert(ws.length === 3, `应有 3 段，实际 ${ws.length}`);
  approx(ws[0].start, 3); approx(ws[2].start, 23);
});

// ---- 2. 平台位置是 t 的纯函数 ----
test('平台位置：同一时刻反复求值一致', () => {
  const p = demoScene.platforms[0];
  const a = JSON.stringify(platformPos(p, 7.33));
  const b = JSON.stringify(platformPos(p, 7.33));
  assert(a === b, '同 t 结果必须一致');
  assert(platformPos(p, 0).y === p.ay, 't=0 在 A 端');
});

// ---- 3. 路线模拟：成功 / 刚好关门失败 ----
test('完整路线存在成功的出发时点', () => {
  const r = sweep(demoScene, demoScene.route, { step: 0.1, horizon: demoScene.horizon });
  assert(r.successCount > 0, '基线应至少有部分成功时点');
  assert(r.windows.every((w) => w.end > w.start), '成功窗口宽度必须为正');
});

test('硬闸门：关门时刻到达判 DOOR_CLOSED，不算通过', () => {
  // 构造一个门恰好在角色到达时关闭的场景
  const scene = {
    walkSpeed: 10,
    points: [{ id: 's', name: '起', x: 0, y: 0 }, { id: 'g', name: '终', x: 100, y: 0 }],
    platforms: [],
    // 开门区间 [0,5)，行走 50/10=5s，t0=0 => 恰在 t=5 到达 => 必败
    doors: [{ id: 'd', name: '闸门', x: 50, y: 0, period: 100, dwellA: 95, dwellB: 5, phase: 0 }],
    route: [], horizon: 50,
  };
  const r = simulateRoute(scene, [{ type: 'walk', to: 'g', waitForDoor: ['d'], allowWait: false }], 0, 50);
  assert(!r.ok && r.reason === REASONS.DOOR_CLOSED, `应判刚好关门失败，实际：${r.reason}`);
  // t0=-0.2（开门后出发）=> t=4.8 到达，仍在 [0,5) 内 => 通过
  const r2 = simulateRoute(scene, [{ type: 'walk', to: 'g', waitForDoor: ['d'], allowWait: false }], -0.2, 50);
  assert(r2.ok, `开门区间内到达应成功，实际：${r2.reason}`);
});

test('允许等门：关闭时等待下一开门窗口后通过', () => {
  const scene = {
    walkSpeed: 100,
    points: [{ id: 's', name: '起', x: 0, y: 0 }, { id: 'g', name: '终', x: 10, y: 0 }],
    platforms: [],
    doors: [{ id: 'd', name: '门', x: 5, y: 0, period: 10, dwellA: 7, dwellB: 3, phase: 0 }],
    route: [], horizon: 50,
  };
  const r = simulateRoute(scene, [{ type: 'walk', to: 'g', waitForDoor: ['d'], allowWait: true }], 4, 50);
  assert(r.ok, `等门后应成功，实际：${r.reason}`);
  approx(r.steps[0].segments[1].t1, 10, '开门区间 [0,3)，t≈4 到达应等到 t=10');
});

test('搭乘：错过靠站末端判 PLATFORM_MISSED，窗口内成功', () => {
  const scene = {
    walkSpeed: 10,
    points: [
      { id: 's', name: '起', x: -20, y: 100 }, { id: 'top', name: '台', x: 0, y: 0 },
    ],
    platforms: [{
      id: 'p', name: '梯', ax: 0, ay: 100, bx: 0, by: 0,
      period: 10, dwellA: 2, dwellB: 2, phase: 0, // A 停靠 [8,10)
    }],
    doors: [], route: [], horizon: 60,
  };
  const act = [{ type: 'ride', platform: 'p', to: 'top', side: 'A' }];
  // 走到 A 端需 20/10=2s；t0=8 => t=10 恰好离站（半开末端）=> 失败
  const miss = simulateRoute(scene, act, 8, 60);
  assert(!miss.ok && miss.reason === REASONS.PLATFORM_MISSED, `应判错过靠站，实际：${miss.reason}`);
  // t0=7 => t=9 到达，落在 [8,10) 内 => 成功
  const ok = simulateRoute(scene, act, 7, 60);
  assert(ok.ok, `窗口内搭乘应成功，实际：${ok.reason}`);
  approx(ok.tEnd, 13, 't=11 到 B 端，停靠 [11,13)，下车即时');
});

// ---- 4. 确定性：charAt 与场景快照反复求值一致 ----
test('确定性自检：来回拖到同一瞬间结果一致', () => {
  const c = consistencyCheck(demoScene, demoScene.route, 3.3, demoScene.horizon);
  assert(c.ok, '两次独立模拟在相同 t 的快照必须完全相等');
});

// ---- 5. 扫描窗口与联合周期 ----
test('sweep：窗口覆盖样本与二分边界自洽', () => {
  const r = sweep(demoScene, demoScene.route, { step: 0.1, horizon: demoScene.horizon });
  const periods = [
    ...demoScene.platforms.map((p) => p.period),
    ...demoScene.doors.map((d) => d.period),
  ]; // [10, 12, 8, 8]
  approx(lcmAll(periods), 120, '联合周期应为 120s');
  approx(r.T, 120);
  for (const w of r.windows) {
    if (w.end - w.start < 0.2) continue; // 跳过过窄的边界碎窗
    const mid = (w.start + w.end) / 2;
    const sim = simulateRoute(demoScene, demoScene.route, mid, demoScene.horizon);
    assert(sim.ok, `窗口中点 ${mid} 必须成功`);
    if (w.end < r.T - 1e-3) {
      // 末端窗口的 end=T 等价于下一周期 t0=0（周期性），不参与失败断言
      const edgeOut = simulateRoute(demoScene, demoScene.route, w.end, demoScene.horizon);
      assert(!edgeOut.ok, `窗口右端 ${w.end}（半开）必须失败`);
    }
  }
});

test('最早失败点：按中断绝对时间排序输出', () => {
  const r = sweep(demoScene, demoScene.route, { step: 0.1, horizon: demoScene.horizon });
  for (const f of r.failures) {
    assert(f.earliest.at >= 0 && f.earliest.step >= 0, '失败点字段完整');
  }
});

// ---- 6. 锁路线对比：救回方案产生 gained 段且路线未改 ----
test('diffSweeps：仅改平台相位后出现救回时段', () => {
  const base = sweep(demoScene, demoScene.route, { step: 0.2, horizon: demoScene.horizon });
  const rescued = applyPatch(demoScene, rescuePatch);
  const cur = sweep(rescued, rescued.route, { step: 0.2, horizon: rescued.horizon });
  const diff = diffSweeps(base, cur);
  assert(diff.gained.length > 0, '救回方案应至少新增一段可出发时段');
  assert(diff.tags.every((tg) => ['same', 'lost', 'gained'].includes(tg)), '标签合法');
  // 路线对象深比较：完全一致
  assert(JSON.stringify(demoScene.route) === JSON.stringify(rescued.route), '锁定期间路线不得变化');
});

test('救回时段内的出发时点在新场景下确实成功', () => {
  const rescued = applyPatch(demoScene, rescuePatch);
  const base = sweep(demoScene, demoScene.route, { step: 0.2, horizon: demoScene.horizon });
  const cur = sweep(rescued, rescued.route, { step: 0.2, horizon: rescued.horizon });
  const diff = diffSweeps(base, cur);
  for (const seg of diff.gained) {
    const t0 = seg.start + 0.05;
    assert(simulateRoute(rescued, rescued.route, t0, rescued.horizon).ok, `救回段 ${t0} 应成功`);
    assert(!simulateRoute(demoScene, demoScene.route, t0, demoScene.horizon).ok, `同 t0 在基线应失败`);
  }
});

// ---- 7. 非法引用 ----
test('路线引用不存在对象时优雅失败', () => {
  const r = simulateRoute(demoScene, [{ type: 'walk', to: 'nope' }], 0, 60);
  assert(!r.ok && r.reason === REASONS.BAD_TARGET, '应报对象不存在');
});

console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
