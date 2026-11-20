import type { ProjectData } from '../types';

export function downloadTextFile(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  triggerDownload(URL.createObjectURL(blob), filename);
}

export function downloadDataUrl(filename: string, dataUrl: string) {
  triggerDownload(dataUrl, filename);
}

function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Blob URL 需要延迟回收
  setTimeout(() => {
    if (href.startsWith('blob:')) URL.revokeObjectURL(href);
  }, 1000);
}

export function readProjectFile(file: File): Promise<ProjectData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as ProjectData;
        if (data.format !== 'shader-lab-project' || data.version !== 1) {
          throw new Error('不是有效的 Shader Lab 工程文件');
        }
        resolve(data);
      } catch (e) {
        reject(e);
      }
    };
    reader.readAsText(file);
  });
}

/** 工程文件名安全化 */
export function safeFileName(name: string, ext: string): string {
  const base = name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'shader-lab';
  return `${base}.${ext}`;
}
