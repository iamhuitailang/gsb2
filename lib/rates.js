// 费率表校验、建索引与生效查找。
// 同一区域可有多条费率（按 effective_from 区分）；effective_from 留空表示永久有效。

import { yuanToFen } from './money.js';
import { isValidIsoDate } from './dates.js';

/**
 * 由费率 CSV 行构建区域索引。
 * @param {Array<Record<string,string>>} rows
 * @param {number[]} lines 每行对应的 CSV 物理行号
 * @returns {{index: Map<string, object[]>, errors: Array<{file:string,line:number,message:string}>}}
 */
export function buildRateIndex(rows, lines, fileName = 'rates.csv') {
  /** @type {Map<string, object[]>} */
  const index = new Map();
  const errors = [];
  const seenKeys = new Set();

  rows.forEach((row, i) => {
    const line = lines[i];
    const region = (row.region ?? '').trim();
    const effectiveFrom = (row.effective_from ?? '').trim() || null;
    const pushError = (message) => errors.push({ file: fileName, line, message });

    if (!region) return pushError('费率行缺少区域 region');
    if (effectiveFrom !== null && !isValidIsoDate(effectiveFrom)) {
      return pushError(`费率生效日期格式非法（需 YYYY-MM-DD）: "${row.effective_from}"`);
    }

    let firstFeeFen;
    let addedFeeFen;
    try {
      firstFeeFen = yuanToFen(row.first_kg_fee_yuan);
      addedFeeFen = yuanToFen(row.added_kg_fee_yuan);
    } catch (err) {
      return pushError(err.message);
    }

    const key = `${region}@${effectiveFrom ?? ''}`;
    if (seenKeys.has(key)) {
      return pushError(`区域[${region}]生效日[${effectiveFrom ?? '永久'}]的费率重复配置`);
    }
    seenKeys.add(key);

    const entry = {
      region,
      effectiveFrom,
      firstFeeFen,
      addedFeeFen,
      firstKgFeeYuan: row.first_kg_fee_yuan.trim(),
      addedKgFeeYuan: row.added_kg_fee_yuan.trim(),
      source: {
        file: fileName,
        line,
        region,
        first_kg_fee_yuan: row.first_kg_fee_yuan.trim(),
        added_kg_fee_yuan: row.added_kg_fee_yuan.trim(),
        effective_from: effectiveFrom,
      },
    };
    if (!index.has(region)) index.set(region, []);
    index.get(region).push(entry);
  });

  return { index, errors };
}

/**
 * 查找某区域在指定运单日期生效的费率：
 * effective_from 为空（永久）或 <= 运单日期的行中，取 effective_from 最大者；永久行兜底。
 * @returns {object|null}
 */
export function findRate(index, region, dateStr) {
  const entries = index.get(region);
  if (!entries || entries.length === 0) return null;

  let fallback = null; // 永久有效行
  let best = null;     // 已生效且生效日最大的行
  for (const entry of entries) {
    if (entry.effectiveFrom === null) {
      if (fallback === null) fallback = entry;
    } else if (entry.effectiveFrom <= dateStr) {
      if (best === null || entry.effectiveFrom > best.effectiveFrom) best = entry;
    }
  }
  return best ?? fallback;
}
