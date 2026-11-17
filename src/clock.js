/**
 * 可调演示时钟。
 *
 * 系统内所有"当前时间"判断（钥匙到期、排队任务到执行时刻）都必须经过 now()，
 * 这样演示时可以通过管理界面拨动时间，观察到期/失效行为而无需真实等待。
 */
export class DemoClock {
  constructor(offsetMs = 0) {
    this.offsetMs = offsetMs;
  }

  /** 当前演示时间（毫秒） */
  now() {
    return Date.now() + this.offsetMs;
  }

  /** 相对当前演示时间快进若干毫秒（可为负数回拨，但不能把时间拨到 Unix 纪元之前） */
  advance(ms) {
    const next = this.now() + ms;
    if (next < 0) throw new Error('演示时钟不能早于 1970-01-01T00:00:00Z');
    this.offsetMs += ms;
    return this.now();
  }

  /** 直接设置演示时间（ISO 字符串或毫秒） */
  setAt(value) {
    const t = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isNaN(t)) throw new Error('无法解析的时间值');
    this.offsetMs = t - Date.now();
    return this.now();
  }

  reset() {
    this.offsetMs = 0;
    return this.now();
  }

  toJSON() {
    return { now: this.now(), offsetMs: this.offsetMs };
  }
}
