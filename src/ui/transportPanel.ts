/** 演奏记录面板：录制、重放、导出 JSON / WAV */
import type { Recording } from '../types.ts';
import { demoRecording } from '../audio/recorder.ts';
import { downloadBlob, h } from './dom.ts';

export interface TransportHandlers {
  onStart: () => void;
  onStop: () => Recording | null;
  onReplay: (rec: Recording) => void;
  onExportWav: (rec: Recording) => Promise<Blob>;
}

export class TransportPanel {
  readonly el: HTMLElement;
  private readonly handlers: TransportHandlers;
  private readonly recDot: HTMLElement;
  private recording = false;
  private last: Recording | null = null;
  private readonly status: HTMLElement;

  constructor(handlers: TransportHandlers, recDot: HTMLElement) {
    this.handlers = handlers;
    this.recDot = recDot;
    this.status = h('span', { class: 'rec-status' }, ['未录制']);

    const recBtn = h('button', { class: 'btn danger' }, ['● 录制']);
    const stopBtn = h('button', { class: 'btn', disabled: true }, ['■ 停止']);
    const replayBtn = h('button', { class: 'btn', disabled: true }, ['▶ 重放']);
    const demoBtn = h('button', { class: 'btn' }, ['载入示例片段']);
    const jsonBtn = h('button', { class: 'btn', disabled: true }, ['导出 JSON']);
    const wavBtn = h('button', { class: 'btn primary', disabled: true }, ['导出 WAV']);

    const setStopped = (rec: Recording | null) => {
      this.last = rec;
      this.recording = false;
      this.recDot.classList.remove('on');
      this.status.textContent = rec
        ? `已记录 ${rec.events.length} 个事件 / ${rec.duration.toFixed(1)}s`
        : '未录制';
      recBtn.disabled = false;
      stopBtn.disabled = true;
      replayBtn.disabled = !rec;
      jsonBtn.disabled = !rec;
      wavBtn.disabled = !rec;
    };

    recBtn.addEventListener('click', () => {
      this.recording = true;
      this.recDot.classList.add('on');
      this.status.textContent = '录制中…';
      recBtn.disabled = true;
      stopBtn.disabled = false;
      replayBtn.disabled = true;
      jsonBtn.disabled = true;
      wavBtn.disabled = true;
      this.handlers.onStart();
    });
    stopBtn.addEventListener('click', () => setStopped(this.handlers.onStop()));
    replayBtn.addEventListener('click', () => {
      if (this.last) this.handlers.onReplay(this.last);
    });
    demoBtn.addEventListener('click', () => setStopped(demoRecording()));
    jsonBtn.addEventListener('click', () => {
      if (!this.last) return;
      const blob = new Blob([JSON.stringify(this.last, null, 2)], {
        type: 'application/json',
      });
      downloadBlob(blob, 'bell-recording.json');
    });
    wavBtn.addEventListener('click', async () => {
      if (!this.last) return;
      wavBtn.disabled = true;
      wavBtn.textContent = '渲染中…';
      try {
        const blob = await this.handlers.onExportWav(this.last);
        downloadBlob(blob, 'bell-recording.wav');
      } finally {
        wavBtn.disabled = false;
        wavBtn.textContent = '导出 WAV';
      }
    });

    this.el = h('div', { class: 'transport-inner' }, [
      h('div', { class: 'btn-row wrap' }, [recBtn, stopBtn, replayBtn]),
      h('div', { class: 'btn-row wrap' }, [demoBtn, jsonBtn, wavBtn]),
      this.status,
    ]);
  }

  isRecording(): boolean {
    return this.recording;
  }
}
