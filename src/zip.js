/** 极简 ZIP 写入器（store，不压缩）。用于批量导出，零依赖。 */
import { crc32, u16le, u32le, concatBytes } from './utils.js';

export function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const dos = dosDateTime(new Date());

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const crc = crc32(data);

    const local = concatBytes([
      u32le(0x04034b50),
      u16le(20), // version needed
      u16le(0x0800), // UTF-8 flag
      u16le(0), // store
      u16le(dos.time),
      u16le(dos.date),
      u32le(crc),
      u32le(data.length),
      u32le(data.length),
      u16le(nameBytes.length),
      u16le(0),
      nameBytes,
    ]);
    localParts.push(local, data);

    const central = concatBytes([
      u32le(0x02014b50),
      u16le(20), // version made by
      u16le(20), // version needed
      u16le(0x0800),
      u16le(0),
      u16le(dos.time),
      u16le(dos.date),
      u32le(crc),
      u32le(data.length),
      u32le(data.length),
      u16le(nameBytes.length),
      u16le(0),
      u16le(0),
      u16le(0),
      u16le(0),
      u32le(0),
      u32le(offset),
      nameBytes,
    ]);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const end = concatBytes([
    u32le(0x06054b50),
    u16le(0),
    u16le(0),
    u16le(entries.length),
    u16le(entries.length),
    u32le(centralSize),
    u32le(offset),
    u16le(0),
  ]);

  return concatBytes([...localParts, ...centralParts, end]);
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { date: dosDate, time: dosTime };
}
