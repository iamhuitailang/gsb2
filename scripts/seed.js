// 初始化演示数据：导入点击与付款，停在演示起点（晚到点击与退款只落盘不导入）。
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { ingestClicks, ingestPayments } from '../server/attribution.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = process.env.DATA_DIR ?? join(root, 'data');

if (existsSync(dataDir) && process.env.RESET !== '1') {
  console.log('data/ 已存在。如需重建请执行：RESET=1 npm run seed');
  process.exit(1);
}
rmSync(dataDir, { recursive: true, force: true });
openDb(join(dataDir, 'app.db'));

const read = (name) => readFileSync(join(root, 'samples', name));

console.log('导入点击 samples/clicks.csv：', ingestClicks(read('clicks.csv'), 'clicks.csv'));
console.log('导入付款 samples/payments.csv：', ingestPayments(read('payments.csv'), 'payments.csv'));

console.log(`
演示起点已就绪：
  O001（12:00 付款）归因 活动甲（10:00 点击 C01），O002 为直接成交。

继续在页面“数据接入”里操作：
  1. 上传 samples/late-click.csv（11:50 活动乙的晚到点击）→ O001 改归活动乙，甲 0 单、乙 1 单；
  2. 上传 samples/refunds.csv（O001 整单退款）→ 活动乙成交 1 / 退款 1 / 净 0；
  3. 在“订单查询”打开 O001，查看甲→乙改判原因与退款记录时间线。
`);
