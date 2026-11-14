// 导出 CSV。与屏幕汇总、钻取共用同一份 enriched/筛选结果，只做格式转换，
// 因此导出数字与页面所见在结构上必然一致。

import { serializeCsv } from './csv.js';
import { fenToYuan } from './money.js';

const CATEGORY_LABEL = {
  billed: '计费',
  cancelled: '已撤销',
  missing_rate: '缺费率',
  error: '数据异常',
};

const SUMMARY_HEADERS = [
  '站点',
  '计费金额(元)',
  '计费单数',
  '撤销单数',
  '缺费率单数',
  '异常单数',
  '总单数',
];

/** @param {object[]} summaryRows summarize() 的返回（含合计行） */
export function buildSummaryCsv(summaryRows) {
  const rows = summaryRows.map((r) => [
    r.site ?? '合计',
    fenToYuan(r.total_fee_fen),
    r.billed_count,
    r.cancelled_count,
    r.missing_rate_count,
    r.error_count,
    r.total_count,
  ]);
  return serializeCsv(SUMMARY_HEADERS, rows);
}

const DETAIL_HEADERS = [
  '运单号',
  '站点',
  '区域',
  '业务日期',
  '状态',
  '归类',
  '计费重量(kg)',
  '取整后(kg)',
  '首重费用(元)',
  '续重公斤',
  '续重费用(元)',
  '配送费(元)',
  '费率来源文件',
  '费率来源行号',
  '费率首公斤价(元)',
  '费率续公斤价(元)',
  '费率生效日',
  '计算过程',
];

/** @param {object[]} enriched 已按筛选/类别过滤的 enriched 运单 */
export function buildDetailsCsv(enriched) {
  const rows = enriched.map((w) => [
    w.waybill_no,
    w.site,
    w.region,
    w.date,
    w.status,
    CATEGORY_LABEL[w.category] ?? w.category,
    w.bill_weight_kg,
    w.billable_kg ?? '',
    w.first_fee_fen === null || w.first_fee_fen === undefined ? '' : fenToYuan(w.first_fee_fen),
    w.added_kg ?? '',
    w.added_fee_fen === null || w.added_fee_fen === undefined ? '' : fenToYuan(w.added_fee_fen),
    w.fee_fen === null ? '' : fenToYuan(w.fee_fen),
    w.rate_source?.file ?? '',
    w.rate_source?.line ?? '',
    w.rate_source?.first_kg_fee_yuan ?? '',
    w.rate_source?.added_kg_fee_yuan ?? '',
    w.rate_source?.effective_from ?? '',
    w.calc_text,
  ]);
  return serializeCsv(DETAIL_HEADERS, rows);
}

export { CATEGORY_LABEL };
