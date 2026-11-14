// CSV 解析与盘点表校验。
// 盘点表约定表头（顺序不限，必须三列齐全；兼容带 BOM 的 UTF-8 文件）：
//   sku,product_name,quantity
// 只有表头、没有数据行的文件是合法的“零行表”，由调用方按 isEmpty 区分。

export class CsvValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsvValidationError';
    this.statusCode = 400;
  }
}

// RFC4180 风格解析：支持引号包裹、引号内逗号/换行/双引号转义，支持 CRLF/LF。
// 返回字符串二维数组。
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ',') {
      pushField();
      i += 1;
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushField();
      pushRow();
      i += 1;
    } else if (ch === '\n') {
      pushField();
      pushRow();
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  // 收尾：最后一个字段/行（文件不以换行结尾时）
  if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }
  return rows;
}

// 解析并校验一张盘点表，返回 { items, itemCount, totalQuantity, isEmpty }
// items: [{ sku, productName, quantity }]
export function parseInventoryCsv(text) {
  const rows = parseCsv(text);
  // 丢掉完全空白的行（每个字段 trim 后都为空）
  const meaningful = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (meaningful.length === 0) {
    throw new CsvValidationError('文件内容为空：连表头都没有');
  }

  const header = meaningful[0].map((h) => h.trim());
  const colSku = header.indexOf('sku');
  const colName = header.indexOf('product_name');
  const colQty = header.indexOf('quantity');
  if (colSku === -1 || colName === -1 || colQty === -1) {
    throw new CsvValidationError(
      `表头必须包含 sku,product_name,quantity 三列，实际表头：${header.join(', ')}`
    );
  }

  const items = [];
  const seen = new Set();
  const errors = [];
  for (let r = 1; r < meaningful.length; r += 1) {
    const lineNo = r + 1; // 行号按含表头的 1 起算
    const cols = meaningful[r];
    const sku = (cols[colSku] ?? '').trim();
    const productName = (cols[colName] ?? '').trim();
    const qtyRaw = (cols[colQty] ?? '').trim();

    if (!sku) {
      errors.push(`第 ${lineNo} 行：sku 不能为空`);
      continue;
    }
    if (!productName) {
      errors.push(`第 ${lineNo} 行：product_name 不能为空（sku=${sku}）`);
      continue;
    }
    if (!/^\d+$/.test(qtyRaw)) {
      errors.push(`第 ${lineNo} 行：quantity 必须是非负整数（sku=${sku}，实际值="${qtyRaw}"）`);
      continue;
    }
    if (seen.has(sku)) {
      errors.push(`第 ${lineNo} 行：sku=${sku} 在文件中重复出现`);
      continue;
    }
    seen.add(sku);
    items.push({ sku, productName, quantity: Number(qtyRaw) });
  }

  if (errors.length > 0) {
    const shown = errors.slice(0, 10).join('；');
    const more = errors.length > 10 ? `；……另有 ${errors.length - 10} 个错误` : '';
    throw new CsvValidationError(`盘点表校验失败：${shown}${more}`);
  }

  const totalQuantity = items.reduce((sum, it) => sum + it.quantity, 0);
  return {
    items,
    itemCount: items.length,
    totalQuantity,
    isEmpty: items.length === 0,
  };
}
