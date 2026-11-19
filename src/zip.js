/**
 * 最小 ZIP 打包器（stored 模式，不压缩）。
 * 用于“导出全部”：annotations.json + masks/*.png + labels.csv。
 * 文件名统一使用 UTF-8，并置位 UTF-8 标志，中文文件名可正常解压。
 */

import { crc32 } from './png.js';

const encoder = new TextEncoder();

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11)
    | ((date.getMinutes() & 0x3f) << 5)
    | ((date.getSeconds() >> 1) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0x0f) << 5)
    | (date.getDate() & 0x1f);
  return { time, day };
}

function u16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * @param {{name: string, data: Uint8Array}[]} files
 * @param {Date} date
 * @returns {Uint8Array}
 */
export function createZip(files, date = new Date()) {
  const { time, day } = dosDateTime(date);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    if (nameBytes.length > 0xffff) throw new Error(`文件名过长：${file.name}`);
    if (file.data.length > 0xffffffff) throw new Error(`文件过大：${file.name}`);
    const crc = crc32(file.data);
    const local = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04,
      ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(time), ...u16(day),
      ...u32(crc), ...u32(file.data.length), ...u32(file.data.length),
      ...u16(nameBytes.length), ...u16(0),
    ]);
    localParts.push(local, nameBytes, file.data);

    const central = new Uint8Array([
      0x50, 0x4b, 0x01, 0x02,
      ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(time), ...u16(day),
      ...u32(crc), ...u32(file.data.length), ...u32(file.data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset),
    ]);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + file.data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06,
    ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(offset),
    ...u16(0),
  ]);

  const total = offset + centralSize + end.length;
  const zip = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    zip.set(part, cursor);
    cursor += part.length;
  }
  return zip;
}

export function downloadBlob(bytes, filename, mime = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadJson(value, filename) {
  const bytes = encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
  downloadBlob(bytes, filename, 'application/json;charset=utf-8');
}
