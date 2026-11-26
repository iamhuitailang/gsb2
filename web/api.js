// 后端 JSON API 封装
'use strict';

const Api = (() => {
  async function call(route, body) {
    const res = await fetch(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? '{}' : JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `${route} 请求失败 (${res.status})`);
    return data;
  }

  return {
    listSamples: () => fetch('/api/samples').then((r) => r.json()),
    load: (path) => call('/api/load', { path }),
    analyze: (path, start, end) => call('/api/analyze', { path, start, end }),
    process: (path, noise, params) => call('/api/process', { path, noise, params }),
    spectrum: (payload) => call('/api/spectrum', payload),
    batch: (jobs, outDir) => call('/api/batch', { jobs, out_dir: outDir || null }),
    saveProject: (path, project) => call('/api/project/save', { path, project }),
    loadProject: (path) => call('/api/project/load', { path }),
    upload: (name, contentB64) => call('/api/upload', { name, content_b64: contentB64 }),
    listDir: (dir) => call('/api/listdir', { dir }),
    audioUrl: (path) => `/api/audio?path=${encodeURIComponent(path)}&t=${Date.now()}`,
    downloadUrl: (path) => `/api/download?path=${encodeURIComponent(path)}`,
  };
})();

// hex 字符串 -> WAV ArrayBuffer
function hexToWav(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes.buffer;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result).split(',')[1];
      resolve(b64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
