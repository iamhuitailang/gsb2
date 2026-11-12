const base = ''

async function req(method, url, body) {
  const resp = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`)
  return resp.json()
}

export const api = {
  listRules: () => req('GET', '/api/rules'),
  createRule: (rule) => req('POST', '/api/rules', rule),
  updateRule: (id, rule) => req('PUT', `/api/rules/${id}`, rule),
  startRun: (ruleId) => req('POST', `/api/rules/${ruleId}/runs`),
  listRuns: () => req('GET', '/api/runs'),
  getRun: (id) => req('GET', `/api/runs/${id}`),
  runPages: (id) => req('GET', `/api/runs/${id}/pages`),
  listPages: () => req('GET', '/api/pages'),
  diff: (a, b) => req('GET', `/api/diff?run_a=${a}&run_b=${b}`),
  diffPage: (a, b, url) =>
    req('GET', `/api/diff/page?run_a=${a}&run_b=${b}&url=${encodeURIComponent(url)}`),
}

export function fmtTime(ts) {
  return ts ? new Date(ts * 1000).toLocaleString() : '-'
}
