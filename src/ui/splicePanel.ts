/** 循环接头试听面板：调整交叉淡化时长并即时试听 */
import type { LoadedSample } from '../types.ts';
import type { SamplerEngine } from '../audio/engine.ts';
import { midiToName } from '../audio/notes.ts';
import { layerName } from '../audio/zones.ts';
import { h } from './dom.ts';

export class SplicePanel {
  readonly el: HTMLElement;
  private readonly engine: SamplerEngine;
  private readonly valueLabel: HTMLElement;
  private current: LoadedSample | null = null;

  constructor(engine: SamplerEngine, loopSamples: LoadedSample[]) {
    this.engine = engine;
    this.el = h('div', { class: 'splice' });

    if (loopSamples.length === 0) {
      this.el.append(h('p', { class: 'empty-hint' }, ['当前没有带持续段的样本']));
      this.valueLabel = h('span');
      return;
    }

    const select = h('select', {}) as HTMLSelectElement;
    for (const s of loopSamples) {
      const opt = h('option', { value: `${s.root}-${s.layer}` }, [
        `${midiToName(s.root)} · ${layerName(s.layer)}`,
      ]) as HTMLOptionElement;
      select.append(opt);
    }
    this.current = loopSamples[0];

    const slider = h('input', {
      type: 'range',
      min: '0',
      max: '80',
      step: '1',
      value: String(engine.getCrossfade()),
    }) as HTMLInputElement;
    this.valueLabel = h('span', { class: 'xf-value' }, [`${slider.value} ms`]);

    const previewRaw = h('button', { class: 'btn' }, ['试听原始接头（0ms）']);
    const previewNow = h('button', { class: 'btn primary' }, ['试听当前设置']);

    select.addEventListener('change', () => {
      this.current = loopSamples.find(
        (s) => `${s.root}-${s.layer}` === select.value,
      ) ?? null;
    });
    slider.addEventListener('input', () => {
      this.valueLabel.textContent = `${slider.value} ms`;
      engine.setCrossfade(Number(slider.value));
      this.engine.previewSplice(this.current!, Number(slider.value));
    });
    previewRaw.addEventListener('click', () => {
      if (this.current) this.engine.previewSplice(this.current, 0);
    });
    previewNow.addEventListener('click', () => {
      if (this.current) this.engine.previewSplice(this.current, Number(slider.value));
    });

    this.el.append(
      h('label', { class: 'field' }, [select]),
      h('div', { class: 'field row' }, [h('span', {}, ['交叉淡化']), slider, this.valueLabel]),
      h('p', { class: 'hint' }, [
        '样本循环点故意与基频周期错位：0ms 时接头处有可闻咔哒声，调大后咔哒声被渐变摊平。',
      ]),
      h('div', { class: 'btn-row' }, [previewRaw, previewNow]),
    );
  }
}
