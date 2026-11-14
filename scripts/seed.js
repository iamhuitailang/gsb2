// 初始化演示数据：
//   1) 建立 4 个仓库主数据
//   2) 2026-11-12 批次：收齐样例并发布（库存查询立即可用）
//   3) 2026-11-13 批次：只建批次和应到名单，等待逐仓导入（WH04 的样例是只有表头的零行表）
// 用法：npm run seed        （data/ 已存在时拒绝执行）
//       RESET=1 npm run seed（清空 data/ 重建）
import { rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getDb, now } from '../server/db.js';
import { getOrCreateBatch, submitUpload, publishBatch } from '../server/batches.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = process.env.DATA_DIR ?? join(root, 'data');
const uploadRoot = join(dataDir, 'uploads');
const sampleRoot = join(root, 'samples');

if (existsSync(dataDir) && process.env.RESET !== '1') {
  console.error(`数据目录已存在：${dataDir}\n如需重建请执行：RESET=1 npm run seed`);
  process.exit(1);
}
rmSync(dataDir, { recursive: true, force: true });

openDb(join(dataDir, 'app.db'));
const db = getDb();

const WAREHOUSES = [
  ['WH01', '华东一仓'],
  ['WH02', '华南二仓'],
  ['WH03', '华北三仓'],
  ['WH04', '西南四仓'],
];
const insWh = db.prepare('INSERT INTO warehouses (code, name, created_at) VALUES (?, ?, ?)');
for (const [code, name] of WAREHOUSES) insWh.run(code, name, now());
console.log('仓库主数据：', WAREHOUSES.map(([c, n]) => `${c} ${n}`).join('，'));

function uploadSampleDir(date) {
  const dir = join(sampleRoot, date);
  const detail0 = getOrCreateBatch(date);
  let detail = detail0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.csv')).sort()) {
    const whCode = file.split('-')[0];
    const buf = readFileSync(join(dir, file));
    detail = submitUpload(detail0.batch.id, whCode, file, buf, uploadRoot);
    const row = detail.warehouses.find((w) => w.whCode === whCode);
    console.log(
      `  [${date}] 接收 ${whCode} ${file}：商品 ${row.itemCount} 种，库存 ${row.totalQuantity} 件` +
      (row.isEmpty ? '（零行表）' : '')
    );
  }
  return detail;
}

console.log('\n第一天 2026-11-12：收齐并发布');
const day1 = uploadSampleDir('2026-11-12');
publishBatch(day1.batch.id);
console.log('  → 已发布，库存查询当前指向 2026-11-12 批次');

console.log('\n第二天 2026-11-13：只建批次和应到名单，等待逐仓导入');
const day2 = getOrCreateBatch('2026-11-13');
console.log(`  → 批次 #${day2.batch.id}，应到 ${day2.expectedCount} 仓，已交 0 仓`);
console.log(`  → 零行表样例：samples/2026-11-13/WH04-西南四仓.csv（只有表头）`);

console.log('\n完成。启动服务：npm start  →  http://localhost:3210');
