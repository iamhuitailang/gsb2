// 穷举求解器
//
// 每个未锁定反光片有 '/' 与 '\\' 两种朝向, 共 2^N 种摆法, 逐一枚举并模拟判定。
// 搜索到 2 个不同解即可证明"至少两解"并提前停止(这是完整证明, 不算没搜完);
// 但因预算(节点数/时间)或外部取消而停止时, 状态一律标 incomplete ——
// 绝不能把"没搜完"报成唯一解。

import { simulate, isSolution } from './engine';
import { cloneLevel, freeMirrors } from './levels';
import { Level, SimResult } from './types';

export type SolveStatus =
  | 'unsat' // 全部摆法搜完, 无解
  | 'unique' // 全部摆法搜完, 恰好一解
  | 'multi' // 找到至少两组真正不同的摆法
  | 'incomplete'; // 预算用尽仍没搜完, 结论未知

export interface SolverOptions {
  /** 最多访问的搜索节点(一次朝向赋值或一次叶节点判定算一个节点) */
  maxNodes: number;
  /** 最长搜索时间(毫秒) */
  maxMs: number;
  /** 每隔多少个节点让出一次事件循环, 0 表示同步跑完 */
  yieldEvery: number;
  shouldCancel?: () => boolean;
}

export interface SolverSolution {
  /** 变量编号 -> 朝向, 变量编号见 freeMirrors 的顺序 */
  assignments: Map<number, 0 | 1>;
  result: SimResult;
}

export interface SolveReport {
  status: SolveStatus;
  nodes: number;
  elapsedMs: number;
  solutions: SolverSolution[];
  /** 可转动反光片总数(变量数) */
  variableCount: number;
  /** 总摆法数 2^N */
  totalCombinations: number;
  /** 是否因预算/取消而提前停止(找到两解而停止不算) */
  stoppedEarly: boolean;
  canceled: boolean;
}

export const DEFAULT_SOLVER_OPTIONS: SolverOptions = {
  maxNodes: 1 << 20, // 约 100 万节点
  maxMs: 4000,
  yieldEvery: 2000,
};

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

export async function solve(
  level: Level,
  options: SolverOptions = DEFAULT_SOLVER_OPTIONS,
): Promise<SolveReport> {
  const vars = freeMirrors(level);
  const n = vars.length;
  const totalCombinations = 2 ** n;

  // 用一份可变关卡做原地搜索, 避免每层拷贝整盘
  const work = cloneLevel(level);
  const workMirrors = freeMirrors(work);
  const current = new Array<0 | 1>(n).fill(0);
  const solutions: SolverSolution[] = [];

  const start = performance.now();
  let nodes = 0;
  let sinceYield = 0;
  let stoppedEarly = false;
  let canceled = false;
  let foundTwo = false;

  const budgetExhausted = (): boolean => {
    if (nodes >= options.maxNodes) return true;
    if (performance.now() - start >= options.maxMs) return true;
    if (options.shouldCancel?.()) {
      canceled = true;
      return true;
    }
    return false;
  };

  const maybeYield = async (): Promise<boolean> => {
    if (options.yieldEvery <= 0 || sinceYield < options.yieldEvery) return false;
    sinceYield = 0;
    await yieldToEventLoop();
    return budgetExhausted();
  };

  const dfs = async (depth: number): Promise<void> => {
    if (stoppedEarly || foundTwo) return;

    if (depth === n) {
      // 叶节点: 一整套完整摆法
      nodes++;
      sinceYield++;
      const result = simulate(work);
      if (isSolution(result)) {
        solutions.push({
          assignments: new Map(current.map((orient, i) => [i, orient])),
          result,
        });
        if (solutions.length >= 2) foundTwo = true;
      }
      if (await maybeYield()) stoppedEarly = true;
      else if (budgetExhausted()) stoppedEarly = true;
      return;
    }

    for (const orient of [0, 1] as const) {
      current[depth] = orient;
      workMirrors[depth].cell.orient = orient;
      nodes++;
      sinceYield++;
      if (budgetExhausted()) {
        stoppedEarly = true;
        return;
      }
      if (await maybeYield()) {
        stoppedEarly = true;
        return;
      }
      await dfs(depth + 1);
      if (stoppedEarly || foundTwo) return;
    }
  };

  await dfs(0);

  const elapsedMs = performance.now() - start;

  let status: SolveStatus;
  if (stoppedEarly) {
    status = 'incomplete';
  } else if (solutions.length === 0) {
    status = 'unsat';
  } else if (solutions.length === 1) {
    status = 'unique';
  } else {
    status = 'multi';
  }

  return {
    status,
    nodes,
    elapsedMs,
    solutions,
    variableCount: n,
    totalCombinations,
    stoppedEarly,
    canceled,
  };
}
