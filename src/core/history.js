/**
 * 撤销 / 重做。
 *
 * 采用整工程快照。cel 缓冲区按不可变方式使用（绘制时克隆再替换），
 * 因此相邻快照共享未改动的像素内存；每个条目只记录“新增”的像素开销。
 *
 * 每条历史同时记录操作前后两次 {frameId, layerId} 选择：
 *   - 撤销时恢复 selectionBefore
 *   - 重做时恢复 selectionAfter
 * 所以切换帧之后撤销，会先回到操作发生的那一帧，绝不会把改动落到当前帧。
 *
 * 连续绘画合并：同一帧/图层/工具在 COALESCE_MS 内的连续提交视为一步。
 */
import {
  estimateSnapshotCost,
  restoreProject,
  snapshotProject,
} from './project.js';

export const COALESCE_MS = 600;
export const MAX_HISTORY_BYTES = 96 * 1024 * 1024;

export function sameProject(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.width !== b.width ||
    a.height !== b.height ||
    a.name !== b.name ||
    a.loop !== b.loop
  ) {
    return false;
  }
  if (a.palette.length !== b.palette.length) return false;
  for (let i = 0; i < a.palette.length; i += 1) {
    if (a.palette[i].id !== b.palette[i].id || a.palette[i].hex !== b.palette[i].hex) {
      return false;
    }
  }
  if (a.layers.length !== b.layers.length) return false;
  for (let i = 0; i < a.layers.length; i += 1) {
    const x = a.layers[i];
    const y = b.layers[i];
    if (x.id !== y.id || x.name !== y.name || x.visible !== y.visible || x.locked !== y.locked) {
      return false;
    }
  }
  if (a.frames.length !== b.frames.length) return false;
  for (let i = 0; i < a.frames.length; i += 1) {
    const x = a.frames[i];
    const y = b.frames[i];
    if (x.id !== y.id || x.duration !== y.duration) return false;
    const ids = Object.keys(x.cels);
    if (ids.length !== Object.keys(y.cels).length) return false;
    for (const id of ids) {
      if (x.cels[id] !== y.cels[id]) return false;
    }
  }
  return true;
}

function normalizeSelection(selection) {
  if (!selection) return null;
  return { frameId: selection.frameId ?? null, layerId: selection.layerId ?? null };
}

export class History {
  constructor(project, { limit = 80, maxBytes = MAX_HISTORY_BYTES } = {}) {
    this.project = project;
    this.limit = limit;
    this.maxBytes = maxBytes;
    this.past = [];
    this.future = [];
    this.bytes = 0;
    this.pending = null;
    this.currentSelection = null;
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.listeners) fn(this);
  }

  get canUndo() {
    return this.past.length > 0 || this.pending != null;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  get undoLabel() {
    return this.past.length ? this.past[this.past.length - 1].label : null;
  }

  get redoLabel() {
    return this.future.length ? this.future[this.future.length - 1].label : null;
  }

  get depth() {
    return this.past.length;
  }

  /** 工程被外部整体替换后重置，例如新建/导入。 */
  reset(project) {
    this.project = project;
    this.past = [];
    this.future = [];
    this.bytes = 0;
    this.pending = null;
    this.currentSelection = null;
    this.#emit();
  }

  /**
   * 开始一次可合并的操作。返回 false 表示已有一个同 key 的进行中事务
   * （调用方继续往同一事务里写即可）。
   */
  begin(label, selection, key = null) {
    if (this.pending) {
      if (key != null && this.pending.key === key) return false;
      this.commit();
    }
    // 撤销后开始的新操作会开一条新分支，不能与撤销前的旧条目合并。
    const branched = this.future.length > 0;
    this.future = [];
    this.pending = {
      snapshot: snapshotProject(this.project),
      label,
      selectionBefore: normalizeSelection(selection),
      key,
      branched,
      startedAt: Date.now(),
    };
    this.#emit();
    return true;
  }

  /** 结束进行中的事务；若工程实际没有变化则丢弃。 */
  commit() {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return false;
    if (sameProject(pending.snapshot, this.project)) return false;
    const now = Date.now();
    const selectionAfter = normalizeSelection(this.currentSelection);
    const top = this.past[this.past.length - 1];
    const canMerge =
      top &&
      pending.key != null &&
      top.key === pending.key &&
      !pending.branched &&
      now - top.committedAt <= COALESCE_MS;
    if (canMerge) {
      // 保留更早的快照，只刷新时间戳与“操作后选择”。
      top.committedAt = now;
      top.selectionAfter = selectionAfter;
      top.label = pending.label;
      this.#emit();
      return true;
    }
    const cost = estimateSnapshotCost(pending.snapshot, this.project);
    this.past.push({
      snapshot: pending.snapshot,
      label: pending.label,
      selectionBefore: pending.selectionBefore,
      selectionAfter,
      key: pending.key,
      committedAt: now,
      cost,
    });
    this.bytes += cost;
    this.#trim();
    this.#emit();
    return true;
  }

  /** 放弃进行中的事务（例如笔划没有落下任何像素）。 */
  cancel() {
    this.pending = null;
    this.#emit();
  }

  #trim() {
    while (this.past.length > this.limit || (this.bytes > this.maxBytes && this.past.length > 1)) {
      const dropped = this.past.shift();
      this.bytes -= dropped.cost;
    }
    if (this.bytes < 0) this.bytes = 0;
  }

  /**
   * 撤销。若存在未提交的事务，先回滚它（尚未落盘的改动直接丢弃）。
   * 返回 { label, selection, frameId, layerId } 或 null。
   */
  undo() {
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      restoreProject(this.project, pending.snapshot);
      this.#emit();
      return {
        label: pending.label,
        selection: pending.selectionBefore,
        frameId: pending.selectionBefore?.frameId ?? null,
        layerId: pending.selectionBefore?.layerId ?? null,
      };
    }
    const entry = this.past.pop();
    if (!entry) return null;
    const current = snapshotProject(this.project);
    const cost = estimateSnapshotCost(current, entry.snapshot);
    this.future.push({
      snapshot: current,
      label: entry.label,
      selectionBefore: entry.selectionBefore,
      selectionAfter: entry.selectionAfter,
      committedAt: Date.now(),
      cost,
    });
    this.bytes -= entry.cost;
    if (this.bytes < 0) this.bytes = 0;
    restoreProject(this.project, entry.snapshot);
    this.#emit();
    return {
      label: entry.label,
      selection: entry.selectionBefore,
      frameId: entry.selectionBefore?.frameId ?? null,
      layerId: entry.selectionBefore?.layerId ?? null,
    };
  }

  redo() {
    if (this.pending) this.commit();
    const entry = this.future.pop();
    if (!entry) return null;
    const current = snapshotProject(this.project);
    const cost = estimateSnapshotCost(current, entry.snapshot);
    this.past.push({
      snapshot: current,
      label: entry.label,
      selectionBefore: entry.selectionBefore,
      selectionAfter: entry.selectionAfter,
      committedAt: Date.now(),
      cost,
    });
    this.bytes += cost;
    restoreProject(this.project, entry.snapshot);
    this.#trim();
    this.#emit();
    return {
      label: entry.label,
      selection: entry.selectionAfter,
      frameId: entry.selectionAfter?.frameId ?? null,
      layerId: entry.selectionAfter?.layerId ?? null,
    };
  }

  /** 记录“当前选择”，撤销/重做时写进反向条目，保证选择往返一致。 */
  setCurrentSelection(selection) {
    this.currentSelection = normalizeSelection(selection);
  }

  clear() {
    this.past = [];
    this.future = [];
    this.bytes = 0;
    this.pending = null;
    this.#emit();
  }
}
