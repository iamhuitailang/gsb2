/**
 * 最小 OfflineAudioContext mock：只实现引擎用到的接口，
 * 用虚拟时钟按时间线触发 source.onended，便于确定性测试声部规则。
 */

interface ScheduledEvent {
  time: number;
  fn: () => void;
}

class MockAudioParam {
  value = 0;
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
}

class MockAudioNode {
  connect(dest: unknown): unknown {
    return dest;
  }
  disconnect(): void {}
}

class MockBufferSource extends MockAudioNode {
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  playbackRate = new MockAudioParam();
  onended: (() => void) | null = null;
  startWhen = 0;
  startOffset = 0;
  startDuration: number | undefined;
  private endedFired = false;
  private contextRef: MockOfflineAudioContext;

  constructor(ctx: MockOfflineAudioContext) {
    super();
    this.contextRef = ctx;
  }

  start(when: number, offset = 0, duration?: number): void {
    this.startWhen = when;
    this.startOffset = offset;
    this.startDuration = duration;
    this.contextRef.registerSource(this);
    this.contextRef.renderedSources.push(this);
  }

  stop(when = Number.POSITIVE_INFINITY): void {
    this.contextRef.schedule(when, () => this.fireEnded());
  }

  fireEnded(): void {
    if (this.endedFired) return;
    this.endedFired = true;
    this.onended?.();
  }

  naturalEndTime(): number {
    if (this.loop) return Number.POSITIVE_INFINITY;
    if (this.startDuration !== undefined) return this.startWhen + this.startDuration;
    const rate = this.playbackRate.value || 1;
    const mediaLeft = (this.buffer?.duration ?? 0) - this.startOffset;
    return this.startWhen + mediaLeft / rate;
  }
}

export interface FakeAudioBuffer {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  duration: number;
  getChannelData: (channel?: number) => Float32Array;
  copyToChannel: (data: Float32Array, channel?: number) => void;
}

export class MockOfflineAudioContext {
  readonly sampleRate: number;
  readonly length: number;
  readonly destination = new MockAudioNode();
  currentTime = 0;
  private queue: ScheduledEvent[] = [];
  /** 渲染期间启动过的全部源，测试据此断言发声调度 */
  readonly renderedSources: MockBufferSource[] = [];

  constructor(_channels: number, length: number, sampleRate: number) {
    this.length = length;
    this.sampleRate = sampleRate;
  }

  createGain(): MockAudioNode & { gain: MockAudioParam } {
    const node = new MockAudioNode() as MockAudioNode & { gain: MockAudioParam };
    node.gain = new MockAudioParam();
    return node;
  }

  createDynamicsCompressor(): MockAudioNode & {
    threshold: MockAudioParam;
    ratio: MockAudioParam;
  } {
    const node = new MockAudioNode() as MockAudioNode & {
      threshold: MockAudioParam;
      ratio: MockAudioParam;
    };
    node.threshold = new MockAudioParam();
    node.ratio = new MockAudioParam();
    return node;
  }

  createBufferSource(): MockBufferSource {
    return new MockBufferSource(this);
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      sampleRate,
      length,
      numberOfChannels: channels,
      duration: length / sampleRate,
      getChannelData: (ch = 0) => data[ch],
      copyToChannel: (src, ch = 0) => data[ch].set(src),
    };
  }

  registerSource(src: MockBufferSource): void {
    const end = src.naturalEndTime();
    if (Number.isFinite(end)) this.schedule(end, () => src.fireEnded());
  }

  schedule(time: number, fn: () => void): void {
    this.queue.push({ time, fn });
  }

  async startRendering(): Promise<FakeAudioBuffer> {
    this.queue.sort((a, b) => a.time - b.time);
    for (const ev of this.queue) {
      this.currentTime = ev.time;
      ev.fn();
    }
    // 用非零信号填充输出缓冲，便于上层测试确认渲染真实发生
    const out = this.createBuffer(1, this.length, this.sampleRate);
    const ch = out.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = 0.25;
    return out;
  }
}

export function installMockAudio(): void {
  (globalThis as Record<string, unknown>).OfflineAudioContext = MockOfflineAudioContext;
}

export function makeFakeBuffer(
  durationSec: number,
  sampleRate = 44100,
): FakeAudioBuffer {
  const length = Math.floor(durationSec * sampleRate);
  const data = new Float32Array(length);
  // 非零信号，区分“真渲染”与空缓冲
  for (let i = 0; i < length; i++) data[i] = Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 0.5;
  return {
    sampleRate,
    length,
    numberOfChannels: 1,
    duration: durationSec,
    getChannelData: () => data,
    copyToChannel: () => {},
  };
}
