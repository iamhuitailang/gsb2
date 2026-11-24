/** 样本状态面板：按键区列出可用/故障样本 */
import type { LoadResult } from '../types.ts';
import { midiToName } from '../audio/notes.ts';
import { layerName } from '../audio/zones.ts';
import { h } from './dom.ts';

export class SampleStatusPanel {
  readonly el: HTMLElement;

  constructor(load: LoadResult) {
    const rows: HTMLElement[] = [];
    const roots = [...new Set(load.manifest.samples.map((s) => s.root))].sort((a, b) => a - b);
    const okKey = new Set(load.samples.map((s) => `${s.root}-${s.layer}`));
    const failByKey = new Map(load.failures.map((f) => [`${f.root}-${f.layer}`, f]));

    for (const root of roots) {
      for (const layer of ['soft', 'hard'] as const) {
        const key = `${root}-${layer}`;
        const fail = failByKey.get(key);
        if (okKey.has(key)) {
          const sample = load.samples.find((s) => s.root === root && s.layer === layer)!;
          rows.push(
            h('div', { class: 'status-row ok' }, [
              h('span', { class: 'dot' }),
              h('span', { class: 'zone' }, [`${midiToName(root)} · ${layerName(layer)}`]),
              h('span', { class: 'meta' }, [sample.loopLength > 0 ? '持续段' : '一次性']),
            ]),
          );
        } else if (fail) {
          const kindText = fail.kind === 'missing' ? '文件缺失' : '解码失败（文件损坏）';
          rows.push(
            h('div', { class: 'status-row bad', title: `${fail.file}：${fail.message}` }, [
              h('span', { class: 'dot' }),
              h('span', { class: 'zone' }, [`${midiToName(root)} · ${layerName(layer)}`]),
              h('span', { class: 'meta' }, [kindText]),
            ]),
          );
        }
      }
    }

    this.el = h('div', { class: 'sample-status-list' }, rows);
  }
}
