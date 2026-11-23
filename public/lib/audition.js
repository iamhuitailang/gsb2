// Web Audio 试听：按共享音频编排实时调度每段音轨。
//
// 不用 <audio> 播放整段素材（那必然会把片头也播一遍），而是把每段源的音频解码成
// AudioBuffer，再在统一时间线的对应起点、以正确的源偏移调度，并施加增益包络。
// 因此试听与导出听到的是同一份编排，且跳过素材片头。
import { buildAudioPlan, gainAt, sourceTimeAt, normalizeAudio } from '../../src/audio.js';

const CTX = window.AudioContext || window.webkitAudioContext;

export class AuditionEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map(); // 源 URL -> AudioBuffer | null
    this.nodes = [];
    this.playing = false;
    this.timer = null;
    this.anchor = null; // {ctxTime, timelineTime}
    this.volume = 0.9;
    this.onEnded = null;
    this.generation = 0;
  }

  get running() {
    return Boolean(this.ctx) && this.ctx.state === 'running';
  }

  ensureCtx() {
    if (!this.ctx) this.ctx = new CTX();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
  }

  async loadSource(url) {
    if (this.buffers.has(url)) return this.buffers.get(url);
    const promise = (async () => {
      try {
        const res = await fetch(`/api/audio-src?file=${encodeURIComponent(baseName(url))}`);
        if (!res.ok) return null;
        const bytes = await res.arrayBuffer();
        const ctx = this.ensureCtx();
        const decoded = await ctx.decodeAudioData(bytes);
        this.buffers.set(url, decoded);
        return decoded;
      } catch {
        this.buffers.set(url, null);
        return null;
      }
    })();
    this.buffers.set(url, promise);
    return promise;
  }

  async prepare(timeline) {
    const urls = [...new Set(timeline.clips.filter((c) => c.clip.hasAudio).map((c) => c.clip.src))];
    await Promise.all(urls.map((u) => this.loadSource(u)));
  }

  // 从统一时间 from 开始试听，直到 to。
  async play(timeline, project, from, to) {
    this.stop();
    this.generation += 1;
    const gen = this.generation;
    const ctx = this.ensureCtx();
    await this.prepare(timeline);
    if (gen !== this.generation) return;

    const plan = buildAudioPlan(timeline, project);
    const now = ctx.currentTime + 0.08;
    const master = ctx.createGain();
    master.gain.value = this.volume;
    master.connect(ctx.destination);
    this.master = master;

    const end = Math.min(to, timeline.duration);
    let anyScheduled = false;
    // 先把窗口内要用的音频缓冲准备好，再统一调度，避免逐段 await 让起点漂移。
    const jobs = [];
    for (const span of plan) {
      if (span.silent) continue;
      const overlapStart = Math.max(from, span.start);
      const overlapEnd = Math.min(end, span.end);
      if (overlapEnd - overlapStart <= 0.001) continue;
      const buffer = await this.buffers.get(timeline.clips[span.clipIndex].clip.src);
      if (!buffer) continue;
      jobs.push({ span, overlapStart, overlapEnd, buffer });
    }
    for (const { span, overlapStart, overlapEnd, buffer } of jobs) {
      anyScheduled = true;
      const when = now + (overlapStart - from);
      const offset = sourceTimeAt(span, overlapStart);
      const dur = overlapEnd - overlapStart;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(gainAt(span.points, overlapStart), when);
      for (const [pt, gv] of span.points) {
        if (pt <= overlapStart + 1e-6 || pt >= overlapEnd - 1e-6) continue;
        gain.gain.linearRampToValueAtTime(gv, now + (pt - from));
      }
      gain.gain.setValueAtTime(gainAt(span.points, overlapEnd), now + (overlapEnd - from));
      src.connect(gain).connect(master);
      try {
        src.start(when, Math.max(0, offset), Math.max(0.01, dur));
      } catch {
        src.start(when, Math.max(0, offset));
      }
      this.nodes.push(src, gain);
    }

    this.anchor = { ctxTime: now, timelineTime: from };
    this.playing = true;
    this.range = { from, to: end };
    if (!anyScheduled) {
      this.playing = true;
    }
    this.timer = setInterval(() => this.tick(), 40);
    return { anyScheduled };
  }

  tick() {
    if (!this.playing || !this.anchor) return;
    const t = this.currentTimelineTime();
    if (this.range && t >= this.range.to - 1e-3) {
      this.playing = false;
      clearInterval(this.timer);
      this.onEnded?.();
    }
  }

  currentTimelineTime() {
    if (!this.playing || !this.anchor) return null;
    return this.anchor.timelineTime + (this.ctx.currentTime - this.anchor.ctxTime);
  }

  stop() {
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const node of this.nodes) {
      try { node.stop?.(); } catch { /* already stopped */ }
      try { node.disconnect(); } catch { /* noop */ }
    }
    this.nodes = [];
    if (this.master) {
      try { this.master.disconnect(); } catch { /* noop */ }
      this.master = null;
    }
    this.anchor = null;
    this.playing = false;
  }
}

function baseName(url) {
  try {
    const u = new URL(url, location.href);
    return u.pathname.split('/').pop();
  } catch {
    return String(url).split('/').pop();
  }
}

export { normalizeAudio };
