// 实时播放引擎。
// 所有轨道共用一条工程时间轴；每个源缓冲区分成小块逐块调度，
// 块内通过 sourceTimeFromAnchors 做线性时间映射，因此支持任意锚点校准与漂移。
// 调整偏移/锚点时调用 resync()：立即按当前工程时间重新调度，播放指针不动。
import { sourceTimeFromAnchors, sourceTimeSimple } from './dsp.js';

const CHUNK_SEC = 2.0;
const SCHED_AHEAD = 0.15;
const TICK_MS = 25;

export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.playing = false;
    this.projectTime = 0; // 暂停时保存位置；播放时由 ctx.currentTime 推算
    this.startCtxTime = 0;
    this.loop = null; // [startSec, endSec] 工程时间
    this.active = []; // { source, stopAt, gain, panner }
    this.timer = null;
    this.onTick = null;
    this.getTracks = () => [];
    this.getProjectDuration = () => 0;
    this.getSolo = () => false;
  }

  mapSource(track, pSec) {
    if (track.anchors && track.anchors.length > 0) {
      return sourceTimeFromAnchors(pSec, track.anchors);
    }
    return sourceTimeSimple(pSec, track.offsetSec || 0, track.driftPpm || 0);
  }

  getProjectTime() {
    if (!this.playing) return this.projectTime;
    return this.projectTime + (this.ctx.currentTime - this.startCtxTime);
  }

  isAudible(track) {
    if (track.muted) return false;
    if (this.getSolo()) return !!track.solo;
    return true;
  }

  _stopActive() {
    for (const a of this.active) {
      try { a.source.onended = null; a.source.stop(); } catch { /* 已停止 */ }
      try { a.gain.disconnect(); } catch { /* noop */ }
      try { a.panner.disconnect(); } catch { /* noop */ }
    }
    this.active = [];
  }

  // 调度从工程时间 pStart 开始、时长 pDur 的一个块（若中途出界则截断）。
  _scheduleChunk(track, pStart, pDur, when) {
    const buf = track.buffer;
    const s0 = this.mapSource(track, pStart);
    const s1 = this.mapSource(track, pStart + pDur);
    let srcStart = s0;
    let srcDur = s1 - s0;
    if (srcDur <= 0 || s0 >= buf.duration) return when;

    // 块超出源素材结尾则截断。
    if (srcStart + srcDur > buf.duration) {
      srcDur = Math.max(0, buf.duration - srcStart);
      pDur = srcDur / (Math.abs(srcDur) > 1e-9 ? (s1 - s0) / pDur : 1);
    }
    if (srcStart < 0) {
      // 起点落在源素材之前：等工程时间走到源起点再发声。
      const skip = -srcStart / ((s1 - s0) / pDur);
      when += skip;
      pStart += skip;
      pDur -= skip;
      srcStart = 0;
      if (pDur <= 0) return when;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = track.gainDb === undefined ? 1 : 10 ** (track.gainDb / 20);
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = track.pan || 0;
    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.master);

    const rate = srcDur / pDur;
    source.playbackRate.value = Math.max(0.0625, Math.min(16, rate));
    source.start(when, srcStart, srcDur / rate);
    const stopAt = when + pDur;
    const entry = { source, stopAt, gain, panner };
    source.onended = () => {
      this.active = this.active.filter((x) => x !== entry);
      try { gain.disconnect(); } catch { /* noop */ }
      try { panner.disconnect(); } catch { /* noop */ }
    };
    this.active.push(entry);
    return stopAt;
  }

  _tick = () => {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    const horizon = now + SCHED_AHEAD;

    for (const track of this.getTracks()) {
      if (!track.buffer || !this.isAudible(track)) continue;
      // 该轨道已调度到的工程时间。
      let nextProject = track._nextProject;
      let nextWhen = track._nextWhen;
      if (nextProject === undefined) {
        nextProject = this.getProjectTime();
        nextWhen = now;
      }
      let guard = 0;
      while (nextWhen < horizon && guard++ < 50) {
        // 已到循环终点：回到循环起点，下一轮 tick 接续。
        if (this.loop && nextProject >= this.loop[1]) {
          nextProject = this.loop[0];
          nextWhen = Math.max(nextWhen, this.ctx.currentTime);
          break;
        }
        let pDur = CHUNK_SEC;
        let looped = false;
        if (this.loop && nextProject + pDur > this.loop[1]) {
          pDur = this.loop[1] - nextProject;
          looped = true;
        }
        if (pDur <= 0) { nextProject = this.loop ? this.loop[0] : 0; break; }
        const endWhen = this._scheduleChunk(track, nextProject, pDur, nextWhen);
        nextProject += pDur;
        nextWhen = endWhen;
        if (looped) {
          // 回到循环起点，在下一轮 tick 重新接续。
          nextProject = this.loop[0];
          break;
        }
        if (nextProject >= this.getProjectDuration()) {
          this.pause();
          this.seek(this.loop ? this.loop[0] : 0);
          return;
        }
      }
      track._nextProject = nextProject;
      track._nextWhen = nextWhen;
    }

    if (this.loop && this.getProjectTime() >= this.loop[1]) {
      this.resync(this.loop[0]);
    }
    if (this.onTick) this.onTick(this.getProjectTime());
  };

  play() {
    if (this.playing) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.playing = true;
    this.startCtxTime = this.ctx.currentTime;
    for (const t of this.getTracks()) {
      t._nextProject = this.projectTime;
      t._nextWhen = this.ctx.currentTime;
    }
    this.timer = setInterval(this._tick, TICK_MS);
    this._tick();
  }

  pause() {
    if (!this.playing) return;
    this.projectTime = this.getProjectTime();
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
    this._stopActive();
  }

  seek(sec) {
    const dur = this.getProjectDuration();
    this.projectTime = Math.max(0, Math.min(sec, dur));
    if (this.playing) this.resync(this.projectTime);
    if (this.onTick) this.onTick(this.projectTime);
  }

  // 参数（偏移/锚点/静音/增益/声像）变化后重新对齐，保持当前工程时间不变。
  resync(atTime = this.getProjectTime()) {
    this._stopActive();
    this.projectTime = atTime;
    if (this.playing) {
      this.startCtxTime = this.ctx.currentTime;
      for (const t of this.getTracks()) {
        t._nextProject = atTime;
        t._nextWhen = this.ctx.currentTime;
      }
      this._tick();
    }
  }

  setLoop(range) {
    this.loop = range;
  }
}
