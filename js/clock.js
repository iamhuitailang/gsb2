// 确定性帧时钟。
// 铁律:画面内容只由帧号 N 决定,t(N) = N * FIXED_DT。
// requestAnimationFrame 的真实刷新率只负责"什么时候推进下一帧",
// 绝不参与任何场景/相机/抖动计算 —— 60Hz 与 120Hz 显示器上,
// 同一帧号的画面完全一致;暂停、单步、跳转也不会改变时间轴。

export const FIXED_DT = 1 / 30; // 模拟步长 30Hz,与显示器刷新率解耦
export const MAX_FRAME = 900; // 30 秒一个镜头循环

export class FrameClock {
  constructor() {
    this.frame = 0;
    this.playing = false;
    this._rafId = 0;
    this._lastWallMs = 0;
    this._acc = 0; // 真实时间累计器,只用于调度,不进入渲染参数
    this._listeners = new Set();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(reason) {
    for (const fn of this._listeners) fn(this.frame, reason);
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this._lastWallMs = performance.now();
    this._acc = 0;
    const tick = (now) => {
      if (!this.playing) return;
      // 追帧上限:切后台回来后最多补 5 帧,避免一次性冲过整个镜头
      this._acc += Math.min(now - this._lastWallMs, 5 * FIXED_DT * 1000);
      this._lastWallMs = now;
      let stepped = false;
      while (this._acc >= FIXED_DT * 1000) {
        this._acc -= FIXED_DT * 1000;
        this.advance('play');
        stepped = true;
      }
      if (stepped) this._emit('play');
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this._rafId);
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  // 单帧推进;到镜头末尾回到 0 并标记 loop 重开
  advance(reason = 'manual') {
    let f = this.frame + 1;
    let wrapped = false;
    if (f > MAX_FRAME) {
      f = 0;
      wrapped = true;
    }
    this.frame = f;
    if (!this.playing) this._emit(reason);
    return { frame: f, wrapped };
  }

  stepBack() {
    this.frame = Math.max(0, this.frame - 1);
    this._emit('seek');
  }

  seek(frame) {
    this.frame = Math.min(MAX_FRAME, Math.max(0, frame | 0));
    this._emit('seek');
  }

  reset() {
    this.pause();
    this.frame = 0;
    this._acc = 0;
    this._emit('seek');
  }
}
