/**
 * 纯工具函数：不依赖 DOM，浏览器与 Node 测试共用。
 */

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function uid(prefix = 'id') {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return `${prefix}-${c.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** #rgb / #rrggbb -> {r,g,b}；非法输入返回 null。 */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  let value = hex.trim().replace(/^#/, '');
  if (value.length === 3) {
    value = value.split('').map((ch) => ch + ch).join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

export function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

export function rgbaToHex(r, g, b) {
  return rgbToHex(r, g, b);
}

/** 把数组缓冲区编码为 base64（浏览器 / Node 均可用）。 */
export function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(text) {
  if (typeof Buffer !== 'undefined') {
    return new Uint8ClampedArray(Buffer.from(text, 'base64'));
  }
  const binary = atob(text);
  const bytes = new Uint8ClampedArray(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 用于文件名的安全 slug。 */
export function slugify(name, fallback = 'pixanim') {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms >= 10000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

export function plural(n, unit) {
  return `${n} ${unit}`;
}

export function safeFileName(name, ext) {
  return `${slugify(name)}.${ext}`;
}

/** 最近邻整数放大，返回新的 RGBA 缓冲区。 */
export function scalePixels(pixels, width, height, scale) {
  const factor = Math.max(1, Math.round(scale));
  if (factor === 1) return { pixels: new Uint8ClampedArray(pixels), width, height };
  const outW = width * factor;
  const outH = height * factor;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y += 1) {
    const srcY = Math.floor(y / factor);
    for (let x = 0; x < outW; x += 1) {
      const src = (srcY * width + Math.floor(x / factor)) * 4;
      const dst = (y * outW + x) * 4;
      out[dst] = pixels[src];
      out[dst + 1] = pixels[src + 1];
      out[dst + 2] = pixels[src + 2];
      out[dst + 3] = pixels[src + 3];
    }
  }
  return { pixels: out, width: outW, height: outH };
}
