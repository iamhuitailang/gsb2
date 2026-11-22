/*
 * 极简 ZIP 写入器（STORE，不压缩）。
 * 图片本身已是压缩格式，ZIP 再压缩几乎无收益，STORE 反而最快且兼容性最好。
 * 文件名按 UTF-8 写入并置位 EFS 标志位（bit 11），保证中文名正确解压。
 */
(function (global) {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
    const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
    return { time, day };
  }

  function u16(view, off, v) { view.setUint16(off, v, true); }
  function u32(view, off, v) { view.setUint32(off, v >>> 0, true); }

  /**
   * @param {Array<{name: string, bytes: Uint8Array}>} files
   * @returns {Blob}
   */
  function buildZip(files) {
    const encoder = new TextEncoder();
    const { time, day } = dosDateTime(new Date());
    const localChunks = [];
    const central = [];
    let offset = 0;

    files.forEach((file) => {
      const nameBytes = encoder.encode(file.name);
      const data = file.bytes;
      const crc = crc32(data);

      // ---- local file header (30 字节 + 文件名) ----
      const lh = new ArrayBuffer(30);
      const lv = new DataView(lh);
      u32(lv, 0, 0x04034b50);
      u16(lv, 4, 20);             // 解压版本
      u16(lv, 6, 0x0800);         // bit 11: UTF-8 文件名
      u16(lv, 8, 0);              // STORE
      u16(lv, 10, time);
      u16(lv, 12, day);
      u32(lv, 14, crc);
      u32(lv, 18, data.length);
      u32(lv, 22, data.length);
      u16(lv, 26, nameBytes.length);
      u16(lv, 28, 0);
      localChunks.push(new Uint8Array(lh), nameBytes, data);

      // ---- central directory header (46 字节 + 文件名) ----
      const ch = new ArrayBuffer(46);
      const cv = new DataView(ch);
      u32(cv, 0, 0x02014b50);
      u16(cv, 4, 20);
      u16(cv, 6, 20);
      u16(cv, 8, 0x0800);
      u16(cv, 10, 0);
      u16(cv, 12, time);
      u16(cv, 14, day);
      u32(cv, 16, crc);
      u32(cv, 20, data.length);
      u32(cv, 24, data.length);
      u16(cv, 28, nameBytes.length);
      u16(cv, 30, 0);
      u16(cv, 32, 0);
      u16(cv, 34, 0);
      u16(cv, 36, 0);
      u32(cv, 38, 0);
      u32(cv, 42, offset);
      central.push(new Uint8Array(ch), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    });

    const centralSize = central.reduce((s, b) => s + b.length, 0);

    // ---- end of central directory (22 字节) ----
    const eocd = new ArrayBuffer(22);
    const ev = new DataView(eocd);
    u32(ev, 0, 0x06054b50);
    u16(ev, 8, files.length);
    u16(ev, 10, files.length);
    u32(ev, 12, centralSize);
    u32(ev, 16, offset);
    u16(ev, 20, 0);

    return new Blob([...localChunks, ...central, new Uint8Array(eocd)], { type: 'application/zip' });
  }

  global.ZipWriter = { buildZip, crc32 };
})(window);
