/**
 * 工程保存 / 恢复 / 纹理导出（浏览器端）。
 *
 * 工程文件（.tpp.json，单文件 JSON）：
 *  - 模型原始文件以 base64 内嵌，恢复时无需再选模型
 *  - 每个材质的基础层、绘画层以 PNG dataURL 保存
 *  - 笔刷参数、分辨率一并保存
 *
 * 导出：
 *  - 每个材质一张合成后的 PNG
 *  - binding.json：材质名 -> 纹理文件 / UV 集 / 分辨率 的绑定信息
 */
import { TextureLayer } from '../core/texture-layer.js';
import { BrushSettings } from '../core/paint-engine.js';

export interface MaterialRecord {
  name: string;
  resolution: number;
  basePng: string;
  paintPng: string;
}

export interface ObjectRecord {
  name: string;
  format: 'obj' | 'gltf' | 'glb';
  modelFiles: Array<{ name: string; base64: string; mime: string }>;
  materials: MaterialRecord[];
}

export interface ProjectFile {
  app: 'meshpaint3d';
  version: 1;
  savedAt: string;
  brush: BrushSettings & { resolution: number };
  objects: ObjectRecord[];
}

export interface BindingInfo {
  app: 'meshpaint3d';
  version: 1;
  object: string;
  materials: Array<{
    material: string;
    textureFile: string;
    resolution: number;
    colorSpace: 'sRGB';
    uvSet: 'uv0';
    wrapping: 'clamp';
  }>;
}

function layerToCanvas(layer: TextureLayer): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = layer.width;
  canvas.height = layer.height;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(layer.width, layer.height);
  imageData.data.set(layer.data);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export function layerToPngDataUrl(layer: TextureLayer): string {
  return layerToCanvas(layer).toDataURL('image/png');
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text: string, filename: string): void {
  downloadBlob(
    new Blob([text], { type: 'application/json;charset=utf-8' }),
    filename,
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const MIME: Record<string, string> = {
  '.obj': 'text/plain',
  '.mtl': 'text/plain',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export function mimeFor(name: string): string {
  const i = name.lastIndexOf('.');
  return MIME[i >= 0 ? name.slice(i).toLowerCase() : ''] ?? 'application/octet-stream';
}

export interface SerializeObjectInput {
  name: string;
  format: ObjectRecord['format'];
  files: Map<string, Uint8Array>;
  materials: Array<{
    name: string;
    resolution: number;
    base: TextureLayer;
    paint: TextureLayer;
  }>;
}

export function buildProjectFile(
  objects: SerializeObjectInput[],
  brush: ProjectFile['brush'],
): ProjectFile {
  return {
    app: 'meshpaint3d',
    version: 1,
    savedAt: new Date().toISOString(),
    brush,
    objects: objects.map((o) => ({
      name: o.name,
      format: o.format,
      modelFiles: [...o.files.entries()].map(([name, bytes]) => ({
        name,
        base64: bytesToBase64(bytes),
        mime: mimeFor(name),
      })),
      materials: o.materials.map((m) => ({
        name: m.name,
        resolution: m.resolution,
        basePng: layerToPngDataUrl(m.base),
        paintPng: layerToPngDataUrl(m.paint),
      })),
    })),
  };
}

export function projectModelFiles(record: ObjectRecord): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const f of record.modelFiles) {
    map.set(f.name, base64ToBytes(f.base64));
  }
  return map;
}

export function bytesToFile(bytes: Uint8Array, name: string, mime: string): File {
  return new File([bytes.slice().buffer], name, { type: mime });
}

/** PNG dataURL -> TextureLayer */
export async function pngDataUrlToLayer(dataUrl: string): Promise<TextureLayer> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => reject(new Error('工程内 PNG 解码失败')), {
      once: true,
    });
    img.src = dataUrl;
  });
  const size = img.naturalWidth;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, size, size).data;
  return TextureLayer.fromRGBA(size, size, data);
}

/**
 * 导出一个材质的合成纹理 PNG，返回 Blob 与建议文件名。
 */
export function exportLayerPng(
  layer: TextureLayer,
  objectName: string,
  materialName: string,
): { blob: Blob; filename: string } {
  const canvas = layerToCanvas(layer);
  const dataUrl = canvas.toDataURL('image/png');
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const safe = (s: string) => s.replace(/[^\w.-]+/g, '_');
  return {
    blob: new Blob([bytes], { type: 'image/png' }),
    filename: `${safe(objectName)}__${safe(materialName)}.png`,
  };
}

export function buildBinding(objectName: string, records: MaterialRecord[]): BindingInfo {
  const safe = (s: string) => s.replace(/[^\w.-]+/g, '_');
  return {
    app: 'meshpaint3d',
    version: 1,
    object: objectName,
    materials: records.map((m) => ({
      material: m.name,
      textureFile: `${safe(objectName)}__${safe(m.name)}.png`,
      resolution: m.resolution,
      colorSpace: 'sRGB',
      uvSet: 'uv0',
      wrapping: 'clamp',
    })),
  };
}
