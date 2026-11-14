// 勾稽测试核心：屏幕汇总、钻取明细、导出 CSV 三方必须对得上。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv } from '../lib/csv.js';
import { buildRateIndex } from '../lib/rates.js';
import { computeAll } from '../lib/billing.js';
import { filterByCategory, filterWaybills, summarize } from '../lib/aggregate.js';
import { buildDetailsCsv, buildSummaryCsv } from '../lib/export.js';
import { fenToYuan } from '../lib/money.js';

const WAYBILLS = `waybill_no,site,region,bill_weight_kg,status,date
WB2026111001,站点A,华东,1.0,active,2026-11-10
WB2026111002,站点A,华东,1.2,active,2026-11-10
WB2026111003,站点A,华南,1.0,cancelled,2026-11-10
WB2026111004,站点A,西北,2.5,active,2026-11-10
WB2026111101,站点B,华南,1.005,active,2026-11-11
WB2026111102,站点B,西南,3,active,2026-11-11`;

const RATES = `region,first_kg_fee_yuan,added_kg_fee_yuan,effective_from
华东,8.00,2.00,
华南,10.00,3.50,
西南,12.00,4.00,`;

function load() {
  const w = parseCsv(WAYBILLS);
  const r = parseCsv(RATES);
  const { index } = buildRateIndex(r.rows, r.lines);
  return computeAll(w.rows, w.lines, index).enriched;
}

// 多组筛选，每组都做全套勾稽
const FILTER_CASES = [
  {},
  { site: '站点A' },
  { site: '站点B' },
  { dateFrom: '2026-11-10', dateTo: '2026-11-10' },
  { dateFrom: '2026-11-11' },
  { dateTo: '2026-11-09' }, // 无数据区间
  { site: '站点A', dateFrom: '2026-11-10', dateTo: '2026-11-11' },
];

test('汇总金额 = 同筛选 billed 明细费用之和；count 恒等式成立', () => {
  const all = load();
  for (const filters of FILTER_CASES) {
    const scoped = filterWaybills(all, filters);
    const rows = summarize(scoped);
    const totalRow = rows.find((r) => r.site === null);

    // 明细侧独立求和
    const billed = filterByCategory(scoped, 'billed');
    const detailSum = billed.reduce((acc, w) => acc + w.fee_fen, 0);
    assert.equal(totalRow.total_fee_fen, detailSum, `筛选 ${JSON.stringify(filters)} 金额勾稽失败`);

    // 各类别单数之和 = 总单数
    for (const row of rows) {
      assert.equal(
        row.billed_count + row.cancelled_count + row.missing_rate_count + row.error_count,
        row.total_count,
        `筛选 ${JSON.stringify(filters)} 单数恒等式失败`,
      );
    }

    // 合计行 = 各站点行之和
    const siteRows = rows.filter((r) => r.site !== null);
    for (const key of [
      'total_fee_fen',
      'billed_count',
      'cancelled_count',
      'missing_rate_count',
      'error_count',
      'total_count',
    ]) {
      assert.equal(
        totalRow[key],
        siteRows.reduce((acc, r) => acc + r[key], 0),
        `合计行字段 ${key} 不等于站点行之和`,
      );
    }
  }
});

test('样例数据预期合计：站点A ¥18.00、站点B ¥33.50、总计 ¥51.50', () => {
  const rows = summarize(load());
  const a = rows.find((r) => r.site === '站点A');
  const b = rows.find((r) => r.site === '站点B');
  const total = rows.find((r) => r.site === null);

  assert.equal(a.total_fee_fen, 1800);
  assert.deepEqual(
    [a.billed_count, a.cancelled_count, a.missing_rate_count, a.total_count],
    [2, 1, 1, 4],
  );
  assert.equal(b.total_fee_fen, 3350);
  assert.equal(b.total_count, 2);
  assert.equal(total.total_fee_fen, 5150);
  assert.equal(fenToYuan(total.total_fee_fen), '51.50');
});

test('导出的两份 CSV 读回后与汇总/明细三方一致', () => {
  const all = load();
  for (const filters of FILTER_CASES) {
    const scoped = filterWaybills(all, filters);
    const summaryRows = summarize(scoped);

    const summaryCsv = parseCsv(buildSummaryCsv(summaryRows));
    const detailsCsv = parseCsv(buildDetailsCsv(scoped));

    // 明细导出按站点独立累加「配送费(元)」，与汇总导出的每个金额单元格比对
    const feeBySiteFromDetails = new Map();
    let detailGrand = 0;
    for (const d of detailsCsv.rows) {
      if (d['归类'] !== '计费') continue;
      // 元字符串转分做整数比较，避免浮点
      const [y, c = ''] = d['配送费(元)'].split('.');
      const fen = Number(y) * 100 + Number(c.padEnd(2, '0'));
      feeBySiteFromDetails.set(d['站点'], (feeBySiteFromDetails.get(d['站点']) || 0) + fen);
      detailGrand += fen;
    }

    for (const row of summaryRows) {
      const key = row.site ?? '合计';
      const csvRow = summaryCsv.rows.find((x) => x['站点'] === key);
      assert.ok(csvRow, `汇总导出缺少行: ${key}`);
      const [y, c = ''] = csvRow['计费金额(元)'].split('.');
      const csvFen = Number(y) * 100 + Number(c.padEnd(2, '0'));
      assert.equal(csvFen, row.total_fee_fen, `汇总导出与页面不一致: ${key}`);

      const expectedDetail = row.site === null ? detailGrand : feeBySiteFromDetails.get(row.site) || 0;
      assert.equal(csvFen, expectedDetail, `汇总导出与明细导出勾稽失败: ${key}`);

      // 单数同样勾稽
      assert.equal(Number(csvRow['总单数']), row.total_count);
    }

    // 明细导出行数 = 筛选范围内运单总数（含撤销/缺费率/异常）
    assert.equal(detailsCsv.rows.length, scoped.length);
  }
});

test('明细导出包含费率原始行与计算过程列', () => {
  const csv = parseCsv(buildDetailsCsv(load()));
  const wb2 = csv.rows.find((r) => r['运单号'] === 'WB2026111002');
  assert.equal(wb2['费率来源文件'], 'rates.csv');
  assert.equal(wb2['费率来源行号'], '2');
  assert.equal(wb2['费率首公斤价(元)'], '8.00');
  assert.ok(wb2['计算过程'].includes('ceil(1.2)=2kg'));
  const cancelled = csv.rows.find((r) => r['运单号'] === 'WB2026111003');
  assert.equal(cancelled['配送费(元)'], '');
  assert.equal(cancelled['归类'], '已撤销');
});
