import type { AnyEntry, Deck, RuleHit } from '../types';
import { CURRENT_POOL, FACTIONS, type PoolVersion } from '../pool';
import { validateDeck } from '../validate';
import { h, type Child } from './dom';

export function factionTag(factionId: keyof typeof FACTIONS, opts?: { soft?: boolean }) {
  const f = FACTIONS[factionId];
  return h(
    'span',
    {
      class: 'faction-tag',
      style: opts?.soft
        ? `color:${f.color};background:${f.soft}`
        : `color:#fff;background:${f.color}`,
      title: `阵营：${f.name}`,
    },
    f.name,
  );
}

export function costBadge(cost: number | null) {
  if (cost == null) return h('span', { class: 'cost-badge cost-core', title: '核心牌' }, '核');
  return h('span', { class: 'cost-badge', title: `费用 ${cost}` }, String(cost));
}

/** 所有牌的统一最小表示：方片 + 名字（方片颜色跟随阵营）。 */
export function cardTitle(cardId: string, pool: PoolVersion = CURRENT_POOL): HTMLElement {
  const c = pool.cardById.get(cardId);
  if (!c) {
    return h('span', { class: 'card-title is-missing' }, h('span', { class: 'diamond' }, '♦'), cardId);
  }
  const f = FACTIONS[c.faction];
  return h(
    'span',
    { class: 'card-title', title: c.text },
    h('span', { class: 'diamond', style: `color:${f.color}` }, '♦'),
    h('span', { class: 'card-name-text' }, c.name),
  );
}

export function printingName(cardId: string, printingId: string | undefined, pool: PoolVersion = CURRENT_POOL): string {
  const c = pool.cardById.get(cardId);
  const p = c?.printings.find((x) => x.id === printingId);
  return p ? `${p.label} · ${p.set}` : printingId ? `未知印次 ${printingId}` : '默认印次';
}

/** 一张牌的完整小条目：费用、♦名字、阵营、印次。 */
export function cardLine(opts: {
  cardId: string;
  printingId?: string;
  pool?: PoolVersion;
  count?: number;
  badges?: Child;
  extra?: Child;
  muted?: boolean;
}): HTMLElement {
  const pool = opts.pool ?? CURRENT_POOL;
  const c = pool.cardById.get(opts.cardId);
  if (!c) {
    return h(
      'div',
      { class: `card-line is-missing${opts.muted ? ' is-muted' : ''}` },
      h('span', { class: 'diamond' }, '♦'),
      h('span', { class: 'card-name-text' }, `缺失牌 ${opts.cardId}`),
      opts.count != null ? h('span', { class: 'qty' }, `×${opts.count}`) : null,
      opts.extra ?? null,
    );
  }
  return h(
    'div',
    { class: `card-line${opts.muted ? ' is-muted' : ''}` },
    costBadge(c.cost),
    cardTitle(c.id, pool),
    factionTag(c.faction, { soft: true }),
    h('span', { class: 'printing-pill', title: '印次' }, printingName(c.id, opts.printingId, pool)),
    opts.badges ?? null,
    opts.count != null ? h('span', { class: 'qty' }, `×${opts.count}`) : null,
    opts.extra ?? null,
  );
}

/** 渲染 AnyEntry（含 unresolved 占位）。 */
export function entryLine(entry: AnyEntry, pool: PoolVersion = CURRENT_POOL, extra?: Child, opts?: { hideCount?: boolean }): HTMLElement {
  const count = opts?.hideCount ? undefined : entry.count;
  if (entry.kind === 'unresolved') {
    return h(
      'div',
      { class: 'card-line is-unresolved' },
      h('span', { class: 'diamond' }, '♦'),
      h('span', { class: 'card-name-text' }, entry.exportedName),
      h('span', { class: 'tag tag-danger' }, '新版本缺失'),
      h('span', { class: 'printing-pill' }, entry.exportedPrintingLabel ?? entry.printingId ?? '印次未知'),
      h('span', { class: 'mono tiny muted' }, entry.cardId),
      count != null ? h('span', { class: 'qty' }, `×${count}`) : null,
      extra ?? null,
    );
  }
  return cardLine({ cardId: entry.cardId, printingId: entry.printingId, count, pool, extra });
}

export function hitItem(hit: RuleHit): HTMLElement {
  const cls = hit.severity === 'error' ? 'hit-error' : hit.severity === 'warning' ? 'hit-warn' : 'hit-info';
  const icon = hit.severity === 'error' ? '✕' : hit.severity === 'warning' ? '!' : 'i';
  return h('li', { class: `hit ${cls}` }, h('span', { class: 'hit-icon' }, icon), h('span', null, hit.message));
}

export function hitList(hits: RuleHit[], emptyText?: string): HTMLElement {
  if (hits.length === 0) {
    return h('div', { class: 'ok-banner' }, '✓ ', emptyText ?? '没有触发规则问题');
  }
  return h('ul', { class: 'hit-list' }, ...hits.map(hitItem));
}

export function deckValidity(deck: Deck): { legal: boolean; errorCount: number } {
  const r = validateDeck(deck);
  return { legal: r.legal, errorCount: r.errors.length };
}

/** 全局牌组选择器（带合法状态点）。 */
export function deckPicker(selectedId: string, onSelect: (id: string) => void, decks: Deck[]): HTMLElement {
  return h(
    'label',
    { class: 'deck-picker' },
    h('span', { class: 'picker-label' }, '当前牌组'),
    (() => {
      const sel = h(
        'select',
        {
          onchange: (e: Event) => onSelect((e.target as HTMLSelectElement).value),
        },
        ...decks.map((d) => {
          const v = deckValidity(d);
          return h(
            'option',
            { value: d.id, selected: d.id === selectedId },
            `${v.legal ? '✓' : '✕'} ${d.name}`,
          );
        }),
      ) as HTMLSelectElement;
      sel.value = selectedId;
      return sel;
    })(),
  );
}

export function sectionTitle(title: string, sub?: string, right?: Child): HTMLElement {
  return h(
    'div',
    { class: 'section-title-row' },
    h('div', null, h('h2', { class: 'section-title' }, title), sub ? h('p', { class: 'section-sub' }, sub) : null),
    right ? h('div', { class: 'section-right' }, right) : null,
  );
}
