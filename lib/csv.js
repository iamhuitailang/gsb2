// CSV 解析与序列化（零依赖）。
// 解析支持：UTF-8 BOM、CRLF/LF、引号包裹、"" 转义、字段内逗号与换行；
// 序列化对 = + - @ 开头的单元格前置单引号，防 Excel 公式注入。

/**
 * 解析 CSV 文本。
 * @param {string} text
 * @returns {{headers: string[], rows: Array<Record<string,string>>, lines: number[]}}
 *   lines[i] 为 rows[i] 对应的 CSV 物理行号（表头为第 1 行）。
 */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM

  const records = [];
  let field = '';
  let record = [];
  let line = 1;
  let recordStartLine = 1;
  let inQuotes = false;

  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    records.push({ line: recordStartLine, fields: record });
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (c === '\n') {
        field += c;
        line++;
      } else if (c === '\r') {
        // 引号内统一规整为 \n
        field += '\n';
        if (text[i + 1] === '\n') i++;
        line++;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushField();
      pushRecord();
      line++;
      recordStartLine = line;
    } else if (c === '\r') {
      pushField();
      pushRecord();
      if (text[i + 1] === '\n') i++;
      line++;
      recordStartLine = line;
    } else {
      field += c;
    }
  }

  if (inQuotes) throw new Error('CSV 结构损坏：引号未闭合');
  // 文件末尾无换行时，最后一个字段/记录还在缓冲区
  if (field !== '' || record.length > 0) {
    pushField();
    pushRecord();
  }

  if (records.length === 0) return { headers: [], rows: [], lines: [] };

  const headers = records[0].fields.map((h) => h.trim());
  const headerSet = new Set();
  for (const h of headers) {
    if (headerSet.has(h)) throw new Error(`CSV 表头存在重复列: "${h}"`);
    headerSet.add(h);
  }

  const rows = [];
  const lines = [];
  for (let r = 1; r < records.length; r++) {
    const { fields, line: physicalLine } = records[r];
    if (fields.length === 1 && fields[0] === '') continue; // 空行跳过
    if (fields.length !== headers.length) {
      throw new Error(
        `CSV 结构损坏：第 ${physicalLine} 行列数(${fields.length})与表头列数(${headers.length})不一致`,
      );
    }
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = fields[idx].trim();
    });
    rows.push(row);
    lines.push(physicalLine);
  }
  return { headers, rows, lines };
}

function escapeCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // 防公式注入
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * 序列化 CSV（默认带 UTF-8 BOM，Excel 打开中文不乱码）。
 * @param {string[]} headers
 * @param {Array<Array<string|number|null|undefined>>} rows
 */
export function serializeCsv(headers, rows, { addBom = true } = {}) {
  const out = [headers.map(escapeCell).join(',')];
  for (const row of rows) out.push(row.map(escapeCell).join(','));
  return (addBom ? '﻿' : '') + out.join('\r\n') + '\r\n';
}
