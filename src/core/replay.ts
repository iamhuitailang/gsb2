import { TutorialCoordinator } from './coordinator.js';
import type { RuleSet } from './rules.js';
import type {
  HintId,
  LearnedState,
  LogRecord,
  TraceEntry,
} from './types.js';

/** 重放到某一步时的只读状态视图 */
export interface ReplayFrame {
  /** 已重放的记录条数(0 表示还在起点) */
  step: number;
  now: number;
  activeHintId: HintId | null;
  queuedHintIds: HintId[];
  suspendedHintIds: HintId[];
  learned: Record<string, LearnedState>;
  lastTrace: Record<string, TraceEntry>;
}

/**
 * 需求 5: 在一条操作记录上暂停重走。
 * 重放 = 把日志里的输入事件按序喂给一个全新协调器;
 * trace 记录只用于展示, 不参与重放(引擎会重新产生同样的 trace, 可交叉校验)。
 */
export class ReplaySession {
  private readonly records: LogRecord[];
  private readonly rules?: RuleSet;
  private readonly initialLearned?: Record<string, LearnedState>;
  private coord: TutorialCoordinator;
  private idx = 0;

  private constructor(
    records: LogRecord[],
    rules?: RuleSet,
    initialLearned?: Record<string, LearnedState>,
  ) {
    this.records = records;
    this.rules = rules;
    this.initialLearned = initialLearned;
    this.coord = this.fresh();
  }

  static fromLog(
    records: readonly LogRecord[],
    opts: { rules?: RuleSet; initialLearned?: Record<string, LearnedState> } = {},
  ): ReplaySession {
    return new ReplaySession([...records], opts.rules, opts.initialLearned);
  }

  private fresh(): TutorialCoordinator {
    return new TutorialCoordinator({
      rules: this.rules,
      initialLearned: this.initialLearned,
    });
  }

  get length(): number {
    return this.records.length;
  }
  get position(): number {
    return this.idx;
  }
  get finished(): boolean {
    return this.idx >= this.records.length;
  }
  get coordinator(): TutorialCoordinator {
    return this.coord;
  }

  /** 当前即将处理的记录(暂停点); 已走完返回 null */
  peek(): LogRecord | null {
    return this.records[this.idx] ?? null;
  }

  /** 单步: 处理下一条记录(若是 trace 则只移动游标, 事件才喂给引擎) */
  step(): ReplayFrame {
    const record = this.records[this.idx];
    if (!record) return this.frame();
    if (record.kind === 'event') {
      this.coord.handle(record.event);
    }
    this.idx += 1;
    return this.frame();
  }

  /** 一直走到日志末尾 */
  runToEnd(): ReplayFrame {
    while (!this.finished) this.step();
    return this.frame();
  }

  /**
   * 暂停重走: 推进到指定 seq 的记录之前停下(该 seq 尚未处理)。
   * seq 对应日志里 event.seq / trace.seq, 调试页点哪条就在哪条之前暂停。
   */
  pauseAtSeq(seq: number): ReplayFrame {
    while (this.idx < this.records.length) {
      const record = this.records[this.idx]!;
      const recordSeq =
        record.kind === 'event' ? record.event.seq : record.entry.seq;
      if (recordSeq >= seq) break;
      this.step();
    }
    return this.frame();
  }

  /**
   * 重走到指定 seq 处理完为止(所有 seq <= 目标的记录都已喂给引擎)。
   * 调试页点击某条日志 => 看那条记录落地后的状态, 暂停点落在下一条。
   */
  runToSeq(seq: number): ReplayFrame {
    while (this.idx < this.records.length) {
      const record = this.records[this.idx]!;
      const recordSeq =
        record.kind === 'event' ? record.event.seq : record.entry.seq;
      if (recordSeq > seq) break;
      this.step();
    }
    return this.frame();
  }

  reset(): ReplayFrame {
    this.coord = this.fresh();
    this.idx = 0;
    return this.frame();
  }

  frame(): ReplayFrame {
    return {
      step: this.idx,
      now: this.coord.time,
      activeHintId: this.coord.active?.hintId ?? null,
      queuedHintIds: this.coord.getQueued().map((e) => e.hintId),
      suspendedHintIds: this.coord.getSuspended().map((e) => e.hintId),
      learned: this.coord.exportLearned(),
      lastTrace: Object.fromEntries(this.coord.getAllTraces()),
    };
  }
}
