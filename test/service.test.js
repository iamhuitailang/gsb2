import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import {
  createCard, submitTransaction, getCard, listTransactions, getTransaction,
} from '../src/service.js';

let db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => db.close());

const CARD = 'C001';

function submit(overrides) {
  return submitTransaction(db, { cardId: CARD, ...overrides });
}

/* ------------------------- 题面完整业务场景 ------------------------- */

test('完整场景：暂存退款补单生效 + 双收银点并发退款只过一笔', () => {
  createCard(db, CARD, 0);

  // 1. 充值 100 元
  const recharge = submit({
    registerId: 'HQ', seq: 'R1', type: 'recharge', amountCents: 10000,
  });
  assert.equal(recharge.tx.status, 'posted');
  assert.equal(getCard(db, CARD).balanceCents, 10000);

  // 2. 先到一笔找不到原消费的 20 元退款 → 暂存，余额不变
  const earlyRefund = submit({
    registerId: 'POS-A', seq: 'A-REF-1', type: 'refund', amountCents: 2000,
    refRegisterId: 'POS-B', refSeq: 'B-PUR-1',
  });
  assert.equal(earlyRefund.tx.status, 'pending');
  assert.equal(getCard(db, CARD).balanceCents, 10000);

  // 3. 原消费 60 元补进 → 暂存退款随之一并生效
  const purchase = submit({
    registerId: 'POS-B', seq: 'B-PUR-1', type: 'purchase', amountCents: 6000,
  });
  assert.equal(purchase.tx.status, 'posted');
  // 消费扣 6000，暂存退款回补 2000 → 余额 6000
  assert.equal(getCard(db, CARD).balanceCents, 6000);

  const settled = getTransaction(db, earlyRefund.tx.id);
  assert.equal(settled.status, 'posted');
  assert.equal(settled.linkedTxId, purchase.tx.id);
  assert.equal(settled.balanceAfterCents, 6000);

  const originAfter = getTransaction(db, purchase.tx.id);
  assert.equal(originAfter.refundedCents, 2000);
  assert.equal(originAfter.refundableCents, 4000); // 剩余可退 40 元

  // 4. 两个收银点同时提交 30 元退款（不同流水号）→ 只能通过一笔
  const attempts = [
    { registerId: 'POS-A', seq: 'A-REF-2', type: 'refund', amountCents: 3000,
      refRegisterId: 'POS-B', refSeq: 'B-PUR-1' },
    { registerId: 'POS-C', seq: 'C-REF-9', type: 'refund', amountCents: 3000,
      refRegisterId: 'POS-B', refSeq: 'B-PUR-1' },
  ].map((payload) => submit(payload));
  const posted = attempts.filter((r) => r.tx.status === 'posted');
  const rejected = attempts.filter((r) => r.tx.status === 'rejected');
  assert.equal(posted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].tx.reasonCode, 'REJECTED_REFUND_EXCEEDS');
  assert.match(rejected[0].tx.reasonDetail, /剩余可退仅 1000 分/);

  // 5. 最终余额 90 元，剩余可退 10 元
  assert.equal(getCard(db, CARD).balanceCents, 9000);
  const finalOrigin = getTransaction(db, purchase.tx.id);
  assert.equal(finalOrigin.refundedCents, 5000);
  assert.equal(finalOrigin.refundableCents, 1000);
});

/* ------------------------------ 去重 ------------------------------ */

test('同收银点同流水号重复上报不重复入账', () => {
  createCard(db, CARD, 0);
  const first = submit({ registerId: 'P1', seq: 'S1', type: 'recharge', amountCents: 5000 });
  const again = submit({ registerId: 'P1', seq: 'S1', type: 'recharge', amountCents: 5000 });
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.tx.id, first.tx.id);
  assert.equal(getCard(db, CARD).balanceCents, 5000);
});

test('不同收银点相同流水号互不影响', () => {
  createCard(db, CARD, 0);
  const a = submit({ registerId: 'P1', seq: 'SAME', type: 'recharge', amountCents: 1000 });
  const b = submit({ registerId: 'P2', seq: 'SAME', type: 'recharge', amountCents: 2000 });
  assert.notEqual(a.tx.id, b.tx.id);
  assert.equal(getCard(db, CARD).balanceCents, 3000);
});

/* --------------------------- 退款额度规则 --------------------------- */

test('多笔部分退款累计不得超过原消费', () => {
  createCard(db, CARD, 0);
  submit({ registerId: 'P', seq: 'R', type: 'recharge', amountCents: 10000 });
  const p = submit({ registerId: 'P', seq: 'B', type: 'purchase', amountCents: 7000 });

  const r1 = submit({
    registerId: 'P', seq: 'F1', type: 'refund', amountCents: 3000,
    refRegisterId: 'P', refSeq: 'B',
  });
  const r2 = submit({
    registerId: 'P', seq: 'F2', type: 'refund', amountCents: 3000,
    refRegisterId: 'P', refSeq: 'B',
  });
  const r3 = submit({
    registerId: 'P', seq: 'F3', type: 'refund', amountCents: 1001,
    refRegisterId: 'P', refSeq: 'B',
  });
  assert.equal(r1.tx.status, 'posted');
  assert.equal(r2.tx.status, 'posted');
  assert.equal(r3.tx.status, 'rejected');

  const origin = getTransaction(db, p.tx.id);
  assert.equal(origin.refundedCents, 6000);
  assert.equal(origin.refundableCents, 1000);
  // 充值 10000 - 消费 7000 + 退 6000
  assert.equal(getCard(db, CARD).balanceCents, 9000);
});

test('退款金额恰等于剩余可退时通过，再退一分即拒', () => {
  createCard(db, CARD, 0);
  submit({ registerId: 'P', seq: 'R', type: 'recharge', amountCents: 5000 });
  const p = submit({ registerId: 'P', seq: 'B', type: 'purchase', amountCents: 3000 });

  const full = submit({
    registerId: 'P', seq: 'F1', type: 'refund', amountCents: 3000,
    refRegisterId: 'P', refSeq: 'B',
  });
  assert.equal(full.tx.status, 'posted');
  assert.equal(getTransaction(db, p.tx.id).refundableCents, 0);

  const oneCent = submit({
    registerId: 'P', seq: 'F2', type: 'refund', amountCents: 1,
    refRegisterId: 'P', refSeq: 'B',
  });
  assert.equal(oneCent.tx.status, 'rejected');
  assert.match(oneCent.tx.reasonDetail, /剩余可退仅 0 分/);
});

/* --------------------------- 暂存 FIFO --------------------------- */

test('原消费到达后多笔暂存退款按 FIFO 释放，超额者拒绝、后续继续核算', () => {
  createCard(db, CARD, 0);
  submit({ registerId: 'HQ', seq: 'R1', type: 'recharge', amountCents: 10000 });

  // 两笔暂存退款，合计 8000，原消费只有 5000
  const w1 = submit({
    registerId: 'A', seq: 'W1', type: 'refund', amountCents: 3000,
    refRegisterId: 'B', refSeq: 'P1',
  });
  const w2 = submit({
    registerId: 'A', seq: 'W2', type: 'refund', amountCents: 5000,
    refRegisterId: 'B', refSeq: 'P1',
  });
  assert.equal(w1.tx.status, 'pending');
  assert.equal(w2.tx.status, 'pending');

  const p = submit({ registerId: 'B', seq: 'P1', type: 'purchase', amountCents: 5000 });

  const w1After = getTransaction(db, w1.tx.id);
  const w2After = getTransaction(db, w2.tx.id);
  assert.equal(w1After.status, 'posted');
  assert.equal(w1After.linkedTxId, p.tx.id);
  assert.equal(w2After.status, 'rejected');
  assert.equal(w2After.reasonCode, 'REJECTED_PENDING_EXCEEDS');

  // 充值 10000 - 消费 5000 + 暂存释放 3000
  assert.equal(getCard(db, CARD).balanceCents, 8000);
  // 流水行只追加：被拒的暂存行保留，可在对账页追溯
  assert.equal(listTransactions(db, { cardId: CARD, status: 'rejected' }).length, 1);
});

/* --------------------------- 拒绝的消费 --------------------------- */

test('余额不足的消费被拒绝并记录原因，余额不变', () => {
  createCard(db, CARD, 0);
  submit({ registerId: 'P', seq: 'R', type: 'recharge', amountCents: 1000 });
  const p = submit({ registerId: 'P', seq: 'B', type: 'purchase', amountCents: 2000 });
  assert.equal(p.tx.status, 'rejected');
  assert.equal(p.tx.reasonCode, 'REJECTED_PURCHASE_INSUFFICIENT_BALANCE');
  assert.equal(getCard(db, CARD).balanceCents, 1000);
});

test('退款指向被拒绝的原消费 → 拒绝', () => {
  createCard(db, CARD, 0);
  submit({ registerId: 'P', seq: 'R', type: 'recharge', amountCents: 1000 });
  submit({ registerId: 'P', seq: 'B', type: 'purchase', amountCents: 2000 }); // 被拒
  const r = submit({
    registerId: 'P', seq: 'F', type: 'refund', amountCents: 100,
    refRegisterId: 'P', refSeq: 'B',
  });
  assert.equal(r.tx.status, 'rejected');
  assert.equal(r.tx.reasonCode, 'REJECTED_REFUND_ORIGIN_REJECTED');
});

test('退款上报到另一张卡（与原消费所属卡不一致）→ 拒绝', () => {
  createCard(db, CARD, 0);
  createCard(db, 'C002', 0);
  submit({ registerId: 'P', seq: 'R', type: 'recharge', amountCents: 5000 });
  submit({ registerId: 'P', seq: 'B', type: 'purchase', amountCents: 2000 });
  const r = submitTransaction(db, {
    cardId: 'C002', registerId: 'P', seq: 'F', type: 'refund', amountCents: 100,
    refRegisterId: 'P', refSeq: 'B',
  });
  assert.equal(r.tx.status, 'rejected');
  assert.equal(r.tx.reasonCode, 'REJECTED_REFUND_CARD_MISMATCH');
});

/* ------------------------------ 校验 ------------------------------ */

test('非法入参返回校验错误', () => {
  createCard(db, CARD, 0);
  assert.throws(
    () => submit({ registerId: 'P', seq: 'X', type: 'recharge', amountCents: 0 }),
    /正整数/,
  );
  assert.throws(
    () => submit({ registerId: 'P', seq: 'X', type: 'recharge', amountCents: -1 }),
    /正整数/,
  );
  assert.throws(
    () => submit({ registerId: 'P', seq: 'X', type: 'refund', amountCents: 100 }),
    /退款必须指向原消费/,
  );
  assert.throws(
    () => submit({ registerId: 'P', seq: 'X', type: 'unknown', amountCents: 100 }),
    /type 必须是/,
  );
});

test('向不存在的卡上报 → 404', () => {
  assert.throws(
    () => submit({ registerId: 'P', seq: 'X', type: 'recharge', amountCents: 100 }),
    (err) => err.statusCode === 404 && err.code === 'CARD_NOT_FOUND',
  );
});

/* --------------------------- 高并发压测 --------------------------- */

test('高并发：20 笔并发退款，入账总额严格不超过原消费', () => {
  createCard(db, CARD, 0);
  submit({ registerId: 'P', seq: 'R', type: 'recharge', amountCents: 100000 });
  const p = submit({ registerId: 'P', seq: 'B', type: 'purchase', amountCents: 10000 });

  // 每笔 1 元、共 20 笔并发，可退额度 100 元 → 恰好 10 笔通过
  const results = [];
  for (let i = 0; i < 20; i++) {
    results.push(submit({
      registerId: `POS-${i % 5}`, seq: `SEQ-${i}`, type: 'refund', amountCents: 1000,
      refRegisterId: 'P', refSeq: 'B',
    }));
  }
  const postedCount = results.filter((r) => r.tx.status === 'posted').length;
  assert.equal(postedCount, 10);
  const origin = getTransaction(db, p.tx.id);
  assert.equal(origin.refundedCents, 10000);
  assert.equal(origin.refundableCents, 0);
  // 充值 100000 - 消费 10000 + 退款 10000
  assert.equal(getCard(db, CARD).balanceCents, 100000);
});
