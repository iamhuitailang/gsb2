// 前端 API 封装。所有数据均来自服务端，页面不自行推断文件可信度。
async function request(path, options = {}) {
  const res = await fetch(path, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const err = new Error(body?.error || `请求失败 (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  health: () => request('/api/health'),
  listTasks: () => request('/api/tasks'),
  getTask: (id) => request(`/api/tasks/${id}`),
  taskAudit: (id) => request(`/api/tasks/${id}/audit`),
  listAudit: () => request('/api/audit'),

  upload(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.onload = () => {
        let body;
        try { body = JSON.parse(xhr.responseText); } catch { body = null; }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body);
        } else {
          const err = new Error(body?.error || `上传失败 (${xhr.status})`);
          err.status = xhr.status;
          err.body = body;
          reject(err);
        }
      };
      xhr.onerror = () => reject(new Error('网络错误，上传中断'));
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }
      const form = new FormData();
      form.append('file', file);
      xhr.send(form);
    });
  },

  // 下载地址由任务 id 派生；服务端会再次校验状态，隔离任务返回 403
  downloadUrl: (id) => `/api/download/${id}`,

  deleteQuarantine: (id) =>
    request(`/api/quarantine/${id}`, { method: 'DELETE' }),

  purgeAll: () =>
    request('/api/quarantine/purge-all', { method: 'POST' }),
};
