import type { AppState } from '../state';
import type { ResolvedItem } from '../types';
import { h } from './dom';
import { STATUS_META } from './bits';

export function renderProvenanceTable(
  state: AppState,
  results: Map<string, ResolvedItem>,
): HTMLElement {
  const packName = (id?: string) =>
    id ? (state.library.find((p) => p.id === id)?.name ?? id) : '—';

  const head = h('thead', {}, [
    h('tr', {}, [
      h('th', { text: '道具' }),
      h('th', { text: '状态' }),
      h('th', { text: '来源包 / 移除包' }),
      h('th', { text: '命中键 scene / lang' }),
      h('th', { text: '同级冲突方' }),
    ]),
  ]);

  const rows = state.items.map((item) => {
    const r = results.get(item.id)!;
    const meta = STATUS_META[r.status];
    const sourceId = r.winnerPackId ?? r.removedByPackId;
    const keyText = r.winnerVariant
      ? `${r.winnerVariant.scene} / ${r.winnerVariant.lang}`
      : '—';

    return h('tr', {
      class: `prov-row prov-${r.status}`,
      dataset: { action: 'select-item', id: item.id },
      title: '点击查看该道具追踪',
    }, [
      h('td', {}, [
        h('div', { class: 'prov-item' }, [
          h('span', { class: 'prov-item-name', text: item.name }),
          h('code', { text: item.id }),
        ]),
      ]),
      h('td', {}, [h('span', { class: `badge status-badge ${meta.cls}`, text: meta.label })]),
      h('td', {}, sourceId
        ? h('span', { class: 'prov-source' }, [
            h('span', { text: packName(sourceId) }),
            h('code', { text: sourceId }),
          ])
        : h('span', { class: 'prov-dash', text: '—' })),
      h('td', {}, [h('code', { text: keyText })]),
      h('td', {}, r.conflict
        ? h('span', { class: 'prov-conflict', text: r.conflict.packIds.join(', ') })
        : h('span', { class: 'prov-dash', text: '—' })),
    ]);
  });

  return h('section', { class: 'panel provenance-panel' }, [
    h('div', { class: 'panel-head' }, [
      h('div', {}, [
        h('h2', { text: '资源来源清单（当前场景 × 语言）' }),
        h('p', { class: 'panel-sub', text: '导出的 JSON / CSV 还包含全部场景 × 全部语言的逐行来源，导入 JSON 时会逐行复算校验' }),
      ]),
    ]),
    h('div', { class: 'table-wrap' }, [
      h('table', { class: 'prov-table' }, [head, h('tbody', {}, rows)]),
    ]),
  ]);
}
