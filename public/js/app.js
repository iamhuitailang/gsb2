// 控制器：事件绑定、视图切换、筛选状态在查询/钻取/导出之间保持一致。

import { api } from './api.js';
import { state, readFilters } from './state.js';
import { renderSummary } from './summary-view.js';
import { renderDetails, renderErrors } from './details-view.js';

const $ = (id) => document.getElementById(id);

async function refreshSummary() {
  const { rows } = await api.summary(state.filters);
  renderSummary(rows, state.filters);
}

async function refreshDetails(category) {
  state.lastCategory = category;
  const { rows } = await api.details(state.filters, category);
  $('view-summary').classList.add('hidden');
  $('view-details').classList.remove('hidden');
  renderDetails(rows, category);
}

async function refreshMeta() {
  const s = await api.state();
  $('meta-line').textContent =
    `数据加载时间: ${s.loadedAt ? new Date(s.loadedAt).toLocaleString() : '—'}｜` +
    `运单 ${s.counts.waybills} 条｜费率 ${s.counts.rates} 条`;
  renderErrors(s.dataErrors);
}

async function init() {
  const { sites } = await api.sites();
  for (const site of sites) {
    const opt = document.createElement('option');
    opt.value = site;
    opt.textContent = site;
    $('site-select').appendChild(opt);
  }
  await refreshMeta();
  await refreshSummary();
}

// 查询
$('btn-query').addEventListener('click', async () => {
  readFilters();
  await refreshSummary();
});

// 重算并重载
$('btn-reload').addEventListener('click', async () => {
  try {
    const result = await api.reload();
    renderErrors(result.dataErrors);
    await refreshSummary();
    await refreshMeta();
    alert(`重算完成：运单 ${result.counts.waybills} 条，费率 ${result.counts.rates} 条`);
  } catch (err) {
    alert(`重算失败，仍保留上一份可用数据：\n${err.message}`);
  }
});

// 导出（与当前筛选完全一致）
$('btn-export-summary').addEventListener('click', () => {
  window.location.href = api.exportSummaryUrl(state.filters);
});
$('btn-export-details').addEventListener('click', () => {
  window.location.href = api.exportDetailsUrl(state.filters);
});

// 返回汇总
$('btn-back').addEventListener('click', () => {
  $('view-details').classList.add('hidden');
  $('view-summary').classList.remove('hidden');
});

// 类别页签
$('category-tabs').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-category]');
  if (!btn) return;
  await refreshDetails(btn.dataset.category);
});

// 钻取链接（汇总页金额/单数）
document.addEventListener('click', async (e) => {
  const link = e.target.closest('a.drill');
  if (!link) return;
  e.preventDefault();
  const params = new URLSearchParams(link.hash.slice(link.hash.indexOf('?') + 1));
  state.filters = {
    site: params.get('site') || '',
    dateFrom: params.get('dateFrom') || '',
    dateTo: params.get('dateTo') || '',
  };
  await refreshDetails(params.get('category') || 'all');
});

init().catch((err) => {
  const banner = $('error-banner');
  banner.classList.remove('hidden');
  banner.textContent = `初始化失败：${err.message}`;
});
