/* trace.test.js — node --test 纯逻辑验收测试（不加载浏览器代码）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Trace = require('./trace.js');
const Sample = require('./sample-data.js');

function revoke(data, detailId) {
  data.corrections.push({
    id: `COR-${data.corrections.length + 1}`,
    type: 'revoke',
    detailId,
    date: '2026-11-10',
    reason: '测试撤销',
  });
}

test('R1 经 H1、H2 两条路径关联到同一成品 P1', () => {
  const data = Sample.fullLedger();
  const r = Trace.trace('R1', data);

  const pathKeys = r.paths.map((p) => p.join('>')).sort();
  assert.deepEqual(pathKeys, ['R1>H1>P1', 'R1>H2>P1']);
  assert.equal(r.paths.length, 2);
  // 两条路径的生产边都在图上
  const edgeKeys = r.pathEdges.map((e) => `${e.from}->${e.to}#${e.productionId}`).sort();
  assert.deepEqual(edgeKeys, [
    'H1->P1#PRD-P1',
    'H2->P1#PRD-P1',
    'R1->H1#PRD-H1',
    'R1->H2#PRD-H2',
  ]);
});

test('R1 验收口径：1 个成品批次、10 件出库、2 个出库单', () => {
  const data = Sample.fullLedger();
  const r = Trace.trace('R1', data);

  assert.deepEqual(r.products, ['P1']);
  assert.equal(r.stats.productBatchCount, 1);
  assert.equal(r.stats.outboundOrderCount, 2);
  assert.equal(r.stats.outboundDetailCount, 2);
  assert.equal(r.stats.outboundQty, 10);
  // P2 与 R1 无关，不应出现
  assert.ok(!r.nodes.includes('P2'));
  assert.ok(!r.outboundDetails.some((d) => d.id === 'OUT-3'));
});

test('撤销第二单后当前变 6 件，保存时的快照仍是 10 件', () => {
  const data = Sample.fullLedger();
  const before = Trace.trace('R1', data);
  assert.equal(before.stats.outboundQty, 10);

  // 模拟保存快照：深存当时的台账与结果
  const snapshot = { data: Sample.clone(data), result: JSON.parse(JSON.stringify(before)) };

  revoke(data, 'OUT-2');
  const after = Trace.trace('R1', data);
  assert.equal(after.stats.outboundQty, 6);
  assert.equal(after.stats.outboundDetailCount, 1);
  assert.equal(after.stats.revokedQty, 4);
  assert.equal(after.stats.revokedDetailCount, 1);
  // 撤销明细仍在结果里可追溯，只是不计入当前汇总
  const out2 = after.outboundDetails.find((d) => d.id === 'OUT-2');
  assert.equal(out2.revoked, true);
  // 成品批次数不受撤销影响
  assert.equal(after.stats.productBatchCount, 1);

  // 用保存时的台账重放，快照口径保持 10 件
  const replay = Trace.trace('R1', snapshot.data);
  assert.equal(replay.stats.outboundQty, 10);
  assert.equal(snapshot.result.stats.outboundQty, 10);
});

test('去重：同一成品批次/出库单不被两条路径重复计数', () => {
  const data = Sample.fullLedger();
  const r = Trace.trace('R1', data);
  const productNodes = r.nodes.filter((n) => n === 'P1');
  assert.equal(productNodes.length, 1);
  const orders = new Set(r.outboundDetails.map((d) => d.orderNo));
  assert.equal(orders.size, r.stats.outboundOrderCount);
});

test('台账后到：H2 生产记录缺失时标出缺失关联', () => {
  const late = Sample.withLateLedger();
  const globalMissing = Trace.findGlobalMissing(late);
  // PRD-P1 仍引用 H2，但 H2 已无生产记录
  assert.ok(globalMissing.some((m) => m.kind === 'danglingProductionInput' && m.batch === 'H2'));

  const r = Trace.trace('R1', late);
  assert.equal(r.paths.length, 1);
  assert.deepEqual(r.paths[0], ['R1', 'H1', 'P1']);
  assert.ok(r.missing.some((m) => m.batch === 'H2'));
  // 缺失状态下仍能给出已知部分的汇总
  assert.equal(r.stats.productBatchCount, 1);
  assert.equal(r.stats.outboundQty, 10);
});

test('补齐迟到台账后重算恢复为两条路径', () => {
  const late = Sample.withLateLedger();
  assert.equal(Trace.trace('R1', late).paths.length, 1);

  const full = Sample.fullLedger();
  late.production = full.production;
  assert.equal(Trace.findGlobalMissing(late).length, 0);
  const r = Trace.trace('R1', late);
  assert.equal(r.paths.length, 2);
  assert.equal(r.missing.length, 0);
  assert.equal(r.stats.outboundQty, 10);
});

test('出库引用了没有生产记录的批次时全局缺失可识别', () => {
  const data = Sample.fullLedger();
  data.outbound.push({
    id: 'OUT-X', orderNo: 'SO-X', productBatch: 'PX', qty: 2,
    shipDate: '2026-11-10', customer: '未知客户',
  });
  const missing = Trace.findGlobalMissing(data);
  assert.ok(missing.some((m) => m.kind === 'danglingOutboundBatch' && m.batch === 'PX'));
});

test('R2 只追溯到 P2，与 R1 链路完全隔离', () => {
  const r = Trace.trace('R2', Sample.fullLedger());
  assert.deepEqual(r.paths, [['R2', 'P2']]);
  assert.deepEqual(r.products, ['P2']);
  assert.equal(r.stats.outboundQty, 3);
});
