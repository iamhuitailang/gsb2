// 后端接口封装。所有请求都走相对路径 /api，开发环境由 Vite 代理。

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body instanceof FormData
      ? {}
      : { 'Content-Type': 'application/json' },
    ...options,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message = data?.detail || `请求失败（HTTP ${res.status}）`
    throw new Error(Array.isArray(message) ? JSON.stringify(message) : message)
  }
  return data
}

export const api = {
  health: () => request('/api/health'),
  options: () => request('/api/options'),

  listFiles: () => request('/api/files'),
  uploadFile: (file, onProgress) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/files')
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText)
          xhr.status >= 200 && xhr.status < 300
            ? resolve(data)
            : reject(new Error(data.detail || `上传失败（HTTP ${xhr.status}）`))
        } catch (err) {
          reject(new Error('上传响应解析失败'))
        }
      }
      xhr.onerror = () => reject(new Error('网络错误，上传失败'))
      const form = new FormData()
      form.append('file', file)
      xhr.send(form)
    }),
  deleteFile: (id) => request(`/api/files/${id}`, { method: 'DELETE' }),
  sourceUrl: (id) => `/api/media/source/${id}`,

  listTasks: () => request('/api/tasks'),
  createTask: (payload) =>
    request('/api/tasks', { method: 'POST', body: JSON.stringify(payload) }),
  cancelTask: (id) => request(`/api/tasks/${id}/cancel`, { method: 'POST' }),
  deleteTask: (id) => request(`/api/tasks/${id}`, { method: 'DELETE' }),
  previewUrl: (id) => `/api/tasks/${id}/preview`,
  downloadUrl: (id) => `/api/tasks/${id}/download`,

  cleanupTemp: () => request('/api/cleanup/temp', { method: 'POST' }),
}
