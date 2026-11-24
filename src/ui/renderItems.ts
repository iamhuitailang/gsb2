import type { AppState } from '../state';
import type {
  PackOutcome,
  ResolvedItem,
  RungState,
} from '../types';
import { blockImage, h } from './dom';
import {
  missingPlaceholder,
  removedPlaceholder,
  sourceChip,
  statusBadge,
} from './bits';

/* ------------------------------ 道具卡片 ------------------------------ */

function cardVisual(r: ResolvedItem, winnerName?: string): HTMLElement {
  const wrap = h('div', { class: 'card-visual' });

  if (r.winnerVariant) {
    const img = blockImage(r.winnerVariant.block, 'thumb thumb-card');
    if (img) wrap.appendChild(img);
  } else if (r.status === 'removed') {
    wrap.appendChild(removedPlaceholder('lg', winnerName));
  } else if (r.status === 'conflict' && r.removedByPackId) {
    wrap.appendChild(removedPlaceholder('lg', winnerName));
  } else {
    wrap.appendChild(missingPlaceholder('lg'));
  }

  if (r.status === 'conflict') {
    wrap.appendChild(h('span', { class: 'corner-badge corner-conflict', text: '冲突' }));
  } else if (r.status === 'removed') {
    wrap.appendChild(h('span', { class: 'corner-badge corner-removed', text: '移除' }));
  } else if (r.status === 'missing') {
    wrap.appendChild(h('span', { class: 'corner-badge corner-missing', text: '缺图' }));
  }
  return wrap;
}

export function renderItemGrid(
  state: AppState,
  results: Map<string, ResolvedItem>,
  packNameById: Map<string, string>,
): HTMLElement {
  const cards = state.items.map((item) => {
    const r = results.get(item.id)!;
    const selected = state.config.selectedItemId === item.id;
    const winnerName =
      (r.winnerPackId ? packNameById.get(r.winnerPackId) : undefined) ??
      (r.removedByPackId ? packNameById.get(r.removedByPackId) : undefined);

    let sourceLine: HTMLElement;
    if (r.winnerPackId) {
      sourceLine = h('div', { class: 'card-source' }, [
        sourceChip(winnerName ?? r.winnerPackId, r.winnerPackId),
      ]);
    } else if (r.removedByPackId) {
      sourceLine = h('div', { class: 'card-source' }, [
        h('span', { class: 'source-chip source-removed' }, [
          h('span', { class: 'source-dot' }),
          h('span', { text: winnerName ?? r.removedByPackId }),
          h('code', { text: r.removedByPackId }),
        ]),
      ]);
    } else {
      sourceLine = h('p', { class: 'card-no-source', text: '所有可用包均未提供 → 缺图' });
    }

    const conflictLine = r.conflict
      ? h('p', {
          class: 'card-conflict-line',
          text: `${r.conflict.packIds.length} 个同级包竞争 · 当前按规则由 ${packNameById.get(r.conflict.chosenPackId) ?? r.conflict.chosenPackId} 临时生效`,
        })
      : null;

    return h('article', {
      class: `item-card card-${r.status} ${selected ? 'is-selected' : ''}`,
      dataset: { action: 'select-item', id: item.id },
      tabindex: '0',
      role: 'button',
      'aria-label': `查看 ${item.name} 的解析过程`,
    }, [
      cardVisual(r, winnerName),
      h('div', { class: 'card-body' }, [
        h('div', { class: 'card-title-row' }, [
          h('h3', { text: item.name }),
          statusBadge(r.status),
        ]),
        h('code', { class: 'item-id', text: `${item.id} · ${item.category}` }),
        sourceLine,
        conflictLine,
      ]),
      h('div', { class: 'card-foot', text: selected ? '正在查看逐级解析 ▴' : '点击查看逐级解析 ▾' }),
    ]);
  });

  return h('section', { class: 'panel grid-panel' }, [
    h('div', { class: 'panel-head' }, [
      h('div', {}, [
        h('h2', { text: '道具实际图片' }),
        h('p', { class: 'panel-sub', text: '色块即演示资源；卡片标识最终状态，点击任意卡片查看每一级被选 / 被跳过的原因' }),
      ]),
    ]),
    h('div', { class: 'item-grid' }, cards),
  ]);
}

/* ------------------------------ 追踪面板 ------------------------------ */

const OUTCOME_META: Record<PackOutcome, { label: string; cls: string }> = {
  won: { label: '✓ 最终采用', cls: 'out-won' },
  removed: { label: '⊘ 移除生效', cls: 'out-removed' },
  'tie-winner': { label: '⚖ 冲突胜出', cls: 'out-tie-winner' },
  'tie-loser': { label: '冲突落选', cls: 'out-tie-loser' },
  overridden: { label: '↓ 被高优先级覆盖', cls: 'out-overridden' },
  missed: { label: '○ 各级均未命中', cls: 'out-missed' },
  'skipped-disabled': { label: '开关关闭 · 跳过', cls: 'out-disabled' },
  'skipped-unusable': { label: '⚠ 包不可用 · 跳过', cls: 'out-invalid' },
};

const RUNG_MARK: Record<RungState, { mark: string; cls: string }> = {
  miss: { mark: '○', cls: 'rung-miss' },
  'hit-selected': { mark: '✓', cls: 'rung-hit-selected' },
  'hit-tie-loser': { mark: '⚖', cls: 'rung-tie-loser' },
  'hit-overridden': { mark: '↓', cls: 'rung-overridden' },
  'removal-selected': { mark: '⊘', cls: 'rung-removal-selected' },
  'removal-tie-loser': { mark: '⊘', cls: 'rung-tie-loser' },
  'removal-overridden': { mark: '⊘', cls: 'rung-overridden' },
  'not-reached': { mark: '…', cls: 'rung-not-reached' },
};

function rungRow(rung: ResolvedItem['trace'][number]['rungs'][number]): HTMLElement {
  const meta = RUNG_MARK[rung.state];
  const thumb = rung.variant ? blockImage(rung.variant.block, 'thumb thumb-rung') : null;
  return h('li', { class: `rung-row ${meta.cls}` }, [
    h('span', { class: 'rung-mark', text: meta.mark }),
    h('div', { class: 'rung-main' }, [
      h('div', { class: 'rung-label-row' }, [
        h('span', { class: 'rung-index', text: `第 ${rung.index + 1} 级` }),
        h('span', { class: 'rung-label', text: rung.label }),
      ]),
      h('p', { class: 'rung-reason', text: rung.reason }),
    ]),
    thumb ? h('div', { class: 'rung-thumb' }, [thumb]) : null,
  ]);
}

export function renderTracePanel(
  state: AppState,
  result: ResolvedItem | undefined,
): HTMLElement {
  const item = state.items.find((i) => i.id === state.config.selectedItemId);
  if (!result || !item) {
    return h('section', { class: 'panel trace-panel' }, [
      h('p', { class: 'trace-empty', text: '点击上方任意道具查看解析过程。' }),
    ]);
  }

  const winnerPack = result.winnerPackId ?? result.removedByPackId;
  const winnerName = winnerPack
    ? (state.library.find((p) => p.id === winnerPack)?.name ?? winnerPack)
    : null;

  const banner =
    result.status === 'conflict' && result.conflict
      ? h('div', { class: 'trace-banner banner-conflict' }, [
          h('strong', { text: `同级替换冲突（优先级 ${result.conflict.priority}）` }),
          h('span', { text: result.conflict.resolution }),
        ])
      : result.status === 'removed'
        ? h('div', { class: 'trace-banner banner-removed' }, [
            h('strong', { text: `资源被「${winnerName}」显式移除` }),
            h('span', { text: result.removalRule?.reason ?? 'manifest.removals 命中；关闭该包即可看到原资源回来' }),
          ])
        : result.status === 'missing'
          ? h('div', { class: 'trace-banner banner-missing' }, [
              h('strong', { text: '逐级回退结束，没有任何可用资源' }),
              h('span', { text: '这是普通缺图，与显式移除（REMOVED）是两种不同状态' }),
            ])
          : h('div', { class: 'trace-banner banner-found' }, [
              h('strong', { text: `最终图源：${winnerName}` }),
              h('span', { text: result.winnerRungLabel ?? '' }),
            ]);

  const packBlocks = result.trace.map((pt) => {
    const meta = OUTCOME_META[pt.outcome];
    const defaultOpen =
      state.expandAllTraces ||
      pt.outcome === 'won' ||
      pt.outcome === 'removed' ||
      pt.outcome === 'tie-winner' ||
      pt.outcome === 'tie-loser' ||
      pt.outcome === 'overridden' ||
      pt.outcome === 'skipped-unusable';

    const body: HTMLElement[] = [];

    if (pt.skipIssues && pt.skipIssues.length > 0) {
      body.push(
        h('ul', { class: 'skip-issues' }, pt.skipIssues.map((msg) =>
          h('li', { text: `⚠ ${msg}` }),
        )),
      );
    }

    if (pt.rungs.length > 0) {
      body.push(h('ol', { class: 'rung-list' }, pt.rungs.map(rungRow)));
    }

    body.push(h('p', { class: `pack-outcome-reason ${meta.cls}`, text: pt.outcomeReason }));

    return h('details', {
      class: `trace-pack ${meta.cls}`,
      ...(defaultOpen ? { open: true } : {}),
      dataset: { packId: pt.packId },
    }, [
      h('summary', { class: 'trace-pack-summary' }, [
        h('span', { class: `outcome-pill ${meta.cls}`, text: meta.label }),
        h('span', { class: 'trace-pack-name', text: pt.packName }),
        h('code', { class: 'pack-id', text: pt.packId }),
        h('span', { class: 'trace-prio', text: `P${pt.priority}` }),
      ]),
      h('div', { class: 'trace-pack-body' }, body),
    ]);
  });

  return h('section', { class: 'panel trace-panel' }, [
    h('div', { class: 'panel-head trace-head' }, [
      h('div', {}, [
        h('h2', { text: `解析追踪 · ${item.name}` }),
        h('p', { class: 'panel-sub', text: `${item.id} · 查询 ${state.config.query.scene} / ${state.config.query.language} · 每个包内最多 6 个回退层级` }),
      ]),
      h('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm',
        text: state.expandAllTraces ? '收起次要包' : '展开全部层级',
        dataset: { action: 'toggle-expand-all' },
      }),
    ]),
    banner,
    h('div', { class: 'trace-pack-list' }, packBlocks),
  ]);
}
