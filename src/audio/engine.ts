/**
 * 采样发声引擎，实时 AudioContext 与 OfflineAudioContext 共用同一套调度代码，
 * 因此试听、重放、导出 WAV 的音头顺序与尾音处理完全一致。
 *
 * 声部规则（统一且确定）：
 * - 同音重按：新音头在 when 处抢断旧声部（20ms 快速淡出），旧声部记 retriggered。
 * - 发声上限：超过 maxVoices 时抢断最旧的在响声部，记 voice-limit。
 * - noteOff：循环样本进入尾音（tail 段 + 0.3s 淡出）；一次性样本继续自然衰减。
 * - 任何声部都有硬寿命，配合看门狗定时器，不存在一直响的音。
 */
import type {
  LoadedSample,
  SampleChoice,
  VoiceEndReason,
  VoiceEvent,
} from '../types.ts';
import { chooseSample } from './zones.ts';
import { clamp } from './notes.ts';
import { encodeWavPcm16 } from './wav.ts';

const ATTACK_SEC = 0.005;
const STEAL_FADE_SEC = 0.02;
const RELEASE_SEC = 0.3;
/** 循环样本最长保持时间，到点自动进尾音，防止漏 noteOff 导致无限发声 */
const MAX_HOLD_SEC = 12;
const WATCHDOG_INTERVAL_MS = 1000;
/** 看门狗宽限：调度结束后仍未 finalize 的声部强制收尾 */
const WATCHDOG_GRACE_SEC = 0.5;

const LAYER_GAIN: Record<SampleChoice['usedLayer'], number> = {
  soft: 0.5,
  hard: 0.9,
};

interface BakedLoop {
  buffer: AudioBuffer;
  loopStart: number;
  loopEnd: number;
}

interface ActiveVoice {
  id: number;
  note: number;
  velocity: number;
  choice: SampleChoice;
  gain: GainNode;
  startedAt: number;
  state: 'attack' | 'sustain' | 'releasing' | 'dead';
  looped: boolean;
  sources: AudioScheduledSourceNode[];
  pendingSources: number;
  hadRelease: boolean;
  endReason: VoiceEndReason | null;
  /** 调度上的最终停止时间，看门狗据此兜底 */
  scheduledEnd: number;
  timers: ReturnType<typeof setTimeout>[];
  finalized: boolean;
  gainDisconnected: boolean;
}

export interface EngineCallbacks {
  onVoiceStart?: (info: {
    id: number;
    note: number;
    velocity: number;
    when: number;
    choice: SampleChoice;
    looped: boolean;
  }) => void;
  onVoiceEnd?: (event: VoiceEvent) => void;
  onError?: (message: string) => void;
}

export class SamplerEngine {
  readonly ctx: BaseAudioContext;
  private readonly isOffline: boolean;
  private readonly master: GainNode;
  private samples: LoadedSample[];
  private readonly velocityThreshold: number;
  private maxVoices: number;
  private crossfadeMs = 10;
  private voices: ActiveVoice[] = [];
  private nextId = 1;
  private readonly callbacks: EngineCallbacks;
  private readonly bakeCache = new Map<string, BakedLoop>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    ctx: BaseAudioContext,
    samples: LoadedSample[],
    velocityThreshold: number,
    maxVoices: number,
    callbacks: EngineCallbacks = {},
  ) {
    this.ctx = ctx;
    this.samples = samples;
    this.velocityThreshold = velocityThreshold;
    this.maxVoices = maxVoices;
    this.callbacks = callbacks;
    this.isOffline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;

    // 压缩器兜底，和弦齐奏时不破音
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 6;
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    if (!this.isOffline) {
      this.watchdog = setInterval(() => this.watchdogSweep(), WATCHDOG_INTERVAL_MS);
    }
  }

  get voiceLimit(): number {
    return this.maxVoices;
  }

  get activeVoiceCount(): number {
    return this.voices.filter((v) => !v.finalized).length;
  }

  get loopSamples(): LoadedSample[] {
    return this.samples.filter((s) => s.loopLength > 0);
  }

  setMaxVoices(n: number): void {
    this.maxVoices = Math.max(1, Math.floor(n));
  }

  /** 改变交叉淡化时长；已发声声部保留旧缓冲，新音头使用新设置 */
  setCrossfade(ms: number): void {
    this.crossfadeMs = Math.max(0, ms);
    this.bakeCache.clear();
  }

  getCrossfade(): number {
    return this.crossfadeMs;
  }

  noteOn(note: number, velocity: number, when?: number): number {
    if (this.disposed) throw new Error('引擎已释放');
    const t = when ?? this.ctx.currentTime;
    const v = clamp(Math.round(velocity), 1, 127);

    let choice: SampleChoice;
    try {
      choice = chooseSample(note, v, this.samples, this.velocityThreshold);
    } catch (err) {
      this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
      return -1;
    }

    // 规则 1：同音重按，抢断同音符最新声部
    const sameNote = this.voices
      .filter((voice) => !voice.finalized && voice.note === note)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (sameNote) this.steal(sameNote, t, 'retriggered');

    // 规则 2：超出发声上限，抢断最旧的在响声部
    if (this.activeVoiceCount >= this.maxVoices) {
      const oldest = [...this.voices]
        .filter((voice) => !voice.finalized)
        .sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest) this.steal(oldest, t, 'voice-limit');
    }

    const gain = this.ctx.createGain();
    gain.connect(this.master);
    const targetGain =
      LAYER_GAIN[choice.usedLayer] * (0.3 + (0.7 * v) / 127);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(targetGain, t + ATTACK_SEC);

    const voice: ActiveVoice = {
      id: this.nextId++,
      note,
      velocity: v,
      choice,
      gain,
      startedAt: t,
      state: 'attack',
      looped: choice.sample.loopLength > 0,
      sources: [],
      pendingSources: 0,
      hadRelease: false,
      endReason: null,
      scheduledEnd: t,
      timers: [],
      finalized: false,
      gainDisconnected: false,
    };
    this.voices.push(voice);

    if (voice.looped) {
      this.startLooped(voice, t);
    } else {
      this.startOneShot(voice, t);
    }

    this.callbacks.onVoiceStart?.({
      id: voice.id,
      note,
      velocity: v,
      when: t,
      choice,
      looped: voice.looped,
    });
    return voice.id;
  }

  noteOff(note: number, when?: number): void {
    const t = when ?? this.ctx.currentTime;
    const voice = this.voices
      .filter((v) => !v.finalized && v.note === note)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!voice) return;

    voice.hadRelease = true;
    if (!voice.looped) {
      // 一次性钟声：松开琴键不打断自然衰减
      return;
    }
    if (voice.state === 'releasing' || voice.state === 'dead') return;

    voice.state = 'releasing';
    voice.endReason = 'released';
    const sample = voice.choice.sample;
    const baked = this.getBaked(sample);
    const rate = voice.choice.playbackRate;
    const tailMedia = (sample.buffer.length - sample.loopEnd) / sample.buffer.sampleRate;

    // 停循环、接尾音段，尾音上做 0.3s 淡出
    for (const src of voice.sources) {
      try {
        src.stop(t);
      } catch {
        /* 源可能已结束 */
      }
    }
    const tail = this.ctx.createBufferSource();
    tail.buffer = baked.buffer;
    tail.playbackRate.value = rate;
    tail.connect(voice.gain);
    // 只播尾音段实际长度；尾部 0.3s 淡出由 gain 完成
    const tailDur = tailMedia / rate;
    tail.start(t, sample.loopEnd / sample.buffer.sampleRate, tailDur);
    this.attachSource(voice, tail);

    const gainParam = voice.gain.gain;
    gainParam.cancelScheduledValues(t);
    gainParam.setValueAtTime(gainParam.value, t);
    gainParam.linearRampToValueAtTime(0.0001, t + Math.min(RELEASE_SEC, tailDur));

    voice.scheduledEnd = t + tailDur;
    this.armDeadline(voice, voice.scheduledEnd + WATCHDOG_GRACE_SEC);
  }

  /** 全部立即静音（页面隐藏 / 手动 panic） */
  panic(): void {
    const t = this.ctx.currentTime;
    for (const voice of [...this.voices]) {
      if (!voice.finalized) this.steal(voice, t, 'panic');
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.watchdog !== null) clearInterval(this.watchdog);
    for (const voice of this.voices) {
      for (const timer of voice.timers) clearTimeout(timer);
      for (const src of voice.sources) {
        try {
          src.onended = null;
          src.disconnect();
          src.stop();
        } catch {
          /* 已停止 */
        }
      }
    }
    this.voices = [];
    this.bakeCache.clear();
  }

  /** 试听某循环样本的接头：循环播放一小段后自动停 */
  previewSplice(sample: LoadedSample, crossfadeMs: number): void {
    if (this.isOffline) return;
    const t = this.ctx.currentTime;
    const baked = this.bakeLoop(sample, crossfadeMs);
    const gain = this.ctx.createGain();
    gain.connect(this.master);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.8, t + 0.01);
    const src = this.ctx.createBufferSource();
    src.buffer = baked.buffer;
    src.loop = true;
    src.loopStart = baked.loopStart / sample.buffer.sampleRate;
    src.loopEnd = baked.loopEnd / sample.buffer.sampleRate;
    src.connect(gain);
    const previewDur = 1.4;
    src.start(t, baked.loopStart / sample.buffer.sampleRate);
    src.stop(t + previewDur);
    gain.gain.setValueAtTime(gain.gain.value, t + previewDur - 0.05);
    gain.gain.linearRampToValueAtTime(0.0001, t + previewDur);
    src.onended = () => {
      src.disconnect();
      gain.disconnect();
    };
  }

  /**
   * 离线渲染一段演奏：与实时路径共用 noteOn/noteOff 调度。
   * 返回 WAV (PCM16) Blob，保证导出的音头顺序、尾音与试听一致。
   */
  static async renderOffline(
    sampleRate: number,
    samples: LoadedSample[],
    velocityThreshold: number,
    maxVoices: number,
    crossfadeMs: number,
    events: { time: number; type: 'on' | 'off'; note: number; velocity?: number }[],
    durationSec: number,
  ): Promise<Blob> {
    const length = Math.ceil(durationSec * sampleRate);
    const ctx = new OfflineAudioContext(1, length, sampleRate);
    const engine = new SamplerEngine(ctx, samples, velocityThreshold, maxVoices);
    engine.setCrossfade(crossfadeMs);
    for (const ev of events) {
      if (ev.type === 'on') {
        engine.noteOn(ev.note, ev.velocity ?? 96, ev.time);
      } else {
        engine.noteOff(ev.note, ev.time);
      }
    }
    const rendered = await ctx.startRendering();
    const wav = encodeWavPcm16(rendered.getChannelData(0), sampleRate);
    const copy = new Uint8Array(wav.byteLength);
    copy.set(wav);
    return new Blob([copy.buffer], { type: 'audio/wav' });
  }

  // ---- 内部实现 ----

  private startOneShot(voice: ActiveVoice, t: number): void {
    const { sample, playbackRate: rate } = voice.choice;
    const src = this.ctx.createBufferSource();
    src.buffer = sample.buffer;
    src.playbackRate.value = rate;
    src.connect(voice.gain);
    const dur = sample.buffer.duration / rate;
    src.start(t);
    this.attachSource(voice, src);
    voice.scheduledEnd = t + dur + WATCHDOG_GRACE_SEC;
    this.armDeadline(voice, voice.scheduledEnd);
  }

  private startLooped(voice: ActiveVoice, t: number): void {
    const { sample, playbackRate: rate } = voice.choice;
    const baked = this.getBaked(sample);
    const sr = sample.buffer.sampleRate;

    // 源 1：从头播到（缩短后的）循环尾
    const head = this.ctx.createBufferSource();
    head.buffer = baked.buffer;
    head.playbackRate.value = rate;
    head.connect(voice.gain);
    const headMedia = baked.loopEnd / sr;
    head.start(t, 0, headMedia / rate);
    this.attachSource(voice, head);

    // 源 2：在循环区间内持续循环，noteOff 或最长保持时间到了才停
    const loopSrc = this.ctx.createBufferSource();
    loopSrc.buffer = baked.buffer;
    loopSrc.playbackRate.value = rate;
    loopSrc.loop = true;
    loopSrc.loopStart = baked.loopStart / sr;
    loopSrc.loopEnd = baked.loopEnd / sr;
    loopSrc.connect(voice.gain);
    const loopBegin = t + headMedia / rate;
    loopSrc.start(loopBegin, baked.loopStart / sr);
    this.attachSource(voice, loopSrc);

    voice.state = 'sustain';
    voice.scheduledEnd = t + MAX_HOLD_SEC;
    // 漏 noteOff 兜底：到最长保持时间自动进尾音
    const timer = setTimeout(() => {
      if (!voice.finalized && voice.state !== 'releasing') {
        voice.endReason = 'natural';
        this.noteOff(voice.note, this.ctx.currentTime);
      }
    }, MAX_HOLD_SEC * 1000);
    voice.timers.push(timer);
  }

  private attachSource(voice: ActiveVoice, src: AudioScheduledSourceNode): void {
    voice.sources.push(src);
    voice.pendingSources += 1;
    src.onended = () => {
      voice.pendingSources -= 1;
      if (voice.pendingSources <= 0) {
        this.disconnectGain(voice);
        this.finalize(voice);
      }
    };
  }

  private steal(voice: ActiveVoice, t: number, reason: VoiceEndReason): void {
    if (voice.finalized) return;
    voice.state = 'dead';
    voice.endReason = reason;
    for (const timer of voice.timers) clearTimeout(timer);
    voice.timers = [];
    const param = voice.gain.gain;
    param.cancelScheduledValues(t);
    try {
      param.setValueAtTime(param.value, t);
    } catch {
      param.setValueAtTime(0.0001, t);
    }
    param.linearRampToValueAtTime(0.0001, t + STEAL_FADE_SEC);
    for (const src of voice.sources) {
      try {
        src.stop(t + STEAL_FADE_SEC);
      } catch {
        /* 已停止 */
      }
    }
    voice.scheduledEnd = t + STEAL_FADE_SEC + WATCHDOG_GRACE_SEC;
    // 立即从活动集合摘除并发出结束事件；源的 onended 只负责收尾资源
    this.removeVoice(voice);
  }

  private finalize(voice: ActiveVoice): void {
    if (voice.finalized) return;
    this.disconnectGain(voice);
    this.removeVoice(voice);
  }

  /** 统一的声部摘除与结束事件发射，抢断与自然结束共用 */
  private removeVoice(voice: ActiveVoice): void {
    if (voice.finalized) return;
    voice.finalized = true;
    for (const timer of voice.timers) clearTimeout(timer);
    voice.timers = [];
    const idx = this.voices.indexOf(voice);
    if (idx >= 0) this.voices.splice(idx, 1);
    // 抢断时源还在走最后 20ms 淡出，等源全部 onended 后再断开 gain
    if (voice.pendingSources <= 0) this.disconnectGain(voice);
    this.callbacks.onVoiceEnd?.({
      id: voice.id,
      note: voice.note,
      velocity: voice.velocity,
      choice: voice.choice,
      startedAt: voice.startedAt,
      endedAt: this.ctx.currentTime,
      endReason: voice.endReason ?? 'natural',
      hadRelease: voice.hadRelease,
    });
  }

  private disconnectGain(voice: ActiveVoice): void {
    if (voice.gainDisconnected) return;
    voice.gainDisconnected = true;
    try {
      voice.gain.disconnect();
    } catch {
      /* ignore */
    }
  }

  private watchdogSweep(): void {
    const now = this.ctx.currentTime;
    for (const voice of [...this.voices]) {
      if (!voice.finalized && voice.scheduledEnd + WATCHDOG_GRACE_SEC < now) {
        // onended 未按预期触发时的兜底：强制收尾，保证没有长鸣音
        this.steal(voice, now, voice.endReason ?? 'natural');
        for (const src of voice.sources) {
          try {
            src.stop(now);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  private armDeadline(voice: ActiveVoice, deadline: number): void {
    if (this.isOffline) return;
    const delay = Math.max(0, (deadline - this.ctx.currentTime) * 1000);
    const timer = setTimeout(() => {
      if (!voice.finalized && voice.pendingSources > 0) {
        for (const src of voice.sources) {
          try {
            src.stop();
          } catch {
            /* ignore */
          }
        }
      }
    }, delay + 200);
    voice.timers.push(timer);
  }

  private getBaked(sample: LoadedSample): BakedLoop {
    const key = `${sample.root}-${sample.layer}-${this.crossfadeMs}`;
    const cached = this.bakeCache.get(key);
    if (cached) return cached;
    const baked = this.bakeLoop(sample, this.crossfadeMs);
    this.bakeCache.set(key, baked);
    return baked;
  }

  /**
   * 把循环尾 X 个采样以等功率方式叠进循环头，并把循环尾缩短 X：
   * 接头处的相位突变被摊到 X 毫秒的渐变里，X 越大咔哒声越弱。
   * xfSec=0 时直接返回原始缓冲（故意错位的循环点会露出咔哒声）。
   */
  private bakeLoop(sample: LoadedSample, crossfadeMs: number): BakedLoop {
    const { buffer, loopStart, loopEnd } = sample;
    const sr = buffer.sampleRate;
    const loopLen = loopEnd - loopStart;
    const x = Math.min(Math.round((crossfadeMs / 1000) * sr), Math.floor(loopLen / 2));
    if (x < 2) return { buffer, loopStart, loopEnd };

    const baked = this.ctx.createBuffer(buffer.numberOfChannels, buffer.length, sr);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const input = buffer.getChannelData(ch);
      const out = new Float32Array(input);
      for (let i = 0; i < x; i++) {
        const g = i / (x - 1);
        const head = input[loopStart + i];
        const tail = input[loopEnd - x + i];
        out[loopStart + i] =
          Math.cos((g * Math.PI) / 2) * head + Math.sin((g * Math.PI) / 2) * tail;
      }
      baked.copyToChannel(out, ch);
    }
    return { buffer: baked, loopStart, loopEnd: loopEnd - x };
  }
}
