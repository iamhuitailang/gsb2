/**
 * 导出：
 *   - 图像：PNG 索引色（tRNS 可表达透明索引与半透明索引）/ PNG 真彩 + Alpha / PNG 灰阶；
 *   - 调色板：GPL / ACT / HEX / JSON；
 *   - 指标：CSV。
 *
 * 所有导出都基于当前预览结果，不重新量化，所以下载文件与屏幕预览逐像素一致。
 */
import { encodeIndexedPng, encodeRgbaPng, encodeGrayPng } from './png.js';
import { rgbToHex } from './color.js';
import { textBytes, sanitizeFilename } from './utils.js';

export const OUTPUT_FORMATS = [
  {
    id: 'indexed',
    name: 'PNG 索引色',
    ext: 'png',
    mime: 'image/png',
    description: '单文件 + 内嵌调色板，透明像素用 tRNS 透明索引，体积最小。',
  },
  {
    id: 'rgba',
    name: 'PNG 真彩 + Alpha',
    ext: 'png',
    mime: 'image/png',
    description: 'RGBA 8-bit，颜色已减到调色板内，兼容性最好。',
  },
  {
    id: 'gray',
    name: 'PNG 灰阶',
    ext: 'png',
    mime: 'image/png',
    description: '只保留亮度，透明像素输出为白色（适合电子墨水/单色屏）；不保留 alpha。',
  },
];

export function outputFormatInfo(id) {
  return OUTPUT_FORMATS.find((f) => f.id === id) || OUTPUT_FORMATS[0];
}

export async function encodeResult(result, format = 'indexed') {
  if (format === 'rgba') return encodeRgbaPng(result.rgba, result.width, result.height);
  if (format === 'gray') {
    const gray = new Uint8Array(result.width * result.height);
    for (let p = 0; p < gray.length; p++) {
      const i = p * 4;
      if (result.rgba[i + 3] < 255) {
        gray[p] = 255;
        continue;
      }
      gray[p] = Math.round(
        0.2126 * result.rgba[i] + 0.7152 * result.rgba[i + 1] + 0.0722 * result.rgba[i + 2],
      );
    }
    return encodeGrayPng(gray, result.width, result.height);
  }
  const payload = buildIndexedPayload(result);
  return encodeIndexedPng(payload.indices, result.width, result.height, payload.palette);
}

/**
 * 索引色 PNG 的调色板项可以携带 alpha（tRNS 支持每个索引一个 alpha），
 * 因此在「保留原始 alpha」模式下，半透明像素会按 (颜色, alpha) 展开成
 * 独立索引，导出结果与预览逐像素一致。
 *
 * 若展开后超过 256 项（极端情况），退回二值 alpha 以保证文件有效；
 * 此时半透明像素会变为不透明。
 */
export function buildIndexedPayload(result) {
  const base = { indices: result.indices, palette: result.palette, expanded: false };
  if (result.alphaMode !== 'preserve') return base;
  const { rgba, indices, palette } = result;
  const count = indices.length;

  let hasSemi = false;
  for (let p = 0; p < count; p++) {
    const a = rgba[p * 4 + 3];
    if (a > 0 && a < 255) {
      hasSemi = true;
      break;
    }
  }
  if (!hasSemi) return base;

  const keyToIndex = new Map();
  const expandedPalette = [];
  const expandedIndices = new Uint8Array(count);
  for (let p = 0; p < count; p++) {
    const alpha = rgba[p * 4 + 3];
    const baseIndex = indices[p];
    const color = palette[baseIndex] || { r: 0, g: 0, b: 0 };
    const key = alpha === 0 ? 'transparent' : `${baseIndex}:${alpha}`;
    let idx = keyToIndex.get(key);
    if (idx === undefined) {
      if (expandedPalette.length >= 256) return base;
      idx = expandedPalette.length;
      keyToIndex.set(key, idx);
      expandedPalette.push(
        alpha === 0
          ? { r: 0, g: 0, b: 0, transparent: true }
          : { r: color.r, g: color.g, b: color.b, a: alpha },
      );
    }
    expandedIndices[p] = idx;
  }
  return { indices: expandedIndices, palette: expandedPalette, expanded: true };
}

export function exportFilename(name, result, format) {
  const base = sanitizeFilename(name);
  const colors = result.usedColors;
  const dither = result.dither === 'none' ? 'nodither' : result.dither;
  return `${base}-${colors}c-${dither}.${outputFormatInfo(format).ext}`;
}

/** GIMP 调色板。 */
export function paletteToGpl(palette, name = 'Palette Forge') {
  const lines = ['GIMP Palette', `Name: ${name}`, 'Columns: 8', '#'];
  for (const c of palette) {
    if (c.transparent) {
      lines.push(`${pad3(0)} ${pad3(0)} ${pad3(0)}\tTransparent`);
      continue;
    }
    lines.push(`${pad3(c.r)} ${pad3(c.g)} ${pad3(c.b)}\t${rgbToHex(c.r, c.g, c.b)}`);
  }
  return textBytes(lines.join('\n') + '\n');
}

function pad3(n) {
  return String(Math.round(n)).padStart(3, ' ');
}

/** Adobe Color Table（Photoshop / Aseprite 通用），固定 768 字节。 */
export function paletteToAct(palette) {
  const out = new Uint8Array(768);
  for (let i = 0; i < Math.min(256, palette.length); i++) {
    const c = palette[i];
    out[i * 3] = c.transparent ? 0 : c.r;
    out[i * 3 + 1] = c.transparent ? 0 : c.g;
    out[i * 3 + 2] = c.transparent ? 0 : c.b;
  }
  return out;
}

export function paletteToHexText(palette) {
  return textBytes(
    palette.map((c) => (c.transparent ? '#00000000' : rgbToHex(c.r, c.g, c.b))).join('\n') + '\n',
  );
}

export function paletteToJson(palette, meta = {}) {
  const payload = {
    format: 'palette-forge-palette',
    version: 1,
    name: meta.name || 'Palette Forge',
    generatedAt: meta.generatedAt || new Date().toISOString(),
    colorCount: palette.length,
    colors: palette.map((c) =>
      c.transparent
        ? { hex: '#00000000', rgba: [0, 0, 0, 0], transparent: true }
        : { hex: rgbToHex(c.r, c.g, c.b), rgb: [c.r, c.g, c.b] },
    ),
    source: meta.source || null,
    settings: meta.settings || null,
  };
  return textBytes(JSON.stringify(payload, null, 2) + '\n');
}

export function paletteFilename(name, ext) {
  return `${sanitizeFilename(name, 'palette')}-palette.${ext}`;
}

/** 指标 CSV，方便贴到表格里比较不同参数。 */
export function metricsToCsv(rows) {
  const header = [
    'image',
    'width',
    'height',
    'paletteColors',
    'usedColors',
    'dither',
    'alphaMode',
    'fileBytes',
    'originalBytes',
    'mae',
    'rmse',
    'psnr',
    'deltaE76Mean',
    'deltaE76Max',
    'p95DeltaE76',
    'ssim',
    'transparentPixels',
    'alphaMismatchPixels',
    'edgeMismatchPixels',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.name),
        r.width,
        r.height,
        r.paletteColors,
        r.usedColors,
        r.dither,
        r.alphaMode,
        r.fileBytes,
        r.originalBytes ?? '',
        fmt(r.mae, 6),
        fmt(r.rmse, 4),
        fmt(r.psnr, 3),
        fmt(r.deltaE76Mean, 4),
        fmt(r.deltaE76Max, 4),
        r.p95DeltaE76 ?? '',
        fmt(r.ssim, 5),
        r.transparentPixels,
        r.alphaMismatchPixels,
        r.edgeMismatchPixels,
      ].join(','),
    );
  }
  return textBytes(lines.join('\n') + '\n');
}

function fmt(v, digits) {
  return Number.isFinite(v) ? Number(v).toFixed(digits) : '';
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
