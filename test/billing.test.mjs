import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv } from '../lib/csv.js';
import { buildRateIndex, findRate } from '../lib/rates.js';
import { computeAll } from '../lib/billing.js';

const WAYBILLS = `waybill_no,site,region,bill_weight_kg,status,date
WB1,站点A,华东,1.0,active,2026-11-10
WB2,站点A,华东,1.2,active,2026-11-10
WB3,站点A,华南,1.0,cancelled,2026-11-10
WB4,站点A,西北,2.5,active,2026-11-10
WB5,站点B,华南,1.005,active,2026-11-11
WB6,站点B,西南,3,active,2026-11-11`;

const RATES = `region,first_kg_fee_yuan,added_kg_fee_yuan,effective_from
华东,8.00,2.00,
华南,10.00,3.50,
西南,12.00,4.00,`;

function compute() {
  const w = parseCsv(WAYBILLS);
  const r = parseCsv(RATES);
  const { index, errors } = buildRateIndex(r.rows, r.lines);
  assert.deepEqual(errors, []);
  return computeAll(w.rows, w.lines, index);
}

test('样例六单的归类与金额（分）', () => {
  const { enriched, errors } = compute();
  assert.deepEqual(errors, []);
  const byNo = Object.fromEntries(enriched.map((e) => [e.waybill_no, e]));

  assert.equal(byNo.WB1.category, 'billed');
  assert.equal(byNo.WB1.billable_kg, 1);
  assert.equal(byNo.WB1.fee_fen, 800); // 正好一公斤，只收首重

  assert.equal(byNo.WB2.category, 'billed');
  assert.equal(byNo.WB2.billable_kg, 2);
  assert.equal(byNo.WB2.fee_fen, 1000); // 800 + 1*200

  assert.equal(byNo.WB3.category, 'cancelled');
  assert.equal(byNo.WB3.fee_fen, null);
  assert.equal(byNo.WB3.rate_source, null); // 撤销短路，不查费率

  assert.equal(byNo.WB4.category, 'missing_rate');
  assert.equal(byNo.WB4.fee_fen, null);

  assert.equal(byNo.WB5.category, 'billed');
  assert.equal(byNo.WB5.billable_kg, 2);
  assert.equal(byNo.WB5.fee_fen, 1350); // 1000 + 350

  assert.equal(byNo.WB6.category, 'billed');
  assert.equal(byNo.WB6.billable_kg, 3);
  assert.equal(byNo.WB6.fee_fen, 2000); // 1200 + 2*400
});

test('billed 运单带费率原始行（文件+物理行号+原始值）', () => {
  const { enriched } = compute();
  const wb2 = enriched.find((e) => e.waybill_no === 'WB2');
  assert.deepEqual(wb2.rate_source, {
    file: 'rates.csv',
    line: 2,
    region: '华东',
    first_kg_fee_yuan: '8.00',
    added_kg_fee_yuan: '2.00',
    effective_from: null,
  });
});

test('行级错误隔离：重复运单号、非法状态、非法日期、零重量、坏金额', () => {
  const badWaybills = `waybill_no,site,region,bill_weight_kg,status,date
WB1,站点A,华东,1.0,active,2026-11-10
WB1,站点A,华东,1.0,active,2026-11-10
WB2,站点A,华东,1.0,shipped,2026-11-10
WB3,站点A,华东,1.0,active,2026-13-40
WB4,站点A,华东,0,active,2026-11-10
WB5,站点A,华东,-2,active,2026-11-10`;
  const w = parseCsv(badWaybills);
  const r = parseCsv(RATES);
  const { index } = buildRateIndex(r.rows, r.lines);
  const { enriched, errors } = computeAll(w.rows, w.lines, index);

  assert.equal(errors.length, 5);
  assert.deepEqual(
    enriched.filter((e) => e.category === 'error').map((e) => e.waybill_no),
    ['WB1', 'WB2', 'WB3', 'WB4', 'WB5'],
  );
  assert.ok(errors.every((e) => typeof e.line === 'number' && e.file === 'waybills.csv'));
});

test('费率行级错误：三位小数金额、负费率、重复区域；0 费率合法', () => {
  const badRates = `region,first_kg_fee_yuan,added_kg_fee_yuan,effective_from
华东,8.00,2.00,
华东,9.00,2.00,
华南,10.000,3.50,
西南,12.00,-4.00,`;
  const r = parseCsv(badRates);
  const { errors } = buildRateIndex(r.rows, r.lines);
  assert.equal(errors.length, 3); // 重复键 / 三位小数 / 负费率
  assert.ok(errors.some((e) => e.message.includes('重复配置')));
  assert.ok(errors.some((e) => e.message.includes('10.000')));
  assert.ok(errors.some((e) => e.message.includes('-4.00')));

  // 免运费区域：0 费率合法且能正常计费
  const freeRates = `region,first_kg_fee_yuan,added_kg_fee_yuan,effective_from
免邮区,0.00,0.00,`;
  const fr = parseCsv(freeRates);
  const built = buildRateIndex(fr.rows, fr.lines);
  assert.deepEqual(built.errors, []);
  const wb = parseCsv(`waybill_no,site,region,bill_weight_kg,status,date
W1,站点A,免邮区,3.7,active,2026-11-10`);
  const { enriched } = computeAll(wb.rows, wb.lines, built.index);
  assert.equal(enriched[0].category, 'billed');
  assert.equal(enriched[0].fee_fen, 0);
});

test('findRate: 生效日期优先级与永久行兜底', () => {
  const csv = `region,first_kg_fee_yuan,added_kg_fee_yuan,effective_from
华东,8.00,2.00,
华东,9.00,2.50,2026-10-01
华东,11.00,3.00,2026-12-01`;
  const r = parseCsv(csv);
  const { index } = buildRateIndex(r.rows, r.lines);

  assert.equal(findRate(index, '华东', '2026-09-30').firstFeeFen, 800); // 均未生效，永久兜底
  assert.equal(findRate(index, '华东', '2026-11-10').firstFeeFen, 900); // 10-01 已生效
  assert.equal(findRate(index, '华东', '2026-12-01').firstFeeFen, 1100); // 12-01 当天生效
  assert.equal(findRate(index, '西北', '2026-11-10'), null);
});

test('撤销单即使缺费率也只归 cancelled，不重复计数', () => {
  const csv = `waybill_no,site,region,bill_weight_kg,status,date
WB1,站点A,西北,1.0,cancelled,2026-11-10`;
  const w = parseCsv(csv);
  const r = parseCsv(RATES);
  const { index } = buildRateIndex(r.rows, r.lines);
  const { enriched } = computeAll(w.rows, w.lines, index);
  assert.equal(enriched[0].category, 'cancelled');
});
