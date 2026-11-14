// 汇总表渲染。金额与各单数都是可点击钻取链接，携带当前筛选条件。

import { fenToYuan, escapeHtml } from './format.js';

function drillCell(value, filters, category) {
  const params = new URLSearchParams({ ...filters, category });
  return `<a class="drill" href="#details?${params.toString()}">${escapeHtml(value)}</a>`;
}

export function renderSummary(rows, filters) {
  const tbody = document.querySelector('#summary-table tbody');
  if (rows.length === 1 && rows[0].total_count === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">当前筛选条件下没有运单</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      const isTotal = r.site === null;
      const site = isTotal ? '合计' : escapeHtml(r.site);
      return `
        <tr class="${isTotal ? 'total-row' : ''}">
          <td>${site}</td>
          <td>${drillCell(`¥${fenToYuan(r.total_fee_fen)}`, filters, 'billed')}</td>
          <td>${drillCell(r.billed_count, filters, 'billed')}</td>
          <td>${drillCell(r.cancelled_count, filters, 'cancelled')}</td>
          <td>${drillCell(r.missing_rate_count, filters, 'missing_rate')}</td>
          <td>${drillCell(r.error_count, filters, 'error')}</td>
          <td>${drillCell(r.total_count, filters, 'all')}</td>
        </tr>`;
    })
    .join('');
}
