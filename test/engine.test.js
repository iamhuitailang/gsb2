// 引擎核心测试：node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAction,
  boardCount,
  cloneState,
  countAt,
  createGame,
  endTurn,
  hashRule,
  previewAction,
} from '../src/engine.js';
import { demoRuleset, demoScript } from '../src/demo.js';
import { checkDrift, loadBundle, makeBundle, replayHistory } from '../src/storage.js';

function fresh() {
  return createGame(structuredClone(demoRuleset));
}
const rs = () => structuredClone(demoRuleset);

test('预览失败时给出具体阻止状态', () => {
  const state = fresh();
  const preview = previewAction(state, demoRuleset, 'a_consume', { cellId: 'rest', marker: 'drop' });
  assert.equal(preview.ok, false);
  assert.match(preview.reason, /安息处.*水滴不足/);
  assert.ok(preview.checks.some((c) => !c.ok && /水滴不足/.test(c.reason)));
});

test('无效行动不消耗本轮次数，有效行动才计数', () => {
  let state = fresh();
  const bad = applyAction(state, demoRuleset, 'a_consume', { cellId: 'rest', marker: 'drop' });
  assert.equal(bad.ok, false);
  assert.equal(bad.state.turn.used['a_consume'] ?? 0, 0);
  assert.equal(bad.state.history.length, 0); // 被阻止的行动不进入可重放历史
  assert.equal(bad.state.log.at(-1).kind, 'blocked');

  const good = applyAction(state, demoRuleset, 'a_place', { cellId: 'src' });
  assert.equal(good.ok, true);
  assert.equal(good.state.turn.used['a_place'], 1);
  assert.equal(good.state.history.length, 1);
});

test('连锁按固定优先级结算且互触发循环被 cap 停止', () => {
  const state = fresh();
  const { state: s1 } = applyAction(state, demoRuleset, 'a_place', { cellId: 'src' });
  // 取料(5) → 蒸发(10) → 顺流(20)：触发顺序固定
  const iEvap = s1.log.findIndex((l) => l.text.includes('规则「蒸发」触发'));
  const iFlow = s1.log.findIndex((l) => l.text.includes('规则「顺流」触发'));
  const iTake = s1.log.findIndex((l) => l.text.includes('规则「取料」触发'));
  assert.ok(iTake < iEvap && iEvap < iFlow);
  // 蒸发消耗水滴 → 凝结放置晶尘
  assert.ok(s1.log.some((l) => l.text.includes('消耗') && l.text.includes('水滴')));
  const condense = s1.log.find((l) => l.text.includes('规则「凝结」触发'));
  assert.ok(condense);
  assert.equal(countAt(s1, 'src', 'dust'), 1);
  assert.equal(countAt(s1, 'src', 'drop'), 0);
  // 顺流/回流各 4 次后被 cap 截断，日志里有明确停止说明
  const flowFires = s1.log.filter((l) => /规则「顺流」触发/.test(l.text)).length;
  const backFires = s1.log.filter((l) => /规则「回流」触发/.test(l.text)).length;
  assert.equal(flowFires, 4);
  assert.equal(backFires, 4);
  assert.ok(s1.log.some((l) => l.kind === 'loop' && l.text.includes('单规则上限')));
  // cap=4 为偶数：最后一次回流后顺流达到上限，余烬停在源火台
  assert.equal(countAt(s1, 'src', 'ember'), 1);
  assert.equal(countAt(s1, 'rest', 'ember'), 0);
});

test('触发顺序改变结果：顺流调到蒸发之前，水滴存活', () => {
  const rules = rs();
  rules.rules.find((r) => r.id === 'r_flow').priority = 5; // 原本 20，提到蒸发(10)之前
  const state = createGame(rules);
  const { state: s1 } = applyAction(state, rules, 'a_place', { cellId: 'src' });
  // 余烬先被顺流带走，蒸发条件不再成立
  assert.ok(s1.log.some((l) => l.text.includes('规则「蒸发」条件不满足')));
  assert.equal(countAt(s1, 'src', 'drop'), 1); // 水滴存活，对比默认顺序下为 0
  assert.equal(boardCount(s1, 'dust'), 1); // 只有初始熔炉的 1 个晶尘，没有凝结出新的
});

test('结束回合只重置 turn 级资源，game 级保留，次数清零', () => {
  let state = fresh();
  state = applyAction(state, demoRuleset, 'a_place', { cellId: 'src' }).state;
  assert.equal(state.poolValues.mana, 1);
  assert.equal(state.poolValues.emberStock, 2);
  assert.equal(state.turn.used['a_place'], 1);
  const next = endTurn(state, demoRuleset);
  assert.equal(next.poolValues.mana, 2); // 每回合重置
  assert.equal(next.poolValues.emberStock, 2); // 整局保留
  assert.deepEqual(next.turn.used, {});
  assert.equal(next.turn.side, 'blue');
  assert.equal(next.turn.index, 1);
});

test('分支隔离：复制出的分支与原状态互不影响', () => {
  let state = fresh();
  const branch = cloneState(state);
  branch.branchTag = 'B';
  const moved = applyAction(branch, demoRuleset, 'a_place', { cellId: 'src' }).state;
  // 原状态未被触碰
  assert.equal(state.history.length, 0);
  assert.equal(countAt(state, 'src', 'ember'), 0);
  // 分支有行动
  assert.equal(moved.history.length, 1);
  // 在分支上再改棋盘不影响原状态
  moved.board.markers['forge'].dust = 99;
  assert.equal(state.board.markers['forge'].dust, 1);
});

test('保存后可快照载入、可重放；规则漂移时拒绝重放并说明原因', () => {
  let state = fresh();
  state = applyAction(state, demoRuleset, 'a_place', { cellId: 'src' }).state;
  const bundle = makeBundle(state, demoRuleset, { name: 'test' });

  // 同规则：重放成功且棋盘一致
  const replay = replayHistory(bundle.state.history, demoRuleset);
  assert.equal(replay.ok, true);
  assert.equal(countAt(replay.state, 'src', 'ember'), 1);

  // 规则漂移：修改一条被触发过的规则
  const changed = rs();
  const evap = changed.rules.find((r) => r.id === 'r_evap');
  evap.cap = 99;
  const drift = checkDrift(bundle, changed);
  assert.equal(drift.compatible, false);
  assert.ok(drift.problems.some((p) => p.level === 'error' && /蒸发.*变更/.test(p.text)));

  const replayed = loadBundle(bundle, changed, 'replay');
  assert.equal(replayed.ok, false);
  assert.match(replayed.reason, /无法直接重放/);

  // 快照模式仍可载入查看
  const snap = loadBundle(bundle, changed, 'snapshot');
  assert.equal(snap.ok, true);
  assert.equal(countAt(snap.state, 'src', 'ember'), 1);
  assert.equal(snap.drift.compatible, false);

  // 删除被引用的规则也要报出来
  const deleted = rs();
  deleted.rules = deleted.rules.filter((r) => r.id !== 'r_evap');
  const d2 = checkDrift(bundle, deleted);
  assert.ok(d2.problems.some((p) => /已被删除/.test(p.text)));

  // 新增一条存档行动从未触发过的规则，不影响该存档的重放校验（哈希按实际触发条目记录）
  const untouched = rs();
  untouched.rules.push({ id: 'r_new', name: '新规则', priority: 99, cap: 1, trigger: { type: 'consumed' }, conditions: [], effects: [] });
  const d3 = checkDrift(bundle, untouched);
  assert.ok(d3.problems.every((p) => !/r_new|新规则/.test(p.text)));
});

test('演示脚本三回合完整可走，合法/非法预期全部符合', () => {
  let state = fresh();
  for (const step of demoScript) {
    while (state.turn.index !== step.turn || state.turn.side !== step.side) {
      state = endTurn(state, demoRuleset);
    }
    const result = applyAction(state, demoRuleset, step.actionId, step.params);
    assert.equal(result.ok, step.expectValid, `步骤失败：${step.note}`);
    state = result.state;
  }
  // 终局断言
  assert.equal(countAt(state, 'rest', 'ember'), 1);
  assert.equal(countAt(state, 'src', 'ember'), 0);
  assert.equal(countAt(state, 'pool', 'ember'), 1);
  assert.equal(countAt(state, 'pool', 'drop'), 1);
  assert.equal(countAt(state, 'forge', 'dust'), 2);
  assert.equal(state.poolValues.emberStock, 1);
});
