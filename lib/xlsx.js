/**
 * 极简 XLSX 读取器：只读取首个工作表，零第三方依赖。
 * 支持共享字符串、内联字符串、数字/布尔值，忽略样式与公式缓存差异。
 */
import zlib from 'node:zlib';

function readZipEntries(buffer) {
  const entries = new Map();
  // End of Central Directory
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 XLSX 文件（缺少 ZIP 目录）');

  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式: ${method}`);

    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeXmlEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code = entity.startsWith('#x')
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
    }
  });
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let si;
  while ((si = siRegex.exec(xml))) {
    const texts = [];
    const textRegex = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
    let text;
    while ((text = textRegex.exec(si[1]))) {
      texts.push(decodeXmlEntities(text[1] ?? ''));
    }
    strings.push(texts.join(''));
  }
  return strings;
}

function columnIndexFromRef(ref) {
  const letters = /^([A-Z]+)/.exec(ref ?? '')?.[1];
  if (!letters) return null;
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function parseWorksheet(xml, sharedStrings) {
  const rows = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(xml))) {
    const row = [];
    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    let cursor = 0;
    while ((cellMatch = cellRegex.exec(rowMatch[1]))) {
      const attrs = cellMatch[1] ?? '';
      const body = cellMatch[2] ?? '';
      const ref = /\br="([^"]+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const index = columnIndexFromRef(ref);
      const target = index ?? cursor;
      cursor = target + 1;

      let value = '';
      if (type === 'inlineStr') {
        const texts = [];
        const textRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let text;
        while ((text = textRegex.exec(body))) texts.push(decodeXmlEntities(text[1]));
        value = texts.join('');
      } else {
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (raw !== undefined) {
          if (type === 's') value = sharedStrings[Number(raw)] ?? '';
          else value = decodeXmlEntities(raw);
        }
      }
      while (row.length < target) row.push('');
      row[target] = value;
    }
    rows.push(row);
  }
  return rows;
}

function firstSheetPath(entries) {
  const workbook = entries.get('xl/workbook.xml')?.toString('utf8');
  const rels = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (workbook && rels) {
    const sheetMatch = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook);
    if (sheetMatch) {
      const relRegex = /<Relationship\b[^>]*>/g;
      let rel;
      while ((rel = relRegex.exec(rels))) {
        if (new RegExp(`\\bId="${sheetMatch[1]}"`).test(rel[0])) {
          const target = /\bTarget="([^"]+)"/.exec(rel[0])?.[1];
          if (target) {
            const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
            if (entries.has(path)) return path;
          }
        }
      }
    }
  }
  return [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
}

/**
 * @param {Buffer} buffer
 * @returns {string[][]}
 */
export function readXlsx(buffer) {
  const entries = readZipEntries(buffer);
  const sharedStrings = parseSharedStrings(
    entries.get('xl/sharedStrings.xml')?.toString('utf8'),
  );
  const sheetPath = firstSheetPath(entries);
  if (!sheetPath) throw new Error('XLSX 中找不到工作表');
  const sheetXml = entries.get(sheetPath).toString('utf8');
  return parseWorksheet(sheetXml, sharedStrings);
}
