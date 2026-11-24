import type { ApplyPlan, Snapshot } from '../engine/batch';
import type { AppState, ModalState } from '../state';
import { blockImage, h, type Child } from './dom';
import { missingPlaceholder, removedPlaceholder } from './bits';

function snapshotVisual(s: Snapshot): HTMLElement {
  const box = h('div', { class: `diff-thumb diff-status-${s.status}` });
  if (s.block) {
    const img = blockImage(s.block, 'thumb thumb-sm');
    if (img) box.appendChild(img);
  } else if (s.status === 'removed') {
    box.appendChild(removedPlaceholder('md'));
  } else if (s.status === 'missing') {
    box.appendChild(missingPlaceholder('md'));
  } else {
    box.appendChild(missingPlaceholder('md'));
  }
  return box;
}

function snapshotCaption(s: Snapshot): HTMLElement {
  if (s.sourcePackName) {
    return h('span', { class: 'diff-source', text: s.sourcePackName });
  }
  if (s.status === 'missing') return h('span', { class: 'diff-source diff-none', text: '缺图' });
  return h('span', { class: 'diff-source diff-none', text: '—' });
}

const KIND_CLS: Record<string, string> = {
  unchanged: 'kind-unchanged',
  replaced: 'kind-replaced',
  added: 'kind-added',
  removed: 'kind-removed',
  restored: 'kind-restored',
  'conflict-new': 'kind-conflict-new',
  'conflict-resolved': 'kind-conflict-resolved',
  changed: 'kind-changed',
};

function diffModal(state: AppState, plan: ApplyPlan, selectedIds: string[]): HTMLElement {
  const packName = (id: string) => state.library.find((p) => p.id === id)?.name ?? id;
  const changed = plan.changes.filter((c) => c.kind !== 'unchanged');
  const unchanged = plan.changes.filter((c) => c.kind === 'unchanged');
  const hasNewConflict = changed.some((c) => c.after.status === 'conflict');

  const blockerBox = plan.blockers.length
    ? h('div', { class: 'diff-blockers' }, [
        h('strong', { text: '⛔ 候选配置中存在无法使用的包，应用已被阻止' }),
        h('p', { class: 'blocker-note', text: '当前正在运行的可玩配置没有任何改动。请返回取消勾选这些包，或先补齐 / 开启它们的依赖。' }),
        ...plan.blockers.map((b) =>
          h('div', { class: 'blocker-item' }, [
            h('div', { class: 'blocker-pack', text: `${b.packName}（${b.packId}）` }),
            ...b.reasons.map((r) => h('p', { text: `· ${r}` })),
          ]),
        ),
      ])
    : null;

  const conflictNote =
    plan.valid && hasNewConflict
      ? h('div', { class: 'diff-conflict-note', text: '⚠ 应用后部分道具会处于「同级冲突」状态，可在问题中心和追踪面板查看裁决详情。' })
      : null;

  const changeRows = changed.map((c) =>
    h('div', { class: `diff-row ${KIND_CLS[c.kind] ?? ''}` }, [
      h('div', { class: 'diff-item' }, [
        h('strong', { text: c.itemName }),
        h('code', { text: c.itemId }),
      ]),
      h('div', { class: 'diff-side' }, [snapshotVisual(c.before), snapshotCaption(c.before)]),
      h('span', { class: 'diff-arrow', text: '→' }),
      h('div', { class: 'diff-side diff-after' }, [snapshotVisual(c.after), snapshotCaption(c.after)]),
      h('span', { class: `diff-kind-tag ${KIND_CLS[c.kind] ?? ''}`, text: c.kindLabel }),
    ]),
  );

  const unchangedDetails =
    unchanged.length > 0
      ? h('details', { class: 'diff-unchanged' }, [
          h('summary', { text: `${unchanged.length} 个道具不变` }),
          h('div', { class: 'unchanged-list' }, unchanged.map((c) =>
            h('span', { class: 'unchanged-chip', text: c.itemName }),
          )),
        ])
      : null;

  return shell(
    '批量替换 · 应用前对比',
    `本次将启用 ${selectedIds.length} 个包：${selectedIds.map(packName).join('、')}`,
    [
      blockerBox,
      conflictNote,
      h('div', { class: 'diff-summary' }, [
        h('span', { class: 'diff-count-hot', text: `${plan.changedCount} 个道具将变化` }),
        h('span', { class: 'diff-count-plain', text: `${plan.changes.length - plan.changedCount} 个不变` }),
      ]),
      h('div', { class: 'diff-list' }, changeRows.length ? changeRows : h('p', { class: 'diff-nochange', text: '这些包不会改变当前查询下任何道具的结果。' })),
      unchangedDetails,
    ],
    plan.valid
      ? [
          h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', dataset: { action: 'close-modal' } }),
          h('button', { type: 'button', class: 'btn btn-primary', text: `确认应用 ${selectedIds.length} 个包`, dataset: { action: 'confirm-apply' } }),
        ]
      : [
          h('button', { type: 'button', class: 'btn btn-primary', text: '返回修改选择', dataset: { action: 'close-modal' } }),
        ],
  );
}

function importReportModal(
  modal: Extract<ModalState, { type: 'import-report' }>,
): HTMLElement {
  const verification = modal.verification
    ? h('div', {
        class: `verify-box ${modal.verification.mismatchCount === 0 ? 'verify-ok' : 'verify-bad'}`,
      }, [
        h('strong', {
          text:
            modal.verification.mismatchCount === 0
              ? `✓ 复算校验一致：${modal.verification.consistent}/${modal.verification.checked} 条来源记录完全相同`
              : `⚠ ${modal.verification.consistent}/${modal.verification.checked} 条一致，${modal.verification.mismatchCount} 条不一致`,
        }),
      ])
    : null;

  return shell(
    modal.title,
    undefined,
    [
      h('div', { class: `import-report-icon ${modal.ok ? 'is-ok' : 'is-bad'}`, text: modal.ok ? '✓' : '!' }),
      ...modal.lines.map((line) => h('p', { class: 'import-line', text: line })),
      verification,
    ],
    [h('button', { type: 'button', class: 'btn btn-primary', text: '关闭', dataset: { action: 'close-modal' } })],
  );
}

function shell(
  title: string,
  sub: string | undefined,
  body: Child[],
  footerButtons: Child[],
): HTMLElement {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const panel = h('div', {
    class: 'modal-panel',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
  }, [
    h('header', { class: 'modal-head' }, [
      h('div', {}, [
        h('h2', { text: title }),
        sub ? h('p', { class: 'modal-sub', text: sub }) : null,
      ]),
      h('button', {
        type: 'button',
        class: 'modal-x',
        text: '×',
        'aria-label': '关闭',
        dataset: { action: 'close-modal' },
      }),
    ]),
    h('div', { class: 'modal-body' }, body),
    h('footer', { class: 'modal-foot' }, footerButtons),
  ]);

  // 点击遮罩空白处关闭；点击面板内部不关闭
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      backdrop.dispatchEvent(new CustomEvent('lab-close-modal', { bubbles: true }));
    }
  });

  backdrop.appendChild(panel);
  return backdrop;
}

export function renderModal(state: AppState): HTMLElement | null {
  const modal = state.modal;
  if (!modal) return null;
  if (modal.type === 'diff') return diffModal(state, modal.plan, modal.selectedIds);
  return importReportModal(modal);
}
