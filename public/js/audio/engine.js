/**
 * Web Audio 播放引擎。
 * - 时间单位：秒。
 * - 支持普通播放、暂停、定位、选中区间循环播放。
 * - 支持拖动边界时的局部循环试听（auditionLoop）。
 */

export class AudioEngine {
  constructor() {
    this.context = null;
    this.buffer = null;
    this.gain = null;
    this.source = null;
    this.auditionSource = null;
    this.auditionGain = null;
    this.auditionRange = null;
    this.auditionStartedAt = 0;

    this.playing = false;
    this.position = 0;
    this.startedAt = 0;
    this.startOffset = 0;
    this.loopRange = null;
    this.rate = 1;
    this.volume = 0.9;
    this.listeners = new Set();
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type) {
    for (const listener of [...this.listeners]) {
      try {
        listener(type, this);
      } catch (error) {
        console.error('[audio] listener failed', error);
      }
    }
  }

  async ensureContext() {
    if (!this.context) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw new Error('当前浏览器不支持 Web Audio');
      this.context = new Context({ latencyHint: 'interactive' });
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') {
      // 没有用户手势时 resume() 可能长时间挂起，不阻塞解码流程
      await Promise.race([
        this.context.resume().catch(() => {}),
        new Promise((resolve) => window.setTimeout(resolve, 300)),
      ]);
    }
    return this.context;
  }

  get duration() {
    return this.buffer?.duration ?? 0;
  }

  get sampleRate() {
    return this.buffer?.sampleRate ?? 0;
  }

  get channels() {
    return this.buffer?.numberOfChannels ?? 0;
  }

  get isPlaying() {
    return this.playing;
  }

  async decode(arrayBuffer) {
    await this.ensureContext();
    const copy = arrayBuffer.slice(0);
    const buffer = await this.context.decodeAudioData(copy);
    this.setBuffer(buffer);
    return buffer;
  }

  async loadUrl(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`音频加载失败：HTTP ${response.status}`);
    const data = await response.arrayBuffer();
    return this.decode(data);
  }
  setBuffer(buffer) {
    this.stop();
    this.stopAudition();
    this.buffer = buffer;
    this.position = 0;
    this.emit('buffer');
  }

  /** 清空当前音轨（例如打开了一个找不到音频的工程）。 */
  clear() {
    this.stop();
    this.stopAudition();
    this.buffer = null;
    this.position = 0;
    this.loopRange = null;
    this.emit('buffer');
  }

  setVolume(value) {
    this.volume = Math.min(1, Math.max(0, Number(value) || 0));
    if (this.gain) this.gain.gain.value = this.volume;
    this.emit('volume');
  }

  setRate(value) {
    const rate = Math.min(2, Math.max(0.5, Number(value) || 1));
    this.rate = rate;
    if (this.playing) {
      const at = this.time;
      this.play({ from: at, loopRange: this.loopRange });
    }
    this.emit('rate');
  }

  /** 当前播放头（秒）。播放中循环时返回循环内的位置。 */
  get currentTime() {
    if (!this.playing || !this.context) return this.position;
    const elapsed = (this.context.currentTime - this.startedAt) * this.rate;
    if (this.loopRange) {
      const { start, end } = this.loopRange;
      const length = Math.max(0.01, end - start);
      const offset = this.startOffset - start + elapsed;
      return start + ((offset % length) + length) % length;
    }
    const time = this.startOffset + elapsed;
    return Math.min(time, this.duration || time);
  }

  /** 播放中取实时位置，停止时取上次定位。界面统一用它读取播放头。 */
  get time() {
    return this.playing ? this.currentTime : this.position;
  }

  async play({ from = this.position, loopRange = null } = {}) {
    if (!this.buffer) return false;
    await this.ensureContext();
    this.stopSource();
    const context = this.context;
    const duration = this.duration;

    let start = Math.max(0, Math.min(Number(from) || 0, Math.max(0, duration)));
    let range = null;
    if (loopRange && loopRange.end - loopRange.start > 0.02) {
      range = {
        start: Math.max(0, Math.min(loopRange.start, duration)),
        end: Math.min(duration, loopRange.end),
      };
      if (range.end - range.start < 0.02) range = null;
    }
    if (range) {
      if (start < range.start || start >= range.end) start = range.start;
    } else if (start >= duration - 0.01) {
      // 播到结尾后再按播放，从头开始
      start = 0;
    }
    start = Math.min(start, Math.max(0, duration - 0.005));

    const source = context.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.rate;
    source.connect(this.gain);
    if (range) {
      source.loop = true;
      source.loopStart = range.start;
      source.loopEnd = range.end;
    }
    source.start(0, start);
    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      if (!this.playing) return;
      this.playing = false;
      this.position = this.loopRange ? this.loopRange.start : duration;
      this.emit('ended');
    };

    this.source = source;
    this.playing = true;
    this.startedAt = context.currentTime;
    this.startOffset = start;
    this.position = start;
    this.loopRange = range;
    this.emit('play');
    return true;
  }

  pause() {
    if (!this.playing) return;
    const at = this.currentTime;
    this.stopSource();
    this.playing = false;
    this.position = at;
    this.emit('pause');
  }

  stop() {
    if (!this.buffer) {
      this.playing = false;
      this.position = 0;
      this.emit('stop');
      return;
    }
    this.stopSource();
    this.playing = false;
    this.position = 0;
    this.loopRange = null;
    this.emit('stop');
  }

  stopSource() {
    const source = this.source;
    this.source = null;
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* 已结束 */
    }
    try {
      source.disconnect();
    } catch {
      /* noop */
    }
  }

  /** 定位；播放中会从新位置继续。 */
  seek(time) {
    const target = Math.max(0, Math.min(Number(time) || 0, this.duration));
    if (this.playing) {
      this.play({ from: target, loopRange: this.loopRange });
    } else {
      this.position = target;
      this.emit('seek');
    }
  }

  setPositionSilently(time) {
    this.position = Math.max(0, Math.min(Number(time) || 0, this.duration));
  }

  togglePlay() {
    if (this.playing) {
      this.pause();
      return false;
    }
    return this.play({ from: this.position, loopRange: this.loopRange });
  }

  /**
   * 边界拖动试听：循环播放 [start, end]。
   * 拖动期间会被高频调用：已在小范围循环时不重建节点；
   * 只有窗口明显变化（或距上次重建已超过 60ms）才重建，避免爆音和抖动。
   */
  auditionLoop(start, end) {
    if (!this.buffer) return;
    const duration = this.duration;
    const from = Math.max(0, Math.min(start, duration - 0.02));
    const to = Math.min(duration, Math.max(end, from + 0.02));
    const range = { start: from, end: to };
    const previous = this.auditionRange;
    this.auditionRange = range;
    if (previous && this.auditionSource) {
      const drift = Math.abs(previous.start - range.start) + Math.abs(previous.end - range.end);
      const now = performance.now();
      if (drift < 0.08 || now - this.auditionStartedAt < 60) return;
    }
    this.startAuditionSource(range);
  }

  async startAuditionSource(range) {
    if (!this.context) {
      try {
        await this.ensureContext();
      } catch {
        return;
      }
    }
    if (!this.buffer || !this.auditionRange) return;
    // 等待异步期间范围可能已更新或已停止，用最新范围重建
    range = this.auditionRange;
    this.auditionStartedAt = performance.now();
    this.stopAuditionSource();
    const context = this.context;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = this.buffer;
    source.loop = true;
    source.loopStart = range.start;
    source.loopEnd = range.end;
    const fade = Math.min(0.02, (range.end - range.start) / 6);
    gain.gain.setValueAtTime(0, context.currentTime);
    gain.gain.linearRampToValueAtTime(this.volume * 0.85, context.currentTime + fade);
    source.connect(gain).connect(context.destination);
    source.start(0, range.start);
    this.auditionSource = source;
    this.auditionGain = gain;
    this.emit('audition');
  }

  stopAuditionSource() {
    const source = this.auditionSource;
    const gain = this.auditionGain;
    this.auditionSource = null;
    this.auditionGain = null;
    if (source) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* noop */
      }
      try {
        source.disconnect();
      } catch {
        /* noop */
      }
    }
    if (gain) {
      try {
        gain.disconnect();
      } catch {
        /* noop */
      }
    }
  }

  stopAudition() {
    this.auditionRange = null;
    this.stopAuditionSource();
  }
}

/** 把 AudioBuffer 混成单声道 Float32Array（用于细致波形绘制）。 */
export function mixToMono(buffer) {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  if (channels === 1) return buffer.getChannelData(0);
  const mono = new Float32Array(length);
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) mono[i] += data[i];
  }
  const scale = 1 / channels;
  for (let i = 0; i < length; i += 1) mono[i] *= scale;
  return mono;
}
