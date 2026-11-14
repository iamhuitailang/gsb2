const state = {
  meta: null,
  current: null, // 当前预览结果
  pendingList: [],
  selectedLine: null,
  activeTab: 'import',
  dirty: false,
  focusColumn: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== null && value !== undefined && value !== false) {
      node.setAttribute(key, value);
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of [].concat(children)) {
    if (child == null || child === '') continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

function toast(message, kind = '') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.className = 'toast';
  }, kind === 'err' ? 5200 : 2800);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const body = isJson ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(body?.error || `请求失败（${response.status}）`);
  }
  return body;
}

const fmt = (value) =>
  value === null || value === undefined || value === ''
    ? '—'
    : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value);

const UNIT_LABEL = { box: '箱', piece: '件' };

/* ------------------------------- 渲染：步骤 2 ------------------------------- */

function renderPendingPanel() {
  const host = $('#pending-panel');
  host.replaceChildren();
  if (!state.current) return;

  const { file, schema, rule, headerRowIndex, rawPreviewRows } = state.current;
  const panel = el('div', { class: 'panel' });
  panel.append(
    el('h2', {}, [el('span', { class: 'step-badge' }, '2'), '识别结果与规则确认']),
  );

  panel.append(
    el('div', { class: 'inline-field', style: 'margin-bottom:12px' }, [
      el('span', { text: `文件：${file.filename}` }),
      el('span', { class: 'badge gray', text: `表头在第 ${headerRowIndex + 1} 行` }),
    ]),
  );

  // —— 规则卡片：明确展示采用哪一版规则
  if (rule) {
    const card = el('div', { class: `rule-card ${rule.version}` }, [
      el('span', { class: `rule-chip ${rule.version}`, text: rule.versionLabel }),
      el('div', { class: 'rule-body' }, [
        el('div', { class: 'rule-title', text: rule.summary }),
        el('div', { class: 'rule-detail', text: rule.detail }),
        el('div', { class: 'rule-formula', text: ruleFormulaText() }),
      ]),
    ]);
    panel.append(card);
  } else {
    panel.append(
      el('div', { class: 'rule-card unknown' }, [
        el('span', { class: 'rule-chip unknown', text: '未识别版本' }),
        el('div', { class: 'rule-body' }, [
          el('div', {
            class: 'rule-title',
            text:
              schema.versionProblem === 'both_quantity_fields'
                ? '同时出现「整箱数量」和「数量」，无法自动判定采用哪一版规则'
                : '没有找到可用的数量列',
          }),
          el('div', {
            class: 'rule-detail',
            text: '请在下方的字段对应关系中指定数量列；保存后重新预览即可确定规则。',
          }),
        ]),
      ]),
    );
  }

  // —— 问题提示
  if (schema.unknownColumns.length) {
    panel.append(
      el('div', { class: 'banner warn' }, [
        el('span', { class: 'banner-icon', text: '!' }),
        el('div', {}, [
          el('div', { text: `有 ${schema.unknownColumns.length} 个表头认不出来，文件已保留等待处理：` }),
          el(
            'div',
            { class: 'unknown-list' },
            schema.unknownColumns.map((column) =>
              el('span', { class: 'unknown-chip', text: `第 ${column.index + 1} 列「${column.header || '空表头'}」` }),
            ),
          ),
          el('div', {
            style: 'margin-top:8px;font-size:12.5px',
            text: '给它们配置字段对应关系后重新预览；不需要的列可选择「忽略该列」。',
          }),
        ]),
      ]),
    );
  }

  if (schema.conflicts.length) {
    panel.append(
      el('div', { class: 'banner err' }, [
        el('span', { class: 'banner-icon', text: '!' }),
        el('div', {}, [
          el('div', { text: '同一字段被重复指定，请调整为唯一列：' }),
          el(
            'ul',
            {},
            schema.conflicts.map((conflict) =>
              el('li', { text: `${conflict.label}：${conflict.headers.join('、')}` }),
            ),
          ),
        ]),
      ]),
    );
  }

  if (schema.missingFields.length) {
    const labelMap = {
      productCode: '商品编号 / 编码',
      unit: '计量单位（新版必需）',
    };
    panel.append(
      el('div', { class: 'banner warn' }, [
        el('span', { class: 'banner-icon', text: '!' }),
        el('div', {
          text: `还缺少必需字段：${schema.missingFields.map((f) => labelMap[f] ?? f).join('、')}`,
        }),
      ]),
    );
  }

  // —— 同商品的来源对照（按箱 / 按件），帮助理解“不同来源如何算出统一件数”
  const comparison = buildSourceComparison();
  if (comparison.length) {
    panel.append(
      el('h3', { style: 'font-size:13.5px;margin:18px 0 8px', text: '不同来源的换算对照' }),
    );
    const wrap = el('div', { class: 'table-wrap' });
    const table = el('table', { class: 'data' }, [
      el('thead', {}, [
        el(
          'tr',
          {},
          ['商品', '来源行', '原始数量', '单位', '每箱件数', '换算过程', '统一件数'].map((text) =>
            el('th', { text }),
          ),
        ),
      ]),
    ]);
    const body = el('tbody');
    for (const group of comparison) {
      for (const line of group.lines) {
        body.append(
          el('tr', {}, [
            el('td', {}, [
              el('div', { class: 'mono', text: group.code }),
              el('div', { style: 'font-size:12px;color:#65707c', text: group.name || '' }),
            ]),
            el('td', { text: `第 ${line.sourceLine} 行` }),
            el('td', { class: 'num mono', text: `${fmt(line.rawQuantity)} ${UNIT_LABEL[line.unitKind] ?? ''}` }),
            el('td', {}, [
              el('span', {
                class: `badge ${line.unitKind === 'box' ? 'info' : 'gray'}`,
                text: UNIT_LABEL[line.unitKind] ?? '—',
              }),
            ]),
            el('td', { class: 'num mono', text: fmt(line.unitsPerBox) }),
            el('td', { class: 'mono', style: 'font-size:12.5px', text: line.formula }),
            el('td', { class: 'num mono', text: fmt(line.pieces) }),
          ]),
        );
      }
    }
    table.append(body);
    wrap.append(table);
    panel.append(wrap);
  }

  // —— 字段对应关系
  panel.append(el('h3', { style: 'font-size:13.5px;margin:18px 0 8px', text: '字段对应关系' }));
  panel.append(renderMappingTable());

  const unitSelect = el(
    'select',
    {
      onchange: (event) => updateDefaultUnit(event.target.value || null),
    },
    [
      el('option', { value: '', text: '未设置（按表中单位）' }),
      el('option', { value: '箱', text: '默认按箱' }),
      el('option', { value: '件', text: '默认按件' }),
    ],
  );
  unitSelect.value = state.current.defaultUnit ?? '';
  panel.append(
    el('div', { style: 'margin-top:12px;display:flex;gap:16px;flex-wrap:wrap;align-items:center' }, [
      el('label', { class: 'inline-field' }, [
        el('span', { text: '新版清单缺失单位时：' }),
        unitSelect,
      ]),
    ]),
  );

  const rePreviewBtn = el(
    'button',
    { class: 'btn primary', disabled: !state.dirty, onClick: () => rePreview() },
    state.dirty ? '重新预览（映射已修改）' : '重新预览',
  );
  const removeBtn = el(
    'button',
    { class: 'btn danger', onClick: () => removeCurrent() },
    '删除此文件',
  );
  panel.append(
    el('div', { class: 'toolbar' }, [
      rePreviewBtn,
      el('span', {
        class: 'note',
        text: state.dirty
          ? '映射已修改，点击“重新预览”后，下方的换算结果才会更新。'
          : '确认导入以当前预览结果为准。',
      }),
      el('span', { class: 'spacer' }),
      removeBtn,
    ]),
  );

  host.append(panel);

  // 映射修改后重建面板时，把焦点还给刚刚操作的那一列。
  if (state.focusColumn !== null && state.focusColumn !== undefined) {
    const target = host.querySelector(`select[data-column="${state.focusColumn}"]`);
    state.focusColumn = null;
    if (target) target.focus();
  }

  function ruleFormulaText() {
    if (!rule) return '';
    const columns = schema.columns.filter((c) => c.field && c.field !== 'ignore');
    if (rule.version === 'old') {
      const boxCol = columns.find((c) => c.field === 'boxQty');
      return `${boxCol?.header ?? '整箱数量'} × 包装表「每箱件数」→ 件`;
    }
    const qtyCol = columns.find((c) => c.field === 'qty');
    const unitCol = columns.find((c) => c.field === 'unit');
    const unitText = unitCol
      ? `${unitCol.header} = 箱 → × 每箱件数；= 件 → × 1`
      : state.current.defaultUnit
        ? `缺少单位列，按默认单位「${state.current.defaultUnit}」换算`
        : '缺少单位列';
    return `${qtyCol?.header ?? '数量'} × 单位换算（${unitText}）→ 件`;
  }
}

function buildSourceComparison() {
  const preview = state.current;
  if (!preview?.lines?.length) return [];
  const groups = new Map();
  for (const line of preview.lines) {
    if (!line.code || line.pieces === null) continue;
    if (!groups.has(line.code)) {
      groups.set(line.code, { code: line.code, name: line.name, lines: [] });
    }
    groups.get(line.code).lines.push(line);
  }
  // 只展示“同一商品出现多种计量来源”的条目，这正是需要核对的地方。
  return [...groups.values()]
    .filter((group) => new Set(group.lines.map((line) => line.unitKind)).size > 1)
    .map((group) => ({
      ...group,
      lines: [...group.lines].sort((a, b) => a.sourceLine - b.sourceLine),
    }));
}

function renderMappingTable() {
  const { schema } = state.current;
  const fieldOptions = state.meta.fields;
  const table = el('table', { class: 'mapping-table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '列（按文件顺序）' }),
        el('th', { text: '表头' }),
        el('th', { text: '字段对应' }),
        el('th', { text: '状态' }),
      ]),
    ]),
  ]);

  const body = el('tbody');
  for (const column of schema.columns) {
    const select = el('select', {
      onchange: (event) => onMappingChange(column, event.target.value),
      'data-column': column.index,
    });
    select.append(el('option', { value: '', text: '— 未识别 —' }));
    for (const field of fieldOptions) {
      select.append(el('option', { value: field.key, text: field.label }));
    }
    select.append(el('option', { value: 'ignore', text: '忽略该列' }));
    select.value = column.field ?? '';
    select.className = column.unknown ? 'unknown' : column.field ? 'assigned' : '';
    let status;
    if (column.unknown) status = el('span', { class: 'badge warn', text: '认不出' });
    else if (column.field === 'ignore') status = el('span', { class: 'badge gray', text: '忽略' });
    else if (column.overridden) status = el('span', { class: 'badge info', text: '已手动配置' });
    else status = el('span', { class: 'badge ok', text: '已识别' });

    body.append(
      el('tr', {}, [
        el('td', { text: `第 ${column.index + 1} 列`, style: 'color:#65707c;white-space:nowrap' }),
        el('td', { class: 'mono', text: column.header || '（空）' }),
        el('td', { style: 'min-width:180px' }, [select]),
        el('td', {}, [status]),
      ]),
    );
  }
  table.append(body);
  return table;
}

/* ------------------------------- 渲染：步骤 3 ------------------------------- */

function renderResultPanel() {
  const host = $('#result-panel');
  host.replaceChildren();
  if (!state.current || !state.current.rule) return;

  const preview = state.current;
  const panel = el('div', { class: 'panel' }, [
    el('h2', {}, [el('span', { class: 'step-badge' }, '3'), '统一件数预览']),
  ]);

  if (preview.schema.status !== 'ready') {
    panel.append(
      el('div', { class: 'banner warn' }, [
        el('span', { class: 'banner-icon', text: '!' }),
        el('div', {
          text: '表头仍有未确定的部分。请回到上方完成字段对应关系并重新预览，之后才能确认导入。',
        }),
      ]),
    );
  } else if (preview.status === 'has_errors') {
    panel.append(
      el('div', { class: 'banner err' }, [
        el('span', { class: 'banner-icon', text: '!' }),
        el('div', {
          text: `有 ${preview.totals.errorRows} 行存在错误，修正前无法确认导入。可在下方展开行查看原因。`,
        }),
      ]),
    );
  } else {
    panel.append(
      el('div', { class: 'banner ok' }, [
        el('span', { class: 'banner-icon', text: '✓' }),
        el('div', { text: '所有行均已成功换算为统一件数，可确认导入。' }),
      ]),
    );
  }

  const totals = preview.totals;
  panel.append(
    el('div', { class: 'stat-row' }, [
      el('div', { class: 'stat' }, [
        el('div', { class: 'label', text: '数据行' }),
        el('div', { class: 'value', text: fmt(totals.rows) }),
        el('div', { class: 'meta', text: `正常 ${fmt(totals.okRows)} · 提示 ${fmt(totals.warningRows)} · 错误 ${fmt(totals.errorRows)}` }),
      ]),
      el('div', { class: 'stat' }, [
        el('div', { class: 'label', text: '按箱计量行' }),
        el('div', { class: 'value', text: fmt(totals.boxRows) }),
        el('div', { class: 'meta', text: `合计 ${fmt(totals.boxQuantity)} 箱` }),
      ]),
      el('div', { class: 'stat' }, [
        el('div', { class: 'label', text: '按件计量行' }),
        el('div', { class: 'value', text: fmt(totals.pieceRows) }),
        el('div', { class: 'meta', text: '直接计为件' }),
      ]),
      el('div', { class: 'stat emphasis' }, [
        el('div', { class: 'label', text: '统一件数合计' }),
        el('div', { class: 'value', text: fmt(totals.pieces) }),
        el('div', { class: 'meta', text: '仅统计无错误行' }),
      ]),
    ]),
  );

  panel.append(
    el('div', { class: 'inline-field', style: 'margin-bottom:10px' }, [
      el('span', { text: '点击任意行可展开，核对原始行与换算过程。' }),
    ]),
  );

  panel.append(renderLinesTable());

  if (state.dirty) {
    panel.append(
      el('div', { class: 'banner warn' }, [
        el('span', { class: 'banner-icon', text: '!' }),
        el('div', { text: '字段对应关系已修改但尚未重新预览，请先点击“重新预览”再确认导入。' }),
      ]),
    );
  }

  const canConfirm = preview.status === 'ok' && preview.schema.status === 'ready' && !state.dirty;
  const confirmBtn = el(
    'button',
    {
      class: 'btn primary',
      disabled: !canConfirm,
      onClick: () => confirmImport(),
    },
    state.dirty
      ? '请先重新预览'
      : preview.status === 'ok'
        ? '确认导入'
        : '有错误，暂不能导入',
  );
  panel.append(
    el('div', { class: 'toolbar' }, [
      confirmBtn,
      el('span', {
        class: 'note',
        text: `将保存：${preview.rule.versionLabel} · 字段映射 · 包装表快照 · 换算结果`,
      }),
    ]),
  );

  host.append(panel);
}

function renderLinesTable() {
  const preview = state.current;
  const wrap = el('div', { class: 'table-wrap' });
  const table = el('table', { class: 'data' });

  const isOld = preview.rule.version === 'old';
  const headers = [
    '#',
    '商品编号',
    '商品名称',
    isOld ? '整箱数量' : '数量',
    '单位',
    '每箱件数',
    '换算系数',
    '统一件数',
    '状态',
  ];

  table.append(
    el('thead', {}, [
      el('tr', {}, headers.map((text) => el('th', { text }))),
    ]),
  );

  const body = el('tbody');
  preview.lines.forEach((line) => {
    const tr = el('tr', {
      onClick: () => toggleLine(line.rowNumber),
    });
    if (state.selectedLine === line.rowNumber) tr.classList.add('selected');

    const statusBadge =
      line.status === 'error'
        ? el('span', { class: 'badge err', text: '错误' })
        : line.status === 'warning'
          ? el('span', { class: 'badge warn', text: '提示' })
          : el('span', { class: 'badge ok', text: '正常' });

    tr.append(
      el('td', { class: 'num', text: String(line.rowNumber) }),
      el('td', { class: 'mono', text: line.code || '—' }),
      el('td', { text: line.name || '—' }),
      el('td', { class: 'num mono', text: fmt(line.rawQuantity) }),
      el('td', {}, [
        el('span', {
          class: `badge ${line.unitKind === 'box' ? 'info' : 'gray'}`,
          text: isOld ? '箱' : line.rawUnitText || '—',
        }),
      ]),
      el('td', { class: 'num mono', text: fmt(line.unitsPerBox) }),
      el('td', { class: 'num mono', text: line.factor === null ? '—' : `× ${fmt(line.factor)}` }),
      el('td', { class: 'num mono', text: line.pieces === null ? '—' : fmt(line.pieces) }),
      el('td', {}, [statusBadge]),
    );
    body.append(tr);

    if (line.status !== 'ok') {
      const detail = el('tr');
      const cell = el('td', { colspan: headers.length });
      cell.append(
        el(
          'div',
          { style: 'padding:2px 10px 8px 42px' },
          [
            ...line.errors.map((message) => el('div', { class: 'err-text', text: `错误：${message}` })),
            ...line.warnings.map((message) => el('div', { class: 'warn-text', text: `提示：${message}` })),
          ],
        ),
      );
      detail.append(cell);
      body.append(detail);
    }

    if (state.selectedLine === line.rowNumber) {
      body.append(renderSourceRow(line, headers.length));
    }
  });

  table.append(body);
  wrap.append(table);
  return wrap;
}

function renderSourceRow(line, colspan) {
  const preview = state.current;
  const isOld = preview.rule.version === 'old';
  const sourceHeaders = preview.headers;
  const mappingByHeader = Object.fromEntries(
    preview.schema.columns
      .filter((c) => c.field && c.field !== 'ignore')
      .map((c) => [c.index, c.field]),
  );

  const sourceTable = el('table', { class: 'source-table' });
  sourceTable.append(
    el('thead', {}, [
      el('tr', {}, [
        ...sourceHeaders.map((header, index) => {
          const field = mappingByHeader[index];
          const mapped = field && field !== 'ignore';
          return el('th', { class: mapped ? 'mapped' : '', text: header || `第 ${index + 1} 列` });
        }),
        el('th', { text: '文件行号', style: 'white-space:nowrap' }),
      ]),
    ]),
  );
  sourceTable.append(
    el('tbody', {}, [
      el('tr', {}, [
        ...sourceHeaders.map((_, index) =>
          el('td', {
            class: mappingByHeader[index] ? 'mapped' : '',
            text: line.sourceCells[index] ?? '',
          }),
        ),
        el('td', { text: `第 ${line.sourceLine} 行` }),
      ]),
    ]),
  );

  const steps = [
    ['原始数量', isOld
      ? `${line.rawQuantityText || '—'} 箱`
      : `${line.rawQuantityText || '—'} ${line.rawUnitText || '（未写单位）'}`],
    ['商品编号', line.code || '—'],
    ['包装表每箱件数', line.unitsPerBox === null ? '—' : `${fmt(line.unitsPerBox)} 件/箱`],
    ['计量单位判定', line.unitKind ? `${UNIT_LABEL[line.unitKind]}` : '—'],
    ['换算系数', line.factor === null ? '—' : `× ${fmt(line.factor)}`],
    ['统一件数', line.pieces === null ? '—' : `${fmt(line.pieces)} 件`],
  ];

  return el('tr', { class: 'source-row' }, [
    el('td', { colspan }, [
      el('div', { class: 'source-inner' }, [
        el('div', { class: 'source-header' }, [
          el('strong', { text: `原始行（第 ${line.sourceLine} 行）` }),
          el('span', { class: 'badge gray', text: preview.rule.versionLabel }),
        ]),
        sourceTable,
        el(
          'ul',
          { class: 'calc-steps' },
          steps.map(([key, value]) =>
            el('li', {}, [el('span', { class: 'k', text: key }), el('span', { class: 'v', text: value })]),
          ),
        ),
        el('div', {
          style: 'margin-top:10px;font-size:12.5px;color:#46505c',
          text: `换算：${line.formula || '未完成'}`,
        }),
      ]),
    ]),
  ]);
}

function toggleLine(rowNumber) {
  state.selectedLine = state.selectedLine === rowNumber ? null : rowNumber;
  renderResultPanel();
}

/* ------------------------------- 交互逻辑 ------------------------------- */

async function loadMeta() {
  state.meta = await api('/api/meta');
}

async function loadPendingList() {
  const { imports } = await api('/api/imports');
  state.pendingList = imports;
}

/**
 * 待处理文件列表：未识别表头或未确认的文件会一直留在这里，随时可以继续处理。
 */
function renderPendingList() {
  const host = $('#pending-list');
  if (!host) return;
  host.replaceChildren();
  const items = state.pendingList;
  if (!items.length) {
    host.append(el('div', { class: 'empty', text: '没有待处理文件。' }));
    return;
  }

  const list = el('div', { class: 'pending-items' });
  for (const item of items) {
    const active = state.current?.file.id === item.id;
    const unresolved = item.lastPreviewStatus !== 'ok' || item.detectedVersion == null;
    const row = el('button', {
      class: `pending-item ${active ? 'active' : ''}`,
      onClick: () => openPending(item.id),
    }, [
      el('div', { class: 'pending-main' }, [
        el('div', { class: 'pending-name', text: item.filename }),
        el('div', {
          class: 'pending-sub',
          text: `${new Date(item.createdAt).toLocaleString('zh-CN')} · ${
            item.detectedVersion ? (item.detectedVersion === 'old' ? '旧版表头' : '新版表头') : '未识别'
          }`,
        }),
      ]),
      el('span', {
        class: `badge ${unresolved ? 'warn' : 'info'}`,
        text: unresolved ? '待处理' : active ? '正在查看' : '待确认',
      }),
    ]);
    list.append(row);
  }
  host.append(list);
}

async function openPending(id) {
  try {
    const preview = await api(`/api/imports/${id}`);
    state.current = preview;
    state.selectedLine = null;
    state.dirty = false;
    renderPendingList();
    renderPendingPanel();
    renderResultPanel();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function onFileSelected(file) {
  if (!file) return;
  const form = new FormData();
  form.append('file', file, file.name);
  try {
    const preview = await api('/api/imports', { method: 'POST', body: form });
    state.current = preview;
    state.selectedLine = null;
    state.dirty = false;
    renderPendingPanel();
    renderResultPanel();
    await loadPendingList();
    renderPendingList();
    if (preview.schema.unknownColumns.length) {
      toast('识别到未知表头，请配置字段对应关系后重新预览', 'err');
    } else if (!preview.rule) {
      toast('未能自动识别清单版本，请手动指定数量列', 'err');
    } else {
      toast(`已识别为${preview.rule.versionLabel}`);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function rePreview() {
  if (!state.current) return;
  // 只回传“用户显式改过”的列，其余交给服务端按别名自动识别。
  const mapping = {};
  for (const column of state.current.schema.columns) {
    if (column.unknown) mapping[column.index] = 'unmapped';
    else if (column.overridden && column.field) mapping[column.index] = column.field;
    else if (column.field === 'ignore' && !column.autoIgnored) mapping[column.index] = 'ignore';
  }
  try {
    const preview = await api(`/api/imports/${state.current.file.id}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mapping,
        headerRowIndex: state.current.headerRowIndex,
        defaultUnit: state.current.defaultUnit ?? null,
      }),
    });
    state.current = preview;
    state.selectedLine = null;
    state.dirty = false;
    renderPendingPanel();
    renderResultPanel();
    toast(preview.rule ? `已按${preview.rule.versionLabel}重新预览` : '仍未能识别版本');
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function onMappingChange(column, value) {
  column.field = value || null;
  column.unknown = !value;
  // 只有在“自动识别之外”的选择才算手动配置；ignore 也算显式配置。
  column.overridden = Boolean(value);
  column.autoIgnored = false;
  state.dirty = true;
  // 记录焦点列，重建映射表后把焦点还回去，方便连续配置。
  state.focusColumn = column.index;
  renderPendingPanel();
  renderResultPanel();
}

async function updateDefaultUnit(value) {
  if (!state.current) return;
  state.current.defaultUnit = value;
  await rePreview();
}

async function removeCurrent() {
  if (!state.current) return;
  if (!confirm(`删除待处理文件「${state.current.file.filename}」？`)) return;
  try {
    await api(`/api/imports/${state.current.file.id}`, { method: 'DELETE' });
    state.current = null;
    state.selectedLine = null;
    state.dirty = false;
    renderPendingPanel();
    renderResultPanel();
    await loadPendingList();
    renderPendingList();
    toast('已删除待处理文件');
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function confirmImport() {
  if (!state.current) return;
  const preview = state.current;
  if (state.dirty || preview.status !== 'ok' || preview.schema.status !== 'ready') return;
  try {
    const result = await api(`/api/imports/${preview.file.id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmedBy: '' }),
    });
    toast(`已导入批次 ${result.batch.id}，共 ${fmt(result.batch.totals.pieces)} 件`);
    state.current = null;
    state.selectedLine = null;
    state.dirty = false;
    renderPendingPanel();
    renderResultPanel();
    await loadPendingList();
    renderPendingList();
    await loadBatches();
  } catch (error) {
    toast(error.message, 'err');
  }
}

/* ------------------------------- 批次视图 ------------------------------- */

async function loadBatches() {
  try {
    const { batches } = await api('/api/batches');
    const host = $('#batch-list');
    if (!batches.length) {
      host.replaceChildren(el('div', { class: 'empty', text: '还没有已确认的批次。' }));
      return;
    }
    const wrap = el('div', { class: 'table-wrap' });
    const table = el('table', { class: 'data' }, [
      el('thead', {}, [
        el('tr', {}, ['确认时间', '来源文件', '采用规则', '行数', '统一件数', ''].map((text) => el('th', { text }))),
      ]),
    ]);
    const body = el('tbody');
    for (const batch of batches) {
      const tr = el('tr', {
        onClick: () => loadBatchDetail(batch.id),
      }, [
        el('td', { text: new Date(batch.confirmedAt).toLocaleString('zh-CN') }),
        el('td', { text: batch.filename ?? '—' }),
        el('td', {}, [
          el('span', {
            class: `rule-chip ${batch.rule?.version ?? ''}`,
            text: batch.rule?.versionLabel ?? '—',
          }),
        ]),
        el('td', { class: 'num', text: fmt(batch.lineCount) }),
        el('td', { class: 'num mono', text: fmt(batch.totals?.pieces) }),
        el('td', {}, [el('span', { class: 'badge info', text: '查看快照' })]),
      ]);
      body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    host.replaceChildren(wrap);
  } catch (error) {
    $('#batch-list').replaceChildren(el('div', { class: 'banner err', text: error.message }));
  }
}

async function loadBatchDetail(id) {
  const host = $('#batch-detail');
  host.replaceChildren(el('div', { class: 'panel', text: '加载中…' }));
  try {
    const { batch } = await api(`/api/batches/${id}`);
    const panel = el('div', { class: 'panel' });
    panel.append(el('h2', { text: `批次快照 · ${batch.id}` }));

    panel.append(
      el('div', { class: 'banner info' }, [
        el('span', { class: 'banner-icon', text: 'i' }),
        el('div', {}, [
          el('div', {
            text: `该批次保存的是 ${new Date(batch.confirmedAt).toLocaleString('zh-CN')} 确认时的映射与换算结果，之后修改包装表或表头别名都不会影响这里。`,
          }),
          el('div', {
            style: 'margin-top:4px',
            text: `采用规则：${batch.rule?.versionLabel} · ${batch.rule?.summary}`,
          }),
        ]),
      ]),
    );

    const mappingRows = Object.entries(batch.schema?.mapping ?? {});
    panel.append(
      el('div', { class: 'stat-row' }, [
        el('div', { class: 'stat' }, [
          el('div', { class: 'label', text: '数据行' }),
          el('div', { class: 'value', text: fmt(batch.totals?.rows) }),
        ]),
        el('div', { class: 'stat' }, [
          el('div', { class: 'label', text: '按箱 / 按件' }),
          el('div', { class: 'value', text: `${fmt(batch.totals?.boxRows)} / ${fmt(batch.totals?.pieceRows)}` }),
        ]),
        el('div', { class: 'stat emphasis' }, [
          el('div', { class: 'label', text: '统一件数合计' }),
          el('div', { class: 'value', text: fmt(batch.totals?.pieces) }),
        ]),
      ]),
    );

    panel.append(el('h3', { style: 'font-size:13.5px;margin:4px 0 8px', text: '当时的字段映射' }));
    const mapWrap = el('div', { class: 'table-wrap' });
    const mapTable = el('table', { class: 'mapping-table' }, [
      el('thead', {}, [el('tr', {}, [el('th', { text: '表头' }), el('th', { text: '字段' })])]),
      el(
        'tbody',
        {},
        mappingRows.map(([header, field]) =>
          el('tr', {}, [
            el('td', { class: 'mono', text: header }),
            el('td', { text: fieldLabel(field) }),
          ]),
        ),
      ),
    ]);
    mapWrap.append(mapTable);
    panel.append(mapWrap);

    panel.append(el('h3', { style: 'font-size:13.5px;margin:16px 0 8px', text: '换算结果快照' }));
    const wrap = el('div', { class: 'table-wrap' });
    const table = el('table', { class: 'data' });
    table.append(
      el('thead', {}, [
        el('tr', {}, ['#', '原始行', '商品编号', '商品名称', '原始数量', '单位', '每箱件数', '统一件数'].map((text) => el('th', { text }))),
      ]),
    );
    const body = el('tbody');
    for (const line of batch.lines ?? []) {
      body.append(
        el('tr', {}, [
          el('td', { class: 'num', text: String(line.rowNumber) }),
          el('td', { text: `第 ${line.sourceLine} 行` }),
          el('td', { class: 'mono', text: line.code }),
          el('td', { text: line.name || '—' }),
          el('td', { class: 'num mono', text: fmt(line.rawQuantity) }),
          el('td', {}, [el('span', { class: 'badge gray', text: UNIT_LABEL[line.unitKind] ?? '—' })]),
          el('td', { class: 'num mono', text: fmt(line.unitsPerBox) }),
          el('td', { class: 'num mono', text: fmt(line.pieces) }),
        ]),
      );
    }
    table.append(body);
    wrap.append(table);
    panel.append(wrap);

    host.replaceChildren(panel);
  } catch (error) {
    host.replaceChildren(el('div', { class: 'banner err', text: error.message }));
  }
}

function fieldLabel(key) {
  const field = state.meta?.fields.find((item) => item.key === key);
  return field ? field.label : key;
}

/* ------------------------------- 启动 ------------------------------- */

function setupTabs() {
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      for (const item of $$('.tab')) item.classList.toggle('active', item === tab);
      $('#view-import').hidden = state.activeTab !== 'import';
      $('#view-batches').hidden = state.activeTab !== 'batches';
      if (state.activeTab === 'batches') loadBatches();
    });
  }
}

function setupUpload() {
  const zone = $('#dropzone');
  const input = $('#file-input');
  input.addEventListener('change', () => {
    onFileSelected(input.files?.[0]);
    input.value = '';
  });
  for (const event of ['dragenter', 'dragover']) {
    zone.addEventListener(event, (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    });
  }
  for (const event of ['dragleave', 'drop']) {
    zone.addEventListener(event, (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
    });
  }
  zone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) onFileSelected(file);
  });
}

async function boot() {
  setupTabs();
  setupUpload();
  try {
    await loadMeta();
    await loadPendingList();
    renderPendingList();
    const open = state.pendingList.find((item) => item.status === 'pending');
    if (open) {
      const preview = await api(`/api/imports/${open.id}`);
      state.current = preview;
      state.dirty = false;
      renderPendingList();
      renderPendingPanel();
      renderResultPanel();
    }
  } catch (error) {
    toast(error.message, 'err');
  }
}

boot();
