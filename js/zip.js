/* 极简 ZIP 写入器（STORE 不压缩 + CRC32），用于把 PNG 序列打包成本地 zip */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});

  const crcTable = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * @param {{name:string, bytes:Uint8Array}[]} files
   * @returns {Blob} application/zip
   */
  function createZip(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;

    const u16 = (v) => {
      const b = new Uint8Array(2);
      new DataView(b.buffer).setUint16(0, v, true);
      return b;
    };
    const u32 = (v) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, v >>> 0, true);
      return b;
    };
    const concat = (arrs) => {
      let len = 0;
      arrs.forEach((a) => (len += a.length));
      const out = new Uint8Array(len);
      let o = 0;
      arrs.forEach((a) => { out.set(a, o); o += a.length; });
      return out;
    };

    // 固定的 DOS 时间：2024-01-01 00:00
    const dosTime = 0;
    const dosDate = ((2024 - 1980) << 9) | (1 << 5) | 1;

    files.forEach((file) => {
      const nameBytes = encoder.encode(file.name);
      const data = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
      const crc = crc32(data);
      const size = data.length;

      const local = concat([
        u32(0x04034b50),
        u16(20),          // version needed
        u16(0x0800),      // UTF-8 flag
        u16(0),           // store
        u16(dosTime),
        u16(dosDate),
        u32(crc),
        u32(size),
        u32(size),
        u16(nameBytes.length),
        u16(0),
        nameBytes,
      ]);
      chunks.push(local, data);

      const cd = concat([
        u32(0x02014b50),
        u16(20), u16(20), // made by / needed
        u16(0x0800),
        u16(0),
        u16(dosTime), u16(dosDate),
        u32(crc),
        u32(size), u32(size),
        u16(nameBytes.length),
        u16(0), u16(0),   // extra, comment
        u16(0), u16(0),   // disk, internal attr
        u32(0),           // external attr
        u32(offset),
        nameBytes,
      ]);
      central.push(cd);

      offset += local.length + data.length;
    });

    const cdBytes = concat(central);
    const eocd = concat([
      u32(0x06054b50),
      u16(0), u16(0),
      u16(files.length),
      u16(files.length),
      u32(cdBytes.length),
      u32(offset),
      u16(0),
    ]);

    return new Blob([concat([...chunks, cdBytes, eocd])], { type: 'application/zip' });
  }

  G.Zip = { createZip, crc32 };
})();
