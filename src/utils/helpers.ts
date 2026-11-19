/** 唯一 id 生成。优先使用加密随机数，降级为时间戳+随机数。 */
export function uid(prefix = 'id'): string {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto?.randomUUID) {
    return `${prefix}_${g.crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 吸附到给定网格（秒） */
export function snapToGrid(time: number, grid: number): number {
  return Math.round(time / grid) * grid;
}

/** mm:ss.d（十分之一秒）格式的时间显示 */
export function formatTime(seconds: number): string {
  const t = Math.max(0, seconds);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

/** 线性插值 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 深度克隆（工程数据均为可 JSON 序列化的普通对象；录音 Blob 单独存 IDB） */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
