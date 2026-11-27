import type { CardInstance, EligibilityStatus } from '../types';
import { CURRENT_POOL, FACTIONS } from '../pool';
import { h, type Child } from './dom';
import { costBadge } from './common';

export interface TileOpts {
  status?: EligibilityStatus;
  mark?: 'out' | 'drawn' | 'kept';
  selectable?: boolean;
  selected?: boolean;
  onToggle?: (iid: number, selected: boolean) => void;
  overlay?: Child;
}

export function handTile(inst: CardInstance, opts: TileOpts = {}): HTMLElement {
  const card = CURRENT_POOL.cardById.get(inst.cardId);
  const faction = card ? FACTIONS[card.faction] : undefined;
  const printing = card?.printings.find((p) => p.id === inst.printingId);

  const classes = ['hand-tile'];
  if (opts.mark === 'out') classes.push('tile-out');
  if (opts.mark === 'drawn') classes.push('tile-drawn');
  if (opts.selected) classes.push('tile-selected');
  if (opts.status) classes.push(opts.status.enabled ? 'tile-eligible' : 'tile-ineligible');

  const checkbox =
    opts.selectable && card
      ? (h('input', {
          type: 'checkbox',
          class: 'tile-check',
          checked: !!opts.selected,
          onchange: (e: Event) => opts.onToggle?.(inst.iid, (e.target as HTMLInputElement).checked),
        }) as HTMLInputElement)
      : null;

  const eligBadge = opts.status
    ? h(
        'div',
        { class: `elig-badge ${opts.status.enabled ? 'elig-ok' : 'elig-no'}`, title: opts.status.reason },
        opts.status.enabled ? '资格成立' : '暂无资格',
      )
    : null;

  return h(
    'label',
    {
      class: classes.join(' '),
      style: faction ? `--faction:${faction.color};--faction-soft:${faction.soft}` : undefined,
    },
    checkbox,
    h('div', { class: 'tile-cost' }, card ? costBadge(card.cost) : '?'),
    h('div', { class: 'tile-diamond', style: faction ? `color:${faction.color}` : '' }, '♦'),
    h('div', { class: 'tile-name' }, card?.name ?? inst.cardId),
    h('div', { class: 'tile-meta' }, faction?.name ?? '?', ' · ', card?.type === 'core' ? '核心' : printing?.label ?? inst.printingId),
    card?.text ? h('div', { class: 'tile-text' }, card.text) : null,
    eligBadge,
    opts.status ? h('div', { class: 'elig-reason' }, opts.status.reason) : null,
    opts.mark === 'out' ? h('div', { class: 'tile-stamp stamp-out' }, '已换走') : null,
    opts.mark === 'drawn' ? h('div', { class: 'tile-stamp stamp-drawn' }, '换入') : null,
    opts.overlay ?? null,
  );
}

export function handTiles(
  cards: CardInstance[],
  optsFor?: (inst: CardInstance) => TileOpts,
): HTMLElement {
  return h('div', { class: 'hand-row' }, ...cards.map((c) => handTile(c, optsFor?.(c))));
}
