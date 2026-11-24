/**
 * 短演奏记录：记录性能时间线上的 noteOn/noteOff。
 * 重放与导出共用同一份事件，时间基准一致，因此音头顺序、尾音完全一致。
 */
import type { NoteEvent, Recording } from '../types.ts';

export class Recorder {
  private events: NoteEvent[] = [];
  private startPerfTime = 0;
  private lastPerfTime = 0;
  private activeNotes = new Set<number>();
  recording = false;

  start(now: number): void {
    this.events = [];
    this.activeNotes.clear();
    this.startPerfTime = now;
    this.lastPerfTime = now;
    this.recording = true;
  }

  recordOn(now: number, note: number, velocity: number): void {
    if (!this.recording) return;
    this.events.push({ time: now - this.startPerfTime, type: 'on', note, velocity });
    this.lastPerfTime = now;
    this.activeNotes.add(note);
  }

  recordOff(now: number, note: number): void {
    if (!this.recording) return;
    this.events.push({ time: now - this.startPerfTime, type: 'off', note });
    this.lastPerfTime = now;
    this.activeNotes.delete(note);
  }

  /** 停止录制；仍按住的键自动补 noteOff，保证重放/导出不留长鸣音 */
  stop(now: number): Recording {
    if (!this.recording) {
      return { version: 1, duration: this.events.length ? this.lastPerfTime - this.startPerfTime : 0, events: [] };
    }
    const endTime = now;
    for (const note of this.activeNotes) {
      this.events.push({ time: endTime - this.startPerfTime, type: 'off', note });
    }
    this.activeNotes.clear();
    this.recording = false;
    this.events.sort((a, b) => a.time - b.time || (a.type === 'off' ? -1 : 1));
    const duration = Math.max(0, ...this.events.map((e) => e.time)) + 0.6;
    return {
      version: 1,
      duration,
      events: this.events.map((e) => ({ ...e })),
    };
  }

  get eventCount(): number {
    return this.events.length;
  }
}

/** 内置试听片段：旋律 + 和弦，用来快速验证重放与导出 */
export function demoRecording(): Recording {
  const seq: Array<[number, number, number, number]> = [
    // 起始秒, 时长, 音高, 力度
    [0.0, 0.35, 60, 96],
    [0.4, 0.35, 64, 80],
    [0.8, 0.35, 67, 110],
    [1.2, 0.6, 72, 120],
    [2.0, 0.8, 60, 60],
    [2.0, 0.8, 67, 96],
    [2.0, 0.8, 72, 110],
    [3.1, 0.5, 65, 72],
  ];
  const events: NoteEvent[] = [];
  for (const [time, dur, note, velocity] of seq) {
    events.push({ time, type: 'on', note, velocity });
    events.push({ time: time + dur, type: 'off', note });
  }
  events.sort((a, b) => a.time - b.time || (a.type === 'off' ? -1 : 1));
  return { version: 1, duration: 3.9, events };
}
