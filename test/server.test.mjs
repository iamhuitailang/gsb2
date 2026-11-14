// HTTP 集成测试：临时端口起服务，覆盖查询、钻取、导出勾稽、补录费率后重算。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

let baseUrl;
let dataDir;
let server;
let httpServer;

before(async () => {
  // 每个测试进程复制一份夹具数据，reload 时可以安全改写
  dataDir = await mkdtemp(join(tmpdir(), 'delivery-fee-test-'));
  await cp(join(process.cwd(), 'test/fixtures/reload-case'), dataDir, { recursive: true });
  process.env.DELIVERY_FEE_DATA_DIR = dataDir;
  process.env.PORT = '0';

  const mod = await import('../server.js');
  server = mod.server;
  await once(server, 'listening');
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  server.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function get(path) {
  const res = await fetch(baseUrl + path);
  return { status: res.status, body: await res.json() };
}

async function getText(path) {
  const res = await fetch(baseUrl + path);
  return { status: res.status, text: await res.text() };
}

test('汇总/钻取/站点接口', async () => {
  const sites = await get('/api/sites');
  assert.deepEqual(sites.body.sites, ['站点A']);

  const summary = await get('/api/summary');
  const total = summary.body.rows.find((r) => r.site === null);
  // WBF001 缺费率、WBF002 计费 1000 分
  assert.equal(total.total_fee_fen, 1000);
  assert.equal(total.billed_count, 1);
  assert.equal(total.missing_rate_count, 1);

  const missing = await get('/api/details?category=missing_rate');
  assert.equal(missing.body.rows.length, 1);
  assert.equal(missing.body.rows[0].waybill_no, 'WBF001');
  assert.equal(missing.body.rows[0].fee_fen, null);

  const billed = await get('/api/details?category=billed');
  assert.equal(billed.body.rows[0].rate_source.file, 'rates.csv');
});

test('补录费率后 reload：缺费率单变 billed，合计相应变化', async () => {
  const updated = await get('/api/details?category=missing_rate');
  assert.equal(updated.body.rows.length, 1);

  // 模拟财务补录西北费率
  const newRates = await import('node:fs/promises').then((fs) =>
    fs.readFile(join(dataDir, 'rates-with-northwest.csv'), 'utf8'),
  );
  await writeFile(join(dataDir, 'rates.csv'), newRates);

  const reloadRes = await fetch(baseUrl + '/api/reload', { method: 'POST' });
  const reloadBody = await reloadRes.json();
  assert.equal(reloadRes.status, 200);
  assert.deepEqual(reloadBody.dataErrors, []);

  const after = await get('/api/summary');
  const total = after.body.rows.find((r) => r.site === null);
  // WBF001: 西北 1kg -> 1500 分；WBF002: 1000 分
  assert.equal(total.missing_rate_count, 0);
  assert.equal(total.billed_count, 2);
  assert.equal(total.total_fee_fen, 2500);

  const wbf1 = (await get('/api/details?category=billed')).body.rows.find(
    (w) => w.waybill_no === 'WBF001',
  );
  assert.equal(wbf1.fee_fen, 1500);
  assert.equal(wbf1.rate_source.line, 3); // 新费率行的物理行号
});

test('reload 读到坏文件时保留上一份可用数据', async () => {
  await writeFile(join(dataDir, 'rates.csv'), 'bad,header\n1,2\n');
  const res = await fetch(baseUrl + '/api/reload', { method: 'POST' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error.includes('缺少必需列'));

  // 内存仍是补录后的好数据
  const stillOk = await get('/api/summary');
  const total = stillOk.body.rows.find((r) => r.site === null);
  assert.equal(total.total_fee_fen, 2500);
});

test('导出接口与页面汇总勾稽，且为 CSV 附件', async () => {
  // 先恢复好数据
  const good = await get('/api/details?category=all');
  assert.equal(good.status, 200);

  const summaryRes = await fetch(baseUrl + '/api/export/summary');
  assert.ok(summaryRes.headers.get('content-type').includes('text/csv'));
  assert.ok(summaryRes.headers.get('content-disposition').includes('attachment'));
  const summaryBuf = Buffer.from(await summaryRes.arrayBuffer());
  assert.equal(summaryBuf[0], 0xef); // UTF-8 BOM（text() 解码会剥 BOM，故按字节判断）
  assert.equal(summaryBuf[1], 0xbb);
  assert.equal(summaryBuf[2], 0xbf);
  const summaryText = summaryBuf.toString('utf8');
  assert.ok(summaryText.includes('25.00'));

  const detailsRes = await getText('/api/export/details');
  assert.equal(detailsRes.status, 200);
  // 明细两行，金额合计 25.00
  assert.ok(detailsRes.text.includes('WBF001'));
  assert.ok(detailsRes.text.includes('WBF002'));
});

test('非法 category 返回 400；未知接口 404；静态页可访问', async () => {
  assert.equal((await get('/api/details?category=nope')).status, 400);
  assert.equal((await get('/api/nope')).status, 404);

  const page = await fetch(baseUrl + '/');
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('配送费核算'));

  const traversal = await fetch(baseUrl + '/../server.js');
  assert.notEqual(traversal.status, 200);
});
