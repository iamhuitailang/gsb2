import type { TimeState } from '../types';
import { h } from './dom';

const MAX_SCRUB = 120; // 拖动条上限（秒），数值输入可超过它

interface TimelineCallbacks {
  getTime: () => TimeState;
  setPlaying: (playing: boolean) => void;
  setTime: (time: number) => void;
}

export class Timeline {
  readonly element: HTMLElement;
  private cb: TimelineCallbacks;
  private playBtn: HTMLButtonElement;
  private slider: HTMLInputElement;
  private number: HTMLInputElement;

  constructor(cb: TimelineCallbacks) {
    this.cb = cb;
    this.playBtn = h('button', { type: 'button', className: 'play-btn' }) as HTMLButtonElement;
    this.slider = h('input', {
      type: 'range', min: '0', max: String(MAX_SCRUB), step: '0.01', value: '0',
      className: 'time-slider',
    }) as HTMLInputElement;
    this.number = h('input', {
      type: 'number', step: '0.01', value: '0', className: 'time-number',
    }) as HTMLInputElement;

    this.playBtn.addEventListener('click', () => {
      const t = this.cb.getTime();
      this.cb.setPlaying(!t.playing);
    });

    // 拖动期间强制暂停，松手后保持暂停（由播放键恢复）——保证固定时间可复现
    this.slider.addEventListener('pointerdown', () => this.cb.setPlaying(false));
    this.slider.addEventListener('input', () => this.cb.setTime(Number(this.slider.value)));
    this.number.addEventListener('input', () => {
      this.cb.setPlaying(false);
      this.cb.setTime(Math.max(0, Number(this.number.value) || 0));
    });

    const resetBtn = h('button', { type: 'button', textContent: '归零' });
    resetBtn.addEventListener('click', () => {
      this.cb.setPlaying(false);
      this.cb.setTime(0);
    });

    this.element = h('div', { className: 'timeline' }, [
      this.playBtn,
      h('span', { className: 'timeline-label', textContent: '时间 (s)' }),
      this.slider,
      this.number,
      resetBtn,
    ]);
  }

  /** 每帧同步控件显示（播放时数值持续变化） */
  sync() {
    const t = this.cb.getTime();
    this.playBtn.textContent = t.playing ? '⏸ 暂停' : '▶ 播放';
    const shown = String(Math.round(t.time * 100) / 100);
    if (document.activeElement !== this.number) this.number.value = shown;
    if (document.activeElement !== this.slider) {
      this.slider.value = String(Math.min(MAX_SCRUB, t.time));
    }
  }
}
