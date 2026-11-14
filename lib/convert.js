import { parseCsv } from './csv.js';
import {
  FIELD_DEFS,
  RULES,
  buildAliasIndex,
  detectSchema,
  findHeaderRow,
  normalizeUnit,
} from './schema.js';
import { normalizeCode, parseCount } from './packaging.js';

export const ROW_STATUS = {
  ok: 'ok',
  warning: 'warning',
  error: 'error',
};

function formatNumber(value) {
  if (!Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 10000) / 10000);
}

/**
 * 解析计量单位。只有“单位单元格为空”时才使用默认单位；
 * 写了但认不出的单位不猜，返回 null 交给调用方报错。
 */
function resolveUnit(rawUnit, defaultUnit) {
  const text = String(rawUnit ?? '').trim();
  if (text === '') return normalizeUnit(defaultUnit);
  return normalizeUnit(text);
}

function splitRows(text, schema, headerRowIndex) {
  const { rows } = parseCsv(text);
  const headers = (rows[headerRowIndex] ?? []).map((cell) => String(cell ?? '').trim());
  const dataRows = [];

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    if (cells.every((cell) => String(cell ?? '').trim() === '')) continue;
    const values = {};
    for (const column of schema.columns) {
      if (!column.field || column.field === 'ignore') continue;
      values[column.field] = String(cells[column.index] ?? '').trim();
    }
    dataRows.push({
      sourceLine: i + 1, // 文件中的物理行号（1-based），用于回看原始行
      cells,
      values,
    });
  }
  return { headers, dataRows };
}

/**
 * 按识别出的规则逐行换算为统一件数。
 *
 * @param {object} params
 * @param {string} params.text 清单原始文本
 * @param {Map} params.packaging 商品编号 -> {code,name,unitsPerBox}
 * @param {object} [params.schema] 已计算好的 schema（配置映射后复用）
 * @param {object} [params.options] { headerRowIndex, customAliases, mapping, defaultUnit }
 */
export function buildPreview({ text, packaging, schema: providedSchema, options = {} }) {
  const { rows } = parseCsv(text);
  const aliasIndex = buildAliasIndex(options.customAliases);
  const headerRowIndex = options.headerRowIndex ?? findHeaderRow(rows, aliasIndex);
  const schema =
    providedSchema ??
    detectSchema(rows[headerRowIndex] ?? [], {
      ...options,
      dataRows: rows.slice(headerRowIndex + 1),
    });
  const rule = schema.version ? RULES[schema.version] : null;

  const totals = {
    rows: 0,
    okRows: 0,
    errorRows: 0,
    warningRows: 0,
    pieces: 0,
    boxRows: 0,
    pieceRows: 0,
    boxQuantity: 0,
  };
  const lines = [];
  const errors = [];
  const productCodes = [];

  if (!rule) {
    return {
      schema,
      rule: null,
      headers: (rows[headerRowIndex] ?? []).map((cell) => String(cell ?? '').trim()),
      headerRowIndex,
      lines,
      totals,
      errors: [
        {
          message:
            schema.versionProblem === 'both_quantity_fields'
              ? '同时匹配到“整箱数量”和“数量”，无法确定版本，请手动指定数量列。'
              : '未能识别数量列，无法确定清单版本。',
          kind: 'schema',
        },
      ],
      status: 'blocked',
      productCodes,
    };
  }

  const { headers, dataRows } = splitRows(text, schema, headerRowIndex);

  for (const row of dataRows) {
    totals.rows++;
    const warnings = [];
    const rowErrors = [];
    const code = normalizeCode(row.values.productCode);
    const name = row.values.productName ?? '';
    const packagingItem = code ? packaging.get(code) : undefined;
    const unitsPerBox = packagingItem?.unitsPerBox ?? null;

    let rawQuantity = null;
    let unitKind = null;
    let factor = null;
    let pieces = null;
    let formula = '';

    if (rule.version === 'old') {
      rawQuantity = parseCount(row.values.boxQty);
      unitKind = 'box';
      if (rawQuantity === null) rowErrors.push('整箱数量无法解析');
      if (rawQuantity !== null && unitsPerBox > 0) {
        factor = unitsPerBox;
        pieces = rawQuantity * factor;
        formula = `${formatNumber(rawQuantity)} 箱 × ${formatNumber(factor)} 件/箱 = ${formatNumber(pieces)} 件`;
      }
    } else {
      rawQuantity = parseCount(row.values.qty);
      const rawUnit = row.values.unit ?? '';
      unitKind = resolveUnit(rawUnit, options.defaultUnit);
      if (rawQuantity === null) rowErrors.push('数量无法解析');
      if (!unitKind) {
        rowErrors.push(`无法识别计量单位“${rawUnit || '空'}”`);
      } else if (unitKind === 'piece') {
        factor = 1;
        if (rawQuantity !== null) {
          pieces = rawQuantity;
          formula = `${formatNumber(rawQuantity)} 件（按件直接计量）= ${formatNumber(pieces)} 件`;
        }
      } else if (rawQuantity !== null && unitsPerBox > 0) {
        factor = unitsPerBox;
        pieces = rawQuantity * factor;
        formula = `${formatNumber(rawQuantity)} 箱 × ${formatNumber(factor)} 件/箱 = ${formatNumber(pieces)} 件`;
      }
    }

    // 商品编号必填；包装表只在需要“按箱换算”时才必须命中，
    // 按件计量的行即使包装表没有该商品也能得到统一件数。
    if (!code) rowErrors.push('缺少商品编号');
    else if (unitKind === 'box') {
      if (!packagingItem) rowErrors.push(`包装表中找不到商品 ${code}，无法按箱换算`);
      else if (!(Number.isFinite(unitsPerBox) && unitsPerBox > 0)) {
        rowErrors.push(`商品 ${code} 在包装表中缺少有效的每箱件数`);
      }
    } else if (unitKind === 'piece' && !packagingItem) {
      warnings.push(`商品 ${code} 不在包装表中；按件计量可直接计件，按箱换算时会无法核对。`);
    }
    if (pieces === null) {
      rowErrors.push('换算失败：无法得到统一件数');
    } else if (!Number.isInteger(pieces)) {
      warnings.push('换算结果不是整数件，请核对数量或包装。');
    }
    if (pieces !== null && pieces < 0) rowErrors.push('换算件数为负数');

    const status = rowErrors.length
      ? ROW_STATUS.error
      : warnings.length
        ? ROW_STATUS.warning
        : ROW_STATUS.ok;

    if (status === ROW_STATUS.error) totals.errorRows++;
    else if (status === ROW_STATUS.warning) totals.warningRows++;
    else totals.okRows++;

    if (pieces !== null && rowErrors.length === 0) {
      totals.pieces += pieces;
      if (unitKind === 'box') {
        totals.boxRows++;
        if (Number.isFinite(rawQuantity)) totals.boxQuantity += rawQuantity;
      } else if (unitKind === 'piece') {
        totals.pieceRows++;
      }
    }

    if (code) productCodes.push(code);

    const line = {
      rowNumber: lines.length + 1,
      sourceLine: row.sourceLine,
      code,
      name: name || packagingItem?.name || '',
      rawQuantity,
      rawQuantityText:
        rule.version === 'old' ? row.values.boxQty ?? '' : row.values.qty ?? '',
      rawUnitText: rule.version === 'new' ? row.values.unit ?? '' : '箱',
      unitKind,
      unitsPerBox,
      factor,
      pieces,
      formula,
      status,
      errors: rowErrors,
      warnings,
      sourceCells: row.cells,
      source: { ...row.values },
    };
    lines.push(line);

    for (const message of rowErrors) {
      errors.push({
        message,
        kind: 'row',
        sourceLine: row.sourceLine,
        rowNumber: line.rowNumber,
      });
    }
  }

  return {
    schema,
    rule,
    headers,
    headerRowIndex,
    lines,
    totals,
    errors,
    status: totals.errorRows > 0 ? 'has_errors' : 'ok',
    productCodes: [...new Set(productCodes)],
  };
}

export { FIELD_DEFS };
