/** 声部管理面板：发声上限、Panic 与规则说明 */
import type { SamplerEngine } from '../audio/engine.ts';
import { h } from './dom.ts';

export class VoicePolicyPanel {
  readonly el: HTMLElement;

  constructor(engine: SamplerEngine, onCountChange: () => void) {
    const slider = h('input', {
      type: 'range',
      min: '4',
      max: '24',
      step: '1',
      value: String(engine.voiceLimit),
    }) as HTMLInputElement;
    const value = h('span', {}, [`${engine.voiceLimit} 个`]);
    slider.addEventListener('input', () => {
      engine.setMaxVoices(Number(slider.value));
      value.textContent = `${slider.value} 个`;
      onCountChange();
    });

    const panic = h('button', { class: 'btn danger' }, ['全部停止 (Panic)']);
    panic.addEventListener('click', () => engine.panic());

    this.el = h('div', { class: 'policy' }, [
      h('div', { class: 'field row' }, [h('span', {}, ['发声上限']), slider, value]),
      panic,
      h('ul', { class: 'rules' }, [
        h('li', {}, ['同音重按：新音头抢断旧声部（旧声部记为 retriggered）']),
        h('li', {}, ['超过上限：抢断最旧的在响声部（记为 voice-limit）']),
        h('li', {}, ['循环声最长保持 12 秒后自动进尾音，看门狗兜底，不存在长鸣音']),
      ]),
    ]);
  }
}
