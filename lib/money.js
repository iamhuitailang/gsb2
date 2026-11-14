// 金额一律以整数「分」在系统内流转，CSV 中以「元」存储。
// 严格模式：只接受非负、最多两位小数的元字符串，拒绝静默四舍五入。

/**
 * 元字符串 -> 整数分。
 * "3.50" -> 350, "3" -> 300, "3.5" -> 350
 * 负数、三位小数、科学计数法、空串等一律抛错。
 * @param {string} input
 * @returns {number}
 */
export function yuanToFen(input) {
  const s = String(input ?? '').trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s) || s.startsWith('-')) {
    throw new Error(`金额格式非法（需为非负数字、最多两位小数）: "${input}"`);
  }
  const [yuan, cents = ''] = s.split('.');
  return Number(yuan) * 100 + Number(cents.padEnd(2, '0'));
}

/**
 * 整数分 -> 两位小数字符串（纯字符串拼接，不走浮点）。
 * 1350 -> "13.50"
 * @param {number} fen
 * @returns {string}
 */
export function fenToYuan(fen) {
  const n = Math.trunc(fen);
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}
