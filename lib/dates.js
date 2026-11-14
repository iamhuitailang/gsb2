// 日期全程按 YYYY-MM-DD 字符串处理，不转 Date 对象，避免时区/跨日问题。
// ISO 日期字符串字典序即时间序，范围筛选直接字符串比较。

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 校验真实日历日期（含闰年），如 2026-02-29、2026-13-01 均为非法。 */
export function isValidIsoDate(s) {
  const m = ISO_RE.exec(String(s ?? ''));
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}
