import { rescueFirstRules, zoneFirstRules, type RuleSet } from '../core/rules.js';
import type { HintId } from '../core/types.js';
import { runScenario, type Scenario, type ScenarioRun } from './runner.js';

export interface RuleComparison {
  scenarioId: string;
  ruleSets: { id: string; label: string }[];
  orders: Record<string, HintId[]>;
  /** 第 N 个上屏位置上两套规则给出的提示是否一致 */
  sameOrder: boolean;
  /** 每个规则集下每种学习结论的计数 */
  learnedSummary: Record<string, Record<string, number>>;
  runs: ScenarioRun[];
}

/** 需求 6: 修改规则后, 用同一串事件对比实际提示次序 */
export function compareRules(
  scenario: Scenario,
  ruleSets: RuleSet[] = [zoneFirstRules, rescueFirstRules],
): RuleComparison {
  const runs = ruleSets.map((rules) => runScenario(scenario, rules));
  const orders: Record<string, HintId[]> = {};
  const learnedSummary: Record<string, Record<string, number>> = {};
  for (const run of runs) {
    orders[run.ruleSetId] = run.showOrder.map((s) => s.hintId);
    const summary: Record<string, number> = {};
    for (const state of Object.values(run.learned)) {
      summary[state.outcome] = (summary[state.outcome] ?? 0) + 1;
    }
    learnedSummary[run.ruleSetId] = summary;
  }
  const ids = Object.keys(orders);
  const first = orders[ids[0]!]!;
  const sameOrder = ids.every((id) => arrayEq(orders[id]!, first));
  return {
    scenarioId: scenario.id,
    ruleSets: ruleSets.map((r) => ({ id: r.id, label: r.label })),
    orders,
    sameOrder,
    learnedSummary,
    runs,
  };
}

function arrayEq<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
