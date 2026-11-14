// 筛选与站点汇总。日期为 ISO 字符串，字典序比较即时间序。

/**
 * 按站点与日期闭区间筛选 enriched 运单。
 * @param {object[]} enriched
 * @param {{site?: string, dateFrom?: string, dateTo?: string}} filters
 */
export function filterWaybills(enriched, { site = '', dateFrom = '', dateTo = '' } = {}) {
  return enriched.filter((w) => {
    if (site && w.site !== site) return false;
    if (dateFrom && w.date < dateFrom) return false;
    if (dateTo && w.date > dateTo) return false;
    return true;
  });
}

function emptyRow(site) {
  return {
    site,
    total_fee_fen: 0,
    billed_count: 0,
    cancelled_count: 0,
    missing_rate_count: 0,
    error_count: 0,
    total_count: 0,
  };
}

function accumulate(row, w) {
  row.total_count += 1;
  switch (w.category) {
    case 'billed':
      row.billed_count += 1;
      row.total_fee_fen += w.fee_fen;
      break;
    case 'cancelled':
      row.cancelled_count += 1;
      break;
    case 'missing_rate':
      row.missing_rate_count += 1;
      break;
    case 'error':
      row.error_count += 1;
      break;
  }
}

/**
 * 按站点汇总，站点按名称排序；末尾追加 site=null 的合计行。
 * 恒等式：billed + cancelled + missing_rate + error = total_count
 * @returns {object[]}
 */
export function summarize(waybills) {
  const bySite = new Map();
  const total = emptyRow(null);

  for (const w of waybills) {
    if (!bySite.has(w.site)) bySite.set(w.site, emptyRow(w.site));
    accumulate(bySite.get(w.site), w);
    accumulate(total, w);
  }

  const rows = [...bySite.values()].sort((a, b) => a.site.localeCompare(b.site, 'zh-Hans-CN'));
  rows.push(total);
  return rows;
}

export const CATEGORIES = ['billed', 'cancelled', 'missing_rate', 'error', 'all'];

export function filterByCategory(waybills, category) {
  if (!category || category === 'all') return waybills;
  return waybills.filter((w) => w.category === category);
}
