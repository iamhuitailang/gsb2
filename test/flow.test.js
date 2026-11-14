// 端到端冒烟测试：node:test + 临时数据目录 + 真实 HTTP 服务
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getDb, now } from '../server/db.js';
import { createApp } from '../server/server.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'inv-test-'));
let base;
let server;

const csv = (rows) => ['sku,product_name,quantity', ...rows.map((r) => r.join(','))].join('\n') + '\n';
const ZERO_ROW = 'sku,product_name,quantity\n';

async function putCsv(batchId, whCode, content, name) {
  const res = await fetch(`${base}/api/batches/${batchId}/warehouses/${whCode}/submission`, {
    method: 'PUT',
    headers: { 'X-Filename': encodeURIComponent(name ?? `${whCode}.csv`), 'Content-Type': 'text/csv' },
    body: Buffer.from(content, 'utf8'),
  });
  const data = await res.json();
  return { status: res.status, data };
}

before(async () => {
  openDb(join(dataDir, 'test.db'));
  const db = getDb();
  for (const [code, name] of [['WH01', '华东一仓'], ['WH02', '华南二仓'], ['WH03', '华北三仓']]) {
    db.prepare('INSERT INTO warehouses (code, name, created_at) VALUES (?, ?, ?)').run(code, name, now());
  }
  server = createApp({ publicDir: join(root, 'public'), uploadRoot: join(dataDir, 'uploads') });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dataDir, { recursive: true, force: true });
});

test('建批次：返回应到仓库名单，全部为未交表', async () => {
  const res = await fetch(`${base}/api/batches`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ countDate: '2026-11-12' }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.expectedCount, 3);
  assert.equal(data.submittedCount, 0);
  assert.equal(data.allSubmitted, false);
  assert.deepEqual(data.warehouses.map((w) => w.status), ['missing', 'missing', 'missing']);
});

test('错误文件被拒：缺列、负数、重复 sku、空文件', async () => {
  const bad = [
    'sku,name\nA,x\n',                                   // 缺 quantity 列
    csv([['SKU-X', '鼠标', '-1']]),                      // 负数
    csv([['SKU-X', '鼠标', '1'], ['SKU-X', '键盘', '2']]), // 重复 sku
    '',                                                  // 完全空文件
  ];
  for (const content of bad) {
    const { status } = await putCsv(1, 'WH01', content);
    assert.equal(status, 400);
  }
  // 全部失败后该仓仍应是 missing，没有产生任何草稿
  const detail = await (await fetch(`${base}/api/batches/1`)).json();
  assert.equal(detail.warehouses[0].status, 'missing');
});

test('正常接收：商品数与库存合计正确，带逗号的引号字段能解析', async () => {
  const content = csv([
    ['SKU-1001', '无线鼠标', '120'],
    ['SKU-1004', '"HDMI线, 2米"', '60'],
  ]);
  const { status, data } = await putCsv(1, 'WH01', content, 'WH01-华东一仓.csv');
  assert.equal(status, 200);
  const w = data.warehouses.find((x) => x.whCode === 'WH01');
  assert.equal(w.status, 'submitted');
  assert.equal(w.itemCount, 2);
  assert.equal(w.totalQuantity, 180);
  assert.equal(w.isEmpty, false);
  assert.equal(w.version, 1);

  const preview = await (await fetch(`${base}/api/batches/1/preview`)).json();
  const hdmi = preview.previewItems.find((i) => i.sku === 'SKU-1004');
  assert.equal(hdmi.productName, 'HDMI线, 2米');
});

test('零行表（只有表头）：状态是已交、零商品、零库存，与未交表区分开', async () => {
  const { data } = await putCsv(1, 'WH02', ZERO_ROW);
  const w2 = data.warehouses.find((x) => x.whCode === 'WH02');
  assert.equal(w2.status, 'submitted');
  assert.equal(w2.isEmpty, true);
  assert.equal(w2.itemCount, 0);
  assert.equal(w2.totalQuantity, 0);
  const w3 = data.warehouses.find((x) => x.whCode === 'WH03');
  assert.equal(w3.status, 'missing'); // 未交表依然是 missing
});

test('没收齐不能发布', async () => {
  const res = await fetch(`${base}/api/batches/1/publish`, { method: 'POST' });
  assert.equal(res.status, 409);
});

test('发布前没有已发布批次时，库存查询为空', async () => {
  const inv = await (await fetch(`${base}/api/inventory`)).json();
  assert.equal(inv.currentBatch, null);
  assert.deepEqual(inv.items, []);
});

test('重交只替换该仓草稿：version+1、明细被替换，其它仓不受影响', async () => {
  const before = await (await fetch(`${base}/api/batches/1`)).json();
  assert.equal(before.warehouses.find((x) => x.whCode === 'WH02').version, 1);

  const { data } = await putCsv(1, 'WH02', csv([
    ['SKU-2001', '摄像头', '12'],
    ['SKU-2002', '支架', '8'],
  ]));
  const w2 = data.warehouses.find((x) => x.whCode === 'WH02');
  assert.equal(w2.version, 2);
  assert.equal(w2.itemCount, 2);
  assert.equal(w2.totalQuantity, 20);
  // WH01 仍是 v1
  assert.equal(data.warehouses.find((x) => x.whCode === 'WH01').version, 1);

  const db = getDb();
  const wh2Rows = db.prepare('SELECT sku FROM draft_items WHERE batch_id=1 AND wh_code=?').all('WH02');
  assert.deepEqual(wh2Rows.map((r) => r.sku).sort(), ['SKU-2001', 'SKU-2002']);
  // 旧版本文件应已清理，当前版本文件存在
  assert.equal(existsSync(join(dataDir, 'uploads', 'batch-1', 'WH02-v1.csv')), false);
  assert.equal(existsSync(join(dataDir, 'uploads', 'batch-1', 'WH02-v2.csv')), true);
});

test('收齐后发布：库存查询一次切到该批次，零行表仓库无库存行', async () => {
  const { status } = await putCsv(1, 'WH03', csv([['SKU-3001', '网线', '200']]));
  assert.equal(status, 200);
  const pub = await (await fetch(`${base}/api/batches/1/publish`, { method: 'POST' })).json();
  assert.equal(pub.batch.status, 'published');

  const inv = await (await fetch(`${base}/api/inventory`)).json();
  assert.equal(inv.currentBatch.countDate, '2026-11-12');
  const skus = inv.items.map((i) => i.sku).sort();
  assert.deepEqual(skus, ['SKU-1001', 'SKU-1004', 'SKU-2001', 'SKU-2002', 'SKU-3001']);
  // WH03 搜索 + 关键字过滤
  const wh3 = await (await fetch(`${base}/api/inventory?whCode=WH03`)).json();
  assert.equal(wh3.items.length, 1);
  const search = await (await fetch(`${base}/api/inventory?q=鼠标`)).json();
  assert.equal(search.items[0].sku, 'SKU-1001');
});

test('发布后批次锁定：不能再上传，重复发布返回冲突', async () => {
  const up = await putCsv(1, 'WH01', csv([['SKU-9999', '幽灵商品', '1']]));
  assert.equal(up.status, 409);
  const pub = await fetch(`${base}/api/batches/1/publish`, { method: 'POST' });
  assert.equal(pub.status, 409);
});

test('新批次接收期间，库存查询仍锁定上一批，不会混用两个日期', async () => {
  const created = await (await fetch(`${base}/api/batches`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ countDate: '2026-11-13' }),
  })).json();
  await putCsv(created.batch.id, 'WH01', csv([
    ['SKU-1001', '无线鼠标', '1'],   // 与上一批同 SKU 但数量不同
    ['SKU-9001', '新商品', '3'],
  ]));
  const inv = await (await fetch(`${base}/api/inventory`)).json();
  assert.equal(inv.currentBatch.countDate, '2026-11-12'); // 还是上一批
  const mouse = inv.items.find((i) => i.sku === 'SKU-1001');
  assert.equal(mouse.quantity, 120);                       // 上一批的值
  assert.equal(inv.items.some((i) => i.sku === 'SKU-9001'), false);

  // 收齐（含零行表）并发布后整体切换
  await putCsv(created.batch.id, 'WH02', ZERO_ROW);
  await putCsv(created.batch.id, 'WH03', csv([['SKU-3001', '网线', '50']]));
  const pub2 = await (await fetch(`${base}/api/batches/${created.batch.id}/publish`, {
    method: 'POST',
  })).json();
  assert.equal(pub2.batch.status, 'published');

  const inv2 = await (await fetch(`${base}/api/inventory`)).json();
  assert.equal(inv2.currentBatch.countDate, '2026-11-13');
  assert.equal(inv2.items.find((i) => i.sku === 'SKU-1001').quantity, 1);
  assert.equal(inv2.items.find((i) => i.sku === 'SKU-9001').quantity, 3);
  // 零行表 WH02 没有任何库存行
  assert.equal(inv2.items.some((i) => i.whCode === 'WH02'), false);
});

test('发布后仍可下载各仓库当时交的原始文件（含零行表）', async () => {
  const res = await fetch(`${base}/api/batches/2/warehouses/WH02/file`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text, ZERO_ROW);
  assert.match(res.headers.get('content-disposition'), /attachment/);
});

test('非应到仓库上传返回 404，静态页可访问', async () => {
  const r1 = await putCsv(2, 'WH99', csv([['X', 'x', '1']]));
  assert.equal(r1.status, 404);
  const r2 = await fetch(`${base}/`);
  assert.equal(r2.status, 200);
  assert.match(await r2.text(), /盘点批次接收/);
});
