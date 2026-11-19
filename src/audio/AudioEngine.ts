import type { Project } from '../types';
import { scheduleProject, type ScheduleHandle } from './scheduler';
import { decodeAudio } from './wav';
import { getRecordingBlob } from '../utils/storage';

type StateListener = (playing: boolean) => void;

/**
 * 播放引擎：
 * - AudioContext 懒初始化（必须由用户手势触发，满足浏览器自动播放策略）
 * - 播放时一次性排程全部片段，所有轨道由音频时钟驱动，天然保持同步
 * - 暂停/跳转即丢弃当前排程并按新位置重新排程
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private handle: ScheduleHandle | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private objectUrls = new Map<string, string>();
  private playing = false;
  private startedAt = 0; // ctx.currentTime 基准
  private originTime = 0; // 基准对应的工程时间
  private rafId = 0;
  private stateListeners = new Set<StateListener>();
  private positionListeners = new Set<(time: number) => void>();

  /** 必须在点击等用户手势中调用 */
  async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** 当前音频上下文采样率（上下文未初始化时返回 null） */
  get sampleRateHint(): number | null {
    return this.ctx?.sampleRate ?? null;
  }

  get currentTime(): number {
    if (!this.ctx) return this.originTime;
    if (this.playing) {
      return this.originTime + (this.ctx.currentTime - this.startedAt);
    }
    return this.originTime;
  }

  onStateChange(fn: StateListener): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  onPosition(fn: (time: number) => void): () => void {
    this.positionListeners.add(fn);
    return () => this.positionListeners.delete(fn);
  }

  /** 预加载工程内全部资源（示例 URL 与录音 Blob） */
  async loadProject(project: Project): Promise<void> {
    await this.ensureContext();
    const ids = new Set<string>();
    for (const track of project.tracks) {
      for (const clip of track.clips) ids.add(clip.resourceId);
    }
    await Promise.all([...ids].map((id) => this.loadBuffer(id, project)));
  }

  private async loadBuffer(id: string, project: Project): Promise<AudioBuffer | undefined> {
    const cached = this.buffers.get(id);
    if (cached) return cached;
    if (!this.ctx) return undefined;
    const meta = project.resources[id];
    if (!meta) return undefined;
    try {
      let data: ArrayBuffer;
      if (meta.kind === 'recording') {
        const blob = await getRecordingBlob(id);
        if (!blob) throw new Error(`录音数据缺失：${meta.name}`);
        data = await blob.arrayBuffer();
      } else if (meta.url) {
        const res = await fetch(meta.url);
        if (!res.ok) throw new Error(`资源加载失败：${meta.url}`);
        data = await res.arrayBuffer();
      } else {
        return undefined;
      }
      const buffer = await decodeAudio(this.ctx, data);
      this.buffers.set(id, buffer);
      return buffer;
    } catch (err) {
      console.error('音频资源加载失败', id, err);
      return undefined;
    }
  }

  /** 直接放入解码后的缓冲（录音完成后调用，避免重复解码） */
  cacheBuffer(id: string, buffer: AudioBuffer): void {
    this.buffers.set(id, buffer);
  }

  getBuffer(id: string): AudioBuffer | undefined {
    return this.buffers.get(id);
  }

  /** 供波形绘制使用，必要时通过对象 URL 加载 */
  async ensureBuffer(id: string, project: Project): Promise<AudioBuffer | undefined> {
    const existing = this.buffers.get(id);
    if (existing) return existing;
    return this.loadBuffer(id, project);
  }

  async play(project: Project, fromTime?: number): Promise<void> {
    const ctx = await this.ensureContext();
    await this.loadProject(project);
    this.teardownSchedule();

    const start = fromTime ?? this.currentTime;
    this.originTime = start;
    this.endAt = project.length;
    this.startedAt = ctx.currentTime + 0.05;
    this.handle = scheduleProject({
      ctx,
      destination: this.master ?? ctx.destination,
      project,
      buffers: this.buffers,
      startTime: this.startedAt,
      fromTime: start,
      untilTime: project.length,
    });
    this.playing = true;
    this.emitState();
    this.loopPosition();
  }

  pause(): void {
    if (!this.playing) return;
    this.originTime = this.currentTime;
    this.teardownSchedule();
    this.playing = false;
    this.stopPositionLoop();
    this.emitState();
  }

  /** 跳转到指定工程时间；播放中跳转则从新位置继续播放，保证所有轨道同步重排 */
  seek(project: Project, time: number): void {
    const target = Math.max(0, Math.min(time, project.length));
    if (this.playing) {
      void this.play(project, target);
    } else {
      this.originTime = target;
      this.emitPosition(target);
    }
  }

  stop(): void {
    this.pause();
    this.originTime = 0;
    this.emitPosition(0);
  }

  private teardownSchedule(): void {
    this.handle?.stop();
    this.handle = null;
  }

  private loopPosition = (): void => {
    if (!this.playing || !this.ctx) return;
    const t = this.currentTime;
    this.emitPosition(t);
    // 播放到工程结尾自动停止
    if (t >= this.endAt) {
      this.pause();
      this.originTime = this.endAt;
      this.emitPosition(this.originTime);
      return;
    }
    this.rafId = window.requestAnimationFrame(this.loopPosition);
  };

  private endAt = 0;

  private stopPositionLoop(): void {
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private emitState(): void {
    for (const fn of this.stateListeners) fn(this.playing);
  }

  private emitPosition(t: number): void {
    for (const fn of this.positionListeners) fn(t);
  }

  /** 轨道静音/独奏/音量/自动化在播放中变化时，从当前位置无缝重排 */
  reschedule(project: Project): void {
    if (!this.playing) return;
    void this.play(project, this.currentTime);
  }

  dispose(): void {
    this.teardownSchedule();
    this.stopPositionLoop();
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    void this.ctx?.close();
    this.ctx = null;
  }
}
