/**
 * 浏览器侧图片读取。
 *
 * PNG 优先走纯 JS 解码（保留精确 alpha、tRNS 与低位深调色板），
 * 其他格式交给浏览器 ImageBitmap 解码后再转 RGBA。
 * 编码统一使用 exporters.js 的 encodeResult，避免两份实现漂移。
 */
import { decodePng, readPngInfo, PNG_SIGNATURE } from './png.js';

export { decodePng, readPngInfo, PNG_SIGNATURE };

export function isPng(bytes) {
  return (
    bytes.length > 8 &&
    bytes[0] === PNG_SIGNATURE[0] &&
    bytes[1] === PNG_SIGNATURE[1] &&
    bytes[2] === PNG_SIGNATURE[2] &&
    bytes[3] === PNG_SIGNATURE[3]
  );
}

/** 用浏览器解码任意格式（GIF/WebP/JPEG/BMP…），得到 RGBA。 */
export async function decodeWithBrowser(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      const canvas = offscreen(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, bitmap.width, bitmap.height);
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      bitmap.close?.();
      return { width: bitmap.width, height: bitmap.height, rgba: data.data };
    } catch {
      /* 回退到 <img> */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = offscreen(img.naturalWidth, img.naturalHeight);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, img.naturalWidth, img.naturalHeight);
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight);
    return { width: img.naturalWidth, height: img.naturalHeight, rgba: data.data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = url;
  });
}

function offscreen(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * 读取任意文件为 RGBA。
 * @returns {{width:number,height:number,rgba:Uint8ClampedArray,bytes:Uint8Array,
 *            pngInfo:object|null,source:'png'|'browser'}}
 */
export async function decodeImageFile(file) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const info = readPngInfo(buffer);
  if (info) {
    try {
      const decoded = await decodePng(buffer);
      return { ...decoded, bytes: buffer, pngInfo: info, source: 'png' };
    } catch (err) {
      console.warn('PNG 原生解码失败，改用浏览器解码:', err);
    }
  }
  const decoded = await decodeWithBrowser(
    new Blob([buffer], { type: file.type || 'application/octet-stream' }),
  );
  return { ...decoded, bytes: buffer, pngInfo: null, source: 'browser' };
}
