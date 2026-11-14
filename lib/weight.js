// 计费重量精确向上取整。
// 禁止 Math.ceil(parseFloat())：浮点误差会让 "1.005" 之类的边界值取整错误。
// 这里把十进制字符串当作 BigInt 有理数计算 ceil。

/**
 * 十进制重量字符串 -> 向上取整后的整数公斤数。
 * "1.0" -> 1, "1.2" -> 2, "1.005" -> 2, "3" -> 3
 * 空串、负数、科学计数法、非数字一律抛错；0 由调用方按业务规则判非法。
 * @param {string} input
 * @returns {number}
 */
export function ceilWeightKg(input) {
  const s = String(input ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`重量格式非法（需为正的十进制数字，不支持科学计数法）: "${input}"`);
  }
  const [intPart, fracPart = ''] = s.split('.');
  const k = fracPart.length;
  const den = 10n ** BigInt(k);
  const num = BigInt(intPart) * den + BigInt(fracPart || '0');
  const ceil = k === 0 ? num : (num + den - 1n) / den;
  return Number(ceil);
}
