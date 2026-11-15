// 端到端测试：node:test + 临时数据目录 + 进程内真实 HTTP 服务
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getDb } from '../server/db.js';
import { createApp } from '../server/server.js';
import { parseCsv } from '../server/csv.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'attr-test-'));
let base;
let server;

const DAY = 86400000;
const t = (h, m = 0, s = 0) => new Date(2026, 10, 15, h, m, s).getTime(); // 本地 2026-11-15

function csv(header, rows) {
  return [header, ...rows.map((r) => r.join(','))].join('\n') + '\n';
}
const clicksCsv = (rows) => csv('click_id,account_id,campaign_id,campaign_name,click_time', rows);
const paymentsCsv = (rows) => csv('order_id,account_id,payment_time', rows);
const refundsCsv = (rows) => csv('refund_id,order_id,refund_time', rows);
const stamp = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

async function ingest(type, content, name = 'f.csv') {
  const res = await fetch(`${base}/api/ingest/${type}`, {
    method: 'POST',
    headers: { 'X-Filename': encodeURIComponent(name), 'Content-Type': 'text/csv' },
    body: Buffer.from(content, 'utf8'),
  });
  return { status: res.status, data: await res.json() };
}
const sendClicks = (rows) => ingest('clicks', clicksCsv(rows));
const sendPayments = (rows) => ingest('payments', paymentsCsv(rows));
const sendRefunds = (rows) => ingest('refunds', refundsCsv(rows));

async function reportDay(date = '2026-11-15') {
  const r = await (await fetch(`${base}/api/reports?date=${date}`)).json();
  const map = {};
  for (const c of r.rows[0].campaigns) map[c.campaignName] = c;
  return map;
}
const cell = (m, name) => m[name] ?? { gross: 0, refunded: 0, net: 0 };

before(async () => {
  openDb(join(dataDir, 'test.db'));
  server = createApp({ publicDir: join(root, 'public'), samplesDir: join(root, 'samples') });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dataDir, { recursive: true, force: true });
});

test('1. 静态页与样例下载', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /本地营销归因服务/);
  const sample = await fetch(`${base}/api/samples/clicks`);
  assert.equal(sample.status, 200);
  assert.match(sample.headers.get('content-disposition'), /attachment/);
  const rows = parseCsv(Buffer.from(await sample.arrayBuffer()).toString('utf8'));
  assert.equal(rows[0][0], 'click_id');
});

test('2. 基础归因：点击后付款归该活动', async () => {
  const r1 = await sendClicks([['C101', 'A1', 'CM1', '活动一', stamp(t(9))]]);
  assert.equal(r1.data.accepted, 1);
  const r2 = await sendPayments([['O101', 'A1', stamp(t(12))]]);
  assert.equal(r2.data.accepted, 1);
  const m = await reportDay();
  assert.equal(cell(m, '活动一').gross, 1);
  const detail = await (await fetch(`${base}/api/orders/O101`)).json();
  assert.equal(detail.order.campaignName, '活动一');
  assert.equal(detail.timeline[0].kind, '初始归因');
});

test('3. 24 小时边界：正好 24h 算，早 1ms 不算', async () => {
  const pay = t(12);
  await sendClicks([
    ['C110', 'A2', 'CM_EDGE', '边界活动', stamp(pay - DAY)],       // 正好 24h，入选
    ['C111', 'A2', 'CM_OLD', '窗外活动', stamp(pay - DAY - 1)],    // 早 1ms，不入选
  ]);
  await sendPayments([['O110', 'A2', stamp(pay)]]);
  const detail = await (await fetch(`${base}/api/orders/O110`)).json();
  assert.equal(detail.order.campaignName, '边界活动');
});

test('4. 同刻点击按 click_id 字典序，靠后者获胜', async () => {
  await sendClicks([
    ['C120', 'A3', 'CM_A', '同刻甲', stamp(t(10))],
    ['C129', 'A3', 'CM_B', '同刻乙', stamp(t(10))], // 同时刻，C129 字典序靠后
  ]);
  await sendPayments([['O120', 'A3', stamp(t(11))]]);
  const detail = await (await fetch(`${base}/api/orders/O120`)).json();
  assert.equal(detail.order.clickId, 'C129');
  assert.equal(detail.order.campaignName, '同刻乙');
});

test('5. 无窗口内点击 → 直接成交', async () => {
  await sendPayments([['O130', 'A4', stamp(t(12))]]);
  const m = await reportDay();
  assert.equal(cell(m, '直接成交').gross >= 1, true);
  const detail = await (await fetch(`${base}/api/orders/O130`)).json();
  assert.equal(detail.order.campaignId, null);
});

test('6. 窗口外（更老）与未来点击都不入选', async () => {
  await sendClicks([
    ['C140', 'A5', 'CM_OLD2', '太早活动', stamp(t(11) - DAY - 1)],
    ['C141', 'A5', 'CM_FUTURE', '未来活动', stamp(t(13))], // 晚于付款
  ]);
  await sendPayments([['O140', 'A5', stamp(t(12))]]);
  const detail = await (await fetch(`${base}/api/orders/O140`)).json();
  assert.equal(detail.order.campaignId, null);
});

test('7. 晚到点击改判：甲→乙，双边计数联动且历史留痕', async () => {
  await sendClicks([['C150', 'A6', 'CM_JIA', '演示甲', stamp(t(10))]]);
  await sendPayments([['O150', 'A6', stamp(t(12))]]);
  let m = await reportDay();
  assert.equal(cell(m, '演示甲').gross, 1);
  const r = await sendClicks([['C151', 'A6', 'CM_YI', '演示乙', stamp(t(11, 50))]]);
  assert.equal(r.data.accepted, 1);
  m = await reportDay();
  assert.equal(cell(m, '演示甲').gross, 0);
  assert.equal(cell(m, '演示乙').gross, 1);
  const detail = await (await fetch(`${base}/api/orders/O150`)).json();
  assert.equal(detail.order.campaignName, '演示乙');
  const change = detail.history.find((h) => h.changeType === 'reattribute');
  assert.ok(change);
  assert.equal(change.oldCampaignName, '演示甲');
  assert.match(change.reason, /C151/);
  assert.match(change.reason, /演示甲 → 演示乙/);
  assert.equal(detail.timeline.filter((x) => x.kind === '归因改判').length, 1);
  // 初始归因的时间线标题不能被误写成“归因改判”
  assert.equal(detail.timeline[0].kind, '初始归因');
  assert.match(detail.timeline[0].title, /^初始归因：演示甲/);
  // 明细 CSV 的历史摘要列必须带活动名而不是 undefined
  const detailCsv = await (await fetch(`${base}/api/exports/orders.csv?date=2026-11-15`)).text();
  const o150Row = parseCsv(detailCsv.replace(/^﻿/, '')).find((r) => r[0] === 'O150');
  assert.match(o150Row[10], /初始归因→演示甲/);
  assert.match(o150Row[10], /演示甲→演示乙/);
  assert.doesNotMatch(o150Row[10], /undefined/);
});

test('8. 晚到但更早的点击不改变归因，不写改判历史', async () => {
  await sendClicks([['C161', 'A7', 'CM_WIN', '获胜活动', stamp(t(11))]]);
  await sendPayments([['O160', 'A7', stamp(t(12))]]);
  await sendClicks([['C160', 'A7', 'CM_LOSE', '落败活动', stamp(t(9))]]);
  const detail = await (await fetch(`${base}/api/orders/O160`)).json();
  assert.equal(detail.order.clickId, 'C161');
  assert.equal(detail.history.filter((h) => h.changeType === 'reattribute').length, 0);
});

test('9. 退款扣减 + 重复退款幂等（同单号重复、同单二次退款）', async () => {
  await sendClicks([['C170', 'A8', 'CM_R', '退款活动', stamp(t(10))]]);
  await sendPayments([['O170', 'A8', stamp(t(12))]]);
  const ok = await sendRefunds([['R170', 'O170', stamp(t(13))]]);
  assert.equal(ok.data.accepted, 1);
  let m = await reportDay();
  assert.equal(cell(m, '退款活动').gross, 1);
  assert.equal(cell(m, '退款活动').refunded, 1);
  assert.equal(cell(m, '退款活动').net, 0);
  const dup = await sendRefunds([['R170', 'O170', stamp(t(13))]]);
  assert.equal(dup.data.duplicate, 1);
  assert.equal(dup.data.accepted, 0);
  const second = await sendRefunds([['R171', 'O170', stamp(t(14))]]);
  assert.equal(second.data.errorRows, 1);
  assert.match(second.data.errors[0], /每单仅可退款一次/);
  m = await reportDay();
  assert.equal(cell(m, '退款活动').refunded, 1);
  const detail = await (await fetch(`${base}/api/orders/O170`)).json();
  assert.equal(detail.timeline.filter((x) => x.kind === '整单退款').length, 1);
});

test('10. 退款先于改判到达：退款随订单整体移到新活动', async () => {
  await sendClicks([['C180', 'A9', 'CM_OLD9', '先活动', stamp(t(10))]]);
  await sendPayments([['O180', 'A9', stamp(t(12))]]);
  await sendRefunds([['R180', 'O180', stamp(t(12, 30))]]);
  let m = await reportDay();
  assert.equal(cell(m, '先活动').gross, 1);
  assert.equal(cell(m, '先活动').refunded, 1);
  assert.equal(cell(m, '先活动').net, 0);
  await sendClicks([['C181', 'A9', 'CM_NEW9', '后活动', stamp(t(11, 50))]]);
  m = await reportDay();
  assert.equal(cell(m, '先活动').gross, 0);
  assert.equal(cell(m, '先活动').refunded, 0);
  assert.equal(cell(m, '先活动').net, 0);
  assert.equal(cell(m, '后活动').gross, 1);
  assert.equal(cell(m, '后活动').refunded, 1);
  assert.equal(cell(m, '后活动').net, 0);
});

test('11. 三类重复上传计数 + 混合文件（新增/重复/坏行）', async () => {
  await sendClicks([['C190', 'A10', 'CM_X', '计数活动', stamp(t(10))]]);
  const mixed = clicksCsv([
    ['C190', 'A10', 'CM_X', '计数活动', stamp(t(10))],   // 重复
    ['C191', 'A10', 'CM_X', '计数活动', stamp(t(10, 30))], // 新增
    ['C192', 'A10', 'CM_X', '计数活动', 'not-a-time'],    // 坏行
  ]);
  const r = await ingest('clicks', mixed);
  assert.equal(r.data.total, 3);
  assert.equal(r.data.accepted, 1);
  assert.equal(r.data.duplicate, 1);
  assert.equal(r.data.errorRows, 1);
  assert.match(r.data.errors[0], /第 4 行/);
  const again = await sendPayments([['O101', 'A1', stamp(t(12))]]); // O101 在测试 2 已存在
  assert.equal(again.data.duplicate, 1);
  assert.equal(again.data.accepted, 0);
  const db = getDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clicks WHERE click_id = ?').get('C190').n, 1);
});

test('12. 按付款日期分组、补零与范围查询', async () => {
  const t2 = new Date(2026, 10, 16, 12, 0, 0).getTime();
  const click2 = new Date(2026, 10, 16, 11, 0, 0).getTime();
  await sendClicks([['C200', 'A11', 'CM_D2', '次日活动', stamp(click2)]]);
  await sendPayments([['O200', 'A11', stamp(t2)]]);
  const day1 = await reportDay('2026-11-15');
  assert.equal(cell(day1, '次日活动').gross, 0); // 补零行存在
  const range = await (await fetch(`${base}/api/reports?startDate=2026-11-15&endDate=2026-11-16`)).json();
  assert.equal(range.dates.length, 2);
  const day2 = range.rows[1].campaigns.find((c) => c.campaignName === '次日活动');
  assert.equal(day2.gross, 1);
  assert.equal(range.startDate, '2026-11-15');
});

test('13. 汇总 CSV / 明细 CSV / JSON 报表三向对账', async () => {
  const qs = 'startDate=2026-11-15&endDate=2026-11-16';
  const json = await (await fetch(`${base}/api/reports?${qs}`)).json();
  const summaryText = await (await fetch(`${base}/api/exports/summary.csv?${qs}`)).text();
  const detailText = await (await fetch(`${base}/api/exports/orders.csv?${qs}`)).text();
  const sRows = parseCsv(summaryText.replace(/^﻿/, ''));
  const dRows = parseCsv(detailText.replace(/^﻿/, ''));

  // 明细按 日期+活动 聚合
  const agg = new Map();
  for (const r of dRows.slice(1)) {
    const key = `${r[3]}|${r[5]}`;
    const cur = agg.get(key) ?? { gross: 0, refunded: 0 };
    cur.gross += 1;
    if (r[7] === '是') cur.refunded += 1;
    agg.set(key, cur);
  }
  // 汇总数据行（跳过表头、空行、区间合计块）
  const dataRows = sRows.slice(1).filter((r) => /^2026-11-\d\d$/.test(r[0] ?? ''));
  for (const r of dataRows) {
    const key = `${r[0]}|${r[2]}`;
    const a = agg.get(key) ?? { gross: 0, refunded: 0 };
    assert.equal(Number(r[3]), a.gross, `成交对不上: ${key}`);
    assert.equal(Number(r[4]), a.refunded, `退款对不上: ${key}`);
    assert.equal(Number(r[5]), a.gross - a.refunded, `净单数对不上: ${key}`);
  }
  // JSON 报表总计与汇总 CSV 总计一致
  const jsonTotalGross = json.totals.reduce((s, c) => s + c.gross, 0);
  const csvTotalGross = dataRows.reduce((s, r) => s + Number(r[3]), 0);
  assert.equal(jsonTotalGross, csvTotalGross);
  assert.equal(jsonTotalGross, dRows.length - 1);
});

test('14. CSV 校验：缺表头整文件 400、BOM、引号、列乱序、错误封顶', async () => {
  const bad = await ingest('clicks', 'click_id,account_id\nC1,A1\n');
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /缺少必填列/);

  const bom = '﻿click_time,click_id,account_id,campaign_id,campaign_name\n' +
    `"2026-11-15 10:00:00","C210","A12","CM_Q","引号,活动"\n`;
  const ok = await ingest('clicks', bom);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.accepted, 1);
  const db = getDb();
  assert.equal(db.prepare('SELECT campaign_name AS n FROM clicks WHERE click_id = ?').get('C210').n, '引号,活动');

  const many = clicksCsv(Array.from({ length: 12 }, (_, i) =>
    [`CX${i}`, 'A13', 'CM', '坏时间活动', 'bad']));
  const capped = await ingest('clicks', many);
  assert.equal(capped.data.errorRows, 12);
  assert.equal(capped.data.errors.length, 11); // 10 条 + 概括句
  assert.match(capped.data.errors[10], /另有 2 个错误/);
});

test('15. 未知订单退款拒绝；订单 404；退款后时间线仍可查', async () => {
  const r = await sendRefunds([['R900', 'O_UNKNOWN', stamp(t(12))]]);
  assert.equal(r.data.errorRows, 1);
  assert.match(r.data.errors[0], /订单 O_UNKNOWN 不存在/);
  const res = await fetch(`${base}/api/orders/O_UNKNOWN`);
  assert.equal(res.status, 404);
  const detail = await (await fetch(`${base}/api/orders/O170`)).json();
  assert.ok(detail.timeline.some((x) => x.kind === '整单退款'));
});

test('16. 乱序到达最终态收敛（付款先于点击 vs 点击先于付款）', async () => {
  // 顺序 A：先付款后补点击
  await sendPayments([['O300', 'A20', stamp(t(12))]]);
  await sendClicks([['C300', 'A20', 'CM_CONV', '收敛活动', stamp(t(11))]]);
  const a = await (await fetch(`${base}/api/orders/O300`)).json();
  // 顺序 B：先点击后付款
  await sendClicks([['C310', 'A21', 'CM_CONV', '收敛活动', stamp(t(11))]]);
  await sendPayments([['O310', 'A21', stamp(t(12))]]);
  const b = await (await fetch(`${base}/api/orders/O310`)).json();
  assert.equal(a.order.campaignId, b.order.campaignId);
  assert.equal(a.order.campaignId, 'CM_CONV');
  assert.equal(b.order.campaignId, 'CM_CONV');
});

test('17. 上传批次列表持久化计数', async () => {
  const list = await (await fetch(`${base}/api/ingest/batches`)).json();
  assert.ok(list.length >= 5);
  const first = list[0];
  assert.ok(['click', 'payment', 'refund'].includes(first.recordType));
  assert.equal(typeof first.accepted, 'number');
  assert.ok(Array.isArray(first.errors));
});
