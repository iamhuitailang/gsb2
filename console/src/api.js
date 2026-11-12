const BASE = '/api';

async function request(path, options = {}) {
  const resp = await fetch(`${BASE}${path}`, options);
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body.error || `请求失败 (${resp.status})`);
  return body;
}

export const api = {
  listJobs: () => request('/jobs'),
  getJob: (id) => request(`/jobs/${id}`),
  importCsv: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('/jobs/import', { method: 'POST', body: fd });
  },
  confirmJob: (id) => request(`/jobs/${id}/confirm`, { method: 'POST' }),
  startJob: (id) => request(`/jobs/${id}/start`, { method: 'POST' }),
  stopJob: (id) => request(`/jobs/${id}/stop`, { method: 'POST' }),
  getLogs: (id) => request(`/jobs/${id}/logs?limit=500`),

  // SSE 事件流，返回带 close() 的 EventSource 包装
  openEvents(id, handlers) {
    const es = new EventSource(`${BASE}/jobs/${id}/events`);
    if (handlers.onJob) es.addEventListener('job', (e) => handlers.onJob(JSON.parse(e.data)));
    if (handlers.onRecord) es.addEventListener('record', (e) => handlers.onRecord(JSON.parse(e.data)));
    if (handlers.onLog) es.addEventListener('log', (e) => handlers.onLog(JSON.parse(e.data)));
    if (handlers.onEnd) {
      es.addEventListener('end', (e) => {
        handlers.onEnd(JSON.parse(e.data));
        es.close();
      });
    }
    es.onerror = () => {
      // 网络抖动时 EventSource 会自动重连（retry: 3000），此处不主动关闭
    };
    return { close: () => es.close() };
  },
};
