// 本地文件读取：所有模型、材质、贴图都从本机读取，不发起任何网络请求（除 /samples 静态资源）

import type { LoadedSource } from './types';

const OBJ_EXT = ['.obj'];
const MTL_EXT = ['.mtl'];
const TEXTURE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function classifyFile(name: string): LoadedSource['kind'] {
  const ext = extOf(name);
  if (OBJ_EXT.includes(ext)) return 'obj';
  if (MTL_EXT.includes(ext)) return 'mtl';
  if (TEXTURE_EXT.includes(ext)) return 'texture';
  return 'other';
}

function readFileAsText(file: File): Promise<string> {
  return file.text();
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

export async function readLocalFiles(fileList: FileList | File[]): Promise<LoadedSource[]> {
  const files = Array.from(fileList);
  const out: LoadedSource[] = [];
  for (const file of files) {
    const kind = classifyFile(file.name);
    if (kind === 'other') continue;
    if (kind === 'texture') {
      out.push({ name: file.name, text: null, dataUrl: await readFileAsDataUrl(file), kind });
    } else {
      out.push({ name: file.name, text: await readFileAsText(file), dataUrl: null, kind });
    }
  }
  return out;
}

/** 读取 public/samples 下的内置样例 */
export async function fetchSampleFiles(names: string[]): Promise<LoadedSource[]> {
  const out: LoadedSource[] = [];
  for (const name of names) {
    const kind = classifyFile(name);
    const resp = await fetch(`./samples/${encodeURIComponent(name)}`);
    if (!resp.ok) {
      throw new Error(`样例文件 ${name} 读取失败（HTTP ${resp.status}），请先运行 npm run generate:samples`);
    }
    if (kind === 'texture') {
      const blob = await resp.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      out.push({ name, text: null, dataUrl, kind });
    } else {
      out.push({ name, text: await resp.text(), dataUrl: null, kind });
    }
  }
  return out;
}

export function basename(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}
