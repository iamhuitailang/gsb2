import test from 'node:test';
import assert from 'node:assert/strict';

import { GameStore, MemoryStorage } from '../src/app/store.ts';
import { buildRenderInput, dispatchAction, makeInitialUi, renderApp, setClipboardWriter } from '../src/app/controller.ts';
import type { UiState } from '../src/app/render.ts';
import { buildRecordExport } from '../src/domain/state.ts';

interface Harness {
  store: GameStore;
  storage: MemoryStorage;
  ui: UiState;
  html(): string;
  run(action: Parameters<typeof dispatchAction>[2]): void;
  reopen(): Harness;
}

function harness(storage = new MemoryStorage(), options: { now?: () => number } = {}): Harness {
  let clock = 1000;
  const now = options.now ?? (() => (clock += 10));
  const store = new GameStore({ storage, now });
  let ui = makeInitialUi(store);
  const api: Harness = {
    store,
    storage,
    ui,
    html() {
      return renderApp(buildRenderInput(store, ui));
    },
    run(action) {
      ui = dispatchAction(store, ui, action);
      api.ui = ui;
    },
    reopen() {
      return harness(storage, options);
    },
  };
  return api;
}

function fillExample(h: Harness, team: 'A' | 'B'): void {
  h.run({ type: 'load-example', team });
}

test('交接页遮挡：不出现任何一方的方案或编辑控件', () => {
  const h = harness();
  const html = h.html();
  assert.match(html, /请把键盘交给甲队/);
  assert.match(html, /屏幕遮挡/);
  assert.doesNotMatch(html, /data-action="inc"/);
  assert.doesNotMatch(html, /data-action="dec"/);
  assert.doesNotMatch(html, /data-action="open-history"/);
  assert.doesNotMatch(html, /history-list/);
  assert.doesNotMatch(html, /data-draft=/);

  h.run({ type: 'accept-handoff', team: 'A' });
  fillExample(h, 'A');
  h.run({ type: 'request-submit', team: 'A' });
  assert.match(h.html(), /确认密封提交/);
  // 确认框打开时仍可修改（需求：确认前可修改）
  const before = h.store.getViewModel().editing!.allocations.m1;
  h.run({ type: 'adjust', team: 'A', deviceId: 'm1', delta: -1 });
  assert.equal(h.store.getViewModel().editing!.allocations.m1, before - 1);
  h.run({ type: 'adjust', team: 'A', deviceId: 'm1', delta: 1 });
  h.run({ type: 'confirm-submit', team: 'A' });

  const cover = h.html();
  assert.equal(h.store.getViewModel().phase, 'handoff-b');
  assert.match(cover, /甲队已密封提交，请把键盘交给乙队/);
  assert.match(cover, /乙队接手/);
  assert.doesNotMatch(cover, /data-action="inc"/);
  assert.doesNotMatch(cover, /data-action="open-history"/);
  assert.doesNotMatch(cover, /history-list/);
  assert.doesNotMatch(cover, /data-draft=/);
  // 示例分工 m1:3 / m4:2 不应出现在交接页的可见文本里
  assert.doesNotMatch(cover, /本队投入 3 工时/);
  assert.ok(!cover.includes('"m1":3'));
});

test('乙队编辑界面只包含乙队自己的草稿，不含甲队选择', () => {
  const h = harness();
  h.run({ type: 'accept-handoff', team: 'A' });
  fillExample(h, 'A');
  h.run({ type: 'confirm-submit', team: 'A' });
  h.run({ type: 'accept-handoff', team: 'B' });
  fillExample(h, 'B');

  const view = h.store.getViewModel();
  assert.equal(view.editing?.team, 'B');
  const html = h.html();
  assert.match(html, /现在轮到 乙队 编辑/);
  assert.match(html, /data-team="B"/);
  assert.doesNotMatch(html, /data-team="A"/);
  // 甲队方案是 m1:3,m2:1,m4:2；乙队示例是 m1:2,m2:1,m3:1,m4:2。
  assert.doesNotMatch(html, /data-draft="m1:3\|/);
  const aLeak = h.store.peekState().current.drafts.A.allocations.m1;
  assert.equal(aLeak, 3);
  assert.equal(view.editing?.allocations.m1, 2);
  // 公开快照不含任何一方方案
  const snapshot = h.store.exportSnapshot();
  assert.ok(!snapshot.includes('"m1": 3'));
  assert.ok(!snapshot.includes('"m1": 2'));
  // 普通历史仍为空
  assert.match(html, /还没有已结算的轮次/);
});

test('结算前重新打开：回到编辑态且设备分布不变', () => {
  const h = harness();
  h.run({ type: 'accept-handoff', team: 'A' });
  fillExample(h, 'A');
  const devices = h.store.getViewModel().devices;
  const reopened = h.reopen();
  assert.match(reopened.html(), /现在轮到 甲队 编辑/);
  assert.deepEqual(reopened.store.getViewModel().devices, devices);
  assert.equal(reopened.store.getViewModel().editing?.allocations.m1, 3);
  assert.match(reopened.html(), /本队投入 3 工时/);
});

test('重复点击结算按钮只入账一轮（通过界面动作）', () => {
  const h = harness();
  h.run({ type: 'accept-handoff', team: 'A' });
  fillExample(h, 'A');
  h.run({ type: 'confirm-submit', team: 'A' });
  h.run({ type: 'accept-handoff', team: 'B' });
  fillExample(h, 'B');
  h.run({ type: 'confirm-submit', team: 'B' });
  assert.equal(h.store.getViewModel().phase, 'awaiting-settlement');
  h.run({ type: 'settle' });
  const firstTotals = h.store.getViewModel().settled!.totals;
  h.run({ type: 'settle' });
  h.run({ type: 'settle' });
  assert.equal(h.store.historyRecords().length, 1);
  assert.deepEqual(h.store.getViewModel().settled!.totals, firstTotals);
  assert.match(h.html(), /重播核对通过/);
  assert.match(h.html(), /各边得到什么/);
});

test('两轮连续结算：交接页、历史与私有草稿分开', () => {
  const h = harness();
  h.run({ type: 'accept-handoff', team: 'A' });
  fillExample(h, 'A');
  h.run({ type: 'confirm-submit', team: 'A' });
  h.run({ type: 'accept-handoff', team: 'B' });
  fillExample(h, 'B');
  h.run({ type: 'confirm-submit', team: 'B' });
  h.run({ type: 'settle' });
  const round1 = h.store.historyRecords()[0]!;

  h.run({ type: 'next-round' });
  assert.equal(h.store.getViewModel().phase, 'handoff-a');
  assert.equal(h.store.getViewModel().round, 2);
  const html = h.html();
  assert.match(html, /请把键盘交给甲队/);
  assert.doesNotMatch(html, /data-action="inc"/);
  // 交接遮挡页不展示历史与导出；历史仍只有已结算的第 1 轮
  assert.doesNotMatch(html, /history-list/);
  assert.doesNotMatch(html, /data-action="export-snapshot"/);
  assert.equal(h.store.historyRecords().length, 1);

  // 第 2 轮先填一半再重新打开：草稿恢复，但历史不受影响
  h.run({ type: 'accept-handoff', team: 'A' });
  h.run({ type: 'adjust', team: 'A', deviceId: h.store.getViewModel().devices[0]!.id, delta: 2 });
  const reopened = h.reopen();
  assert.equal(reopened.store.getViewModel().round, 2);
  assert.equal(reopened.store.getViewModel().phase, 'editing-a');
  assert.equal(reopened.store.historyRecords().length, 1);
  assert.match(reopened.html(), /第 1 轮/);

  reopened.run({ type: 'confirm-submit', team: 'A' });
  reopened.run({ type: 'accept-handoff', team: 'B' });
  reopened.run({ type: 'adjust', team: 'B', deviceId: reopened.store.getViewModel().devices[0]!.id, delta: 1 });
  reopened.run({ type: 'confirm-submit', team: 'B' });
  reopened.run({ type: 'settle' });
  const history = reopened.store.historyRecords();
  assert.equal(history.length, 2);
  assert.deepEqual(
    history.map((record) => record.round),
    [1, 2],
  );
  assert.deepEqual(history[0]!.totals, round1.totals);
  assert.equal(history[0]!.checksum, round1.checksum);
});

test('历史回放与导入走同一份记录', () => {
  const h = harness();
  h.run({ type: 'accept-handoff', team: 'A' });
  fillExample(h, 'A');
  h.run({ type: 'confirm-submit', team: 'A' });
  h.run({ type: 'accept-handoff', team: 'B' });
  fillExample(h, 'B');
  h.run({ type: 'confirm-submit', team: 'B' });
  h.run({ type: 'settle' });
  const record = h.store.historyRecords()[0]!;
  h.run({ type: 'open-history', id: record.id });
  h.run({ type: 'replay-history', id: record.id });
  assert.match(h.html(), /通过：同一记录重播仍为/);

  // 另一局粘贴同一份记录：只做重播核对，不改动本机进度
  const other = harness(new MemoryStorage());
  other.run({ type: 'accept-handoff', team: 'A' });
  other.run({ type: 'set-import-text', text: buildRecordExport(record) });
  other.run({ type: 'import-record' });
  assert.match(other.html(), /重播核对通过/);
  assert.equal(other.store.historyRecords().length, 0);
  assert.equal(other.store.getViewModel().phase, 'editing-a');
});

test('导出按钮把公开快照写入剪贴板', () => {
  let copied = '';
  setClipboardWriter((text) => {
    copied = text;
  });
  const h = harness();
  h.run({ type: 'accept-handoff', team: 'A' });
  fillExample(h, 'A');
  h.run({ type: 'export-snapshot' });
  assert.ok(copied.includes('repair-lab-public-snapshot'));
  assert.ok(!copied.includes('"m1": 3'));
});
