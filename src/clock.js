/**
 * 演示时钟：真实时间 + 可配置偏移量。
 *
 * 限流窗口的所有时间戳都基于这个时钟，因此页面可以把时钟向前拨，
 * 用来观察“什么时候能再试”。
 */
export class DemoClock {
  constructor(offsetMs = 0, onChange = () => {}) {
    this.offsetMs = Number.isFinite(offsetMs) ? offsetMs : 0;
    this.onChange = onChange;
  }

  now() {
    return Date.now() + this.offsetMs;
  }

  advance(ms) {
    if (!Number.isInteger(ms) || ms <= 0) {
      throw new Error('advanceMs 必须是正整数');
    }
    this.offsetMs += ms;
    this.onChange();
  }

  reset() {
    this.offsetMs = 0;
    this.onChange();
  }
}
