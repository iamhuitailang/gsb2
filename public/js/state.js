// 当前筛选条件（单一数据源，汇总钻取与导出共用，保证所见即所导）。

export const state = {
  filters: { site: '', dateFrom: '', dateTo: '' },
  lastCategory: 'all',
};

export function readFilters() {
  state.filters = {
    site: document.getElementById('site-select').value,
    dateFrom: document.getElementById('date-from').value,
    dateTo: document.getElementById('date-to').value,
  };
  return state.filters;
}
