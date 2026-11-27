import { TutorialCoordinator } from '../core/coordinator.js';
import type { RuleSet } from '../core/rules.js';
import type {
  GameEvent,
  HintId,
  LearnedState,
  LogRecord,
  TraceEntry,
} from '../core/types.js';

/** 带虚拟时间戳的脚本事件(毫秒, 相对场景起点) */
export interface ScriptedEvent {
  t: number;
  event: GameEvent;
  note?: string;
}

export interface Scenario {
  id: string;
  label: string;
  startLearned: Record<string, LearnedState>;
  events: ScriptedEvent[];
}

/** 一次上屏记录, 规则对比主要看这个序列 */
export interface ShowRecord {
  hintId: HintId;
  shownAt: number;
  endedAt: number;
  /** shown -> 结束时的去向, 直接取自引擎 trace, 不做启发式猜测 */
  ending: 'watched' | 'skipped' | 'selfDone' | 'cancelled' | 'preempted' | 'open';
}

export interface ScenarioRun {
  scenarioId: string;
  ruleSetId: string;
  showOrder: ShowRecord[];
  learned: Record<string, LearnedState>;
  traces: TraceEntry[];
  log: LogRecord[];
  coordinator: TutorialCoordinator;
}

/**
 * 用虚拟时钟跑完整条脚本。引擎本身不碰真实时间,
 * 这里按脚本时间戳依次注入 tick/游戏事件, 保证同脚本同结果。
 * 每条 shown 记录的结局由后续 trace(learned/suspended/cancelled)直接闭合。
 */
export function runScenario(
  scenario: Scenario,
  rules?: RuleSet,
): ScenarioRun {
  const coord = new TutorialCoordinator({
    rules,
    initialLearned: scenario.startLearned,
    now: 0,
  });

  const showOrder: ShowRecord[] = [];
  const openByHint = new Map<HintId, ShowRecord>();
  // 全局游标: tick 与 event 两次 handle 产生的 trace 都不漏
  let cursor = 0;

  const closeOpen = (hintId: HintId, now: number, ending: ShowRecord['ending']) => {
    const rec = openByHint.get(hintId);
    if (!rec) return;
    const isLearning = ending === 'watched' || ending === 'skipped' || ending === 'selfDone';
    // 自学路径会先 cancel(superseded) 再 learn(selfDone), 且两条 trace 同刻到达:
    // 学习结论始终优先于取消, 因此不要在 cancel 时把记录移出 map
    if (rec.ending !== 'open' && !isLearning) return;
    rec.ending = ending;
    rec.endedAt = now;
    if (isLearning) openByHint.delete(hintId);
  };

  const drainTraces = () => {
    const log = coord.getLog();
    const fresh = log.slice(cursor);
    cursor = log.length;
    for (const record of fresh) {
      if (record.kind !== 'trace') continue;
      const { entry } = record;
      if (entry.reason.kind === 'shown') {
        const rec: ShowRecord = {
          hintId: entry.hintId,
          shownAt: entry.now,
          endedAt: -1,
          ending: 'open',
        };
        showOrder.push(rec);
        openByHint.set(entry.hintId, rec);
      } else if (entry.reason.kind === 'learned') {
        closeOpen(entry.hintId, entry.now, entry.reason.outcome);
      } else if (entry.reason.kind === 'suspended') {
        closeOpen(entry.hintId, entry.now, 'preempted');
      } else if (entry.reason.kind === 'cancelled') {
        closeOpen(entry.hintId, entry.now, 'cancelled');
      }
    }
  };

  for (const item of scenario.events) {
    coord.handle({ type: 'tick', now: item.t });
    drainTraces();
    coord.handle(item.event);
    drainTraces();
  }

  // 收尾: 场景结束时仍开着的记录
  for (const rec of showOrder) {
    if (rec.ending === 'open') {
      rec.ending = 'cancelled';
      rec.endedAt = coord.time;
    }
  }

  const traces: TraceEntry[] = [];
  for (const record of coord.getLog()) {
    if (record.kind === 'trace') traces.push(record.entry);
  }

  return {
    scenarioId: scenario.id,
    ruleSetId: coord.ruleSet.id,
    showOrder,
    learned: coord.exportLearned(),
    traces,
    log: [...coord.getLog()],
    coordinator: coord,
  };
}
