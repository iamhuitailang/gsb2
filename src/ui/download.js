/**
 * 下载 / 文件读写辅助。
 */

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(text, filename, type = 'application/json') {
  downloadBlob(new Blob([text], { type: `${type};charset=utf-8` }), filename);
}

/**
 * 把 RGBA 缓冲编码为 PNG Blob（保留 alpha）。
 */
export async function rgbaToPngBlob({ width, height, data }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG 编码失败');
  return blob;
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

export function saveProjectWithPicker(text, suggestedName) {
  // File System Access API（Chrome/Edge）：允许用户选择保存位置。
  if ('showSaveFilePicker' in window) {
    return (async () => {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [
            {
              description: 'Pixanim 工程',
              accept: { 'application/json': ['.json'] },
            },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        return { saved: true, name: handle.name };
      } catch (error) {
        if (error?.name === 'AbortError') return { saved: false, aborted: true };
        throw error;
      }
    })();
  }
  downloadText(text, suggestedName);
  return Promise.resolve({ saved: true, name: suggestedName });
}
