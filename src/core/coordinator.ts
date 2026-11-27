import {
  GLOBAL_COOLDOWN_MS,
  HINTS_BY_ID,
  MAX_QUEUE,
  RETRIGGER_COOLDOWN_MS,
  SKIP_COOLDOWN_MS,
} from '../catalog/hints.js';
import {
  tieBreak,
  type PriorityContext,
  type RuleSet,
  zoneFirstRules,
} from './rules.js';
import type {
  ActionId,
  CancelReason,
  FilterReason,
  GameEvent,
  HintId,
  HintSpec,
  LearnedOutcome,
  LearnedState,
  LogRecord,
  StampedEvent,
  TraceEntry,
  TraceReason,
  ZoneId,
} from './types.js';

/** 一条候选提示在引擎里的运行期形态 */
export interface QueueEntry {
  hintId: HintId;
  state: 'queued' | 'active' | 'suspended';
  queuedAt: number;
  shownAt: number | null;
  /** 剩余自动展示时长(被抢占时用, 恢复后接着算) */
  remainingMs: number | null;
  interruptions: number;
}

/** 完整快照: 持久化层只需要 learned 部分; 调试台导出全部 */
export interface CoordinatorSnapshot {
  version: 1;
  now: number;
  seq: number;
  currentZone: ZoneId | null;
  activeScene: string | null;
  world: {
    actionUses: Record<string, number>;
    actionFailures: Record<string, number>;
  };
  entries: QueueEntry[];
  learned: Record<string, LearnedState>;
  /** hintId -> 最近一次被取消的时间, 用于重触发冷却 */
  cancelledAt: Record<string, number>;
  /** hintId -> 最近一次被主动略过的时间 */
  skippedAt: Record<string, number>;
  lastTrace: Record<string, TraceEntry>;
  globalCooldownUntil: number;
  log: LogRecord[];
}

export interface CoordinatorOptions {
  rules?: RuleSet;
  initialLearned?: Record<string, LearnedState>;
  now?: number;
}

/**
 * 引导提示协调器。
 * 设计原则:
 *  - 纯事件驱动、只认事件携带的虚拟时间戳, 不读系统时钟, 因此可确定性重放;
 *  - 每个决策都落一条 TraceEntry(触发/过滤及原因/取消及原因), 可逐条审计;
 *  - 学习结论(看完/略过/自己完成)与运行期队列分离, 单独可持久化。
 */
export class TutorialCoordinator {
  private rules: RuleSet;
  private now: number;
  private seq = 0;
  private currentZone: ZoneId | null = null;
  private activeScene: string | null = null;
  private actionUses = new Map<ActionId, number>();
  private actionFailures = new Map<ActionId, number>();
  private entries = new Map<HintId, QueueEntry>();
  private learned = new Map<HintId, LearnedState>();
  private cancelledAt = new Map<HintId, number>();
  private skippedAt = new Map<HintId, number>();
  private lastTrace = new Map<HintId, TraceEntry>();
  private globalCooldownUntil = 0;
  private log: LogRecord[] = [];

  constructor(opts: CoordinatorOptions = {}) {
    this.rules = opts.rules ?? zoneFirstRules;
    this.now = opts.now ?? 0;
    if (opts.initialLearned) {
      for (const [id, state] of Object.entries(opts.initialLearned)) {
        this.learned.set(id as HintId, state);
      }
    }
  }

  // ---------- 对外只读视图(调试页/测试用) ----------

  get time(): number {
    return this.now;
  }
  get zone(): ZoneId | null {
    return this.currentZone;
  }
  get scene(): string | null {
    return this.activeScene;
  }
  get ruleSet(): RuleSet {
    return this.rules;
  }
  get active(): QueueEntry | null {
    for (const e of this.entries.values()) if (e.state === 'active') return e;
    return null;
  }
  getQueued(): QueueEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.state === 'queued')
      .sort((a, b) => -this.comparePriority(a.hintId, b.hintId));
  }
  getSuspended(): QueueEntry[] {
    return [...this.entries.values()].filter((e) => e.state === 'suspended');
  }
  getLearned(): ReadonlyMap<HintId, LearnedState> {
    return this.learned;
  }
  /** 需求 5: 读出某条提示最近一次 trigger / filter / cancel 等原因 */
  getLastTrace(hintId: HintId): TraceEntry | undefined {
    return this.lastTrace.get(hintId);
  }
  getAllTraces(): ReadonlyMap<HintId, TraceEntry> {
    return this.lastTrace;
  }
  getLog(): readonly LogRecord[] {
    return this.log;
  }
  getUseCount(action: ActionId): number {
    return this.actionUses.get(action) ?? 0;
  }
  getFailureCount(action: ActionId): number {
    return this.actionFailures.get(action) ?? 0;
  }

  // ---------- 事件入口 ----------

  handle(event: GameEvent): void {
    const stamped: StampedEvent = { ...event, seq: this.nextSeq() };
    this.log.push({ kind: 'event', event: stamped });

    if (stamped.type === 'tick') {
      this.now = stamped.now;
    }
    // 任何事件都先让时间到期的东西结算(TTL、自动看完、冷却)
    this.punch();
    // 时钟推进可能正好跨过全局冷却终点: 让排队中的队首补位上屏
    if (stamped.type === 'tick') this.pop();

    switch (stamped.type) {
      case 'enterZone':
        this.currentZone = stamped.zone;
        this.onEnterZone(stamped.zone);
        break;
      case 'leaveZone':
        this.onLeaveZone(stamped.zone);
        if (this.currentZone === stamped.zone) this.currentZone = null;
        break;
      case 'actionUse':
        this.bumpAction(stamped.action, stamped.success);
        // 先结算"靠自己完成": 做对目标动作且还没学过 => 直接了结, 不必再教
        // (失败的动作不算自学, 否则失败解锁类提示会被错误地撤掉)
        if (stamped.success) this.evaluateSelfDone(stamped.action);
        this.evaluateTriggers();
        break;
      case 'dismiss':
        this.onDismiss();
        break;
      case 'sceneEnter':
        this.activeScene = stamped.scene;
        break;
      case 'sceneLeave':
        this.onSceneLeave();
        break;
      case 'tick':
        break;
    }
  }

  // ---------- 时间结算 ----------

  private punch(): void {
    // 1. 正在展示的提示: 停留到展示时长 => 看完
    const active = this.active;
    if (active && active.remainingMs !== null) {
      const elapsed = active.shownAt === null ? 0 : this.now - active.shownAt;
      if (elapsed >= active.remainingMs) {
        this.finishWatched(active);
      }
    }
    // 2. 排队/挂起中的过时条目清理
    this.sweepStale();
  }

  private finishWatched(entry: QueueEntry): void {
    this.learn(entry.hintId, 'watched');
    this.entries.delete(entry.hintId);
    this.globalCooldownUntil = this.now + GLOBAL_COOLDOWN_MS;
    this.pop();
  }

  // ---------- 解锁评估 ----------

  private evaluateTriggers(): void {
    for (const hint of this.hintOrder()) {
      if (this.learned.has(hint.id)) {
        // 已学会(看完/略过/自学)的不再弹, 但留痕让调试页能看到"被谁过滤"
        this.filter(hint.id, 'alreadyLearned');
        continue;
      }
      const existing = this.entries.get(hint.id);
      if (existing) {
        this.filter(
          hint.id,
          existing.state === 'active'
            ? 'active'
            : existing.state === 'suspended'
              ? 'suspended'
              : 'inQueue',
        );
        continue;
      }
      const failure = this.unlockFailure(hint);
      if (failure) {
        this.filter(hint.id, failure);
        continue;
      }
      // 重触发冷却 / 略过冷静期
      const cancelled = this.cancelledAt.get(hint.id);
      if (cancelled !== undefined && this.now - cancelled < RETRIGGER_COOLDOWN_MS) {
        this.filter(hint.id, 'retriggerCooldown');
        continue;
      }
      const skipped = this.skippedAt.get(hint.id);
      if (skipped !== undefined && this.now - skipped < SKIP_COOLDOWN_MS) {
        this.filter(hint.id, 'skipCooldown');
        continue;
      }
      this.admit(hint);
    }
  }

  /** 检查全部解锁条件, 返回第一个不满足的过滤原因; null = 有资格 */
  private unlockFailure(hint: HintSpec): FilterReason | null {
    for (const rule of hint.unlock) {
      switch (rule.kind) {
        case 'zone': {
          if (this.currentZone !== rule.zone) return 'zoneMismatch';
          if (rule.action && this.getUseCount(rule.action) < 1) {
            return 'zoneActionPending';
          }
          break;
        }
        case 'firstUse': {
          const need = rule.atUse ?? 1;
          if (this.getUseCount(rule.action) < need) return 'useCountNotMet';
          break;
        }
        case 'failure': {
          if (this.getFailureCount(rule.action) < rule.threshold) {
            return 'failureCountNotMet';
          }
          break;
        }
        case 'prereq': {
          const prior = this.learned.get(rule.requires);
          if (!prior || prior.outcome === 'skipped') return 'prereqNotMet';
          break;
        }
      }
    }
    // 场景未激活时一律不解锁(位置类提示随后再检查具体位置)
    if (!this.activeScene) return 'notInScene';
    return null;
  }

  /** 有资格的候选: 入队(或紧急抢占), 然后尝试弹出 */
  private admit(hint: HintSpec): void {
    const active = this.active;
    // 紧急提示可打断正在展示的普通提示(同类不互抢, 避免抖动)
    if (
      active &&
      hint.urgent &&
      HINTS_BY_ID.get(active.hintId)?.urgent !== true &&
      this.comparePriority(hint.id, active.hintId) > 0
    ) {
      this.suspend(active, 'preempted');
    }

    if (!this.entries.has(hint.id) && this.countQueued() >= MAX_QUEUE) {
      // 队列满: 挤出优先级最低的排队候选, 留下痕迹而不是静默吞掉
      const lowest = this.lowestQueued();
      if (lowest && this.comparePriority(hint.id, lowest.hintId) > 0) {
        this.cancel(lowest.hintId, 'queueEvicted');
      } else {
        this.filter(hint.id, 'queueOverflow');
        return;
      }
    }
    const entry: QueueEntry = {
      hintId: hint.id,
      state: 'queued',
      queuedAt: this.now,
      shownAt: null,
      remainingMs: null,
      interruptions: 0,
    };
    this.entries.set(hint.id, entry);
    this.trace(hint.id, { kind: 'queued' });
    // 紧急提示可越过全局冷却立即上屏, 但前提仍是它在当前规则集下排第一 ——
    // 否则规则对比会被 urgent 短路, 救援优先等策略失效。
    if (hint.urgent && !this.active && this.getQueued()[0]?.hintId === hint.id) {
      this.forceShow(entry);
      return;
    }
    // 非队首的紧急提示与普通提示一样走 pop(冷却已过时由队首正常上屏)
    this.pop();
  }

  private countQueued(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.state === 'queued') n += 1;
    return n;
  }

  private lowestQueued(): QueueEntry | null {
    const queued = this.getQueued();
    return queued.length ? queued[queued.length - 1]! : null;
  }

  // ---------- 上屏 / 排队 / 冷却 ----------

  private pop(): void {
    if (this.active) return;
    if (this.now < this.globalCooldownUntil) return;
    this.sweepStale();
    const next = this.getQueued()[0];
    if (!next) return;
    const spec = HINTS_BY_ID.get(next.hintId);
    if (!spec) return;
    next.state = 'active';
    next.shownAt = this.now;
    // 恢复(被抢占)时沿用剩余时长, 首次展示用 TTL 作为完整展示时长
    next.remainingMs = next.remainingMs ?? spec.ttlMs;
    this.globalCooldownUntil = this.now + GLOBAL_COOLDOWN_MS;
    this.trace(next.hintId, { kind: 'shown' });
  }

  private sweepStale(): void {
    for (const entry of [...this.entries.values()]) {
      const spec = HINTS_BY_ID.get(entry.hintId);
      if (!spec) continue;
      if (entry.state === 'active') continue; // 展示中的由 punch 结算
      const ctx = this.priorityCtx(spec);
      if (this.rules.isStale(spec, entry.queuedAt, ctx)) {
        // 需求 2: 排队/挂起的提示过时后撤掉, 不再遮挡后续操作
        this.cancel(entry.hintId, 'ttlExpired');
      }
    }
  }

  // ---------- 打断与恢复(需求 4) ----------

  private onLeaveZone(zone: ZoneId): void {
    for (const entry of [...this.entries.values()]) {
      const spec = HINTS_BY_ID.get(entry.hintId);
      if (!spec || spec.zone !== zone) continue;
      if (entry.state === 'active') {
        // 离开位置: 展示中的先挂起(额度内), 额度耗尽则按中断预算取消
        this.suspendOrCancel(entry, 'interruptionBudget');
      } else if (entry.state === 'queued') {
        // 排队中的同位置提示直接按过时撤掉
        this.cancel(entry.hintId, 'zoneLeft');
      }
      // suspended 的条目原地等待, 回位置时恢复
    }
  }

  private suspendOrCancel(entry: QueueEntry, reason: CancelReason): void {
    const spec = HINTS_BY_ID.get(entry.hintId)!;
    if (entry.interruptions >= spec.maxInterruptions) {
      this.cancel(entry.hintId, reason === 'zoneLeft' ? 'zoneLeft' : 'interruptionBudget');
      return;
    }
    this.suspend(entry, reason === 'zoneLeft' ? 'zoneLeave' : 'preempted');
  }

  private suspend(entry: QueueEntry, why: 'zoneLeave' | 'preempted'): void {
    if (entry.state === 'active' && entry.shownAt !== null && entry.remainingMs !== null) {
      const elapsed = this.now - entry.shownAt;
      entry.remainingMs = Math.max(0, entry.remainingMs - elapsed);
    }
    entry.interruptions += 1;
    entry.state = 'suspended';
    entry.shownAt = null;
    this.trace(entry.hintId, { kind: 'suspended', reason: why });
  }

  private onEnterZone(zone: ZoneId): void {
    // 回到绑定位置: 挂起条目有明确去留 —— 仍在 TTL 内则恢复, 否则取消
    const resumed: QueueEntry[] = [];
    for (const entry of this.getSuspended()) {
      const spec = HINTS_BY_ID.get(entry.hintId);
      if (spec?.zone !== zone) continue;
      if (this.now - entry.queuedAt > spec.ttlMs) {
        this.cancel(entry.hintId, 'ttlExpired');
        continue;
      }
      entry.state = 'queued';
      entry.queuedAt = this.now;
      resumed.push(entry);
      this.trace(entry.hintId, { kind: 'resumed' });
    }
    // 位置变化可能让 zone 类提示新满足条件
    this.evaluateTriggers();
    // 恢复优先于新排队: 挂起回来的条目直接上屏, 不受全局冷却再次拦截
    if (!this.active) {
      const top = this.getQueued()[0];
      const topResumed = resumed
        .filter((e) => e.state === 'queued')
        .sort((a, b) => -this.comparePriority(a.hintId, b.hintId))[0];
      if (topResumed && (!top || this.comparePriority(topResumed.hintId, top.hintId) >= 0)) {
        this.forceShow(topResumed);
      } else {
        this.pop();
      }
    }
  }

  private forceShow(entry: QueueEntry): void {
    const spec = HINTS_BY_ID.get(entry.hintId);
    if (!spec) return;
    entry.state = 'active';
    entry.shownAt = this.now;
    entry.remainingMs = entry.remainingMs ?? spec.ttlMs;
    this.trace(entry.hintId, { kind: 'shown' });
  }

  // ---------- 玩家操作: 略过 / 自学完成 ----------

  private onDismiss(): void {
    const active = this.active;
    if (!active) return;
    // 需求 3: 主动略过是独立学习结论, 冷静期内不再弹, 但不视为学会(不满足前置)
    this.learn(active.hintId, 'skipped');
    this.skippedAt.set(active.hintId, this.now);
    this.entries.delete(active.hintId);
    this.globalCooldownUntil = this.now + GLOBAL_COOLDOWN_MS;
    this.pop();
  }

  private evaluateSelfDone(action: ActionId): void {
    for (const hint of this.hintOrder()) {
      if (hint.objectiveAction !== action) continue;
      if (this.learned.has(hint.id)) {
        this.filter(hint.id, 'alreadyLearned');
        continue;
      }
      // 没看提示就做对了: 队列/展示中的它全部撤掉, 标记 selfDone
      const entry = this.entries.get(hint.id);
      if (entry) {
        this.cancel(hint.id, 'superseded');
      }
      this.learn(hint.id, 'selfDone');
    }
  }

  private bumpAction(action: ActionId, success: boolean): void {
    this.actionUses.set(action, this.getUseCount(action) + 1);
    if (!success) {
      this.actionFailures.set(action, this.getFailureCount(action) + 1);
    }
  }

  // ---------- 场景进出(需求 3) ----------

  private onSceneLeave(): void {
    // 运行期提示全部清场; learned 保留 —— 重新进入/重开页面沿用学习状态
    for (const entry of [...this.entries.values()]) {
      this.cancel(entry.hintId, 'sceneLeft');
    }
    this.entries.clear();
    this.actionUses.clear();
    this.actionFailures.clear();
    this.currentZone = null;
    this.activeScene = null;
    this.globalCooldownUntil = 0;
  }

  // ---------- 学习结论 / 取消 ----------

  private learn(hintId: HintId, outcome: LearnedOutcome): void {
    this.learned.set(hintId, { outcome, at: this.now });
    this.entries.delete(hintId);
    this.trace(hintId, { kind: 'learned', outcome });
  }

  private cancel(hintId: HintId, reason: CancelReason): void {
    this.entries.delete(hintId);
    this.cancelledAt.set(hintId, this.now);
    this.trace(hintId, { kind: 'cancelled', reason });
  }

  // ---------- 优先级 ----------

  private priorityCtx(hint: HintSpec): PriorityContext {
    const failureRule = hint.unlock.find((u) => u.kind === 'failure');
    const threshold = failureRule?.kind === 'failure' ? failureRule.threshold : 1;
    const action = failureRule?.kind === 'failure' ? failureRule.action : undefined;
    return {
      currentZone: this.currentZone,
      inCurrentZone: hint.zone !== undefined && hint.zone === this.currentZone,
      failureCount: action ? this.getFailureCount(action) : 0,
      failureThreshold: threshold,
      now: this.now,
    };
  }

  /**
   * 优先级比较: 返回正数表示 a 应排在 b 前面。
   * 排序(sort)和抢占判断(>0)共用这一个方向, 不能写反。
   */
  private comparePriority(a: HintId, b: HintId): number {
    const ha = HINTS_BY_ID.get(a);
    const hb = HINTS_BY_ID.get(b);
    if (!ha || !hb) return tieBreak(a, b);
    const diff =
      this.rules.priority(ha, this.priorityCtx(ha)) -
      this.rules.priority(hb, this.priorityCtx(hb));
    return diff !== 0 ? diff : tieBreak(a, b);
  }

  private hintOrder(): HintSpec[] {
    // 稳定顺序遍历目录, 优先级只在排队/弹出时裁决
    return [...HINTS_BY_ID.values()];
  }

  // ---------- 日志与快照 ----------

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private trace(hintId: HintId, reason: TraceReason): void {
    const entry: TraceEntry = { seq: this.nextSeq(), now: this.now, hintId, reason };
    this.lastTrace.set(hintId, entry);
    this.log.push({ kind: 'trace', entry });
  }

  private filter(hintId: HintId, reason: FilterReason): void {
    this.trace(hintId, { kind: 'filtered', reason });
  }

  /** 持久化用: 只存学习结论, 重开页面后据此跳过已会的提示 */
  exportLearned(): Record<string, LearnedState> {
    return Object.fromEntries(this.learned.entries());
  }

  exportSnapshot(): CoordinatorSnapshot {
    return {
      version: 1,
      now: this.now,
      seq: this.seq,
      currentZone: this.currentZone,
      activeScene: this.activeScene,
      world: {
        actionUses: Object.fromEntries(this.actionUses.entries()),
        actionFailures: Object.fromEntries(this.actionFailures.entries()),
      },
      entries: [...this.entries.values()].map((e) => ({ ...e })),
      learned: this.exportLearned(),
      cancelledAt: Object.fromEntries(this.cancelledAt.entries()),
      skippedAt: Object.fromEntries(this.skippedAt.entries()),
      lastTrace: Object.fromEntries(this.lastTrace.entries()),
      globalCooldownUntil: this.globalCooldownUntil,
      log: [...this.log],
    };
  }

  static fromSnapshot(snap: CoordinatorSnapshot, rules?: RuleSet): TutorialCoordinator {
    const c = new TutorialCoordinator({
      rules,
      initialLearned: snap.learned,
      now: snap.now,
    });
    c.seq = snap.seq;
    c.currentZone = snap.currentZone;
    c.activeScene = snap.activeScene;
    c.actionUses = new Map(Object.entries(snap.world.actionUses)) as Map<ActionId, number>;
    c.actionFailures = new Map(Object.entries(snap.world.actionFailures)) as Map<ActionId, number>;
    c.entries = new Map(snap.entries.map((e) => [e.hintId, { ...e }]));
    c.cancelledAt = new Map(Object.entries(snap.cancelledAt)) as Map<HintId, number>;
    c.skippedAt = new Map(Object.entries(snap.skippedAt)) as Map<HintId, number>;
    c.lastTrace = new Map(Object.entries(snap.lastTrace)) as Map<HintId, TraceEntry>;
    c.globalCooldownUntil = snap.globalCooldownUntil;
    c.log = [...snap.log];
    return c;
  }
}
