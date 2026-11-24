import test from 'node:test';
import assert from 'node:assert/strict';

import { settleDevice, settleRound, replayRecord, validatePlan } from '../src/domain/rules.ts';
import { examplePlanFor, SCENARIOS } from '../src/domain/scenarios.ts';
import { createGame, beginEditing, setAllocation, submitTeam, settleCurrent, buildViewModel, buildStateExport, serializeInternal, deserializeInternal, nextRound, importRecord, inspectRecord, buildRecordExport } from '../src/domain/state.ts';
import { GameStore, MemoryStorage } from '../src/app/store.ts';

/* ------------------------------------------------------------------ */
/* 1. 规则：上限 / 平手 / 最后一单位                                    */
/* ------------------------------------------------------------------ */

test('超过设备上限的工时按固定规则作废（投入更多者先扣）', () => {
  const device = { id: 'x', name: '测试设备', severity: 3, cap: 4, reward: 8 };
  const result = settleDevice(device, { A: 4, B: 2 });
  assert.equal(result.raw.A + result.raw.B, 6);
  assert.equal(result.capped.A + result.capped.B, 4);
  assert.equal(result.trimmed.A, 2);
  assert.equal(result.trimmed.B, 0);
  assert.equal(result.used.A + result.used.B, 3);
  assert.equal(result.repaired, true);
  assert.equal(result.awarded.A + result.awarded.B, 8);
});

test('平手超上限时固定从乙队先扣', () => {
  const device = { id: 'x', name: '测试设备', severity: 3, cap: 3, reward: 7 };
  const result = settleDevice(device, { A: 2, B: 2 });
  assert.deepEqual(result.capped, { A: 2, B: 1 });
  assert.equal(result.trimmed.B, 1);
  assert.equal(result.tieTrimUsed, true);
  // 作废后乙队较少，交替计入时乙队先放：乙 → 甲 → 甲。
  assert.deepEqual(result.order, ['B', 'A', 'A']);
  assert.deepEqual(result.used, { A: 2, B: 1 });
  assert.equal(result.finisher, 'A');
  assert.equal(result.awarded.A + result.awarded.B, 7);
});

test('最后一单位决定平手余数归属', () => {
  const device = { id: 'x', name: '测试设备', severity: 2, cap: 2, reward: 7 };
  const result = settleDevice(device, { A: 1, B: 1 });
  assert.equal(result.repaired, true);
  assert.equal(result.tie, true);
  // 双方相同，甲队先放；交替顺序 A → B，第 2 个单位由乙队放下。
  assert.deepEqual(result.order, ['A', 'B']);
  assert.equal(result.finisher, 'B');
  assert.deepEqual(result.awarded, { A: 3, B: 4 });
});

test('超额维修计入投入但不计分', () => {
  const device = { id: 'x', name: '测试设备', severity: 2, cap: 5, reward: 6 };
  const result = settleDevice(device, { A: 3, B: 1 });
  assert.equal(result.repaired, true);
  assert.equal(result.used.A + result.used.B, 2);
  assert.equal(result.overRepair.A + result.overRepair.B, 2);
  assert.equal(result.awarded.A + result.awarded.B, 6);
});

test('未达到修复阈值双方都是 0 分', () => {
  const device = { id: 'x', name: '测试设备', severity: 3, cap: 4, reward: 9 };
  const result = settleDevice(device, { A: 1, B: 1 });
  assert.equal(result.repaired, false);
  assert.deepEqual(result.awarded, { A: 0, B: 0 });
  assert.equal(result.finisher, null);
});

test('分工校验：负值、非整数、超预算都拒绝', () => {
  const devices = [{ id: 'a', name: 'A', severity: 1, cap: 2, reward: 1 }];
  assert.equal(validatePlan(devices, 3, { a: 2 }).ok, true);
  assert.equal(validatePlan(devices, 3, { a: 4 }).ok, false);
  assert.equal(validatePlan(devices, 3, { a: 1.5 }).ok, false);
  assert.equal(validatePlan(devices, 3, { a: -1 }).ok, false);
  assert.equal(validatePlan(devices, 3, { z: 1 }).ok, false);
});

/* ------------------------------------------------------------------ */
/* 2. 内置场景：竞争同一设备 / 两方都少分一单位                          */
/* ------------------------------------------------------------------ */

test('场景“竞争同一设备”的示例分工得到稳定结果', () => {
  const devices = SCENARIOS.contested.devices!;
  const round = settleRound({
    round: 1,
    seed: 'seed',
    budget: 6,
    devices,
    plans: SCENARIOS.contested.examplePlans!,
    submittedAt: { A: 1, B: 2 },
    settledAt: 3,
  });
  const pump = round.settlements.find((item) => item.deviceId === 'm1')!;
  const console_ = round.settlements.find((item) => item.deviceId === 'm4')!;
  // 主泵站：3 + 2 = 5，正好等于上限；乙队投入较少先放，顺序 乙甲乙甲甲 → 前 4 个计入。
  assert.equal(pump.trimmed.A + pump.trimmed.B, 0);
  assert.deepEqual(pump.used, { A: 2, B: 2 });
  assert.equal(pump.finisher, 'A');
  assert.equal(pump.overRepair.A, 1);
  assert.equal(pump.overRepair.B, 0);
  assert.equal(pump.tie, true);
  assert.equal(pump.awarded.A, 5);
  assert.equal(pump.awarded.B, 5);
  // 控制台：2 + 2 = 4 超过上限 3，平手从乙队扣 1；顺序 乙甲 → 双方各 1。
  assert.equal(console_.tieTrimUsed, true);
  assert.equal(console_.trimmed.A, 0);
  assert.equal(console_.trimmed.B, 1);
  assert.equal(console_.finisher, 'A');
  assert.deepEqual(console_.awarded, { A: 4, B: 3 });
  assert.deepEqual(round.totals, { A: 9, B: 8 });
});

test('场景“两方都少分一单位”确实双方都差一个单位', () => {
  const devices = SCENARIOS['one-short'].devices!;
  const plans = SCENARIOS['one-short'].examplePlans!;
  for (const device of devices) {
    const total = (plans.A[device.id] ?? 0) + (plans.B[device.id] ?? 0);
    if (device.id === 'n1') assert.equal(total, device.severity - 1);
  }
  const round = settleRound({
    round: 1,
    seed: 'seed',
    budget: 4,
    devices,
    plans,
    submittedAt: { A: 1, B: 2 },
    settledAt: 3,
  });
  const pump = round.settlements.find((item) => item.deviceId === 'n1')!;
  assert.equal(pump.repaired, false);
  assert.deepEqual(pump.awarded, { A: 0, B: 0 });
  assert.deepEqual(round.totals, { A: 7, B: 7 });
});

test('示例分工只在固定场景可用', () => {
  assert.ok(examplePlanFor('contested', 'A', SCENARIOS.contested.devices!));
  assert.equal(examplePlanFor('random', 'A', SCENARIOS.contested.devices!), null);
});

/* ------------------------------------------------------------------ */
/* 3. 状态机与密封提交                                                  */
/* ------------------------------------------------------------------ */

function prepared(): ReturnType<typeof createGame> {
  return createGame({ baseSeed: 's', preset: 'contested', now: 10 });
}

test('第一边确认后不能修改，也不能在乙队阶段改甲队', () => {
  let state = prepared();
  state = beginEditing(state, 'A').state;
  state = setAllocation(state, 'A', 'm1', 3).state;
  const submitted = submitTeam(state, 'A', 100);
  assert.equal(submitted.error, null);
  state = submitted.state;
  assert.equal(state.current.phase, 'handoff-b');

  const editAfterSubmit = setAllocation(state, 'A', 'm1', 5);
  assert.match(editAfterSubmit.error ?? '', /不能修改|不在编辑阶段/);
  const resubmit = submitTeam(state, 'A', 200);
  assert.match(resubmit.error ?? '', /不能/);

  const startB = beginEditing(state, 'B');
  assert.equal(startB.error, null);
  const tamperA = setAllocation(startB.state, 'A', 'm1', 0);
  assert.match(tamperA.error ?? '', /不能修改/);
  const aAfter = startB.state.current.drafts.A.allocations.m1;
  assert.equal(aAfter, 3);
});

test('遮挡页 / 编辑页 / 公开快照在结算前不含任何一方的选择', () => {
  let state = prepared();
  state = beginEditing(state, 'A').state;
  state = setAllocation(state, 'A', 'm3', 6).state;
  state = submitTeam(state, 'A', 100).state;

  const handoffView = buildViewModel(state);
  assert.equal(handoffView.phase, 'handoff-b');
  assert.equal(handoffView.handoff?.team, 'B');
  assert.equal(handoffView.handoff?.previousSubmitted, true);
  assert.equal(handoffView.editing, null);
  assert.equal(handoffView.awaiting, null);
  assert.equal(handoffView.settled, null);
  // 交接页的对象里没有任何方案字段
  assert.equal('plans' in handoffView.handoff!, false);
  assert.equal(JSON.stringify(handoffView).includes('"m3":6'), false);

  const snapshot = buildStateExport(state);
  assert.equal(snapshot.includes('"m3": 6'), false);
  assert.equal(/plans/i.test(snapshot), false);

  state = beginEditing(state, 'B').state;
  const editView = buildViewModel(state);
  assert.equal(editView.editing?.team, 'B');
  assert.equal(editView.editing?.allocations.m3, 0);
  assert.equal(JSON.stringify(editView).includes('"m3":6'), false);

  const snapshotEditing = buildStateExport(state);
  assert.equal(snapshotEditing.includes('"m3": 6'), false);
});

test('结算前的普通历史为空，导出不含当前轮私有草稿', () => {
  const store = new GameStore({ storage: new MemoryStorage(), now: () => 500 });
  store.acceptHandoff('A');
  store.setWork('A', 'm3', 6);
  store.submit('A');
  store.acceptHandoff('B');
  store.setWork('B', 'm1', 4);
  const snapshot = store.exportSnapshot();
  assert.equal(snapshot.includes('"m3": 6'), false);
  assert.equal(snapshot.includes('"m1": 4'), false);
  assert.equal(store.historyRecords().length, 0);

  const internal = store.storage.getItem('repair-lab:v1:save')!;
  // 内部存档用于中断恢复，允许含草稿；但它不是对外导出。
  assert.ok(internal.includes('"m1":4'));
});

/* ------------------------------------------------------------------ */
/* 4. 中断恢复                                                          */
/* ------------------------------------------------------------------ */

test('恢复后设备分布不会重新抽取', () => {
  const storeA = new GameStore({ storage: new MemoryStorage(), now: () => 1000 });
  const devicesBefore = storeA.getViewModel().devices;
  storeA.acceptHandoff('A');
  storeA.setWork('A', 'm1', 2);

  const storage = storeA.storage;
  const reopened = new GameStore({ storage, now: () => 2000 });
  assert.equal(reopened.wasRestored(), true);
  assert.equal(reopened.getViewModel().phase, 'editing-a');
  assert.deepEqual(reopened.getViewModel().devices, devicesBefore);
  assert.equal(reopened.getViewModel().editing?.allocations.m1, 2);

  // 随机场景也走同一条恢复路径
  const randomStore = new GameStore({ storage: new MemoryStorage(), now: () => 1, preset: 'random', baseSeed: 'abc' });
  const randomDevices = randomStore.getViewModel().devices;
  const randomAgain = new GameStore({ storage: randomStore.storage, now: () => 2 });
  assert.deepEqual(randomAgain.getViewModel().devices, randomDevices);
  assert.equal(randomAgain.getViewModel().seed, randomStore.getViewModel().seed);
});

test('恢复能回到等待 / 编辑 / 结算三种状态', () => {
  const storage = new MemoryStorage();
  const fresh = new GameStore({ storage, now: () => 10 });
  assert.equal(fresh.getViewModel().phase, 'handoff-a');

  const waiting = new GameStore({ storage, now: () => 20 });
  assert.equal(waiting.getViewModel().phase, 'handoff-a');

  waiting.acceptHandoff('A');
  waiting.setWork('A', 'm1', 3);
  waiting.submit('A');
  const handoffB = new GameStore({ storage, now: () => 30 });
  assert.equal(handoffB.getViewModel().phase, 'handoff-b');

  handoffB.acceptHandoff('B');
  const editing = new GameStore({ storage, now: () => 40 });
  assert.equal(editing.getViewModel().phase, 'editing-b');
  assert.equal(editing.getViewModel().editing?.team, 'B');

  editing.setWork('B', 'm4', 2);
  editing.submit('B');
  const awaiting = new GameStore({ storage, now: () => 50 });
  assert.equal(awaiting.getViewModel().phase, 'awaiting-settlement');

  awaiting.settle();
  const settled = new GameStore({ storage, now: () => 60 });
  assert.equal(settled.getViewModel().phase, 'settled');
  assert.equal(settled.getViewModel().settled?.record.totals.A, settled.historyRecords()[0]?.totals.A);
});

test('存档中的非法阶段 / 篡改记录会被拒绝恢复', () => {
  const store = new GameStore({ storage: new MemoryStorage(), now: () => 1 });
  store.acceptHandoff('A');
  store.submit('A');
  const raw = store.storage.getItem('repair-lab:v1:save')!;
  const parsed = JSON.parse(raw);
  parsed.state.current.phase = 'handoff-b';
  parsed.state.current.drafts.A.submittedAt = null;
  const result = deserializeInternal(JSON.stringify(parsed));
  assert.equal(result.ok, false);

  const settledStore = new GameStore({ storage: new MemoryStorage(), now: () => 2 });
  settledStore.acceptHandoff('A');
  settledStore.submit('A');
  settledStore.acceptHandoff('B');
  settledStore.submit('B');
  settledStore.settle();
  const good = JSON.parse(settledStore.storage.getItem('repair-lab:v1:save')!);
  good.state.history[0].settlements[0].awarded.A += 99;
  const tampered = deserializeInternal(JSON.stringify(good));
  assert.equal(tampered.ok, false);
});

/* ------------------------------------------------------------------ */
/* 5. 重播与重复结算                                                    */
/* ------------------------------------------------------------------ */

test('重复触发结算只入账一轮', () => {
  const store = new GameStore({ storage: new MemoryStorage(), now: () => 1 });
  store.acceptHandoff('A');
  store.setWork('A', 'm1', 3);
  store.submit('A');
  store.acceptHandoff('B');
  store.setWork('B', 'm1', 2);
  store.submit('B');
  store.settle();
  const afterFirst = store.historyRecords();
  assert.equal(afterFirst.length, 1);
  store.settle();
  store.settle();
  assert.equal(store.historyRecords().length, 1);
  assert.equal(store.getViewModel().phase, 'settled');
  assert.deepEqual(store.historyRecords()[0]?.totals, afterFirst[0]?.totals);
});

test('同一份已结算记录重播得到相同分值', () => {
  const store = new GameStore({ storage: new MemoryStorage(), now: () => 1 });
  store.acceptHandoff('A');
  store.loadExample('A');
  store.submit('A');
  store.acceptHandoff('B');
  store.loadExample('B');
  store.submit('B');
  store.settle();
  const record = store.historyRecords()[0]!;
  const replay = replayRecord(record);
  assert.equal(replay.matches, true);
  assert.deepEqual(replay.replayed.totals, record.totals);
  assert.equal(replay.replayed.checksum, record.checksum);

  const fromExport = inspectRecord(buildRecordExport(record));
  assert.equal(fromExport.error, null);
  assert.deepEqual(fromExport.record?.totals, record.totals);
});

test('导入只做重播核对：通过时给出分值，不改动本机历史', () => {
  // 构造第 1 轮的独立记录
  const sourceStore = new GameStore({ storage: new MemoryStorage(), now: () => 1, baseSeed: 'shared' });
  sourceStore.acceptHandoff('A');
  sourceStore.loadExample('A');
  sourceStore.submit('A');
  sourceStore.acceptHandoff('B');
  sourceStore.loadExample('B');
  sourceStore.submit('B');
  sourceStore.settle();
  const round1 = sourceStore.historyRecords()[0]!;
  const exported = buildRecordExport(round1);

  const target = new GameStore({ storage: new MemoryStorage(), now: () => 2 });
  assert.equal(target.historyRecords().length, 0);
  target.importSettledRecord(exported);
  assert.equal(target.getError(), null);
  assert.match(target.getNotice() ?? '', /重播核对通过/);
  assert.match(target.getNotice() ?? '', new RegExp(`甲 ${round1.totals.A} : 乙 ${round1.totals.B}`));
  // 导入用于核对，不会把外部记录塞进本机历史
  assert.equal(target.historyRecords().length, 0);
  assert.equal(target.getViewModel().phase, 'handoff-a');
});

test('篡改过的记录不会被接受', () => {
  const store = new GameStore({ storage: new MemoryStorage(), now: () => 1 });
  store.acceptHandoff('A');
  store.loadExample('A');
  store.submit('A');
  store.acceptHandoff('B');
  store.loadExample('B');
  store.submit('B');
  store.settle();
  const record = store.historyRecords()[0]!;
  const tampered = { ...record, totals: { A: 999, B: 0 } };
  const target = new GameStore({ storage: new MemoryStorage(), now: () => 2 });
  target.importSettledRecord(JSON.stringify(tampered));
  assert.match(target.getError() ?? '', /校验失败/);
  assert.equal(target.historyRecords().length, 0);
});

/* ------------------------------------------------------------------ */
/* 6. 两轮连续结算                                                      */
/* ------------------------------------------------------------------ */

test('两轮连续结算：历史分开、设备分布逐轮不同且可复现', () => {
  const store = new GameStore({ storage: new MemoryStorage(), now: () => 1, baseSeed: 'two-rounds', preset: 'random' });
  const round1Devices = store.getViewModel().devices.map((d) => ({ ...d }));
  store.acceptHandoff('A');
  store.setWork('A', round1Devices[0]!.id, 3);
  store.submit('A');
  store.acceptHandoff('B');
  store.setWork('B', round1Devices[0]!.id, 2);
  store.submit('B');
  store.settle();
  store.startNextRound();

  assert.equal(store.getViewModel().phase, 'handoff-a');
  assert.equal(store.getViewModel().round, 2);
  assert.equal(store.historyRecords().length, 1);
  assert.equal(store.getViewModel().settled, null);
  const round2Devices = store.getViewModel().devices;
  // 每一轮用 base seed#R轮次 作种子；第 2 轮的种子必然与第 1 轮不同。
  assert.equal(store.getViewModel().seed, 'two-rounds#R2');
  assert.notEqual(store.getViewModel().seed, store.historyRecords()[0]!.seed);
  assert.ok(round2Devices.length > 0);

  store.acceptHandoff('A');
  store.setWork('A', round2Devices[0]!.id, 2);
  store.setWork('A', round2Devices[1]!.id, 1);
  store.submit('A');
  store.acceptHandoff('B');
  store.setWork('B', round2Devices[0]!.id, 1);
  store.setWork('B', round2Devices[1]!.id, 2);
  store.submit('B');
  store.settle();
  const history = store.historyRecords();
  assert.equal(history.length, 2);
  assert.deepEqual(
    history.map((record) => record.round),
    [1, 2],
  );
  assert.notEqual(history[0]!.checksum, history[1]!.checksum);
  for (const record of history) {
    assert.equal(replayRecord(record).matches, true);
  }

  // 相同 base seed → 相同的第 1 轮设备分布
  const replayStore = new GameStore({ storage: new MemoryStorage(), now: () => 1, baseSeed: 'two-rounds', preset: 'random' });
  assert.deepEqual(replayStore.getViewModel().devices, round1Devices);
});
