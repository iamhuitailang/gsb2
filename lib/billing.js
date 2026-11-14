// 计费的唯一事实来源。汇总、钻取、导出都只消费本模块产出的 enriched 记录，
// 任何接口不得自行重算金额。
//
// 判定优先级固定：行级字段校验 -> 状态（cancelled 短路）-> 费率匹配 -> 计费。

import { ceilWeightKg } from './weight.js';
import { fenToYuan } from './money.js';
import { findRate } from './rates.js';
import { isValidIsoDate } from './dates.js';

const VALID_STATUS = new Set(['active', 'cancelled']);

/**
 * 计算全部运单。
 * @param {Array<Record<string,string>>} rows
 * @param {number[]} lines
 * @param {Map<string, object[]>} rateIndex
 * @param {string} fileName
 */
export function computeAll(rows, lines, rateIndex, fileName = 'waybills.csv') {
  const enriched = [];
  const errors = [];
  const seenWaybillNos = new Set();

  rows.forEach((row, i) => {
    const line = lines[i];
    const result = computeOne(row, rateIndex, { line, fileName, seenWaybillNos });
    if (result.error) {
      errors.push({ file: fileName, line, message: result.error, waybillNo: row.waybill_no ?? '' });
    }
    enriched.push(result.record);
  });

  return { enriched, errors };
}

function computeOne(row, rateIndex, { line, fileName, seenWaybillNos }) {
  const waybillNo = (row.waybill_no ?? '').trim();
  const site = (row.site ?? '').trim();
  const region = (row.region ?? '').trim();
  const status = (row.status ?? '').trim();
  const rawWeight = (row.bill_weight_kg ?? '').trim();
  const date = (row.date ?? '').trim();

  const base = {
    waybill_no: waybillNo,
    site,
    region,
    bill_weight_kg: rawWeight,
    status,
    date,
    sourceLine: line,
  };
  const fail = (message) => ({
    error: message,
    record: { ...base, category: 'error', fee_fen: null, calc_text: `数据异常：${message}` },
  });

  if (!waybillNo) return fail('运单号 waybill_no 为空');
  if (seenWaybillNos.has(waybillNo)) return fail(`运单号重复: ${waybillNo}`);
  seenWaybillNos.add(waybillNo);

  if (!site) return fail('站点 site 为空');
  if (!region) return fail('区域 region 为空');
  if (!VALID_STATUS.has(status)) {
    return fail(`运单状态非法（仅允许 active/cancelled）: "${status}"`);
  }
  if (!isValidIsoDate(date)) return fail(`运单日期格式非法（需 YYYY-MM-DD）: "${row.date}"`);

  let billableKg;
  try {
    billableKg = ceilWeightKg(rawWeight);
  } catch (err) {
    return fail(err.message);
  }
  if (billableKg <= 0) return fail(`计费重量必须大于 0: "${rawWeight}"`);

  // 撤销单短路：不计费，也不再查费率（避免与缺费率重复归类）
  if (status === 'cancelled') {
    return {
      error: null,
      record: {
        ...base,
        category: 'cancelled',
        billable_kg: billableKg,
        fee_fen: null,
        first_fee_fen: null,
        added_kg: null,
        added_fee_fen: null,
        rate_source: null,
        calc_text: '运单已撤销，不计费',
      },
    };
  }

  const rate = findRate(rateIndex, region, date);
  if (!rate) {
    return {
      error: null,
      record: {
        ...base,
        category: 'missing_rate',
        billable_kg: billableKg,
        fee_fen: null,
        first_fee_fen: null,
        added_kg: null,
        added_fee_fen: null,
        rate_source: null,
        calc_text: `区域[${region}]在 ${date} 没有配置生效费率，请补录 rates.csv 后重算`,
      },
    };
  }

  const addedKg = billableKg - 1;
  const feeFen = rate.firstFeeFen + addedKg * rate.addedFeeFen;
  const calcText =
    `ceil(${rawWeight})=${billableKg}kg；` +
    `首重 ${fenToYuan(rate.firstFeeFen)} 元` +
    (addedKg > 0
      ? ` + 续重 ${addedKg}kg × ${fenToYuan(rate.addedFeeFen)} 元 = ${fenToYuan(feeFen)} 元`
      : ` = ${fenToYuan(feeFen)} 元`);

  return {
    error: null,
    record: {
      ...base,
      category: 'billed',
      billable_kg: billableKg,
      fee_fen: feeFen,
      first_fee_fen: rate.firstFeeFen,
      added_kg: addedKg,
      added_fee_fen: rate.addedFeeFen,
      rate_source: { ...rate.source },
      calc_text: calcText,
    },
  };
}
