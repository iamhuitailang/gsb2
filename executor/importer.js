'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseMoneyToCents, formatCents } = require('../lib/money');

const HEADER_ALIASES = {
  code: ['商品编号', '编号', 'code', 'sku', '商品代码'],
  old: ['预计旧价', '旧价', '原价', 'old_price', 'oldprice', 'expected_old_price'],
  next: ['新价', '目标价', 'new_price', 'newprice', 'target_price'],
};

function normalizeHeader(name) {
  return String(name).replace(/﻿/, '').trim().toLowerCase();
}

function matchColumn(headers, aliases) {
  const normalized = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

/**
 * 读取导入文件。返回 { ok, items, errors, fileHash }。
 * items: [{ index, code, expectedOldCents, newCents }]
 */
function loadImportFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`找不到导入文件：${abs}`], items: [], fileHash: '' };
  }
  const content = fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n');
  const fileHash = crypto.createHash('sha1').update(content).digest('hex');
  const lines = content.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) {
    return { ok: false, errors: ['导入文件为空'], items: [], fileHash };
  }

  const headers = splitCsvLine(lines[0]);
  const colCode = matchColumn(headers, HEADER_ALIASES.code);
  const colOld = matchColumn(headers, HEADER_ALIASES.old);
  const colNew = matchColumn(headers, HEADER_ALIASES.next);
  const errors = [];
  if (colCode === -1) errors.push(`表头缺少商品编号列（应为 ${HEADER_ALIASES.code.join(' / ')}）`);
  if (colOld === -1) errors.push(`表头缺少预计旧价列（应为 ${HEADER_ALIASES.old.join(' / ')}）`);
  if (colNew === -1) errors.push(`表头缺少新价列（应为 ${HEADER_ALIASES.next.join(' / ')}）`);
  if (errors.length) return { ok: false, errors, items: [], fileHash };

  const items = [];
  const seen = new Set();
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const lineNo = i + 1;
    const code = (cells[colCode] || '').trim();
    const oldRaw = cells[colOld] || '';
    const newRaw = cells[colNew] || '';
    if (!code) {
      errors.push(`第 ${lineNo} 行：商品编号为空`);
      continue;
    }
    if (seen.has(code)) {
      errors.push(`第 ${lineNo} 行：商品编号 ${code} 重复`);
      continue;
    }
    const oldPrice = parseMoneyToCents(oldRaw);
    if (!oldPrice.ok) {
      errors.push(`第 ${lineNo} 行：预计旧价无效 — ${oldPrice.error}`);
      continue;
    }
    const newPrice = parseMoneyToCents(newRaw);
    if (!newPrice.ok) {
      errors.push(`第 ${lineNo} 行：新价无效 — ${newPrice.error}`);
      continue;
    }
    if (newPrice.cents === oldPrice.cents) {
      errors.push(`第 ${lineNo} 行：${code} 新价与预计旧价相同（${formatCents(newPrice.cents)}），无需改价`);
      continue;
    }
    seen.add(code);
    items.push({
      index: items.length,
      code,
      expectedOldCents: oldPrice.cents,
      newCents: newPrice.cents,
      sourceLine: lineNo,
    });
  }

  if (items.length === 0) errors.push('没有可用的商品行');
  return { ok: errors.length === 0, items, errors, fileHash, absPath: abs };
}

module.exports = { loadImportFile };
