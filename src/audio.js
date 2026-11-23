/*
 * Voicebox — procedural short-sound synthesis and preview playback.
 *
 * Every sample is generated in code (no audio files). The scheduler's plan is
 * rendered into ONE offline buffer, so what you hear is exactly what the
 * timeline shows, and the exported WAV matches the on-screen result.
 *
 * Playback rule for seeking: a playhead position is only ever served by a
 * freshly created AudioBufferSourceNode carrying the current generation.
 * Pausing, seeking backwards, changing settings or restarting stops the old
 * node outright and bumps the generation; stale `ended` handlers therefore
 * can never resume, re-arm or reuse an expired slot.
 */

export const SAMPLE_RATE = 48000;

/* Deterministic noise so every render of a plan is sample-identical. */
function makeRng(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function noiseBuffer(ctx, seconds, seed) {
  const len = Math.max(1, Math.ceil(seconds * ctx.sampleRate));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rng = makeRng(seed);
  for (let i = 0; i < len; i += 1) data[i] = rng() * 2 - 1;
  return buf;
}

/* One timbre = a small graph. t0 is when the sound starts, dur its natural
 * length in seconds. `out` is the destination node. */
const TIMBRE_BUILDERS = {
  footstep(ctx, out, t0, dur, gain, seed) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, dur, seed);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t0);
    lp.frequency.exponentialRampToValueAtTime(180, t0 + dur);
    lp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(lp).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + dur + 0.01);
    // Low body thump.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t0);
    osc.frequency.exponentialRampToValueAtTime(62, t0 + Math.min(0.09, dur));
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.exponentialRampToValueAtTime(gain * 0.55, t0 + 0.006);
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.min(0.11, dur));
    osc.connect(og).connect(out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.01);
  },

  coin(ctx, out, t0, dur, gain, seed) {
    const notes = [
      { f: 987.77, at: 0, len: dur * 0.62 },
      { f: 1318.51, at: dur * 0.42, len: dur * 0.58 },
    ];
    for (const [i, n] of notes.entries()) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      const start = t0 + n.at;
      const end = Math.min(t0 + dur, start + n.len);
      const span = Math.max(0.02, end - start);
      osc.frequency.setValueAtTime(n.f, start);
      osc.frequency.exponentialRampToValueAtTime(n.f * 1.01, end);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(gain * (i ? 0.75 : 1), start + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(g).connect(out);
      osc.start(start);
      osc.stop(end + 0.01);
    }
  },

  sword(ctx, out, t0, dur, gain, seed) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, dur, seed ^ 0x51ed);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.2;
    bp.frequency.setValueAtTime(5200, t0);
    bp.frequency.exponentialRampToValueAtTime(1400, t0 + dur * 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.9);
    src.connect(bp).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + dur + 0.01);
    // Metallic ring.
    for (const [i, f] of [2380, 3170, 4610].entries()) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t0);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.exponentialRampToValueAtTime(gain * 0.13 * (1 - i * 0.25), t0 + 0.008);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.8);
      osc.connect(og).connect(out);
      osc.start(t0);
      osc.stop(t0 + dur + 0.01);
    }
  },

  hit(ctx, out, t0, dur, gain, seed) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(170, t0);
    osc.frequency.exponentialRampToValueAtTime(42, t0 + Math.min(0.22, dur));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.01);
    // Transient click.
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.05, seed ^ 0x77);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(gain * 0.7, t0);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.045);
    src.connect(hp).connect(ng).connect(out);
    src.start(t0);
    src.stop(t0 + 0.06);
  },

  ui(ctx, out, t0, dur, gain, seed) {
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, t0);
    osc.frequency.setValueAtTime(1174.66, t0 + Math.min(0.028, dur * 0.4));
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(lp).connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.01);
  },

  magic(ctx, out, t0, dur, gain, seed) {
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(523.25, t0);
    carrier.frequency.exponentialRampToValueAtTime(880, t0 + dur * 0.7);
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = 1570;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(420, t0);
    modGain.gain.exponentialRampToValueAtTime(20, t0 + dur);
    mod.connect(modGain).connect(carrier.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    carrier.connect(g).connect(out);
    carrier.start(t0);
    mod.start(t0);
    carrier.stop(t0 + dur + 0.01);
    mod.stop(t0 + dur + 0.01);
  },
};

/** Render one timbre into ctx at t0, truncated at `cutSeconds`. */
export function buildTimbre(ctx, out, timbreId, t0, durationSeconds, gain, cutSeconds, seed) {
  const audible = cutSeconds == null ? durationSeconds : Math.max(0.012, cutSeconds);
  const builder = TIMBRE_BUILDERS[timbreId] || TIMBRE_BUILDERS.ui;
  builder(ctx, out, t0, audible, gain, seed == null ? 0x2545f491 : seed);
}

/** Render the whole plan offline at 48 kHz, stereo, honouring muted categories
 *  and preemption cut points. Returns an AudioBuffer. */
export async function renderPlan(plan, options = {}) {
  const { sampleRate = SAMPLE_RATE, mutedCategoryIds = [], tailMs = 120 } = options;
  const muted = new Set(mutedCategoryIds);
  const lengthMs = Math.max(plan.totalMs, 250) + tailMs;
  const frames = Math.ceil((lengthMs / 1000) * sampleRate);
  const OfflineCtor =
    typeof OfflineAudioContext !== 'undefined'
      ? OfflineAudioContext
      : typeof globalThis.webkitOfflineAudioContext !== 'undefined'
        ? globalThis.webkitOfflineAudioContext
        : null;
  if (!OfflineCtor) throw new Error('OfflineAudioContext 不可用');
  const ctx = new OfflineCtor(2, frames, sampleRate);

  const master = ctx.createGain();
  master.gain.value = plan.config.masterGain;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.12;
  master.connect(comp).connect(ctx.destination);

  const cats = new Map(plan.config.categories.map((c) => [c.id, c]));
  const playbacks = new Map(plan.playbacks.map((p) => [p.eventId, p]));

  for (const d of plan.decisions) {
    if (d.status === 'dropped' || d.status === 'muted') continue;
    if (muted.has(d.categoryId)) continue;
    const p = playbacks.get(d.eventId);
    const cat = cats.get(d.categoryId);
    if (!p || !cat) continue;
    const t0 = p.start / 1000;
    const natural = (p.naturalEnd - p.start) / 1000;
    const audible = (p.end - p.start) / 1000;
    // A preempted voice is cut abruptly: render the natural envelope, but
    // hard-gate this voice's own gain at the cut instant.
    const gate = ctx.createGain();
    gate.gain.setValueAtTime(1, t0);
    if (audible < natural - 0.001) {
      gate.gain.setValueAtTime(1, t0 + Math.max(0, audible - 0.006));
      gate.gain.linearRampToValueAtTime(0, t0 + audible);
    }
    gate.connect(master);
    buildTimbre(ctx, gate, cat.timbre, t0, natural, cat.gain, null, hashString(d.eventId + cat.id));
  }

  return ctx.startRendering();
}

/** Render a single category's timbre for the audition button. */
export async function renderOneShot(category, options = {}) {
  const sampleRate = options.sampleRate || SAMPLE_RATE;
  const secs = Math.max(0.04, category.durationMs / 1000);
  const OfflineCtor =
    typeof OfflineAudioContext !== 'undefined'
      ? OfflineAudioContext
      : typeof globalThis.webkitOfflineAudioContext !== 'undefined'
        ? globalThis.webkitOfflineAudioContext
        : null;
  if (!OfflineCtor) throw new Error('OfflineAudioContext 不可用');
  const frames = Math.ceil((secs + 0.08) * sampleRate);
  const ctx = new OfflineCtor(1, frames, sampleRate);
  const g = ctx.createGain();
  g.gain.value = 0.95;
  g.connect(ctx.destination);
  buildTimbre(ctx, g, category.timbre, 0.005, secs, category.gain, null, hashString(category.id));
  const buf = await ctx.startRendering();
  return buf;
}

function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Encode an AudioBuffer as a 16-bit PCM WAV Blob. */
export function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const chans = [];
  for (let c = 0; c < channels; c += 1) chans.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}

/* ------------------------------------------------------------------ */
/* Preview transport                                                   */
/* ------------------------------------------------------------------ */

export class PreviewTransport {
  constructor() {
    this.ctx = null;
    this.src = null;
    this.buffer = null;
    this.generation = 0;
    this.state = 'idle'; // idle | playing | paused | ended
    this.offsetMs = 0;
    this.startedAt = 0;
    this.listeners = new Set();
    this.bufferKey = '';
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  ensureContext() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('浏览器不支持 Web Audio');
      try {
        this.ctx = new Ctor({ sampleRate: SAMPLE_RATE });
      } catch {
        // Some browsers refuse a non-native rate; buffers resample on play.
        this.ctx = new Ctor();
      }
    }
    return this.ctx;
  }

  async setBuffer(buffer, key) {
    this.stop();
    this.buffer = buffer;
    this.bufferKey = key || '';
    this.offsetMs = 0;
    this.state = 'idle';
    this.emit();
  }

  get durationMs() {
    return this.buffer ? (this.buffer.duration * 1000) : 0;
  }

  positionMs() {
    if (this.state === 'playing') {
      return Math.min(
        this.durationMs,
        this.offsetMs + (this.ctx.currentTime - this.startedAt) * 1000
      );
    }
    if (this.state === 'ended') return this.durationMs;
    return this.offsetMs;
  }

  _detach() {
    this.generation += 1;
    if (this.src) {
      try {
        this.src.onended = null;
        this.src.stop();
      } catch {
        /* already stopped */
      }
      try {
        this.src.disconnect();
      } catch {
        /* noop */
      }
      this.src = null;
    }
  }

  stop() {
    this._detach();
    this.state = 'idle';
    this.offsetMs = 0;
    this.emit();
  }

  async play(fromMs) {
    if (!this.buffer) return;
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const gen = ++this.generation;
    if (this.src) {
      this.src.onended = null;
      try {
        this.src.stop();
      } catch {
        /* noop */
      }
      this.src = null;
    }
    const startMs = Math.max(0, Math.min(fromMs ?? this.offsetMs, this.durationMs - 1));
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(ctx.destination);
    src.onended = () => {
      // Only the current generation may transition the transport. A stopped
      // or superseded node must not revive an old position.
      if (gen !== this.generation) return;
      this.state = 'ended';
      this.offsetMs = this.durationMs;
      this.src = null;
      this.emit();
    };
    src.start(0, startMs / 1000);
    this.src = src;
    this.startedAt = ctx.currentTime;
    this.offsetMs = startMs;
    this.state = 'playing';
    this.emit();
  }

  async pause() {
    if (this.state !== 'playing') return;
    const at = this.positionMs();
    this._detach();
    this.offsetMs = at;
    this.state = 'paused';
    this.emit();
  }

  async toggle() {
    if (this.state === 'playing') await this.pause();
    else if (this.state === 'ended') await this.play(0);
    else await this.play(this.offsetMs);
  }

  async seek(ms) {
    const target = Math.max(0, Math.min(ms, this.durationMs));
    const wasPlaying = this.state === 'playing';
    this._detach();
    this.offsetMs = target;
    this.state = wasPlaying ? 'idle' : 'paused';
    this.emit();
    if (wasPlaying) await this.play(target);
  }

  async step(deltaMs) {
    await this.seek(this.positionMs() + deltaMs);
  }

  async restart() {
    this._detach();
    this.offsetMs = 0;
    this.state = 'idle';
    this.emit();
    await this.play(0);
  }

  /** Invalidate everything: used when the plan changes under the playhead. */
  invalidate() {
    this._detach();
    this.buffer = null;
    this.bufferKey = '';
    this.state = 'idle';
    this.offsetMs = 0;
    this.emit();
  }
}
