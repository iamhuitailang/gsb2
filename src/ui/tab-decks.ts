import type { AnyEntry, Deck, DeckEntry } from '../types';
import { CURRENT_POOL, FACTIONS, FACTION_ORDER, RULES } from '../pool';
import { store } from '../state';
import { genUid } from '../defaultDecks';
import { validateDeck } from '../validate';
import { zoneTotal } from '../deckUtils';
import { h } from './dom';
import { deckValidity, entryLine, hitList, sectionTitle } from './common';

function printingSelect(entry: DeckEntry) {
  const card = CURRENT_POOL.cardById.get(entry.cardId);
  if (!card) return null;
  return h(
    'select',
    {
      class: 'printing-select',
      title: '选择印次（不同印次共享数量上限）',
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        store.updateSelected((d) => {
          const target = [...d.main, ...d.sideboard].find((x) => x.uid === entry.uid);
          if (target && target.kind === 'entry') target.printingId = v;
        });
      },
    },
    ...card.printings.map((p) =>
      h('option', { value: p.id, selected: p.id === entry.printingId }, `${p.label} · ${p.set}${p.foil ? ' ✦闪' : ''}`),
    ),
  ) as HTMLSelectElement;
}

function countControls(entry: AnyEntry) {
  return h(
    'span',
    { class: 'count-controls' },
    h('button', {
      class: 'mini-btn',
      title: '减少一张',
      onclick: () =>
        store.updateSelected((d) => {
          const t = [...d.main, ...d.sideboard].find((x) => x.uid === entry.uid);
          if (t) t.count = Math.max(0, t.count - 1);
          if (t && t.count === 0) removeEntry(d, entry.uid);
        }),
    }, '−'),
    h('span', { class: 'count-num' }, String(entry.count)),
    h('button', {
      class: 'mini-btn',
      title: '增加一张',
      onclick: () =>
        store.updateSelected((d) => {
          const t = [...d.main, ...d.sideboard].find((x) => x.uid === entry.uid);
          if (t) t.count += 1;
        }),
    }, '+'),
  );
}

function removeEntry(d: Deck, uid: string) {
  d.main = d.main.filter((e) => e.uid !== uid);
  d.sideboard = d.sideboard.filter((e) => e.uid !== uid);
}

function entryRow(entry: AnyEntry) {
  const controls = h(
    'span',
    { class: 'row-controls' },
    entry.kind === 'entry' ? printingSelect(entry) : null,
    countControls(entry),
    h(
      'button',
      {
        class: 'mini-btn mini-danger',
        title: '删除整条',
        onclick: () =>
          store.updateSelected((d) => {
            d.main = d.main.filter((x) => x.uid !== entry.uid);
            d.sideboard = d.sideboard.filter((x) => x.uid !== entry.uid);
          }),
      },
      '删',
    ),
  );
  return h('div', { class: 'entry-row' }, entryLine(entry, CURRENT_POOL, controls, { hideCount: true }));
}

function addCardBar(zone: 'main' | 'sideboard') {
  const select = h(
    'select',
    { class: 'add-card-select' },
    h('option', { value: '' }, `＋ 选择卡牌加入${zone === 'main' ? '主牌' : '备选'}…`),
    ...FACTION_ORDER.flatMap((f) => {
      const cards = CURRENT_POOL.cards.filter((c) => c.faction === f);
      return [
        h('optgroup', { label: FACTIONS[f].name }, ...cards.map((c) => h('option', { value: c.id }, `♦ ${c.name}（上限 ${c.limit}）`))),
      ];
    }),
  ) as HTMLSelectElement;

  return h(
    'div',
    { class: 'add-card-bar' },
    select,
    h('button', {
      class: 'btn btn-small',
      onclick: () => {
        const cardId = select.value;
        if (!cardId) return;
        const card = CURRENT_POOL.cardById.get(cardId)!;
        store.updateSelected((d) => {
          const list = zone === 'main' ? d.main : d.sideboard;
          const existing = list.find((e) => e.kind === 'entry' && e.cardId === cardId && e.printingId === card.printings[0].id) as
            | DeckEntry
            | undefined;
          if (existing) existing.count += 1;
          else
            list.push({
              kind: 'entry',
              uid: genUid('add'),
              cardId,
              printingId: card.printings[0].id,
              count: 1,
            });
        });
        select.value = '';
      },
    }, '加入一张'),
  );
}

function factionDistribution(deck: Deck) {
  const counts: Record<string, number> = { crimson: 0, tide: 0, grove: 0, neutral: 0 };
  for (const e of deck.main) {
    if (e.kind !== 'entry') continue;
    const c = CURRENT_POOL.cardById.get(e.cardId);
    if (c) counts[c.faction] += e.count;
  }
  const total = zoneTotal(deck.main) || 1;
  return h(
    'div',
    { class: 'faction-dist' },
    h('div', { class: 'dist-bar' }, ...FACTION_ORDER.map((f) =>
      counts[f] > 0
        ? h('div', {
            class: 'dist-seg',
            style: `width:${(counts[f] / total) * 100}%;background:${FACTIONS[f].color}`,
            title: `${FACTIONS[f].name} ${counts[f]}`,
          })
        : null,
    )),
    h(
      'div',
      { class: 'dist-legend' },
      ...FACTION_ORDER.map((f) =>
        h('span', { class: 'legend-item' }, h('i', { style: `background:${FACTIONS[f].color}` }), `${FACTIONS[f].name} ${counts[f]}`),
      ),
    ),
  );
}

export function renderDecksTab(): HTMLElement {
  const deck = store.selectedDeck;
  const report = validateDeck(deck);
  const mainTotal = zoneTotal(deck.main);
  const sideTotal = zoneTotal(deck.sideboard);

  const list = h(
    'div',
    { class: 'deck-list' },
    ...store.decks.map((d) => {
      const v = deckValidity(d);
      return h(
        'button',
        {
          class: `deck-list-item${d.id === deck.id ? ' active' : ''}`,
          onclick: () => store.select(d.id),
        },
        h('span', { class: `valid-dot ${v.legal ? 'is-legal' : 'is-illegal'}`, title: v.legal ? '规则合法' : `${v.errorCount} 个规则错误` }),
        h('span', { class: 'deck-list-name' }, d.name),
        h('span', { class: 'deck-list-tag' }, d.tag),
      );
    }),
  );

  const editor = h(
    'div',
    { class: 'deck-editor' },
    h(
      'div',
      { class: 'deck-head card-panel' },
      h('input', {
        class: 'deck-name-input',
        value: deck.name,
        onchange: (e: Event) =>
          store.updateSelected((d) => {
            d.name = (e.target as HTMLInputElement).value || d.name;
          }),
      }),
      h('div', { class: 'deck-tag-row' }, h('span', { class: 'tag' }, deck.tag), h('span', { class: 'muted small' }, deck.id)),
      h('textarea', {
        class: 'deck-desc-input',
        rows: 2,
        onchange: (e: Event) =>
          store.updateSelected((d) => {
            d.description = (e.target as HTMLTextAreaElement).value;
          }),
      }, deck.description),
      deck.pitfall
        ? h('div', { class: 'pitfall-callout' }, h('strong', null, '故意卡住的点：'), deck.pitfall)
        : null,
      h(
        'div',
        { class: 'deck-head-actions' },
        h('button', {
          class: 'btn btn-small btn-danger-ghost',
          onclick: () => {
            if (confirm(`删除牌组「${deck.name}」？可通过「恢复全部默认牌组」找回内置牌组。`)) store.deleteDeck(deck.id);
          },
        }, '删除此牌组'),
        h('button', { class: 'btn btn-small', onclick: () => store.resetAll() }, '恢复全部默认牌组'),
      ),
    ),

    h(
      'div',
      { class: `validation-panel card-panel ${report.legal ? 'is-legal' : 'is-illegal'}` },
      h(
        'div',
        { class: 'validation-head' },
        h('span', { class: `verdict-badge ${report.legal ? 'verdict-ok' : 'verdict-bad'}` }, report.legal ? '整组合法' : `存在 ${report.errors.length} 个错误`),
        h('span', { class: 'muted small' }, '规则：主牌 40 张 · 备选 ≤10 · 同卡跨印次共享上限（主/备分别结算） · 核心 1–2 枚且阵营盟约须同时满足'),
      ),
      hitList(report.hits),
    ),

    h(
      'div',
      { class: 'deck-zones' },
      h(
        'section',
        { class: 'zone card-panel' },
        sectionTitle(`主牌（${mainTotal}/${RULES.mainSize}）`, '起手抽牌只展开主牌'),
        factionDistribution(deck),
        h('div', { class: 'entry-list' }, ...deck.main.map(entryRow)),
        addCardBar('main'),
      ),
      h(
        'section',
        { class: 'zone card-panel' },
        sectionTitle(`备选（${sideTotal}/${RULES.sideboardMax}）`, '赛前可与主牌 1:1 互换'),
        h('div', { class: 'entry-list' }, ...deck.sideboard.map(entryRow)),
        addCardBar('sideboard'),
      ),
    ),
  );

  return h('div', { class: 'tab-decks layout-sidebar' }, h('aside', { class: 'sidebar card-panel' }, h('h2', { class: 'sidebar-title' }, '本地牌组'), list), editor);
}
