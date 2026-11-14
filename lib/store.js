// 内存数据仓：启动时读盘一次，POST /api/reload 重新读盘重算。
// reload 采用「先算新数据、成功后整体替换」：坏文件不覆盖上一份可用数据。
// 数据目录可用环境变量 DELIVERY_FEE_DATA_DIR 覆盖（测试用）。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseCsv } from './csv.js';
import { buildRateIndex } from './rates.js';
import { computeAll } from './billing.js';

const WAYBILL_HEADERS = ['waybill_no', 'site', 'region', 'bill_weight_kg', 'status', 'date'];
const RATE_HEADERS = ['region', 'first_kg_fee_yuan', 'added_kg_fee_yuan', 'effective_from'];

export const WAYBILLS_FILE = 'waybills.csv';
export const RATES_FILE = 'rates.csv';

function dataDir() {
  return process.env.DELIVERY_FEE_DATA_DIR || join(process.cwd(), 'data');
}

function requireHeaders(fileName, actual, expected) {
  const missing = expected.filter((h) => !actual.includes(h));
  if (missing.length > 0) {
    throw new Error(`${fileName} 缺少必需列: ${missing.join(', ')}`);
  }
}

async function readCsv(filePath, fileName, expectedHeaders) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(`无法读取 ${fileName}: ${err.message}`);
  }
  if (text.trim() === '') throw new Error(`${fileName} 为空，至少需要表头行`);
  const parsed = parseCsv(text);
  requireHeaders(fileName, parsed.headers, expectedHeaders);
  return parsed;
}

function buildState() {
  return {
    enriched: [],
    sites: [],
    dataErrors: [],
    loadedAt: null,
    counts: { waybills: 0, rates: 0 },
  };
}

let state = buildState();

async function loadFromDisk() {
  const dir = dataDir();
  const waybillCsv = await readCsv(join(dir, WAYBILLS_FILE), WAYBILLS_FILE, WAYBILL_HEADERS);
  const rateCsv = await readCsv(join(dir, RATES_FILE), RATES_FILE, RATE_HEADERS);

  const { index: rateIndex, errors: rateErrors } = buildRateIndex(
    rateCsv.rows,
    rateCsv.lines,
    RATES_FILE,
  );
  const { enriched, errors: waybillErrors } = computeAll(
    waybillCsv.rows,
    waybillCsv.lines,
    rateIndex,
    WAYBILLS_FILE,
  );

  const sites = [...new Set(enriched.map((w) => w.site).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'zh-Hans-CN'),
  );

  return {
    enriched,
    sites,
    dataErrors: [...rateErrors, ...waybillErrors],
    loadedAt: new Date().toISOString(),
    counts: { waybills: waybillCsv.rows.length, rates: rateCsv.rows.length },
  };
}

export async function initStore() {
  state = await loadFromDisk();
  return state;
}

export function getState() {
  return state;
}

/** 重新读盘；失败时保留旧 state，错误随异常抛给路由层。 */
export async function reload() {
  const next = await loadFromDisk();
  state = next;
  return state;
}
