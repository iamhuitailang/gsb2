import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STATE, createDraft, groupByCheckpoint, markNeedsAction, markOffline, markSynced,
  markSyncing, normalizeDrafts, runSync, selectSyncTargets, summarize, updateDraftPayload,
} from '../public/queue-core.js';

const NOW = '2026-11-16T09:00:00.000Z';
const payload = { answers: { temp: { result: 'pass' } }, note: '' };

function draft(id, checkpointId = 'cp-jia') {
  return createDraft({ id, checkpointId, checkpointName: checkpointId, payload, now: NOW });
}

test('新草稿默认待发送，且不预置任何成功凭据', () => {
  const d = draft('d1');
  assert.equal(d.state, STATE.PENDING);
  assert.equal(d.attempts, 0);
  assert.equal(d.receipt, null);
});

test('normalizeDrafts 会把残留的「发送中」退回待发送，非法数据被丢弃', () => {
  const list = normalizeDrafts([
    { id: 'a', checkpointId: 'cp-jia', state: STATE.SYNCING },
    { id: 'b', checkpointId: 'cp-yi', state: 'weird' },
    { id: 3, checkpointId: 'cp-yi' },
    { checkpointId: 'cp-yi' },
    null,
  ]);
  assert.deepEqual(list.map((d) => d.id), ['a', 'b']);
  assert.equal(list[0].state, STATE.PENDING);
  assert.equal(list[1].state, STATE.PENDING);
  assert.equal(normalizeDrafts('nope').length, 0);
});

test('已成功的草稿不会被再次选为同步目标', () => {
  const a = draft('a');
  const b = draft('b');
  const c = draft('c');
  markSynced(a, { seq: 1, receivedAt: NOW });
  markNeedsAction(c, { code: 'CHECKPOINT_NOT_AUTHORIZED', message: '授权已撤销', status: 403 });

  const targets = selectSyncTargets([a, b, c]);
  assert.deepEqual(targets.map((d) => d.id), ['b', 'c']);
  assert.deepEqual(selectSyncTargets([a, b, c], 'a'), []);
  assert.deepEqual(selectSyncTargets([a, b, c], 'c').map((d) => d.id), ['c']);
});

test('状态流转：待发送 → 发送中 → 已成功，记录正式编号', () => {
  const d = draft('d');
  markSyncing(d);
  assert.equal(d.state, STATE.SYNCING);
  markSynced(d, { seq: 7, receivedAt: NOW }, { duplicate: true });
  assert.equal(d.state, STATE.SYNCED);
  assert.equal(d.attempts, 1);
  assert.deepEqual(d.receipt, { seq: 7, receivedAt: NOW, duplicate: true });
});

test('需处理状态保留原因，重新编辑后回到待发送并清空原因', () => {
  const d = draft('d');
  markNeedsAction(d, { code: 'CHECKPOINT_NOT_AUTHORIZED', message: '「甲」的授权已撤销', status: 403 });
  assert.equal(d.state, STATE.NEEDS_ACTION);
  assert.equal(d.attempts, 1);
  assert.equal(d.lastError.status, 403);

  updateDraftPayload(d, { answers: {}, note: '改过' }, NOW);
  assert.equal(d.state, STATE.PENDING);
  assert.equal(d.lastError, null);
});

test('发送途中断网时退回待发送，不算失败次数', () => {
  const d = draft('d');
  markSyncing(d);
  markOffline(d);
  assert.equal(d.state, STATE.PENDING);
  assert.equal(d.attempts, 0);
  assert.equal(d.lastError.code, 'OFFLINE');
});

test('汇总区分未发送 / 需处理 / 已成功', () => {
  const a = draft('a');
  const b = draft('b', 'cp-yi');
  const c = draft('c', 'cp-yi');
  markSynced(a, { seq: 1, receivedAt: NOW });
  markNeedsAction(c, { code: 'CHECKPOINT_NOT_AUTHORIZED', message: 'x', status: 403 });
  const s = summarize([a, b, c]);
  assert.equal(s.total, 3);
  assert.equal(s.notSent, 1);
  assert.equal(s.needsAction, 1);
  assert.equal(s.succeeded, 1);
});

test('不同检查点的草稿各自分组，互不影响', () => {
  const jia = draft('j');
  const yi = draft('y', 'cp-yi');
  const groups = groupByCheckpoint([jia, yi]);
  assert.deepEqual([...groups.keys()], ['cp-jia', 'cp-yi']);
  assert.equal(groups.get('cp-jia').length, 1);
  assert.equal(groups.get('cp-yi').length, 1);
});

// ---------------- runSync：逐条上报编排 ----------------

const okRecord = (seq) => ({ seq, receivedAt: NOW });

test('runSync：一条被拒不影响其它检查点，后续草稿照常入库', async () => {
  const jia = draft('jia', 'cp-jia');
  const yi = draft('yi', 'cp-yi');
  const calls = [];
  const submit = async (d) => {
    calls.push(d.checkpointId);
    if (d.checkpointId === 'cp-jia') {
      throw Object.assign(new Error('「甲」的授权已撤销'), {
        code: 'CHECKPOINT_NOT_AUTHORIZED',
        status: 403,
      });
    }
    return { record: okRecord(1), duplicate: false };
  };

  const result = await runSync([jia, yi], { submit });

  assert.deepEqual(calls, ['cp-jia', 'cp-yi'], '两条都尝试过，顺序不变');
  assert.equal(result.accepted, 1);
  assert.equal(result.blocked, 1);
  assert.equal(result.interrupted, false);
  assert.equal(jia.state, STATE.NEEDS_ACTION);
  assert.equal(jia.lastError.status, 403);
  assert.equal(yi.state, STATE.SYNCED);
  assert.equal(yi.receipt.seq, 1);
});

test('runSync：已成功的草稿不会被再次上报', async () => {
  const done = draft('done');
  markSynced(done, okRecord(9));
  const fresh = draft('fresh', 'cp-yi');
  const calls = [];

  await runSync([done, fresh], {
    submit: async (d) => {
      calls.push(d.id);
      return { record: okRecord(10), duplicate: false };
    },
  });

  assert.deepEqual(calls, ['fresh']);
  assert.equal(done.attempts, 1, '已成功的草稿没有新增尝试次数');
  assert.equal(done.receipt.seq, 9);
});

test('runSync：遇到断网立即停手，剩余草稿保持待发送', async () => {
  const first = draft('first', 'cp-jia');
  const second = draft('second', 'cp-yi');
  let offline = false;

  const result = await runSync([first, second], {
    isOffline: () => offline,
    submit: async () => {
      offline = true;
      throw Object.assign(new Error('无法连接服务端'), { kind: 'offline' });
    },
  });

  assert.equal(result.interrupted, true);
  assert.equal(first.state, STATE.PENDING);
  assert.equal(first.attempts, 0, '断网不算一次失败尝试');
  assert.equal(second.state, STATE.PENDING);
  assert.equal(second.lastError, null, '未轮到的草稿不受影响');
});

test('runSync：onlyId 只发送指定草稿', async () => {
  const a = draft('a');
  const b = draft('b', 'cp-yi');
  const calls = [];
  await runSync([a, b], {
    onlyId: 'b',
    submit: async (d) => {
      calls.push(d.id);
      return { record: okRecord(1), duplicate: false };
    },
  });
  assert.deepEqual(calls, ['b']);
  assert.equal(a.state, STATE.PENDING);
  assert.equal(b.state, STATE.SYNCED);
});

test('runSync：重复提交返回 duplicate 时仍标记为已成功并记录同一条正式记录', async () => {
  const d = draft('d');
  const result = await runSync([d], {
    submit: async () => ({ record: okRecord(4), duplicate: true }),
  });
  assert.equal(result.accepted, 1);
  assert.equal(result.duplicates.length, 1);
  assert.equal(d.state, STATE.SYNCED);
  assert.equal(d.receipt.duplicate, true);
  assert.equal(d.receipt.seq, 4);
});

test('runSync：onChange 在每条状态变化后触发，便于刷新界面', async () => {
  const a = draft('a');
  const b = draft('b', 'cp-yi');
  let ticks = 0;
  await runSync([a, b], {
    submit: async () => ({ record: okRecord(1), duplicate: false }),
    onChange: () => { ticks += 1; },
  });
  assert.equal(ticks, 4, '两条草稿各经历「发送中」和「已成功」两次刷新');
});
