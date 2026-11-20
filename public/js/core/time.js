/**
 * 时间工具。工程内部、导出文件和所有计算统一使用「秒」（seconds）。
 * 只在界面展示和输入解析时转换为 mm:ss.mmm 之类的可读格式，精度为毫秒。
 */

export const TIME_UNIT = 'seconds';
export const TIME_PRECISION = 3;
export const TIME_EPSILON = 1e-6;

/** 最短标注区间（秒）。避免出现零长度或无法操作的区间。 */
export const MIN_REGION_SECONDS = 0.02;

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function isFiniteTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * 四舍五入到指定小数位（默认毫秒）。
 * 用十进制移位（`Number('1.2345e3')`）而不是乘法，避免 1.2345×1000 得到
 * 1234.4999… 这类二进制误差导致「四舍」错误。
 */
export function roundSeconds(value, decimals = TIME_PRECISION) {
  if (!Number.isFinite(value)) return 0;
  const shifted = Number(`${value}e${decimals}`);
  if (!Number.isFinite(shifted)) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }
  return Number(`${Math.round(shifted)}e-${decimals}`);
}

/** 转成「以 10^-decimals 为单位的整数」，供时间码拆分使用。 */
function toUnits(seconds, decimals) {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const shifted = Number(`${value}e${decimals}`);
  if (!Number.isFinite(shifted)) return Math.round(value * 10 ** decimals);
  return Math.round(shifted);
}

function pad(value, size) {
  return String(value).padStart(size, '0');
}

/**
 * 格式化为时间码：`mm:ss.mmm`，超过一小时为 `h:mm:ss.mmm`。
 * 负数按 0 处理。
 */
export function formatTimecode(seconds, { decimals = TIME_PRECISION } = {}) {
  const factor = 10 ** decimals;
  const totalUnits = toUnits(seconds, decimals);
  const sub = totalUnits % factor;
  const totalSeconds = Math.floor(totalUnits / factor);
  const sec = totalSeconds % 60;
  const min = Math.floor(totalSeconds / 60) % 60;
  const hour = Math.floor(totalSeconds / 3600);
  const suffix = decimals > 0 ? `.${pad(sub, decimals)}` : '';
  if (hour > 0) return `${hour}:${pad(min, 2)}:${pad(sec, 2)}${suffix}`;
  return `${pad(min, 2)}:${pad(sec, 2)}${suffix}`;
}

/** 不带小时、适合列表里的紧凑格式：`ss.mmm` / `m:ss.mmm`。 */
export function formatShortTime(seconds) {
  return formatTimecode(seconds);
}

/** 秒数的纯数字展示，固定 3 位小数，便于复制。 */
export function formatSeconds(seconds) {
  return roundSeconds(seconds).toFixed(TIME_PRECISION);
}

/**
 * 解析用户输入的时间，返回秒数；无法解析时返回 null。
 * 支持：
 *   `12.345`、`12.345s`、`12.345秒`
 *   `1:02.345`（分:秒.毫秒 / 分:秒）
 *   `1:02:03.456`（时:分:秒.毫秒）
 */
export function parseTimeInput(input) {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input >= 0 ? roundSeconds(input) : null;
  }
  if (typeof input !== 'string') return null;
  let text = input.trim().replace(/\s+/g, '');
  if (!text) return null;
  text = text.replace(/(?:seconds?|secs?|s|秒)$/i, '');
  if (!text) return null;

  const clock = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?(?:[.,](\d{1,3}))?$/);
  if (clock) {
    const first = Number(clock[1]);
    const second = Number(clock[2]);
    const third = clock[3] === undefined ? null : Number(clock[3]);
    const fraction = clock[4] ? Number(`0.${clock[4]}`) : 0;
    let hours = 0;
    let minutes = first;
    let seconds = second;
    if (third !== null) {
      hours = first;
      minutes = second;
      seconds = third;
    }
    if (minutes > 59 || seconds > 59) return null;
    return roundSeconds(hours * 3600 + minutes * 60 + seconds + fraction);
  }

  const plain = text.match(/^(\d+(?:\.\d+)?)$/);
  if (plain) return roundSeconds(Number(plain[1]));

  // 允许 0,5 这类小数逗号写法
  const comma = text.match(/^(\d+),(\d{1,3})$/);
  if (comma) return roundSeconds(Number(`${comma[1]}.${comma[2]}`));
  return null;
}

/** 让区间落在 [0, duration] 内，并保证 end - start >= MIN_REGION_SECONDS。 */
export function clampRegion(start, end, duration, minDuration = MIN_REGION_SECONDS) {
  const max = Number.isFinite(duration) && duration > 0 ? duration : Math.max(end, 0);
  const min = Math.min(minDuration, max);
  let s = clamp(Number(start), 0, Math.max(0, max - min));
  let e = clamp(Number(end), s + min, max);
  if (!Number.isFinite(s)) s = 0;
  if (!Number.isFinite(e) || e < s + min) e = Math.min(max, s + min);
  return { start: roundSeconds(s), end: roundSeconds(e) };
}
