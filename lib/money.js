'use strict';

/**
 * 金额统一用「分」为单位的整数保存，避免浮点误差。
 */

function parseMoneyToCents(input) {
  if (input === null || input === undefined) {
    return { ok: false, error: '价格不能为空' };
  }
  const raw = String(input).trim().replace(/[¥￥,\s]/g, '');
  if (raw === '') return { ok: false, error: '价格不能为空' };
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    return { ok: false, error: `价格格式不正确：${input}` };
  }
  const [yuan, fen = ''] = raw.split('.');
  const cents = Number(yuan) * 100 + Number(fen.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 0) {
    return { ok: false, error: `价格超出范围：${input}` };
  }
  return { ok: true, cents };
}

function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function yuan(cents) {
  return `¥${formatCents(cents)}`;
}

module.exports = { parseMoneyToCents, formatCents, yuan };
