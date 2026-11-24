import type {
  BlockStyle,
  ItemDef,
  PackManifest,
  ResolvedItem,
  ResolveStatus,
} from '../types';
import { analyzePacks, collectBlockingPacks, type Analysis } from './graph';
import { resolveItem, type Query } from './resolve';

/** 对比用的轻量结果快照 */
export interface Snapshot {
  status: ResolveStatus;
  sourcePackId: string | null;
  sourcePackName: string | null;
  block: BlockStyle | null;
  conflictPackIds: string[];
  removedByPackId: string | null;
}

export function snapshotOf(
  resolved: ResolvedItem,
  byId: Map<string, PackManifest>,
): Snapshot {
  const sourceId = resolved.winnerPackId ?? resolved.removedByPackId ?? null;
  return {
    status: resolved.status,
    sourcePackId: sourceId,
    sourcePackName: sourceId ? (byId.get(sourceId)?.name ?? sourceId) : null,
    block: resolved.winnerVariant?.block ?? null,
    conflictPackIds: resolved.conflict?.packIds ?? [],
    removedByPackId: resolved.removedByPackId ?? null,
  };
}

export type ChangeKind =
  | 'unchanged'
  | 'replaced'
  | 'added'
  | 'removed'
  | 'restored'
  | 'conflict-new'
  | 'conflict-resolved'
  | 'changed';

export interface ItemChange {
  itemId: string;
  itemName: string;
  category: string;
  kind: ChangeKind;
  kindLabel: string;
  before: Snapshot;
  after: Snapshot;
}

export interface ApplyPlan {
  selectedIds: string[];
  candidateEnabled: Record<string, boolean>;
  analysis: Analysis;
  /** 非空 = 候选配置里存在不可用包，禁止提交 */
  blockers: ReturnType<typeof collectBlockingPacks>;
  valid: boolean;
  changes: ItemChange[];
  changedCount: number;
}

const KIND_LABEL: Record<ChangeKind, string> = {
  unchanged: '不变',
  replaced: '换图',
  added: '新增',
  removed: '移除',
  restored: '恢复',
  'conflict-new': '出现冲突',
  'conflict-resolved': '冲突解除',
  changed: '变化',
};

function classify(before: Snapshot, after: Snapshot): ChangeKind {
  const sameSource = before.sourcePackId === after.sourcePackId;
  const sameStatus = before.status === after.status;
  const sameConflict =
    before.conflictPackIds.join('|') === after.conflictPackIds.join('|');
  if (sameStatus && sameSource && sameConflict) return 'unchanged';

  if (after.status === 'conflict' && before.status !== 'conflict') {
    return 'conflict-new';
  }
  if (before.status === 'conflict' && after.status !== 'conflict') {
    return 'conflict-resolved';
  }
  if (before.status === 'missing' && after.status === 'found') return 'added';
  if (after.status === 'removed' && before.status !== 'removed') return 'removed';
  if (before.status === 'removed' && after.status === 'found') return 'restored';
  if (
    before.status === 'found' &&
    after.status === 'found' &&
    !sameSource
  ) {
    return 'replaced';
  }
  return 'changed';
}

/**
 * 生成「一次应用多个包」的预览计划：
 * 不改任何外部状态 —— 候选配置只存在于返回值里，UI 确认后才允许提交。
 */
export function planBatchApply(args: {
  library: PackManifest[];
  items: ItemDef[];
  query: Query;
  currentEnabled: Record<string, boolean>;
  priorities: Record<string, number>;
  selectedIds: string[];
}): ApplyPlan {
  const { library, items, query, priorities, selectedIds } = args;

  const candidateEnabled: Record<string, boolean> = {
    ...args.currentEnabled,
  };
  for (const id of selectedIds) candidateEnabled[id] = true;

  const analysis = analyzePacks(library, candidateEnabled, priorities);
  const beforeAnalysis = analyzePacks(
    library,
    args.currentEnabled,
    priorities,
  );
  const blockers = collectBlockingPacks(analysis);
  const byManifest = new Map(library.map((p) => [p.id, p]));

  const changes: ItemChange[] = items.map((item) => {
    const beforeResolved = resolveItem(
      item.id,
      query,
      library,
      beforeAnalysis,
    );
    const afterResolved = resolveItem(item.id, query, library, analysis);
    const before = snapshotOf(beforeResolved, byManifest);
    const after = snapshotOf(afterResolved, byManifest);
    const kind = classify(before, after);
    return {
      itemId: item.id,
      itemName: item.name,
      category: item.category,
      kind,
      kindLabel: KIND_LABEL[kind],
      before,
      after,
    };
  });

  const changedCount = changes.filter((c) => c.kind !== 'unchanged').length;

  return {
    selectedIds,
    candidateEnabled,
    analysis,
    blockers,
    valid: blockers.length === 0,
    changes,
    changedCount,
  };
}

/**
 * 原子提交入口：再次校验候选状态。
 * 只要存在不可用包就拒绝并返回阻断原因，调用方必须保留原可玩状态。
 */
export function attemptBatchApply(args: {
  library: PackManifest[];
  currentEnabled: Record<string, boolean>;
  priorities: Record<string, number>;
  selectedIds: string[];
}):
  | { ok: true; enabled: Record<string, boolean> }
  | { ok: false; blockers: ReturnType<typeof collectBlockingPacks> } {
  const candidateEnabled = { ...args.currentEnabled };
  for (const id of args.selectedIds) candidateEnabled[id] = true;

  const analysis = analyzePacks(
    args.library,
    candidateEnabled,
    args.priorities,
  );
  const blockers = collectBlockingPacks(analysis);
  if (blockers.length > 0) return { ok: false, blockers };
  return { ok: true, enabled: candidateEnabled };
}
