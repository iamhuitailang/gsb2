/**
 * 表头识别与字段映射。
 *
 * 旧版清单：商品编码 + 整箱数量（数量一律按箱）
 * 新版清单：商品编号 + 数量 + 计量单位（数量可能按箱，也可能按件）
 *
 * 列顺序不参与判断，全部按表头名称匹配。
 */

export const FIELD_DEFS = {
  productCode: {
    key: 'productCode',
    label: '商品编号 / 编码',
    shortLabel: '商品编号',
    required: true,
    aliases: [
      '商品编码',
      '商品编号',
      '商品代码',
      '商品货号',
      '产品编码',
      '产品编号',
      '货号',
      '物料编码',
      '物料编号',
      'sku',
      '编码',
      '编号',
    ],
  },
  productName: {
    key: 'productName',
    label: '商品名称',
    shortLabel: '商品名称',
    required: false,
    aliases: ['商品名称', '产品名称', '品名', '名称', '货品名称'],
  },
  boxQty: {
    key: 'boxQty',
    label: '整箱数量（旧版）',
    shortLabel: '整箱数量',
    required: false,
    aliases: ['整箱数量', '整箱数', '箱数', '整箱件数', '整箱'],
  },
  qty: {
    key: 'qty',
    label: '数量（新版）',
    shortLabel: '数量',
    required: false,
    aliases: ['数量', '供货数量', '本次数量', '数量合计'],
  },
  unit: {
    key: 'unit',
    label: '计量单位（新版）',
    shortLabel: '计量单位',
    required: false,
    aliases: ['计量单位', '单位', '单位名称', '计量单位名称'],
  },
  ignore: {
    key: 'ignore',
    label: '忽略该列',
    shortLabel: '忽略',
    required: false,
    aliases: ['序号', '行号', '备注', '说明', '摘要'],
  },
};

export const FIELD_KEYS = Object.keys(FIELD_DEFS);

export const RULES = {
  old: {
    id: 'old-box-v1',
    version: 'old',
    label: '旧版表头',
    shortLabel: '旧版',
    title: '旧版规则',
    versionLabel: '旧版 · v1',
    quantityField: '整箱数量',
    summary: '整箱数量 × 包装表每箱件数 = 统一件数',
    detail:
      '旧版清单只提供整箱数量，整箱数按商品包装表中的“每箱件数”换算为件。',
  },
  new: {
    id: 'new-unit-v1',
    version: 'new',
    label: '新版表头',
    shortLabel: '新版',
    title: '新版规则',
    versionLabel: '新版 · v1',
    quantityField: '数量 + 计量单位',
    summary: '按计量单位换算：箱 × 每箱件数，件 × 1',
    detail:
      '新版清单的数量带有计量单位。单位为箱时乘以包装表每箱件数，单位为件时直接计为件。',
  },
};

export const UNIT_KINDS = {
  box: {
    key: 'box',
    label: '箱',
    aliases: ['箱', '整箱', '箱装', 'box', 'boxes', 'case', 'cases', 'ctn', 'carton'],
  },
  piece: {
    key: 'piece',
    label: '件',
    aliases: ['件', 'pcs', 'pc', 'each', 'ea', 'piece', 'pieces', 'unit', 'units'],
  },
};

export function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/[\s　]+/g, '')
    // 去掉常见后缀：(*) 、（元）、(件) 之类
    .replace(/[（(][^（）()]*[）)]\s*$/g, '')
    .replace(/[*＊:：]+$/g, '')
    .trim()
    .toLowerCase();
}

export function normalizeUnit(value) {
  const normalized = normalizeHeader(value);
  for (const kind of Object.values(UNIT_KINDS)) {
    if (kind.aliases.includes(normalized)) return kind.key;
  }
  return null;
}

export function buildAliasIndex(customAliases = {}) {
  const index = new Map();
  for (const field of Object.values(FIELD_DEFS)) {
    for (const alias of field.aliases) {
      index.set(normalizeHeader(alias), field.key);
    }
  }
  for (const [alias, field] of Object.entries(customAliases ?? {})) {
    if (!FIELD_DEFS[field]) continue;
    const normalized = normalizeHeader(alias);
    if (normalized) index.set(normalized, field);
  }
  return index;
}

/**
 * 在前若干行中找出最像表头的一行：命中已知表头别名最多的一行。
 * 单格标题行（合并单元格的“某某供货清单”）会被跳过，避免抢占表头位置。
 */
export function findHeaderRow(rows, aliasIndex, maxScan = 10) {
  let best = { index: 0, score: -1 };
  const limit = Math.min(rows.length, maxScan);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] ?? [];
    const nonEmpty = row.filter((cell) => String(cell ?? '').trim() !== '');
    if (nonEmpty.length === 0) continue;
    let score = 0;
    for (const cell of row) {
      const normalized = normalizeHeader(cell);
      if (normalized && aliasIndex.has(normalized)) score++;
    }
    // 单个非空单元格的标题行：只有它本身是已知表头时才参与竞争。
    if (nonEmpty.length === 1 && score === 0) continue;
    if (score > best.score) best = { index: i, score };
  }
  return best.score >= 1 ? best.index : 0;
}

export function detectSchema(headers, options = {}) {
  const {
    customAliases = {},
    mapping = {},
    defaultUnit = null,
    dataRows = [],
  } = options;
  const aliasIndex = buildAliasIndex(customAliases);
  const columnHasData = (index) =>
    dataRows.some((row) => String(row?.[index] ?? '').trim() !== '');

  const columns = headers.map((header, index) => {
    const override = mapping[index] ?? mapping[String(index)];
    const normalized = normalizeHeader(header);
    let field = null;
    let autoIgnored = false;
    // 'unmapped' 表示用户显式取消映射：不再回退到别名自动识别。
    if (override === 'unmapped') {
      field = null;
    } else if (override && FIELD_DEFS[override]) {
      field = override;
    } else if (normalized && aliasIndex.has(normalized)) {
      field = aliasIndex.get(normalized);
    } else if (!normalized && !columnHasData(index)) {
      // 表头为空且整列没有数据：多为导出文件尾部的空列，直接忽略。
      field = 'ignore';
      autoIgnored = true;
    }
    return {
      index,
      header: String(header ?? ''),
      normalized,
      field,
      unknown: field === null,
      autoIgnored,
      overridden: Boolean(override && override !== 'unmapped' && FIELD_DEFS[override]),
      forcedUnknown: override === 'unmapped',
    };
  });

  const fieldCounts = new Map();
  for (const col of columns) {
    if (!col.field || col.field === 'ignore') continue;
    fieldCounts.set(col.field, (fieldCounts.get(col.field) ?? 0) + 1);
  }
  const conflicts = [...fieldCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([field]) => ({
      field,
      label: FIELD_DEFS[field].label,
      headers: columns.filter((c) => c.field === field).map((c) => c.header),
    }));

  const unknownColumns = columns
    .filter((c) => c.unknown)
    .map((c) => ({ index: c.index, header: c.header }));

  const has = (field) => columns.some((c) => c.field === field);

  let version = null;
  let versionProblem = null;
  if (has('qty') && has('boxQty')) {
    versionProblem = 'both_quantity_fields';
  } else if (has('qty')) {
    version = 'new';
  } else if (has('boxQty')) {
    version = 'old';
  } else {
    versionProblem = 'no_quantity_field';
  }

  const missingFields = [];
  if (!has('productCode')) missingFields.push('productCode');
  if (version === 'new' && !has('unit') && !normalizeUnit(defaultUnit)) {
    missingFields.push('unit');
  }
  if (version === 'old' && has('unit')) {
    // 旧版表里出现计量单位时不影响换算，但需提示该列不会被使用。
  }

  const status =
    version && !versionProblem && !unknownColumns.length && !conflicts.length && !missingFields.length
      ? 'ready'
      : 'needs_mapping';

  return {
    status,
    version,
    rule: version ? RULES[version] : null,
    columns,
    unknownColumns,
    conflicts,
    missingFields,
    versionProblem,
    mappingByHeader: Object.fromEntries(
      columns.filter((c) => c.field).map((c) => [c.header, c.field]),
    ),
  };
}

export function schemaSummary(schema) {
  if (!schema.version) {
    return '未能确定清单版本';
  }
  const rule = RULES[schema.version];
  const fields = schema.columns
    .filter((c) => c.field && c.field !== 'ignore')
    .map((c) => `${c.header} → ${FIELD_DEFS[c.field].shortLabel}`);
  return `${rule.versionLabel}：${fields.join('，')}`;
}
