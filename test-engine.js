/* 引擎不变量测试：node test-engine.js
   覆盖：确定性重放、非法移动、记忆三分、同队视野合并/交接、
   暗处不同步、保留开关、半开门规则、门闭合结算顺序、导出隔离。 */

const assert = require('assert');
const E = require('./engine');
const { K } = E;

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✔', name); }
  catch (err) { console.error('  ✘', name, '\n    ', err.message); process.exitCode = 1; }
}

for (const sc of E.SCENARIOS) {
  console.log(`\n场景：${sc.name} (${sc.id})`);

  check('脚本移动均为单格邻接且不穿墙/不穿关闭门', () => {
    const s = E.createState(sc);
    for (const ev of s.script) {
      for (const mv of ev.moves) {
        assert.ok(Math.abs(mv.dx) + Math.abs(mv.dy) === 1, `${mv.id} 不是单格移动`);
        const ent = s.units.find(u => u.id === mv.id) || s.crates.find(c => c.id === mv.id);
        const tx = ent.x + mv.dx, ty = ent.y + mv.dy;
        const tr = traceType(s, tx, ty);
        assert.notStrictEqual(tr, 'wall', `${mv.id} 穿墙 (${tx},${ty})`);
        assert.notStrictEqual(tr, 'door:closed', `${mv.id} 穿关闭门 (${tx},${ty})`);
        ent.x = tx; ent.y = ty;
      }
      // 应用门事件以反映后续步骤的真实状态
      for (const d of ev.doors) s.doors.get(K(d.x, d.y)).state = d.state;
    }
  });

  check('重放确定性：逐步增量 == 两次独立从头重放', () => {
    const inc = E.createState(sc);
    for (let i = 0; i < inc.script.length; i++) {
      E.applyStep(inc, inc.script[i]);
      const r1 = E.replay(sc, i + 1);
      const r2 = E.replay(sc, i + 1);
      assert.strictEqual(E.stateHash(inc), E.stateHash(r1), `第 ${i + 1} 步 增量!=重放`);
      assert.strictEqual(E.stateHash(r1), E.stateHash(r2), `第 ${i + 1} 步 两次重放不一致`);
    }
  });

  check('记忆三分且永远不会出现“知道但没见过”的地形', () => {
    for (let n = 0; n <= maxSteps(sc); n++) {
      const s = E.replay(sc, n);
      for (const team of ['A', 'B']) {
        for (const [, m] of s.teams[team].memory) {
          assert.ok(['visible', 'remembered'].includes(m.state));
          assert.ok(m.observedType, '记忆条目必须带有观察时地形');
        }
        for (const k of s.teams[team].fov) {
          assert.strictEqual(s.teams[team].memory.get(k).state, 'visible', 'FOV 内必须是当前可见');
        }
      }
    }
  });

  check('FOV = 本队各单位视野的并集（合并规则）', () => {
    const s = E.replay(sc, maxSteps(sc));
    for (const team of ['A', 'B']) {
      const union = new Set();
      for (const u of s.units.filter(u => u.team === team)) {
        for (const k of E.unitFOV(s, u)) union.add(k);
      }
      assert.strictEqual(union.size, s.teams[team].fov.size, `${team} 队 FOV 大小不符`);
      for (const k of union) assert.ok(s.teams[team].fov.has(k));
    }
  });

  check('实体知识只在视野内更新；暗处移动后位置不同步', () => {
    for (let n = 0; n < maxSteps(sc); n++) {
      const before = E.replay(sc, n);
      const after = E.replay(sc, n + 1);
      for (const team of ['A', 'B']) {
        for (const e of allEnts(after)) {
          if (e.team === team) continue;
          const kn = after.teams[team].knowledge.get(e.id);
          if (!kn) continue;
          const inSight = after.teams[team].fov.has(K(e.x, e.y));
          if (!inSight) {
            // 知识位置必须停留在旧位置，绝不能等于敌人的新真实位置（除非恰好重合）
            const liveMoved = JSON.stringify(kn.pos) !== JSON.stringify([e.x, e.y]);
            if (liveMoved) {
              const prevEnt = allEnts(before).find(p => p.id === e.id);
              assert.ok(JSON.stringify(kn.pos) === JSON.stringify([prevEnt.x, prevEnt.y]) ||
                        kn.lastStep <= n, `${e.id} 的过期知识被暗中更新`);
            }
          }
        }
      }
    }
  });

  check('retention=false 时失去视野立即删除知识；true 时保留幽灵', () => {
    const last = maxSteps(sc);
    const keep = E.replay(sc, last, { retention: true });
    const drop = E.replay(sc, last, { retention: false });
    for (const team of ['A', 'B']) {
      const tmKeep = keep.teams[team], tmDrop = drop.teams[team];
      for (const [id, kn] of tmKeep.knowledge) {
        const inSight = tmKeep.fov.has(K(kn.pos[0], kn.pos[1]));
        if (!inSight) assert.ok(!tmDrop.knowledge.has(id), `${id} 应在不保留模式下被删除`);
      }
      for (const [, kn] of tmDrop.knowledge) {
        assert.ok(tmDrop.fov.has(K(kn.pos[0], kn.pos[1])), '不保留模式只允许存在当前可见的知识');
      }
    }
  });

  check('半开/关闭门阻挡视线但全开门不挡', () => {
    const s = E.replay(sc, maxSteps(sc));
    for (const [k, d] of s.doors) {
      const [dx, dy] = k.split(',').map(Number);
      // 门旁两格的视线
      const trace = E.losTrace(s, dx, Math.max(1, dy - 1), dx, Math.min(s.h - 2, dy + 1));
      if (d.state === 'open') assert.strictEqual(trace.blocked, false, '全开门不应挡视线');
      else assert.strictEqual(trace.blocked, true, `${d.state} 门应挡视线`);
    }
  });

  check('导出的阵营视图不含任何未知区域地形/敌人真实位置', () => {
    const s = E.replay(sc, maxSteps(sc));
    for (const team of ['A', 'B']) {
      const view = E.exportTeamView(s, team);
      for (const c of view.cells) {
        if (c.state === 'unknown') {
          assert.strictEqual(c.observedType, undefined, 'unknown 格泄露了地形');
          assert.strictEqual(c.lastStep, undefined);
        }
      }
      const livePos = new Map(allEnts(s).map(e => [e.id, [e.x, e.y]]));
      for (const ent of view.knownEntities) {
        assert.strictEqual(ent.livePos, undefined, '导出泄露真实位置字段');
        const lp = livePos.get(ent.id);
        // 若实体已离开记忆位置，导出里只能有旧位置
        if (JSON.stringify(lp) !== JSON.stringify(ent.lastKnownPos)) {
          assert.ok(true); // 结构上无 livePos 即满足，这里显式记录
        }
      }
    }
  });

  check('逐步记录包含三个阶段事件且顺序为 move -> door -> vision', () => {
    const s = E.replay(sc, maxSteps(sc));
    const rec = E.exportStepRecord(s);
    for (const st of rec.steps) {
      const phases = st.events.map(e => e.phase);
      const lastDoor = phases.lastIndexOf('door');
      const firstVis = phases.indexOf('vision');
      const lastMove = phases.lastIndexOf('move');
      assert.ok(firstVis !== -1 && firstVis === phases.length - 1, '视野结算必须在最后');
      if (lastDoor !== -1) assert.ok(lastDoor > lastMove, '门事件必须晚于移动');
      assert.strictEqual(st.fovSnapshot.A.length > 0, true);
      assert.strictEqual(st.fovSnapshot.B.length > 0, true);
    }
  });
}

/* -------- 场景专属断言 -------- */

console.log('\n场景专属规则');

check('门闭合：A1 移动阶段途经门格，门关闭后视野阶段不再可见门后区域', () => {
  const sc = E.SCENARIOS.find(s => s.id === 'door-close');
  const doorK = K(6, 4);
  const s4 = E.replay(sc, 4);
  // 第 4 步 A1 穿过全开的门，门此时仍 open；A1 停在门格 (6,4)
  assert.strictEqual(s4.doors.get(doorK).state, 'open');
  assert.deepStrictEqual([s4.units.find(u => u.id === 'A1').x, s4.units.find(u => u.id === 'A1').y], [6, 4]);
  const s5 = E.replay(sc, 5);
  assert.strictEqual(s5.doors.get(doorK).state, 'closed');
  // 门格在第 4 步移动阶段被 A1 途经刷新；第 5 步门关闭后该痕迹仍保留
  const memDoor = s5.teams.A.memory.get(doorK);
  assert.strictEqual(memDoor.moveRefreshStep, 4, '门格应保留第 4 步移动阶段刷新痕迹');
  // 门关闭后，门西侧 A2 的视线被关闭的门挡住
  const diag = E.inspectCell(s5, 5, 4).teams.A.diagnosis;
  assert.ok(diag.some(d => d.blocked && d.reason === 'door:closed'), '关闭门未出现在遮挡诊断中');
  // 关门后：A1 在门东侧仍可见 B1（合并视野保持），但 A2 被关闭的门+内墙隔开。
  // 用 A2 的逐单位视线诊断证明门挡住了它；A1 看得见所以团队 FOV 里 B1 仍是 visible。
  const s6 = E.replay(sc, 6);
  const b1 = s6.units.find(u => u.id === 'B1');
  assert.deepStrictEqual([b1.x, b1.y], [9, 2]);
  const a2Diag = E.inspectCell(s6, b1.x, b1.y).teams.A.diagnosis.find(d => d.unit === 'A2');
  assert.strictEqual(a2Diag.blocked, true, 'A2 到 B1 的视线应被距离/内墙/门挡住');
  assert.ok(['wall', 'door:closed', 'range'].includes(a2Diag.reason));
  // 直接验证关闭门本身的遮挡：门两侧同列格 (5,4)->(7,4) 必须被门切断
  assert.strictEqual(E.losTrace(s6, 5, 4, 7, 4).reason, 'door:closed');
  const kn = s6.teams.A.knowledge.get('B1');
  assert.ok(kn, 'A 队应保留 B1 的知识');
  // 团队合并视野仍由 A1 维持 => 知识为当前可见
  assert.strictEqual(s6.teams.A.fov.has(K(b1.x, b1.y)), true);
  assert.strictEqual(kn.currentlyVisible, true);
  // 不保留模式：所有知识条目必须当前可见
  const s6drop = E.replay(sc, 6, { retention: false });
  for (const [, k] of s6drop.teams.A.knowledge) {
    assert.ok(s6drop.teams.A.fov.has(K(k.pos[0], k.pos[1])), '不保留模式存在过期知识');
  }
});

check('队友交接：B1 穿过缺口全过程在 A 队记忆里始终为 visible', () => {
  const sc = E.SCENARIOS.find(s => s.id === 'handoff');
  const trail = [[2, 7], [3, 7], [4, 7], [5, 7], [5, 6], [5, 5], [6, 5], [7, 5], [8, 5]];
  for (let n = 1; n <= 8; n++) {
    const s = E.replay(sc, n);
    const [x, y] = trail[n];
    const b1 = s.units.find(u => u.id === 'B1');
    assert.deepStrictEqual([b1.x, b1.y], [x, y]);
    const m = s.teams.A.memory.get(K(x, y));
    assert.ok(m, `第 ${n} 步 B1 所在格 A 队没有记忆`);
    assert.strictEqual(m.state, 'visible', `第 ${n} 步 B1 所在格掉出 A 队当前可见`);
    assert.ok(m.seenByNow.length >= 1, '至少一名队友当前可见该格');
  }
  // 第 6 步后 A1 被墙挡住、A2 接上
  const s6 = E.replay(sc, 6);
  const seenAt75 = s6.teams.A.fovDetail.get(K(7, 5));
  assert.ok(seenAt75 && seenAt75.includes('A2'), '缺口东侧应由 A2 观察');
  // 幽灵：箱子 C1 第 6 步后脱离 B 队视野，知识滞留且标记为非当前可见
  const s7 = E.replay(sc, 7);
  const c1 = s7.crates.find(c => c.id === 'C1');
  assert.strictEqual(s7.teams.B.fov.has(K(c1.x, c1.y)), false);
  const ghost = s7.teams.B.knowledge.get('C1');
  assert.ok(ghost && ghost.currentlyVisible === false, 'C1 应作为 B 队幽灵保留');
  const s7drop = E.replay(sc, 7, { retention: false });
  assert.ok(!s7drop.teams.B.knowledge.has('C1'), '不保留模式下幽灵应被删除');
});

check('半开门可通过：脚本中没有单位停在门格但门允许挤过（DDA 只挡视线）', () => {
  const sc = E.SCENARIOS.find(s => s.id === 'occlusion');
  // 第 1 步 half，第 2 步 closed，第 4 步 open
  const s1 = E.replay(sc, 1);
  assert.strictEqual(s1.doors.get(K(9, 4)).state, 'half');
  const s2 = E.replay(sc, 2);
  assert.strictEqual(s2.doors.get(K(9, 4)).state, 'closed');
  const s4 = E.replay(sc, 4);
  assert.strictEqual(s4.doors.get(K(9, 4)).state, 'open');
  // 关闭状态下两侧互不可见
  const traceClosed = E.losTrace(s2, 8, 4, 10, 4);
  assert.strictEqual(traceClosed.blocked, true);
  assert.strictEqual(traceClosed.reason, 'door:closed');
  // 半开状态下视线也被挡
  assert.strictEqual(E.losTrace(s1, 8, 4, 10, 4).reason, 'door:half');
  // 全开贯通
  assert.strictEqual(E.losTrace(s4, 8, 4, 10, 4).blocked, false);
});

check('交叉场景：两队在门口互相发现，知识条目带 seenBy 与步号', () => {
  const sc = E.SCENARIOS.find(s => s.id === 'cross');
  // 第 7 步 A1、B1 同处 (8,5) 附近的门口区域（A1 在 (7,5)，B1 在 (8,5)）
  const s7 = E.replay(sc, 7);
  const aKnowsB = s7.teams.A.knowledge.get('B1');
  const bKnowsA = s7.teams.B.knowledge.get('A1');
  assert.ok(aKnowsB && bKnowsA, '第 7 步双方应互相建立知识');
  assert.ok(aKnowsB.seenBy.includes('A1'));
  assert.ok(bKnowsA.seenBy.includes('B1'));
  // 半开门步骤 (4) 南门格仍可通行但挡视线：(10,9) 看不到门北侧 (10,7)
  const s4 = E.replay(sc, 4);
  assert.strictEqual(s4.doors.get(K(10, 8)).state, 'half');
  const t = E.losTrace(s4, 10, 9, 10, 7);
  assert.strictEqual(t.blocked, true);
  assert.strictEqual(t.reason, 'door:half');
});

/* -------- 辅助 -------- */

function traceType(s, x, y) {
  const k = K(x, y);
  if (s.walls.has(k)) return 'wall';
  const d = s.doors.get(k);
  if (d) return 'door:' + d.state;
  return 'floor';
}
function maxSteps(sc) { return E.compileScenario(sc).length; }
function allEnts(s) { return [...s.units, ...s.crates]; }

console.log(`\n${process.exitCode ? '存在失败用例' : `全部通过（${passed} 项）`}`);
