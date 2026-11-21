/** 通用小工具：字节处理、CRC、格式化、下载等。 */

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function deepClone(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fallthrough */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

export function uid(prefix = 'id') {
  const rand =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${rand}`;
}

let crcTable = null;

export function crc32(bytes, start = 0, end = bytes.length) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function adler32(bytes) {
  let a = 1;
  let b = 0;
  const mod = 65521;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % mod;
    b = (b + a) % mod;
  }
  return ((b << 16) | a) >>> 0;
}

export function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function concatUint8(...chunks) {
  return concatBytes(chunks);
}

export function u32be(value) {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

export function u16be(value) {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

export function u32le(value) {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

export function u16le(value) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

export function readU32be(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatPercent(value, digits = 0) {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatFixed(value, digits = 1, suffix = '') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}${suffix}`;
}

export function sanitizeFilename(name, fallback = 'image') {
  const base = String(name || fallback)
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return base || fallback;
}

export function downloadBytes(bytes, filename, mime = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function textBytes(text) {
  return new TextEncoder().encode(text);
}

export function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const clean = String(base64).replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return new Uint8Array(Buffer.from(clean, 'base64'));
  }
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToDataUrl(bytes, mime = 'image/png') {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

export function dataUrlToBytes(dataUrl) {
  const match = /^data:([^;,]+)?(;[^,]*)?;base64,(.*)$/s.exec(String(dataUrl));
  if (!match) throw new Error('不是有效的 base64 data URL');
  return base64ToBytes(match[3]);
}

export function dataUrlByteLength(dataUrl) {
  try {
    const match = /^data:[^;,]*(;[^,]*)?;base64,(.*)$/s.exec(String(dataUrl));
    if (!match) return 0;
    const b64 = match[2];
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
  } catch {
    return 0;
  }
}

export function debounce(fn, delay = 200) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

export function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function sortByName(a, b) {
  return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
