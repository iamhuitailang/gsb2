import type { GameState, PresetKey, RoundRecord, TeamId, ViewModel } from '../domain/types.ts';
import { TEAM_NAMES } from '../domain/types.ts';
import {
  buildRecordExport,
  buildStateExport,
  buildViewModel,
  beginEditing,
  createGame,
  currentRecord,
  deserializeInternal,
  importRecord,
  nextRound,
  replaceDraftPlan,
  serializeInternal,
  setAllocation,
  settleCurrent,
  STORAGE_KEY,
  submitTeam,
} from '../domain/state.ts';
import { examplePlanFor } from '../domain/scenarios.ts';
import { replayRecord } from '../domain/rules.ts';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 测试用内存存储；浏览器里用 localStorage 实现同样的接口。 */
export class MemoryStorage implements StorageLike {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  keys(): string[] {
    return [...this.data.keys()];
  }
}

export type StoreListener = (store: GameStore) => void;

export interface GameStoreOptions {
  storage: StorageLike;
  now?: () => number;
  baseSeed?: string;
  preset?: PresetKey;
  /** 测试里可关闭自动恢复，用于验证“重新打开”的两种路径。 */
  restore?: boolean;
}

/**
 * 界面状态容器。
 *
 * 所有修改都走 domain 层，并立即写入内部存档；构造时优先恢复存档，
 * 因此刷新页面会回到原来的等待 / 编辑 / 结算状态，而不会重抽设备分布。
 */
export class GameStore {
  readonly storage: StorageLike;
  private readonly clock: () => number;
  private state: GameState;
  private view: ViewModel;
  private savedAt: number | null = null;
  private restored = false;
  private notice: string | null = null;
  private error: string | null = null;
  private listeners: StoreListener[] = [];
  private saveError: string | null = null;

  constructor(options: GameStoreOptions) {
    this.storage = options.storage;
    this.clock = options.now ?? Date.now;
    const restore = options.restore ?? true;
    let raw: string | null = null;
    if (restore) {
      try {
        raw = this.storage.getItem(STORAGE_KEY);
      } catch (error) {
        this.saveError = `读取本机存档失败：${String(error instanceof Error ? error.message : error)}`;
      }
    }
    let preserveBrokenSave = false;
    if (raw) {
      const loaded = deserializeInternal(raw);
      if (loaded.ok) {
        this.state = loaded.state;
        this.savedAt = loaded.savedAt;
        this.restored = true;
        this.view = buildViewModel(this.state);
        this.notice = `已从本机存档恢复到「${this.view.phaseLabel}」。`;
        return;
      }
      preserveBrokenSave = true;
      this.error = `存档无法恢复：${loaded.error}。已按默认设置开始新的一局；原存档暂未覆盖，先点侧栏「清除本机存档」可避免下次操作写回新进度。`;
    }
    this.state = createGame({
      baseSeed: options.baseSeed ?? 'repair-lab-2026',
      preset: options.preset ?? 'contested',
      now: this.clock(),
    });
    this.view = buildViewModel(this.state);
    // 存档损坏时不立即覆盖，保留原始内容供用户排查。
    if (!preserveBrokenSave) this.persist();
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this);
  }

  private persist(): void {
    try {
      const at = this.clock();
      this.storage.setItem(STORAGE_KEY, serializeInternal(this.state, at));
      this.savedAt = at;
      this.saveError = null;
    } catch (error) {
      this.saveError = `自动保存失败：${String(error instanceof Error ? error.message : error)}`;
    }
  }

  private commit(next: GameState, message: string | null): void {
    this.state = next;
    this.view = buildViewModel(this.state);
    this.error = null;
    this.notice = message;
    this.persist();
    this.emit();
  }

  private fail(message: string): void {
    this.error = message;
    this.notice = null;
    this.emit();
  }

  /* ---------------- 只读访问 ---------------- */

  getViewModel(): ViewModel {
    return this.view;
  }

  getNotice(): string | null {
    return this.notice;
  }

  getError(): string | null {
    return this.error;
  }

  getSaveError(): string | null {
    return this.saveError;
  }

  getSavedAt(): number | null {
    return this.savedAt;
  }

  wasRestored(): boolean {
    return this.restored;
  }

  /** 仅供检查 / 测试读取；界面必须使用 getViewModel()。 */
  peekState(): GameState {
    return this.state;
  }

  historyRecords(): RoundRecord[] {
    return this.state.history.map((record) => structuredClone(record));
  }

  /* ---------------- 流程动作 ---------------- */

  acceptHandoff(team: TeamId): void {
    const outcome = beginEditing(this.state, team);
    if (outcome.error) return this.fail(outcome.error);
    this.commit(outcome.state, `${TEAM_NAMES[team]}接手，开始安排本轮工时。`);
  }

  setWork(team: TeamId, deviceId: string, value: number): void {
    const outcome = setAllocation(this.state, team, deviceId, value);
    if (outcome.error) return this.fail(outcome.error);
    this.commit(outcome.state, null);
  }

  adjustWork(team: TeamId, deviceId: string, delta: number): void {
    const current = this.view.editing?.allocations[deviceId] ?? 0;
    this.setWork(team, deviceId, current + delta);
  }

  /** 载入固定场景的示例分工（仍是草稿，可继续修改）。 */
  loadExample(team: TeamId): void {
    if (this.view.editing?.team !== team) return this.fail('当前不在该队的编辑阶段。');
    const example = examplePlanFor(this.state.preset, team, this.state.current.devices);
    if (!example) return this.fail('当前场景没有可用的示例分工。');
    const outcome = replaceDraftPlan(this.state, team, example);
    if (outcome.error) return this.fail(outcome.error);
    this.commit(outcome.state, '已载入示例分工，提交确认前仍可修改。');
  }

  submit(team: TeamId): void {
    const outcome = submitTeam(this.state, team, this.clock());
    if (outcome.error) return this.fail(outcome.error);
    if (team === 'A') {
      this.commit(outcome.state, '甲队方案已密封提交。请将设备交给乙队。');
    } else {
      this.commit(outcome.state, '乙队方案已密封提交。现在可以结算。');
    }
  }

  settle(): void {
    const outcome = settleCurrent(this.state, this.clock());
    if (outcome.error) return this.fail(outcome.error);
    if (outcome.duplicate) {
      this.notice = '本轮已经结算过，重复点击不会重复入账。';
      this.error = null;
      this.emit();
      return;
    }
    const totals = outcome.record?.totals;
    this.commit(
      outcome.state,
      totals
        ? `结算完成：${TEAM_NAMES.A} ${totals.A} : ${totals.B} ${TEAM_NAMES.B}。本轮投入已公开。`
        : '结算完成。',
    );
  }

  startNextRound(): void {
    const outcome = nextRound(this.state, this.clock());
    if (outcome.error) return this.fail(outcome.error);
    this.commit(
      outcome.state,
      `进入第 ${this.state.current.round + 1} 轮：上一轮记录已归档，新一轮草稿与历史分开保存。`,
    );
  }

  restart(baseSeed: string, preset: PresetKey): void {
    this.state = createGame({ baseSeed: baseSeed.trim() || 'repair-lab-2026', preset, now: this.clock() });
    this.view = buildViewModel(this.state);
    this.restored = false;
    this.error = null;
    this.notice = '已按新种子开始新一轮试验。';
    this.persist();
    this.emit();
  }

  clearSavedGame(): void {
    this.storage.removeItem(STORAGE_KEY);
    this.savedAt = null;
    this.notice = '已清除本机存档。当前界面状态保持不变，下一次操作会重新写入。';
    this.error = null;
    this.emit();
  }

  /* ---------------- 导出 / 导入 ---------------- */

  exportSnapshot(): string {
    return buildStateExport(this.state);
  }

  exportCurrentRecord(): string {
    const record = currentRecord(this.state);
    if (!record) {
      this.fail('本轮尚未结算，没有可导出的结算记录。');
      return '';
    }
    return buildRecordExport(record);
  }

  importSettledRecord(raw: string): void {
    const outcome = importRecord(this.state, raw);
    if (outcome.error) return this.fail(outcome.error);
    const record = outcome.record;
    if (!record) return this.fail('记录无法识别。');
    const replayTotals = outcome.replay?.replayed.totals ?? record.totals;
    const same = replayTotals.A === record.totals.A && replayTotals.B === record.totals.B;
    this.commit(
      this.state,
      `${outcome.alreadyInHistory ? '该轮已在本机历史中；' : ''}重播核对通过（甲 ${replayTotals.A} : 乙 ${
        replayTotals.B
      }），与记录分值${same ? '一致' : '不一致'}。导入只用于核对，不会改动当前进度。`,
    );
  }

  /** 用历史记录重播，返回面向界面的核对结论。 */
  replayHistoryRecord(id: string): string {
    const record = this.state.history.find((item) => item.id === id);
    if (!record) return '找不到这条记录。';
    const replay = replayRecord(record);
    const base = `通过：同一记录重播仍为 甲 ${replay.replayed.totals.A} : 乙 ${replay.replayed.totals.B}`;
    if (replay.matches) return base;
    return `不一致：记录为 甲 ${record.totals.A} : 乙 ${record.totals.B}，重播为 ${replay.comparison}`;
  }
}

/** 浏览器 localStorage 的薄包装，避免在非浏览器环境直接引用。 */
export function browserStorage(): StorageLike {
  return {
    getItem: (key) => {
      try {
        return globalThis.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        globalThis.localStorage.setItem(key, value);
      } catch {
        // 隐私模式 / 配额满：保留在内存里，界面会显示“未保存”
      }
    },
    removeItem: (key) => {
      try {
        globalThis.localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}
