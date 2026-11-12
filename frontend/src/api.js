/**
 * Thin API client. Every filter used by the list page is also accepted by the
 * CSV export endpoint, so `buildQuery` is shared.
 */
const BASE = '/api'

function buildQuery(params = {}) {
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') {
      q.set(key, String(value))
    }
  }
  const text = q.toString()
  return text ? `?${text}` : ''
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(typeof detail.detail === 'string' ? detail.detail : JSON.stringify(detail.detail))
  }
  return res.json()
}

export const api = {
  health: () => get('/health'),
  players: () => get('/players'),
  listSessions: (filters, page = 1, pageSize = 20) =>
    get(`/sessions${buildQuery({ ...filters, page, page_size: pageSize })}`),
  getSession: (sessionId) => get(`/sessions/${encodeURIComponent(sessionId)}`),
  getRawEvents: (sessionId) => get(`/sessions/${encodeURIComponent(sessionId)}/raw`),
  reprocess: (sessionId) =>
    fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/reprocess`, { method: 'POST' }).then((r) => {
      if (!r.ok) throw new Error('reprocess failed')
      return r.json()
    }),
  exportCsvUrl: (filters) => `${BASE}/export/sessions.csv${buildQuery(filters)}`,
}
