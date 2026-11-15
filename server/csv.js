// CSV 解析（RFC4180）、三类记录的 typed 解析与校验、导出序列化。零外部依赖。

export class CsvValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsvValidationError';
    this.statusCode = 400;
  }
}

// ---------- 通用 RFC4180 解析：BOM、引号包裹、字段内逗号/换行、"" 转义、CRLF/LF ----------
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (quoted) throw new CsvValidationError('CSV 格式错误：存在未闭合的引号');
  // 文件不以换行结尾时补齐最后一个字段/行
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ---------- 导出序列化：含特殊字符的单元格加引号，内部引号双写 ----------
export function rowsToCsv(rows) {
  return rows.map((row) => row.map((cell) => {
    const s = cell === null || cell === undefined ? '' : String(cell);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n') + '\r\n';
}

// ---------- 时间：只接受 YYYY-MM-DD HH:mm:ss（本地时区），合法性回环校验 ----------
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

export function parseLocalTime(value) {
  const s = String(value ?? '').trim();
  const m = TIME_RE.exec(s);
  if (!m) throw new Error(`时间格式应为 YYYY-MM-DD HH:mm:ss，实际值="${s}"`);
  const [, y, mo, d, h, mi, se] = m.map(Number);
  const date = new Date(y, mo - 1, d, h, mi, se);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d ||
      date.getHours() !== h || date.getMinutes() !== mi || date.getSeconds() !== se) {
    throw new Error(`时间不是合法日期，实际值="${s}"`);
  }
  return date.getTime();
}

// 毫秒 -> 本地 'YYYY-MM-DD'
export function toPayDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 毫秒 -> 本地 'YYYY-MM-DD HH:mm:ss'
export function formatLocalTime(ms) {
  if (ms === null || ms === undefined) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- 表头映射：按名称识别、列序不限，支持中英文别名 ----------
function buildHeaderIndex(header, aliasMap) {
  const trimmed = header.map((h) => h.trim());
  const index = {};
  const missing = [];
  for (const [key, aliases] of Object.entries(aliasMap)) {
    const pos = trimmed.findIndex((h) => aliases.includes(h));
    if (pos < 0) missing.push(aliases[0]);
    else index[key] = pos;
  }
  if (missing.length) {
    throw new CsvValidationError(`缺少必填列：${missing.join('、')}；实际表头为：${trimmed.join(' | ') || '（空）'}`);
  }
  return index;
}

const ALIASES = {
  click: {
    click_id: ['click_id', '点击编号'],
    account_id: ['account_id', '账号'],
    campaign_id: ['campaign_id', '活动编号'],
    campaign_name: ['campaign_name', '活动名称'],
    click_time: ['click_time', '点击时间'],
  },
  payment: {
    order_id: ['order_id', '订单编号'],
    account_id: ['account_id', '账号'],
    payment_time: ['payment_time', '付款时间'],
  },
  refund: {
    refund_id: ['refund_id', '退款单号'],
    order_id: ['order_id', '订单编号'],
    refund_time: ['refund_time', '退款时间'],
  },
};

function splitRows(text) {
  const rows = parseCsv(text);
  const dataRows = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (dataRows.length === 0) throw new CsvValidationError('文件内容为空：连表头都没有');
  return [dataRows[0], dataRows.slice(1)];
}

// 通用行解析：fields 定义每行如何取值与校验，返回 { records, errors }（行号含表头，从 1 起）
function parseTyped(text, type, fields) {
  const [header, rest] = splitRows(text);
  const idx = buildHeaderIndex(header, ALIASES[type]);
  const records = [];
  const errors = [];
  rest.forEach((cells, r) => {
    const lineNo = r + 2; // 表头占第 1 行
    const rec = { lineNo };
    const rowErrors = [];
    for (const f of fields) {
      const raw = (cells[idx[f.key]] ?? '').trim();
      if (!raw) { rowErrors.push(`${f.label} 不能为空`); continue; }
      if (f.time) {
        try { rec[f.storeKey ?? f.key] = parseLocalTime(raw); }
        catch (err) { rowErrors.push(err.message); continue; }
      } else rec[f.key] = raw;
    }
    if (rowErrors.length) errors.push(`第 ${lineNo} 行：${rowErrors.join('；')}`);
    else records.push(rec);
  });
  return { records, errors, totalRows: rest.length };
}

export function parseClicksCsv(text) {
  return parseTyped(text, 'click', [
    { key: 'click_id', label: 'click_id（点击编号）' },
    { key: 'account_id', label: 'account_id（账号）' },
    { key: 'campaign_id', label: 'campaign_id（活动编号）' },
    { key: 'campaign_name', label: 'campaign_name（活动名称）' },
    { key: 'click_time', storeKey: 'click_time_ms', label: 'click_time（点击时间）', time: true },
  ]);
}

export function parsePaymentsCsv(text) {
  return parseTyped(text, 'payment', [
    { key: 'order_id', label: 'order_id（订单编号）' },
    { key: 'account_id', label: 'account_id（账号）' },
    { key: 'payment_time', storeKey: 'payment_time_ms', label: 'payment_time（付款时间）', time: true },
  ]);
}

export function parseRefundsCsv(text) {
  return parseTyped(text, 'refund', [
    { key: 'refund_id', label: 'refund_id（退款单号）' },
    { key: 'order_id', label: 'order_id（订单编号）' },
    { key: 'refund_time', storeKey: 'refund_time_ms', label: 'refund_time（退款时间）', time: true },
  ]);
}

// 错误清单最多展示 10 条，超出部分用一句话概括
export function capErrors(errors) {
  if (errors.length <= 10) return errors.slice();
  return [...errors.slice(0, 10), `……另有 ${errors.length - 10} 个错误`];
}
