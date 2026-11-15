import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createCard, submitTransaction, getCard, getTransaction } from '../src/service.js';

let db;
let server;
let base;

function post(path, payload) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

before(async () => {
  db = openDb(':memory:');
  server = createApp(db);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

test('HTTP 端到端：题面场景 + 真实并发请求下退款只过一笔', async () => {
  const card = 'C900';
  createCard(db, card, 0);

  // 充值 100
  let r = await post('/api/transactions', {
    cardId: card, registerId: 'HQ', seq: 'R1', type: 'recharge', amountCents: 10000,
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.tx.status, 'posted');

  // 暂存退款 20（原消费未到）
  r = await post('/api/transactions', {
    cardId: card, registerId: 'POS-A', seq: 'A-1', type: 'refund', amountCents: 2000,
    refRegisterId: 'POS-B', refSeq: 'B-1',
  });
  assert.equal(r.body.tx.status, 'pending');

  // 原消费 60 补进，暂存退款一并生效
  r = await post('/api/transactions', {
    cardId: card, registerId: 'POS-B', seq: 'B-1', type: 'purchase', amountCents: 6000,
  });
  assert.equal(r.body.tx.status, 'posted');
  assert.equal(getCard(db, card).balanceCents, 6000);

  // 真实并发：两个请求同时发出
  const concurrent = await Promise.all([
    post('/api/transactions', {
      cardId: card, registerId: 'POS-A', seq: 'A-2', type: 'refund', amountCents: 3000,
      refRegisterId: 'POS-B', refSeq: 'B-1',
    }),
    post('/api/transactions', {
      cardId: card, registerId: 'POS-C', seq: 'C-9', type: 'refund', amountCents: 3000,
      refRegisterId: 'POS-B', refSeq: 'B-1',
    }),
  ]);
  const statuses = concurrent.map((x) => x.body.tx.status).sort();
  assert.deepEqual(statuses, ['posted', 'rejected']);

  assert.equal(getCard(db, card).balanceCents, 9000);
  const origin = db.prepare("SELECT * FROM transactions WHERE register_id='POS-B' AND seq='B-1'").get();
  assert.equal(origin.refunded_cents, 5000);
  assert.equal(getTransaction(db, origin.id).refundableCents, 1000);

  // 重复上报幂等
  r = await post('/api/transactions', {
    cardId: card, registerId: 'POS-A', seq: 'A-2', type: 'refund', amountCents: 3000,
    refRegisterId: 'POS-B', refSeq: 'B-1',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.duplicate, true);

  // 查询接口与筛选
  const all = await fetch(`${base}/api/transactions?cardId=${card}`).then((x) => x.json());
  assert.ok(all.length >= 5);
  const rejected = await fetch(`${base}/api/transactions?cardId=${card}&status=rejected`).then((x) => x.json());
  assert.ok(rejected.every((t) => t.status === 'rejected'));
  assert.ok(rejected[0].reasonCode);
});

test('HTTP 错误处理：非法 JSON / 未知卡 / 静态页', async () => {
  const bad = await fetch(`${base}/api/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not-json',
  });
  assert.equal(bad.status, 400);

  const missing = await post('/api/transactions', {
    cardId: 'NOPE', registerId: 'P', seq: 'S', type: 'recharge', amountCents: 100,
  });
  assert.equal(missing.status, 404);

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /礼品卡流水对账/);

  const health = await fetch(`${base}/api/health`).then((x) => x.json());
  assert.equal(health.ok, true);
});

test('开卡接口：重复开卡 409，初始余额生效', async () => {
  const r1 = await post('/api/cards', { cardId: 'C-NEW', initialBalanceCents: 500 });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.balanceCents, 500);
  const r2 = await post('/api/cards', { cardId: 'C-NEW' });
  assert.equal(r2.status, 409);
});

// 直接用 service 造一条暂存数据，验证 GET 详情字段完整
test('暂存流水详情包含原因与原消费定位', () => {
  createCard(db, 'C-DET', 0);
  const r = submitTransaction(db, {
    cardId: 'C-DET', registerId: 'P1', seq: 'S1', type: 'refund', amountCents: 100,
    refRegisterId: 'P2', refSeq: 'S2',
  });
  const detail = getTransaction(db, r.tx.id);
  assert.equal(detail.status, 'pending');
  assert.equal(detail.reasonCode, 'PENDING_REFUND_ORIGIN_MISSING');
  assert.deepEqual(detail.ref, { registerId: 'P2', seq: 'S2' });
  assert.equal(detail.balanceAfterCents, null);
});
