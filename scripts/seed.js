/**
 * 重置数据库并复现题面场景，便于在对账页人工核对。
 * 运行：npm run seed
 */
import { rmSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { createCard, submitTransaction, getCard, getTransaction } from '../src/service.js';

const DB_PATH = process.env.GC_DB_PATH || new URL('../data/giftcard.db', import.meta.url).pathname;

for (const suffix of ['', '-wal', '-shm']) {
  rmSync(DB_PATH + suffix, { force: true });
}
const db = openDb(DB_PATH);
const CARD = 'C001';

const step = (title, fn) => {
  const r = fn();
  const tx = r?.tx;
  const extra = tx
    ? `#${tx.id} ${tx.status}${tx.reasonCode ? ` (${tx.reasonCode})` : ''}`
    : JSON.stringify(r);
  console.log(`- ${title}: ${extra}`);
  return r;
};

console.log('== 初始化：开卡 C001，初始余额 0 元 ==');
createCard(db, CARD, 0);

step('充值 100 元 (HQ/R1)', () =>
  submitTransaction(db, { cardId: CARD, registerId: 'HQ', seq: 'R1', type: 'recharge', amountCents: 10000 }));

step('退款 20 元，原消费未到 → 暂存 (POS-A/A-REF-1 → POS-B/B-PUR-1)', () =>
  submitTransaction(db, {
    cardId: CARD, registerId: 'POS-A', seq: 'A-REF-1', type: 'refund', amountCents: 2000,
    refRegisterId: 'POS-B', refSeq: 'B-PUR-1',
  }));

console.log(`  当前余额: ${getCard(db, CARD).balanceCents} 分（应为 10000）`);

const purchase = step('补进原消费 60 元 (POS-B/B-PUR-1)，暂存退款一并生效', () =>
  submitTransaction(db, { cardId: CARD, registerId: 'POS-B', seq: 'B-PUR-1', type: 'purchase', amountCents: 6000 }));

const origin = getTransaction(db, purchase.tx.id);
console.log(`  当前余额: ${getCard(db, CARD).balanceCents} 分（应为 6000），剩余可退: ${origin.refundableCents} 分（应为 4000）`);

console.log('== 两个收银点同时提交 30 元退款（不同流水号）==');
const concurrent = [
  { cardId: CARD, registerId: 'POS-A', seq: 'A-REF-2', type: 'refund', amountCents: 3000,
    refRegisterId: 'POS-B', refSeq: 'B-PUR-1' },
  { cardId: CARD, registerId: 'POS-C', seq: 'C-REF-9', type: 'refund', amountCents: 3000,
    refRegisterId: 'POS-B', refSeq: 'B-PUR-1' },
].map((payload, i) => step(`并发退款 #${i + 1} (${payload.registerId}/${payload.seq})`, () =>
  submitTransaction(db, payload)));

const finalOrigin = getTransaction(db, purchase.tx.id);
console.log('== 结果 ==');
console.log(`  通过: ${concurrent.filter((r) => r.tx.status === 'posted').length} 笔，` +
  `拒绝: ${concurrent.filter((r) => r.tx.status === 'rejected').length} 笔`);
console.log(`  最终余额: ${getCard(db, CARD).balanceCents} 分（应为 9000）`);
console.log(`  剩余可退: ${finalOrigin.refundableCents} 分（应为 1000），已退累计: ${finalOrigin.refundedCents} 分（应为 5000）`);
console.log(`\n数据库已写入 ${DB_PATH}`);
console.log('启动 npm start 后打开 http://localhost:3000 查看对账页');
db.close();
