// fetch 封装：统一拼查询参数、统一错误抛出。

function buildQuery(params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, v);
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

async function getJson(path, params) {
  const res = await fetch(path + buildQuery(params));
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `请求失败: ${res.status}`);
  return body;
}

export const api = {
  sites: () => getJson('/api/sites'),
  state: () => getJson('/api/state'),
  summary: (filters) => getJson('/api/summary', filters),
  details: (filters, category) => getJson('/api/details', { ...filters, category }),
  missingRates: (filters) => getJson('/api/missing-rates', filters),
  reload: async () => {
    const res = await fetch('/api/reload', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || '重算失败');
    return body;
  },
  exportSummaryUrl: (filters) => '/api/export/summary' + buildQuery(filters),
  exportDetailsUrl: (filters) => '/api/export/details' + buildQuery(filters),
};
