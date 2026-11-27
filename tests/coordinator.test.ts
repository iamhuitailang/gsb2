import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GLOBAL_COOLDOWN_MS,
  HINT_CATALOG,
  experiencedAccountLearned,
  newAccountLearned,
} from '../src/catalog/hints.js';
import { TutorialCoordinator } from '../src/core/coordinator.js';
import { ReplaySession } from '../src/core/replay.js';
import { zoneFirstRules, rescueFirstRules } from '../src/core/rules.js';
import { compareRules } from '../src/sim/compare.js';
import {
  denseTriggerScenario,
  divergenceScenario,
  experiencedScenario,
  newAccountScenario,
} from '../src/sim/scenarios.js';
import { runScenario } from '../src/sim/runner.js';
import type { FilterReason, GameEvent, HintId, TraceReason } from '../src/core/types.js';

function fresh(learned = newAccountLearned()): TutorialCoordinator {
  return new TutorialCoordinator({ initialLearned: learned });
}

function send(coord: TutorialCoordinator, now: number, event: GameEvent): void {
  coord.handle({ type: 'tick', now });
  coord.handle(event);
}

/** 独立函数内取值, 规避 assert.equal(x, null) 在同一作用域的类型收窄 */
function activeId(coord: TutorialCoordinator): HintId | null {
  return coord.active?.hintId ?? null;
}

function lastReason(coord: TutorialCoordinator, id: HintId): TraceReason | undefined {
  return coord.getLastTrace(id)?.reason;
}

function expectFiltered(coord: TutorialCoordinator, id: HintId): FilterReason {
  const reason = lastReason(coord, id);
  assert.ok(reason && reason.kind === 'filtered', `${id} 最近记录应为 filtered, 实际 ${JSON.stringify(reason)}`);
  return (reason as { kind: 'filtered'; reason: FilterReason }).reason;
}

function expectCancelled(coord: TutorialCoordinator, id: HintId): string {
  const reason = lastReason(coord, id);
  assert.ok(reason && reason.kind === 'cancelled', `${id} 最近记录应为 cancelled, 实际 ${JSON.stringify(reason)}`);
  return (reason as { kind: 'cancelled'; reason: string }).reason;
}

test('需求1: 位置/首用/失败/前置依赖四种解锁方式', () => {
  const coord = fresh();
  send(coord, 0, { type: 'sceneEnter', scene: 's' });

  // 位置解锁: 进 hub 前无提示, 进入后 h_pick 上屏
  assert.equal(activeId(coord), null);
  send(coord, 100, { type: 'enterZone', zone: 'hub' });
  assert.equal(activeId(coord), 'h_pick');

  // 位置+首用复合条件: 到 door 但没跳 => zoneActionPending
  send(coord, 500, { type: 'leaveZone', zone: 'hub' });
  send(coord, 600, { type: 'enterZone', zone: 'door' });
  assert.equal(expectFiltered(coord, 'h_jumptip'), 'zoneActionPending');
  send(coord, 700, { type: 'actionUse', action: 'jump', success: false });
  assert.ok(
    coord.getQueued().some((e) => e.hintId === 'h_jumptip') ||
      activeId(coord) === 'h_jumptip',
  );

  // 首用解锁: openInventory 第一次使用后 h_inventory 有资格;
  // 但这次动作本身做对了 => 按 selfDone 直接了结(没看会就做对, 不必再教)
  send(coord, 900, { type: 'actionUse', action: 'openInventory', success: true });
  assert.equal(coord.getLearned().get('h_inventory')?.outcome, 'selfDone');

  // 首用解锁的另一面: 动作失败不算自学, 首次接触后提示正常入队等教
  const c1b = fresh();
  send(c1b, 0, { type: 'sceneEnter', scene: 's' });
  send(c1b, 10, { type: 'actionUse', action: 'openInventory', success: false });
  assert.equal(c1b.getLearned().get('h_inventory'), undefined);
  const invTrace = lastReason(c1b, 'h_inventory');
  assert.ok(
    invTrace?.kind === 'queued' || invTrace?.kind === 'shown',
    `首用(失败)后应入队/上屏, 实际 ${JSON.stringify(invTrace)}`,
  );

  // 前置依赖: 未学会前置前, h_combine 永远 prereqNotMet
  const c2 = fresh();
  send(c2, 0, { type: 'sceneEnter', scene: 's' });
  send(c2, 10, { type: 'enterZone', zone: 'workbench' });
  assert.equal(expectFiltered(c2, 'h_combine'), 'prereqNotMet');

  // 失败解锁: craft 连续失败两次后 h_craftfail 有资格(前置未打通, h_combine 不占位, 故直接上屏)
  send(c2, 20, { type: 'actionUse', action: 'craft', success: false });
  assert.equal(expectFiltered(c2, 'h_craftfail'), 'failureCountNotMet');
  send(c2, 30, { type: 'actionUse', action: 'craft', success: false });
  const craftFailTrace = lastReason(c2, 'h_craftfail');
  assert.ok(
    craftFailTrace?.kind === 'queued' || craftFailTrace?.kind === 'shown',
    `达到失败阈值后应入队/上屏, 实际 ${JSON.stringify(craftFailTrace)}`,
  );
});

test('需求1: 先学会一项才出现下一项(前置链按序打通)', () => {
  const coord = fresh();
  send(coord, 0, { type: 'sceneEnter', scene: 's' });
  send(coord, 50, { type: 'enterZone', zone: 'workbench' });
  assert.equal(expectFiltered(coord, 'h_combine'), 'prereqNotMet');
  // 自学两项前置
  send(coord, 100, { type: 'enterZone', zone: 'hub' });
  send(coord, 200, { type: 'actionUse', action: 'pick', success: true });
  send(coord, 300, { type: 'actionUse', action: 'openInventory', success: true });
  // 再回工作台 => h_combine 解锁
  send(coord, 400, { type: 'enterZone', zone: 'workbench' });
  const trace = lastReason(coord, 'h_combine');
  assert.ok(
    trace?.kind === 'queued' || trace?.kind === 'shown',
    `前置打通后应入队/上屏, 实际 ${JSON.stringify(trace)}`,
  );
});

test('需求2: 同一次只显示一条, 全局冷却防密集遮挡', () => {
  const coord = fresh(experiencedAccountLearned(0));
  send(coord, 0, { type: 'sceneEnter', scene: 's' });
  send(coord, 100, { type: 'enterZone', zone: 'workbench' });
  // craft 失败两次 => h_craftfail 排队, 但 h_combine 正在展示, 不能同时上屏
  send(coord, 200, { type: 'actionUse', action: 'craft', success: false });
  send(coord, 300, { type: 'actionUse', action: 'craft', success: false });
  assert.equal(activeId(coord), 'h_combine');
  assert.ok(coord.getQueued().some((e) => e.hintId === 'h_craftfail'));

  // 冷却窗口内即使当前提示消失, 下一条也要等冷却结束
  coord.handle({ type: 'dismiss' });
  assert.equal(activeId(coord), null, '冷却期内不得立刻补位');
  assert.ok(GLOBAL_COOLDOWN_MS > 0);
});

test('需求2: 排队提示过时(TTL)后撤掉', () => {
  // 工作台: h_combine 先上屏占住展示位, h_craftfail 解锁后只能排队;
  // 排队期间超过它自己的 TTL(18s) => ttlExpired 撤掉, 全程没有上屏。
  const coord = fresh(experiencedAccountLearned(0));
  send(coord, 0, { type: 'sceneEnter', scene: 's' });
  send(coord, 100, { type: 'enterZone', zone: 'workbench' });
  assert.equal(activeId(coord), 'h_combine');
  send(coord, 200, { type: 'actionUse', action: 'craft', success: false });
  send(coord, 300, { type: 'actionUse', action: 'craft', success: false });
  assert.ok(coord.getQueued().some((e) => e.hintId === 'h_craftfail'));
  coord.handle({ type: 'tick', now: 45_000 });
  assert.equal(expectCancelled(coord, 'h_craftfail'), 'ttlExpired');
  assert.ok(!coord.getQueued().some((e) => e.hintId === 'h_craftfail'));
});

test('需求3: 看完/主动略过/靠自己完成三种结局区分正确', () => {
  // watched
  const c1 = fresh();
  send(c1, 0, { type: 'sceneEnter', scene: 's' });
  send(c1, 100, { type: 'enterZone', zone: 'hub' });
  const pickTtl = HINT_CATALOG.find((h) => h.id === 'h_pick')!.ttlMs;
  c1.handle({ type: 'tick', now: 100 + pickTtl + 1 });
  assert.equal(c1.getLearned().get('h_pick')?.outcome, 'watched');

  // skipped
  const c2 = fresh();
  send(c2, 0, { type: 'sceneEnter', scene: 's' });
  send(c2, 100, { type: 'enterZone', zone: 'hub' });
  send(c2, 200, { type: 'dismiss' });
  assert.equal(c2.getLearned().get('h_pick')?.outcome, 'skipped');
  // 略过不满足前置: 合成提示的 prereq 仍然不认
  send(c2, 300, { type: 'actionUse', action: 'openInventory', success: true });
  send(c2, 400, { type: 'enterZone', zone: 'workbench' });
  assert.equal(expectFiltered(c2, 'h_combine'), 'prereqNotMet');

  // selfDone: 没看会就做对目标动作
  const c3 = fresh();
  send(c3, 0, { type: 'sceneEnter', scene: 's' });
  send(c3, 100, { type: 'enterZone', zone: 'hub' });
  assert.equal(activeId(c3), 'h_pick');
  send(c3, 200, { type: 'actionUse', action: 'pick', success: true });
  assert.equal(c3.getLearned().get('h_pick')?.outcome, 'selfDone');
  assert.equal(activeId(c3), null, '自学完成后提示应立即撤下');
});

test('需求3: 进出场景与重开(快照导入导出)沿用学习状态', () => {
  const coord = fresh();
  send(coord, 0, { type: 'sceneEnter', scene: 's' });
  send(coord, 100, { type: 'enterZone', zone: 'hub' });
  send(coord, 200, { type: 'actionUse', action: 'pick', success: true }); // selfDone
  send(coord, 300, { type: 'sceneLeave', scene: 's' });
  assert.equal(coord.getLearned().get('h_pick')?.outcome, 'selfDone');

  // 模拟重开页面: 只用 learned 重建
  const reopened = new TutorialCoordinator({
    initialLearned: coord.exportLearned(),
  });
  send(reopened, 0, { type: 'sceneEnter', scene: 's' });
  send(reopened, 100, { type: 'enterZone', zone: 'hub' });
  assert.equal(activeId(reopened), null, '已学会的提示重开后不再弹');
  assert.equal(expectFiltered(reopened, 'h_pick'), 'alreadyLearned');
  assert.equal(reopened.getLearned().get('h_pick')?.outcome, 'selfDone');

  // 完整快照往返: 运行期状态也一致
  const snap = coord.exportSnapshot();
  const restored = TutorialCoordinator.fromSnapshot(snap);
  assert.deepEqual(restored.exportLearned(), coord.exportLearned());
  assert.equal(restored.zone, coord.zone);
});

test('需求4: 离开位置打断, 回位置恢复; 超过中断额度则取消', () => {
  const run = runScenario(experiencedScenario);
  const traces = run.traces.filter((t) => t.hintId === 'h_combine');
  const kinds = traces.map((t) => t.reason.kind);
  assert.ok(kinds.includes('suspended'), '应留下挂起记录');
  assert.ok(kinds.includes('resumed'), '应留下恢复记录');
  // 第三次离开超出 maxInterruptions(2) => 取消
  const cancelled = traces.find(
    (t) =>
      t.reason.kind === 'cancelled' &&
      (t.reason as { reason: string }).reason === 'interruptionBudget',
  );
  assert.ok(cancelled, '中断额度耗尽后应取消, 实际: ' + JSON.stringify(traces));
});

test('需求4: 紧急提示可抢占普通提示, 被抢占者挂起并保留剩余时长', () => {
  const coord = fresh(experiencedAccountLearned(0));
  send(coord, 0, { type: 'sceneEnter', scene: 's' });
  send(coord, 100, { type: 'enterZone', zone: 'workbench' });
  assert.equal(activeId(coord), 'h_combine');
  const before = coord.active!.remainingMs;
  // 走进危险区: 紧急 h_dodge 抢占
  send(coord, 1_000, { type: 'enterZone', zone: 'hazard' });
  assert.equal(activeId(coord), 'h_dodge');
  const suspended = coord.getSuspended().find((e) => e.hintId === 'h_combine');
  assert.ok(suspended, '被抢占的普通提示应挂起');
  assert.ok(suspended!.remainingMs !== null && suspended!.remainingMs! < before!);
});

test('需求5: 每条提示可读出最近一次触发/过滤/取消原因', () => {
  const coord = fresh();
  send(coord, 0, { type: 'sceneEnter', scene: 's' });
  send(coord, 10, { type: 'enterZone', zone: 'workbench' });
  const trace = coord.getLastTrace('h_combine');
  assert.ok(trace);
  assert.equal(trace!.reason.kind, 'filtered');
  // 全部 6 条提示都有最近痕迹(评估是全量遍历的)
  for (const hint of HINT_CATALOG) {
    assert.ok(coord.getLastTrace(hint.id), `${hint.id} 应有最近一次原因记录`);
  }
});

test('需求5: 可在任意操作记录上暂停并重走, 重放结果与原始运行一致', () => {
  const run = runScenario(newAccountScenario);
  const session = ReplaySession.fromLog(run.log);
  const PAUSE_SEQ = 10;
  session.pauseAtSeq(PAUSE_SEQ);
  assert.ok(session.position > 0);
  const paused = session.frame();
  const stepped = session.step();
  assert.equal(stepped.step, paused.step + 1);
  session.runToEnd();
  const end = session.frame();
  assert.deepEqual(end.learned, run.learned, '重放终点的学习状态必须与原始运行一致');
  assert.deepEqual(
    [...end.queuedHintIds].sort(),
    run.coordinator.getQueued().map((e) => e.hintId).sort(),
  );
});

test('需求6: 提供新账号与已懂两项操作的存档样例', () => {
  assert.deepEqual(newAccountLearned(), {});
  const exp = experiencedAccountLearned(0);
  assert.equal(exp.h_pick?.outcome, 'selfDone');
  assert.equal(exp.h_inventory?.outcome, 'selfDone');
  const run = runScenario(experiencedScenario);
  assert.equal(run.learned.h_pick?.outcome, 'selfDone', '存档状态应沿用到运行结束');
});

test('需求6: 修改规则后同一事件流给出可对比的不同提示次序', () => {
  const cmp = compareRules(divergenceScenario);
  assert.equal(cmp.sameOrder, false, '分歧场景下两套规则次序应不同');
  // 第一条 h_combine 两规则一致(开场在工作台看完); 分歧从第二位开始
  assert.equal(cmp.orders['zone-first']![1], 'h_dodge', '眼前优先: 危险区提示随后先上屏');
  assert.equal(
    cmp.orders['rescue-first']![1],
    'h_craftfail',
    '救援优先: 失败类提示随后先上屏',
  );

  // 密集场景也能稳定跑通并产出次序
  const dense = compareRules(denseTriggerScenario);
  assert.ok(dense.orders['zone-first']!.length > 0);
  assert.ok(dense.orders['rescue-first']!.length > 0);
});

test('规则集是可插拔的: 两套规则优先级裁决不同', () => {
  const a = new TutorialCoordinator({ rules: zoneFirstRules });
  const b = new TutorialCoordinator({ rules: rescueFirstRules });
  assert.equal(a.ruleSet.id, 'zone-first');
  assert.equal(b.ruleSet.id, 'rescue-first');
});
