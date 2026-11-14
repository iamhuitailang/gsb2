import { parseCsv } from './csv.js';
import { normalizeHeader } from './schema.js';

const CODE_HEADERS = ['商品编号', '商品编码', '编号', '编码', '货号', '产品编码', '物料编码'];
const NAME_HEADERS = ['商品名称', '名称', '品名', '产品名称'];
const PER_BOX_HEADERS = ['每箱件数', '每箱数量', '箱规', '装箱数', '每箱数', '包装数量'];

function findColumn(headers, aliases) {
  const normalizedAliases = aliases.map(normalizeHeader);
  return headers.findIndex((header) => normalizedAliases.includes(normalizeHeader(header)));
}

export function normalizeCode(value) {
  const text = String(value ?? '')
    .replace(/[\s　]+/g, '')
    .trim();
  if (/^\d+\.0+$/.test(text)) return text.replace(/\.0+$/, '');
  return text;
}

export function parseCount(value) {
  if (value === null || value === undefined) return null;
  let text = String(value)
    .replace(/[,，\s　]/g, '')
    .replace(/[０-９．]/g, (ch) =>
      ch === '．' ? '.' : String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    );
  if (text === '') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/**
 * 解析商品包装表。返回 Map<商品编号, {code, name, unitsPerBox}>。
 * 同一商品编号出现多次时保留第一条，并记录冲突。
 */
export function parsePackagingTable(text) {
  const { rows } = parseCsv(text);
  if (!rows.length) {
    return { items: new Map(), conflicts: [], header: [] };
  }
  const header = rows[0];
  const codeIndex = findColumn(header, CODE_HEADERS);
  const nameIndex = findColumn(header, NAME_HEADERS);
  const perBoxIndex = findColumn(header, PER_BOX_HEADERS);

  if (codeIndex < 0 || perBoxIndex < 0) {
    throw new Error('包装表缺少“商品编号”或“每箱件数”列');
  }

  const items = new Map();
  const conflicts = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (row.every((cell) => String(cell ?? '').trim() === '')) continue;
    const code = normalizeCode(row[codeIndex]);
    if (!code) continue;
    const unitsPerBox = parseCount(row[perBoxIndex]);
    const item = {
      code,
      name: nameIndex >= 0 ? String(row[nameIndex] ?? '').trim() : '',
      unitsPerBox,
    };
    if (items.has(code)) {
      const existing = items.get(code);
      if (existing.unitsPerBox !== unitsPerBox) {
        conflicts.push({
          code,
          values: [existing.unitsPerBox, unitsPerBox],
        });
      }
      continue;
    }
    items.set(code, item);
  }
  return { items, conflicts, header };
}
