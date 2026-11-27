import type { Deck, DrawTrace } from '../types';
import { CURRENT_POOL } from '../pool';
import { eligibilityInHand, evaluateGoal } from '../opening';
import { h, openModal } from './dom';
import { handTile } from './hand';

function checksBlock(trace: DrawTrace, which: 'first' | 'final', deck: Deck) {
  const checks = which === 'first' ? trace.firstChecks : trace.finalChecks;
  const pass = which === 'first' ? trace.firstPass : trace.finalPass;
  return h(
    'div',
    { class: `trace-checks ${pass ? 'is-ok' : 'is-no'}` },
    h('div', { class: 'trace-checks-head' },
      h('strong', null, which === 'first' ? '初始起手判定' : '调度后判定'),
      h('span', { class: `verdict-badge ${pass ? 'verdict-ok' : 'verdict-bad'}` }, pass ? '满足' : '不满足')),
    h('ul', { class: 'goal-checks' },
      ...checks.map((c) =>
        h('li', { class: c.pass ? 'check-ok' : 'check-no' },
          h('span', null, c.pass ? '✓' : '✕'),
          h('span', null, c.label),
          h('span', { class: 'muted small' }, c.detail)))),
    which === 'first' ? h('div', { class: 'muted small' }, `目标：${deck.goal.label}`) : null,
  );
}

function handWithEligibility(trace: DrawTrace, which: 'initial' | 'final') {
  const hand = which === 'initial' ? trace.initial : trace.finalHand;
  const eligMap = new Map(eligibilityInHand(hand, CURRENT_POOL).map((e) => [e.cardId, e]));
  const drawnIds = new Set(trace.drawn.map((c) => c.iid));
  return h(
    'div',
    { class: 'trace-hand-block' },
    h('div', { class: 'trace-hand-label' }, which === 'initial' ? '当时的初始起手（5 张）' : '换手后的最终起手'),
    h('div', { class: 'hand-row' },
      ...hand.map((inst) =>
        handTile(inst, {
          status: eligMap.get(inst.cardId),
          mark: which === 'final' && drawnIds.has(inst.iid) ? 'drawn' : undefined,
        }))),
  );
}

/** 打开一个失败样本浏览器：可在失败种子之间上下切换。 */
export function openTraceBrowser(deck: Deck, traces: DrawTrace[], startIndex = 0, title?: string) {
  let idx = Math.max(0, Math.min(startIndex, traces.length - 1));

  const content = h('div', { class: 'trace-browser' });

  function renderContent() {
    content.replaceChildren();
    if (traces.length === 0) {
      content.appendChild(h('p', { class: 'muted' }, '没有可查看的样本。'));
      return;
    }
    const trace = traces[idx];

    const seedSelect = h(
      'select',
      {
        class: 'seed-pick-select',
        onchange: (e: Event) => {
          idx = (e.target as HTMLSelectElement).selectedIndex;
          renderContent();
        },
      },
      ...traces.map((t, i) => h('option', { selected: i === idx }, `种子 #${t.seedNum}（第 ${t.seedKey} 批）`)),
    ) as HTMLSelectElement;
    seedSelect.selectedIndex = idx;

    const head = h(
      'div',
      { class: 'trace-browser-head' },
      h('button', { class: 'btn btn-small', disabled: idx === 0, onclick: () => { idx -= 1; renderContent(); } }, '← 上一个失败'),
      seedSelect,
      h('button', { class: 'btn btn-small', disabled: idx >= traces.length - 1, onclick: () => { idx += 1; renderContent(); } }, '下一个失败 →'),
      h('span', { class: 'muted small' }, `${idx + 1} / ${traces.length}`),
    );

    const mullBlock = trace.mulliganed.length
      ? h('div', { class: 'trace-mull' },
          h('div', { class: 'trace-hand-label' }, `按「${trace.policy === 'all' ? '全部换走' : '智能留牌'}」策略换走 ${trace.mulliganed.length} 张`),
          h('div', { class: 'hand-row hand-row-small' }, ...trace.mulliganed.map((c) => handTile(c, { mark: 'out' }))))
      : h('p', { class: 'muted small' }, trace.policy === 'none' ? '策略为不换手。' : '初始起手已达标，没有换手。');

    content.appendChild(head);
    content.appendChild(h('div', { class: 'trace-seed-line mono' }, `seed = ${trace.seedNum}（同一数字种子对所有牌组产生相同的随机序列起点）`));
    content.appendChild(handWithEligibility(trace, 'initial'));
    content.appendChild(checksBlock(trace, 'first', deck));
    content.appendChild(mullBlock);
    if (trace.mulliganed.length) {
      content.appendChild(handWithEligibility(trace, 'final'));
      content.appendChild(checksBlock(trace, 'final', deck));
    }
  }

  renderContent();
  openModal(title ?? `失败样本 · ${deck.name}`, content, { wide: true });
}
