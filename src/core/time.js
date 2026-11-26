// 时间 / 帧率相关的纯函数。
// 统一单位：内部所有时间戳均为「时间线秒」（number，秒）。
// 素材在时间线上的位置：timelineT = sourceT + source.offset。

/** 解析帧率字符串，支持 "25"、"29.97"、"30000/1001"。失败返回 30。 */
export function parseFps(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return 30;
  const s = value.trim();
  if (s.includes('/')) {
    const [n, d] = s.split('/').map(Number);
    if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) return n / d;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/** 时间线秒 -> 帧序号（0 起），fps 为该素材帧率。半帧四舍五入。 */
export function timeToFrame(t, fps) {
  return Math.max(0, Math.round(t * fps));
}

/** 帧序号 -> 该帧在素材内的精确时间（秒）。 */
export function frameToTime(frame, fps) {
  return frame / fps;
}

/**
 * 把任意时间线时间吸附到指定机位的帧网格上。
 * 切点必须落在「切入机位」的帧边界，否则切换瞬间会出现半帧。
 */
export function snapToFrame(t, fps) {
  return frameToTime(timeToFrame(t, fps), fps);
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 格式化为 SMPTE 风格时间码 HH:MM:SS:FF（按给定帧率取帧位）。 */
export function formatTimecode(t, fps = 30) {
  if (!Number.isFinite(t)) return '--:--:--:--';
  const neg = t < 0;
  const totalFrames = Math.round(Math.abs(t) * fps);
  const ff = totalFrames % Math.round(fps);
  const totalSec = Math.floor(totalFrames / fps);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return `${neg ? '-' : ''}${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/** 秒 -> m:ss.s 形式，用于紧凑显示。 */
export function formatSeconds(t) {
  if (!Number.isFinite(t)) return '--';
  const neg = t < 0;
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  return `${neg ? '-' : ''}${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/** 带符号的偏移文本，如 +0.500s / -12 帧。 */
export function formatOffset(offsetSeconds) {
  const sign = offsetSeconds > 0 ? '+' : '';
  return `${sign}${offsetSeconds.toFixed(3)}s`;
}
