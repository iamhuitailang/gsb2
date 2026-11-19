/**
 * 预览播放器的计时逻辑，与 requestAnimationFrame 解耦，便于测试。
 *
 * 每一帧占据 [start, start + duration) 的时间片，循环时长 = 所有帧时长之和。
 * 单帧模式只停在指定帧，不推进时间。
 */

export function frameStarts(frames) {
  const starts = [];
  let acc = 0;
  for (const frame of frames) {
    starts.push(acc);
    acc += frame.duration;
  }
  return starts;
}

export function totalDuration(frames) {
  return frames.reduce((sum, f) => sum + f.duration, 0);
}

/** 根据循环内的时间（毫秒）求当前帧索引。frames 为空时返回 -1。 */
export function frameIndexAt(frames, timeMs) {
  if (!frames.length) return -1;
  const total = totalDuration(frames);
  if (total <= 0) return 0;
  let t = timeMs;
  if (!Number.isFinite(t) || t < 0) t = 0;
  t %= total;
  const starts = frameStarts(frames);
  let index = 0;
  for (let i = 0; i < frames.length; i += 1) {
    if (t >= starts[i]) index = i;
    else break;
  }
  return index;
}

export class LoopClock {
  constructor(frames = []) {
    this.frames = frames;
    this.playing = false;
    this.loop = true;
    this.timeMs = 0;
    this.currentFrame = 0;
    this.playCount = 0;
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.listeners) fn(this);
  }

  get duration() {
    return totalDuration(this.frames);
  }

  setFrames(frames) {
    this.frames = frames;
    if (this.currentFrame >= frames.length) this.currentFrame = Math.max(0, frames.length - 1);
    // 保持当前帧相对起点，让编辑过程中预览不跳回第 1 帧。
    const starts = frameStarts(frames);
    if (starts.length) this.timeMs = starts[this.currentFrame] ?? 0;
    this.#emit();
  }

  seekToFrame(index) {
    if (!this.frames.length) {
      this.currentFrame = -1;
      this.timeMs = 0;
      this.#emit();
      return;
    }
    const clamped = Math.max(0, Math.min(index, this.frames.length - 1));
    const starts = frameStarts(this.frames);
    this.currentFrame = clamped;
    this.timeMs = starts[clamped];
    this.#emit();
  }

  play() {
    if (this.playing || !this.frames.length) return;
    this.playing = true;
    this.#emit();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.#emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  /** 推进时间；返回 { frameChanged, looped }。 */
  tick(deltaMs) {
    if (!this.playing || !this.frames.length) return { frameChanged: false, looped: false };
    const total = this.duration;
    if (total <= 0) return { frameChanged: false, looped: false };
    const prevIndex = this.currentFrame;
    this.timeMs += Math.max(0, deltaMs);
    let looped = false;
    if (this.timeMs >= total) {
      if (this.loop) {
        const laps = Math.floor(this.timeMs / total);
        this.timeMs %= total;
        this.playCount += laps;
        looped = true;
      } else {
        this.timeMs = total - 1;
        this.playing = false;
        this.currentFrame = this.frames.length - 1;
        this.#emit();
        return { frameChanged: this.currentFrame !== prevIndex, looped: false };
      }
    }
    this.currentFrame = frameIndexAt(this.frames, this.timeMs);
    if (this.currentFrame !== prevIndex || looped) this.#emit();
    return { frameChanged: this.currentFrame !== prevIndex, looped };
  }
}
