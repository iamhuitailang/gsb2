import type { Analysis } from '../engine/graph';
import type { AppState } from '../state';
import { h } from './dom';
import { kindChip } from './bits';

function packIssues(status: Analysis['statuses'][number]): HTMLElement | null {
  const all = [
    ...status.manifestIssues,
    ...(status.enabled ? status.runtimeIssues : []),
  ];
  if (all.length === 0) return null;
  return h('div', { class: 'pack-issues' }, all.map((issue) => {
    const cls = issue.code === 'cycle' ? 'issue-cycle' : 'issue-dep';
    const label =
      issue.code === 'cycle'
        ? '依赖成环'
        : issue.code === 'missing-dependency'
          ? '缺依赖'
          : issue.code === 'dependency-disabled'
            ? '依赖未开启'
            : '依赖不可用';
    return h('span', { class: `badge issue-badge ${cls}`, title: issue.message }, [
      h('strong', { text: label }),
      h('span', { class: 'issue-msg-inline', text: ` ${issue.depId ? `(${issue.depId})` : ''}` }),
    ]);
  }));
}

function dependencyLine(state: AppState, analysis: Analysis, status: Analysis['statuses'][number]): HTMLElement | null {
  const deps = status.pack.dependencies ?? [];
  if (deps.length === 0) return null;
  return h('div', { class: 'pack-deps' }, [
    h('span', { class: 'deps-label', text: '依赖 →' }),
    ...deps.map((d) => {
      const dep = analysis.byId.get(d);
      const exists = !!dep;
      const enabled = state.config.enabled[d] ?? false;
      const cls = !exists ? 'dep-id dep-missing' : enabled ? 'dep-id dep-on' : 'dep-id dep-off';
      const title = !exists
        ? '库中不存在'
        : enabled
          ? '依赖已开启'
          : '依赖未开启';
      return h('code', { class: cls, title, text: d });
    }),
  ]);
}

export function renderPackStack(state: AppState, analysis: Analysis): HTMLElement {
  const rows = analysis.order.map((id) => {
    const status = analysis.byId.get(id)!;
    const pack = status.pack;
    const priority = analysis.priorityOf.get(id) ?? pack.priority;
    const selected = state.config.enabled[id] ?? false;

    const classes = [
      'pack-row',
      `pack-kind-${pack.kind}`,
      selected ? 'is-enabled' : 'is-disabled',
      selected && !status.usable ? 'is-invalid' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return h('div', { class: classes, dataset: { packId: id } }, [
      h('label', { class: 'switch', title: selected ? '点击关闭该包' : '点击开启该包' }, [
        h('input', {
          type: 'checkbox',
          checked: selected,
          dataset: { action: 'toggle-pack', id },
          'aria-label': `开关 ${pack.name}`,
        }),
        h('span', { class: 'switch-track' }),
      ]),
      h('span', { class: 'pack-accent', style: `background:${pack.accent ?? '#94a3b8'}` }),
      h('div', { class: 'pack-body' }, [
        h('div', { class: 'pack-title-row' }, [
          h('span', { class: 'pack-name', text: pack.name }),
          kindChip(pack.kind),
          selected && !status.usable
            ? h('span', { class: 'badge issue-badge issue-dep', text: '已跳过' })
            : null,
        ]),
        h('code', { class: 'pack-id', text: `${pack.id} · v${pack.version}` }),
        pack.description ? h('p', { class: 'pack-desc', text: pack.description }) : null,
        dependencyLine(state, analysis, status),
        packIssues(status),
      ]),
      h('div', { class: 'prio-ctl', title: '有效优先级，越大越优先；相同数值构成同级' }, [
        h('button', {
          type: 'button',
          class: 'prio-btn',
          text: '−',
          dataset: { action: 'prio-dec', id },
          'aria-label': `降低 ${pack.name} 优先级`,
        }),
        h('span', { class: 'prio-value', text: String(priority) }),
        h('button', {
          type: 'button',
          class: 'prio-btn',
          text: '+',
          dataset: { action: 'prio-inc', id },
          'aria-label': `提高 ${pack.name} 优先级`,
        }),
      ]),
    ]);
  });

  return h('section', { class: 'panel pack-panel' }, [
    h('div', { class: 'panel-head' }, [
      h('div', {}, [
        h('h2', { text: '包堆栈 · 加载顺序' }),
        h('p', { class: 'panel-sub', text: '按优先级从高到低；同优先级即「同级」，同道具多包表态会判冲突' }),
      ]),
      h('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm',
        text: '恢复默认优先级',
        dataset: { action: 'reset-priorities' },
      }),
    ]),
    h('div', { class: 'pack-list' }, rows),
  ]);
}

export function renderBatchPanel(state: AppState, analysis: Analysis): HTMLElement {
  // 批量流程只负责「一次性启用多个包」；这里列出当前关闭的可候选替换包
  const candidates = state.library.filter(
    (p) => p.batchCandidate && !(state.config.enabled[p.id] ?? false),
  );

  const checks = candidates.map((pack) => {
    const st = analysis.byId.get(pack.id);
    const issues = [
      ...(st?.manifestIssues ?? []),
    ];
    const checked = state.batchSelection.includes(pack.id);
    return h('label', {
      class: `batch-item ${checked ? 'is-checked' : ''} ${issues.length ? 'is-broken' : ''}`,
    }, [
      h('input', {
        type: 'checkbox',
        checked,
        dataset: { action: 'toggle-batch', id: pack.id },
      }),
      h('span', { class: 'batch-name', text: pack.name }),
      h('code', { class: 'pack-id', text: pack.id }),
      issues.length
        ? h('span', {
            class: 'badge issue-badge issue-dep',
            title: issues.map((i) => i.message).join('\n'),
            text: issues[0].code === 'cycle' ? '成环 · 应用会被拦截' : '缺依赖 · 应用会被拦截',
          })
        : h('span', { class: 'badge batch-ok', text: '可用' }),
    ]);
  });

  const selectedCount = state.batchSelection.length;

  return h('section', { class: 'panel batch-panel' }, [
    h('div', { class: 'panel-head' }, [
      h('div', {}, [
        h('h2', { text: '批量应用替换包' }),
        h('p', { class: 'panel-sub', text: '勾选多套 → 先逐道具对比 → 确认后才真正启用；坏包会阻止提交并保留当前可玩状态' }),
      ]),
    ]),
    h('div', { class: 'batch-actions-row' }, [
      h('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm',
        text: '勾选全部可用包',
        dataset: { action: 'batch-select-healthy' },
      }),
      h('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm',
        text: '清空选择',
        dataset: { action: 'batch-clear' },
      }),
    ]),
    candidates.length === 0
      ? h('p', { class: 'batch-empty', text: '所有候选替换包都已启用。关闭某个包后可再次批量加入。' })
      : h('div', { class: 'batch-list' }, checks),
    h('button', {
      type: 'button',
      class: 'btn btn-primary batch-submit',
      disabled: selectedCount === 0,
      dataset: { action: 'open-diff' },
      text: selectedCount > 0 ? `对比变更并应用（${selectedCount} 个包）` : '对比变更并应用',
    }),
  ]);
}
