import type { Analysis } from '../engine/graph';
import type { AppState } from '../state';
import type { ResolvedItem } from '../types';
import { h } from './dom';

function issueCard(
  tone: 'tone-dep' | 'tone-cycle' | 'tone-conflict',
  title: string,
  count: number,
  body: HTMLElement,
): HTMLElement {
  return h('section', { class: `panel issue-card ${tone}` }, [
    h('header', { class: 'issue-head' }, [
      h('h3', { text: title }),
      h('span', { class: `count-badge ${count > 0 ? 'count-hot' : 'count-zero'}`, text: String(count) }),
    ]),
    body,
  ]);
}

function emptyLine(text: string): HTMLElement {
  return h('p', { class: 'issue-empty', text });
}

export function renderIssueCenter(
  state: AppState,
  analysis: Analysis,
  results: Map<string, ResolvedItem>,
): HTMLElement {
  /* ---- 第一栏：缺依赖 / 依赖未开启 / 依赖不可用（不含成环） ---- */
  const depRows: HTMLElement[] = [];
  for (const s of analysis.statuses) {
    const depIssues = [
      ...s.manifestIssues.filter((i) => i.code !== 'cycle'),
      ...(s.enabled ? s.runtimeIssues.filter((i) => i.code !== 'cycle') : []),
    ];
    if (depIssues.length === 0) continue;
    depRows.push(
      h('div', { class: 'issue-row', dataset: { action: 'locate-pack', id: s.pack.id } }, [
        h('div', { class: 'issue-row-title' }, [
          h('span', { class: 'issue-pack-name', text: s.pack.name }),
          h('code', { text: s.pack.id }),
          s.enabled
            ? h('span', { class: 'mini-tag mini-tag-on', text: '开启中·已跳过' })
            : h('span', { class: 'mini-tag', text: '未开启' }),
        ]),
        ...depIssues.map((i) => h('p', { class: 'issue-msg', text: `· ${i.message}` })),
      ]),
    );
  }

  /* ---- 第二栏：依赖成环 ---- */
  const cycleRows = analysis.cycles.map((c) =>
    h('div', { class: 'issue-row' }, [
      h('p', { class: 'cycle-path', text: c.path }),
      h('div', { class: 'cycle-nodes' }, c.nodes.map((n) => h('code', { text: n }))),
    ]),
  );

  /* ---- 第三栏：同级替换冲突（来自当前场景 × 语言的解析结果） ---- */
  const itemName = (id: string) => state.items.find((i) => i.id === id)?.name ?? id;
  const packName = (id: string) => state.library.find((p) => p.id === id)?.name ?? id;

  const conflictRows: HTMLElement[] = [];
  for (const r of results.values()) {
    if (r.status !== 'conflict' || !r.conflict) continue;
    conflictRows.push(
      h('div', {
        class: 'issue-row conflict-row',
        dataset: { action: 'select-item', id: r.itemId },
        title: '点击查看该道具的逐级追踪',
      }, [
        h('div', { class: 'issue-row-title' }, [
          h('span', { class: 'issue-pack-name', text: `${itemName(r.itemId)}（${r.itemId}）` }),
          h('span', { class: 'mini-tag mini-tag-conflict', text: `优先级 ${r.conflict.priority} 同级` }),
        ]),
        h('p', { class: 'issue-msg', text: `竞争包：${r.conflict.packIds.map(packName).join('、')}` }),
        h('p', { class: 'issue-msg issue-resolution', text: `裁决：${r.conflict.resolution}` }),
      ]),
    );
  }

  const depCount = depRows.length;
  const cycleCount = analysis.cycles.length;
  const conflictCount = conflictRows.length;

  return h('div', { class: 'issue-grid' }, [
    issueCard(
      'tone-dep',
      '① 缺依赖 / 依赖异常',
      depCount,
      h('div', { class: 'issue-body' }, depRows.length ? depRows : emptyLine('没有缺失依赖 ✓')),
    ),
    issueCard(
      'tone-cycle',
      '② 依赖成环',
      cycleCount,
      h('div', { class: 'issue-body' }, cycleRows.length ? cycleRows : emptyLine('没有循环依赖 ✓')),
    ),
    issueCard(
      'tone-conflict',
      '③ 同级替换冲突（当前查询）',
      conflictCount,
      h('div', { class: 'issue-body' }, conflictRows.length ? conflictRows : emptyLine('当前场景 / 语言下没有同级冲突 ✓')),
    ),
  ]);
}
