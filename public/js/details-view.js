// 明细视图：每单展示取整、计算过程、费率原始行与状态徽章。

import { fenToYuan, escapeHtml, CATEGORY_LABEL } from './format.js';

function rateSourceHtml(w) {
  if (!w.rate_source) return '—';
  const r = w.rate_source;
  return escapeHtml(
    `${r.file} 第${r.line}行｜区域:${r.region}｜首公斤:${r.first_kg_fee_yuan}元` +
      `｜续公斤:${r.added_kg_fee_yuan}元｜生效日:${r.effective_from || '永久'}`,
  );
}

export function renderDetails(rows, category) {
  document.getElementById('details-title').textContent =
    `运单明细 — ${category === 'all' ? '全部' : CATEGORY_LABEL[category] || category}（${rows.length} 单）`;
  document.getElementById('missing-tip').classList.toggle('hidden', category !== 'missing_rate');

  document.querySelectorAll('#category-tabs button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.category === category);
  });

  const tbody = document.querySelector('#details-table tbody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">该类别下没有运单</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map(
      (w) => `
      <tr>
        <td>${escapeHtml(w.waybill_no)}</td>
        <td>${escapeHtml(w.site)}</td>
        <td>${escapeHtml(w.region)}</td>
        <td>${escapeHtml(w.date)}</td>
        <td><span class="badge badge-${w.category}">${escapeHtml(CATEGORY_LABEL[w.category] || w.category)}</span></td>
        <td>${escapeHtml(w.bill_weight_kg)}</td>
        <td>${w.billable_kg ?? '—'}</td>
        <td>${fenToYuan(w.fee_fen)}</td>
        <td class="calc">${escapeHtml(w.calc_text)}</td>
        <td class="rate-src">${rateSourceHtml(w)}</td>
      </tr>`,
    )
    .join('');
}

export function renderErrors(dataErrors) {
  const banner = document.getElementById('error-banner');
  if (!dataErrors || dataErrors.length === 0) {
    banner.classList.add('hidden');
    banner.innerHTML = '';
    return;
  }
  banner.classList.remove('hidden');
  banner.innerHTML =
    `共 ${dataErrors.length} 条数据错误（异常单不计费，已在明细「数据异常」中列出）：` +
    dataErrors
      .map((e) => `<div class="err-line">${escapeHtml(`${e.file} 第${e.line}行：${e.message}`)}</div>`)
      .join('');
}
