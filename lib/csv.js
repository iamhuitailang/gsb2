/**
 * 极简 CSV / 分隔文本解析，零依赖。
 * 支持引号包裹、引号转义、CRLF、BOM。
 */

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function countOutsideQuotes(line, delimiter) {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && ch === delimiter) {
      count++;
    }
  }
  return count;
}

export function sniffDelimiter(text) {
  const firstContentLine =
    text
      .split(/\r?\n/)
      .find((line) => line.trim() !== '') ?? '';
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestCount = 0;
  for (const delimiter of candidates) {
    const count = countOutsideQuotes(firstContentLine, delimiter);
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

export function parseDelimited(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * @returns {{rows: string[][], delimiter: string}}
 */
export function parseCsv(text) {
  const clean = stripBom(String(text).replace(/\r\n?/g, '\n'));
  const delimiter = sniffDelimiter(clean);
  return { rows: parseDelimited(clean, delimiter), delimiter };
}
