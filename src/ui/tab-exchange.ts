import type { Deck, SwapPair, ZoneId } from '../types';
import { CURRENT_POOL } from '../pool';
import { PRESET_PLANS } from '../defaultDecks';
import { store } from '../state';
import { analyzePair, applyBatch, type PairAnalysis } from '../exchange';
import { h, clear } from './dom';
import { deckPicker, hitList } from './common';
import { entryLabel } from '../deckUtils';

interface DraftPair {
  id: string;
  mainUid: string;
  sideUid: string;
}

let draftDeckId: string | null = null;
let draft: DraftPair[] = [];
let appliedNote: string | null = null;
let draftSeq = 0;

function newDraft(mainUid = '', sideUid = ''): DraftPair {
  draftSeq += 1;
  return { id: `draft-${draftSeq}`, mainUid, sideUid };
}

function ensureDraft(deckId: string) {
  if (draftDeckId === deckId) return;
  draftDeckId = deckId;
  appliedNote = null;
  const preset = PRESET_PLANS.find((p) => p.deckId === deckId);
  draft = preset ? preset.pairs.map((p) => newDraft(p.mainUid, p.sideUid)) : [newDraft()];
}

function entryOptionText(deck: Deck, uid: string): string {
  const e = [...deck.main, ...deck.sideboard].find((x) => x.uid === uid);
  return e ? entryLabel(e, CURRENT_POOL) : uid;
}

function uidSelect(zone: ZoneId, value: string, onChange: (uid: string) => void) {
  const deck = store.selectedDeck;
  const entries = zone === 'main' ? deck.main : deck.sideboard;
  const sel = h(
    'select',
    {
      class: 'uid-select',
      onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value),
    },
    h('option', { value: '' }, zone === 'main' ? '选择要移出的主牌…' : '选择要换入的备选牌…'),
    ...entries.map((e) => h('option', { value: e.uid, selected: e.uid === value }, `×${e.count}  ${entryLabel(e, CURRENT_POOL)}`)),
  ) as HTMLSelectElement;
  sel.value = value;
  return sel;
}

function sideAnalysisBox(title: string, a: PairAnalysis['out'], tone: 'out' | 'in') {
  return h(
    'div',
    { class: `attr-box attr-${tone}${a.hits.length ? ' has-hit' : ''}` },
    h('div', { class: 'attr-title' }, title),
    h('div', { class: 'attr-card' }, a.title),
    a.effects.length
      ? h('ul', { class: 'effect-list' }, ...a.effects.map((x) => h('li', null, x)))
      : null,
    a.hits.length ? hitList(a.hits) : h('div', { class: 'attr-ok' }, '未直接触发违规规则'),
  );
}

function pairCard(analysis: PairAnalysis, index: number, rerender: () => void) {
  return h(
    'div',
    { class: `pair-card card-panel ${analysis.singleLegal ? 'pair-ok' : 'pair-bad'}` },
    h(
      'div',
      { class: 'pair-card-head' },
      h('span', { class: 'pair-label' }, `第 ${index + 1} 对`),
      h('span', { class: `verdict-badge ${analysis.singleLegal ? 'verdict-ok' : 'verdict-bad'}` },
        analysis.singleLegal ? '只换这一对：合法' : '只换这一对：不合法'),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'mini-btn mini-danger',
        onclick: () => {
          draft = draft.filter((d) => d.id !== analysis.pair.id);
          rerender();
        },
      }, '移除这对'),
    ),
    h('div', { class: 'attr-grid' }, sideAnalysisBox('原牌（从主牌移出）', analysis.out, 'out'), sideAnalysisBox('换入牌（从备选中进入主牌）', analysis.incoming, 'in')),
    analysis.singleLegal ? null : h('div', { class: 'pair-single-all' }, h('strong', null, '单独执行时的全部规则输出：'), hitList(analysis.singleReport.hits)),
  );
}

function presetCard(planId: string, rerender: () => void) {
  const plan = PRESET_PLANS.find((p) => p.id === planId)!;
  const deck = store.decks.find((d) => d.id === plan.deckId);
  if (!deck) return null;
  const pairAnalyses = plan.pairs.map((p) => analyzePair(deck, p, CURRENT_POOL));
  const batch = applyBatch(deck, plan.pairs, CURRENT_POOL);

  return h(
    'div',
    { class: `preset-card ${batch.legal ? 'preset-legal' : 'preset-illegal'}` },
    h('div', { class: 'preset-name' }, plan.name),
    h('p', { class: 'preset-blurb' }, plan.blurb),
    h(
      'ul',
      { class: 'preset-singles' },
      ...pairAnalyses.map((a, i) =>
        h(
          'li',
          null,
          h('span', { class: `dot ${a.singleLegal ? 'dot-ok' : 'dot-bad'}` }),
          h('span', null, `单换 ${i + 1}：${entryOptionText(deck, a.pair.mainUid)} → ${entryOptionText(deck, a.pair.sideUid)} — `),
          h('strong', { class: a.singleLegal ? 'text-ok' : 'text-bad' }, a.singleLegal ? '合法' : `不合法（${a.incoming.hits[0]?.code ?? a.out.hits[0]?.code ?? '规则错误'}）`),
        ),
      ),
    ),
    h(
      'div',
      { class: 'preset-batch' },
      '整批一起：',
      h('strong', { class: batch.legal ? 'text-ok' : 'text-bad' }, batch.legal ? '合法 ✓ 可以一次生效' : '仍不合法 ✕'),
    ),
    h(
      'div',
      { class: 'preset-actions' },
      h('button', {
        class: 'btn btn-small',
        onclick: () => {
          draftDeckId = deck.id;
          draft = plan.pairs.map((p) => newDraft(p.mainUid, p.sideUid));
          store.select(deck.id);
          rerender();
        },
      }, '载入到工作台'),
      batch.legal && batch.final
        ? h('button', {
            class: 'btn btn-small btn-primary',
            onclick: () => {
              const res = applyBatch(deck, plan.pairs, CURRENT_POOL);
              if (!res.legal || !res.final) return;
              store.replaceDeck(deck.id, res.final);
              draft = [newDraft()];
              appliedNote = `已整批应用「${plan.name}」：所有移动作为同一事务生效。`;
              rerender();
            },
          }, '直接整批应用')
        : null,
    ),
  );
}

export function createExchangeTab() {
  const el = h('div', { class: 'tab-exchange' });

  function update() {
    clear(el);
    const deck = store.selectedDeck;
    ensureDraft(deck.id);

    const validPairs: SwapPair[] = draft.filter((d) => d.mainUid && d.sideUid).map((d) => ({ id: d.id, mainUid: d.mainUid, sideUid: d.sideUid }));
    const analyses = validPairs.map((p) => analyzePair(deck, p, CURRENT_POOL));
    const batch = validPairs.length ? applyBatch(deck, validPairs, CURRENT_POOL) : null;
    const deckPlans = PRESET_PLANS.filter((p) => p.deckId === deck.id);

    const pickerRow = h('div', { class: 'tab-toolbar card-panel' }, deckPicker(deck.id, (id) => store.select(id), store.decks));

    const intro = h(
      'div',
      { class: 'explain card-panel' },
      h('strong', null, '整批交换规则：'),
      ' 一批备选互换要么全部生效，要么全部不生效。下方每一对都会单独试算（看原牌与换入牌各自触了什么规则），同时按「整批结算后的最终牌组」再校验一次。只有整批合法时，应用按钮才可点。',
    );

    const note = appliedNote ? h('div', { class: 'ok-banner' }, appliedNote) : null;

    const presets = h(
      'section',
      { class: 'card-panel' },
      h('h2', { class: 'section-title' }, '预置交换难题（含「单张不行、整批合法」）'),
      h('div', { class: 'preset-grid' }, ...PRESET_PLANS.map((p) => presetCard(p.id, update))),
      deckPlans.length === 0 ? h('p', { class: 'muted small' }, '当前牌组没有专属预置方案，可在下方自行组一批交换。') : null,
    );

    const draftRows = draft.map((d, idx) =>
      h(
        'div',
        { class: 'draft-row' },
        h('span', { class: 'pair-index' }, `${idx + 1}`),
        uidSelect('main', d.mainUid, (uid) => {
          d.mainUid = uid;
          update();
        }),
        h('span', { class: 'swap-arrow' }, '⇄'),
        uidSelect('sideboard', d.sideUid, (uid) => {
          d.sideUid = uid;
          update();
        }),
        h('button', {
          class: 'mini-btn mini-danger',
          title: '移除这一行',
          onclick: () => {
            draft = draft.filter((x) => x.id !== d.id);
            update();
          },
        }, '✕'),
      ),
    );

    const editor = h(
      'section',
      { class: 'card-panel' },
      h('h2', { class: 'section-title' }, '交换批次工作台'),
      h('div', { class: 'draft-rows' }, draftRows),
      h('button', { class: 'btn btn-small', onclick: () => { draft.push(newDraft()); update(); } }, '＋ 添加一对互换'),
    );

    const batchPanel = h(
      'section',
      { class: `card-panel batch-panel ${batch?.legal ? 'is-legal' : batch ? 'is-illegal' : ''}` },
      h('h2', { class: 'section-title' }, '整批校验与生效'),
      batch
        ? [
            batch.qtyHits.length ? hitList(batch.qtyHits) : null,
            batch.report ? hitList(batch.report.hits, '整批交换后的牌组完全合法，可以生效。') : null,
            h(
              'div',
              { class: 'batch-actions' },
              h('button', {
                class: 'btn btn-primary',
                disabled: !batch.legal,
                title: batch.legal ? '整批事务提交' : '整批存在错误，不能部分生效',
                onclick: () => {
                  if (!batch.legal || !batch.final) return;
                  store.replaceDeck(deck.id, batch.final);
                  draft = [newDraft()];
                  appliedNote = `已应用 ${validPairs.length} 对互换（整批事务）。可到「牌组校验」查看新牌组。`;
                  update();
                },
              }, batch.legal ? `整批应用 ${validPairs.length} 对交换` : '整批不合法，已阻止生效'),
              h('span', { class: 'muted small' }, batch.legal ? '所有移动作为一个整体提交。' : '不会应用其中任何一对。'),
            ),
          ]
        : h('p', { class: 'muted' }, '先在上方至少选完整的一对牌。'),
    );

    const analysis = h('section', { class: 'analysis-list' }, ...analyses.map((a, i) => pairCard(a, i, update)));

    el.appendChild(pickerRow);
    el.appendChild(intro);
    if (note) el.appendChild(note);
    el.appendChild(presets);
    el.appendChild(editor);
    el.appendChild(batchPanel);
    if (analysis.children.length) el.appendChild(h('h2', { class: 'section-title analysis-title' }, '逐对规则归因'));
    el.appendChild(analysis);
  }

  update();
  return { el, onStoreChange: update };
}
