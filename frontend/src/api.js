const BASE = '/api'

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  let body = null
  const text = await response.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = { detail: text }
    }
  }
  if (!response.ok) {
    const error = new Error(body?.detail || `请求失败（${response.status}）`)
    error.status = response.status
    error.body = body
    throw error
  }
  return body
}

export const api = {
  health: () => request('/health'),
  meta: () => request('/meta'),

  demos: () => request('/demos'),
  demo: (slug) => request(`/demos/${slug}`),
  runDemo: (slug, save = true) =>
    request(`/demos/${slug}/run`, {
      method: 'POST',
      body: JSON.stringify({ save }),
    }),

  configs: () => request('/configs'),
  config: (id) => request(`/configs/${id}`),
  validateConfig: (config) =>
    request('/configs/validate', {
      method: 'POST',
      body: JSON.stringify({ config }),
    }),
  saveConfig: (config, configId = null) =>
    request('/configs', {
      method: 'POST',
      body: JSON.stringify({ config, config_id: configId }),
    }),
  deleteConfig: (id) => request(`/configs/${id}`, { method: 'DELETE' }),

  analyze: (payload) =>
    request('/analyze', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  analyses: (params = {}) => {
    const search = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') {
        search.set(key, value)
      }
    })
    const query = search.toString()
    return request(`/analyses${query ? `?${query}` : ''}`)
  },
  analysis: (id) => request(`/analyses/${id}`),
  deleteAnalysis: (id) => request(`/analyses/${id}`, { method: 'DELETE' }),

  resetDemoData: () => request('/demo-data/reset', { method: 'POST' }),

  exportUrl: (params = {}) => {
    const search = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') {
        search.set(key, value)
      }
    })
    const query = search.toString()
    return `${BASE}/export${query ? `?${query}` : ''}`
  },
}

export const FIELD_META = {
  x_forwarded_for: {
    label: 'X-Forwarded-For',
    placeholder: '203.0.113.42, 192.0.2.10, 10.0.0.5',
    hint: '逗号分隔整串，或将每次出现的请求头分别填入多行',
    multiline: true,
  },
  forwarded: {
    label: 'Forwarded (RFC 7239)',
    placeholder: 'for=203.0.113.42, for=192.0.2.10',
    hint: '按 RFC 7239 写 for= 元素，逗号分隔',
    multiline: true,
  },
  x_real_ip: {
    label: 'X-Real-IP',
    placeholder: '203.0.113.42',
    hint: '单值字段，只能填一个地址',
    multiline: false,
  },
  cf_connecting_ip: {
    label: 'CF-Connecting-IP',
    placeholder: '203.0.113.42',
    hint: '单值字段，只能填一个地址',
    multiline: false,
  },
}

export const FIELD_ORDER = ['x_forwarded_for', 'forwarded', 'x_real_ip', 'cf_connecting_ip']

export function emptyConfig() {
  return {
    name: '本机信任配置',
    entries: [{ value: '10.0.0.0/8', label: '内网反向代理' }],
    fields: {
      x_forwarded_for: { enabled: true, max_hops: 5 },
      forwarded: { enabled: false, max_hops: 5 },
      x_real_ip: { enabled: false, max_hops: 1 },
      cf_connecting_ip: { enabled: false, max_hops: 1 },
    },
  }
}

export function formatTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}
