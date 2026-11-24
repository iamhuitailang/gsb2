/** 最近发声日志：显示每次发声实际用了哪段样本、结束原因 */
import type { VoiceEvent } from '../types.ts';
import { midiToName } from '../audio/notes.ts';
import { layerName, zoneLabel } from '../audio/zones.ts';
import { h } from './dom.ts';

const END_REASON_TEXT: Record<VoiceEvent['endReason'], string> = {
  natural: '自然结束',
  released: '松开进尾音',
  retriggered: '同音重按抢断',
  'voice-limit': '超上限抢断',
  panic: '全部停止',
};

const MAX_ROWS = 12;

export class VoiceLogPanel {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;

  constructor() {
    this.empty = h('div', { class: 'empty-hint' }, ['尚无发声']);
    this.list = h('div', { class: 'voice-rows' });
    this.el = h('div', {}, [this.empty, this.list]);
  }

  addStart(info: {
    note: number;
    velocity: number;
    when: number;
    choice: VoiceEvent['choice'];
    looped: boolean;
  }): void {
    this.empty.remove();
    const row = h('div', { class: 'voice-row start' }, [
      h('span', { class: 'vr-note' }, [midiToName(info.note)]),
      h('span', { class: 'vr-layer' }, [layerName(info.choice.usedLayer)]),
      h('span', { class: 'vr-vel' }, [`力度 ${info.velocity}`]),
      h('span', { class: 'vr-sample' }, [info.choice.reason]),
      h('span', { class: 'vr-tag' }, [info.looped ? '持续段' : '一次性']),
    ]);
    this.list.prepend(row);
    this.trim();
  }

  addEnd(ev: VoiceEvent): void {
    const row = h('div', { class: 'voice-row end' }, [
      h('span', { class: 'vr-note' }, [midiToName(ev.note)]),
      h('span', { class: 'vr-sample' }, [
        `样本 ${zoneLabel(ev.choice.usedRoot, ev.choice.usedLayer)}`,
      ]),
      h('span', { class: 'vr-end' }, [END_REASON_TEXT[ev.endReason]]),
      h('span', { class: 'vr-dur' }, [`${(ev.endedAt - ev.startedAt).toFixed(2)}s`]),
    ]);
    this.list.prepend(row);
    this.trim();
  }

  private trim(): void {
    while (this.list.children.length > MAX_ROWS) this.list.lastElementChild?.remove();
  }
}
