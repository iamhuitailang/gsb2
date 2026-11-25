import type { UiContext } from '../context.ts';
import { h } from '../h.ts';
import { EVENTS, MATRIX_COUNTS, BUY_MATRIX_SAMPLES, INSPECT_MATRIX_SAMPLES } from '../../data/events.ts';
import { SPEAKERS, ITEMS, categoryLabel } from '../../data/game-data.ts';
import { renderSample } from '../../core/render.ts';
import type { TriggerSample } from '../../core/types.ts';
import { partsNodes, sourceBadge, resultFlags, localeShort } from '../widgets.ts';

function speakerName(id: string, locale: string): string {
  return SPEAKERS[id]?.[locale] ?? SPEAKERS[id]?.['zh-CN'] ?? id;
}

/** 控制台覆盖角色/物品/数量，得到“批量预演”样例 */
function rehearsed(sample: TriggerSample, ctx: UiContext): TriggerSample {
  const { characterId, itemId, count } = ctx.state;
  return { ...sample, characterId, itemId, count };
}

function DialogueLineView(sample: TriggerSample, speakerId: string, ctx: UiContext) {
  const s = ctx.state;
  const r = renderSample(
    { packs: s.packs, characters: Object.fromEntries(s.characters.map((c) => [c.id, c])), items: Object.fromEntries(s.items.map((i) => [i.id, i])) },
    rehearsed(sample, ctx),
    s.locale,
  );

  return h(
    'div',
    { class: `dlg-line ${r.ok ? '' : 'dlg-line-error'}` },
    h('div', { class: 'dlg-speaker' }, speakerName(speakerId, s.locale)),
    h('div', { class: 'dlg-body' }, ...partsNodes(r.parts)),
    h(
      'div',
      { class: 'dlg-meta' },
      sourceBadge(r.source),
      resultFlags(r),
      h('span', { class: 'sample-id', title: sample.label }, sample.id),
    ),
    r.source.hops.length
      ? h('div', { class: 'dlg-hops' }, '轨迹：' + r.source.hops.join(' → '))
      : null,
  );
}

function EventCard(eventId: string, ctx: UiContext) {
  const ev = EVENTS.find((e) => e.id === eventId)!;
  return h(
    'section',
    { class: 'card event-card' },
    h('header', { class: 'card-head' }, h('h3', null, ev.title), h('p', { class: 'card-blurb' }, ev.blurb)),
    h(
      'div',
      { class: 'dlg-list' },
      ...ev.lines.map((line) => DialogueLineView(line.sample, line.speakerId, ctx)),
    ),
  );
}

function sourceDot(signature: string, via: string, label: string) {
  return h('span', { class: `src-dot src-${via}`, title: label }, localeShort(signature.split('::')[0] ?? ''));
}

function MatrixTable(
  id: string,
  title: string,
  description: string,
  samples: TriggerSample[],
  ctx: UiContext,
) {
  const s = ctx.state;
  const byKey = new Map(samples.map((x) => [`${x.itemId}:${x.count}`, x]));

  const head = h(
    'tr',
    null,
    h('th', null, '物品 \\ 数量'),
    ...MATRIX_COUNTS.map((n) => h('th', { class: 'num' }, n === 0 ? '0（零）' : n === 1 ? '1（单数）' : `${n}（复数）`)),
  );

  const rows = ITEMS.map((item) =>
    h(
      'tr',
      null,
      h('th', { scope: 'row' }, item.name[s.locale] ?? item.name['zh-CN'], h('span', { class: 'cat-tag' }, categoryLabel(item.category, s.locale))),
      ...MATRIX_COUNTS.map((n) => {
        const base = byKey.get(`${item.id}:${n}`)!;
        // 矩阵中称呼跟随顶部角色，方便一起预演 {address}
        const sample: TriggerSample = { ...base, characterId: s.characterId };
        const r = renderSample(
          {
            packs: s.packs,
            characters: Object.fromEntries(s.characters.map((c) => [c.id, c])),
            items: Object.fromEntries(s.items.map((i) => [i.id, i])),
          },
          sample,
          s.locale,
        );
        return h(
          'td',
          { class: `matrix-cell ${r.ok ? '' : 'matrix-cell-error'}` },
          h('div', { class: 'matrix-text' }, ...partsNodes(r.parts)),
          h('div', { class: 'matrix-src' }, sourceDot(r.source.signature, r.source.via, r.source.label + '\n' + r.source.hops.join('\n'))),
        );
      }),
    ),
  );

  return h(
    'section',
    { class: 'card matrix-card', id },
    h('header', { class: 'card-head' }, h('h3', null, title), h('p', { class: 'card-blurb' }, description)),
    h('div', { class: 'table-wrap' }, h('table', { class: 'matrix-table' }, h('thead', null, head), h('tbody', null, ...rows))),
  );
}

export function renderPlayTab(ctx: UiContext): HTMLElement {
  return h(
    'div',
    { class: 'tab-play' },
    h(
      'div',
      { class: 'notice' },
      '顶部控制台正在批量覆盖每条对白的角色 / 物品 / 数量；零、单数、复数可直接用数量按钮切换。单句出错会标红，但其他台词继续渲染。原始样例上下文见「质检清单」。',
    ),
    ...EVENTS.map((e) => EventCard(e.id, ctx)),
    MatrixTable(
      'matrix-buy',
      '批量预演 · 购买句矩阵',
      '行是物品类别（影响中文量词等），列是数量句式；右下角小标是该格真实资源来源。',
      BUY_MATRIX_SAMPLES,
      ctx,
    ),
    MatrixTable(
      'matrix-inspect',
      '批量预演 · 道具说明矩阵',
      '同一句 item.inspect 同时包含称呼、物品名和数量变量。',
      INSPECT_MATRIX_SAMPLES,
      ctx,
    ),
  );
}
