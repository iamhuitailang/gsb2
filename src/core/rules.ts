import type { HintId, HintSpec, ZoneId } from './types.js';

/** 计算优先级时引擎给出的上下文 */
export interface PriorityContext {
  /** 玩家当前所在位置 */
  currentZone: ZoneId | null;
  /** 提示是否在当前位置解锁(眼前那一步) */
  inCurrentZone: boolean;
  /** 失败解锁类提示: 当前累计失败次数 */
  failureCount: number;
  failureThreshold: number;
  now: number;
}

/**
 * 规则集: 把"先教谁、什么算过时"抽成可替换策略,
 * 改规则后用同一串事件重放, 即可对比实际提示次序(见 sim/compare.ts)。
 */
export interface RuleSet {
  id: string;
  label: string;
  /** 数值越大越先教; hint.id 作为最终确定性平手裁决 */
  priority(hint: HintSpec, ctx: PriorityContext): number;
  /** 排队中的提示是否已经过时(默认实现: TTL 到期; 规则集可扩展位置等条件) */
  isStale(
    hint: HintSpec,
    queuedAt: number,
    ctx: PriorityContext,
  ): boolean;
}

/** 规则一(默认): 眼前那一步优先 —— 当前位置解锁的提示压过其他一切 */
export const zoneFirstRules: RuleSet = {
  id: 'zone-first',
  label: '眼前优先: 当前位置 +100, 首用类 +10, 失败类按失败程度加权',
  priority(hint, ctx) {
    let score = 0;
    if (ctx.inCurrentZone) score += 100;
    if (hint.unlock.some((u) => u.kind === 'firstUse')) score += 10;
    if (hint.unlock.some((u) => u.kind === 'failure')) {
      score += Math.round((ctx.failureCount / ctx.failureThreshold) * 20);
    }
    if (hint.urgent) score += 5;
    return score;
  },
  isStale(hint, queuedAt, ctx) {
    return ctx.now - queuedAt > hint.ttlMs;
  },
};

/**
 * 规则二(对比用): 失败救援优先 —— 失败次数越多越紧急,
 * 位置分被压低。同一串事件下提示次序会与默认规则不同。
 */
export const rescueFirstRules: RuleSet = {
  id: 'rescue-first',
  label: '救援优先: 失败类 +120 起, 位置只 +40',
  priority(hint, ctx) {
    let score = 0;
    if (ctx.inCurrentZone) score += 40;
    if (hint.unlock.some((u) => u.kind === 'firstUse')) score += 10;
    if (hint.unlock.some((u) => u.kind === 'failure')) {
      score += 120 + Math.round((ctx.failureCount / ctx.failureThreshold) * 20);
    }
    if (hint.urgent) score += 5;
    return score;
  },
  isStale(hint, queuedAt, ctx) {
    return ctx.now - queuedAt > hint.ttlMs;
  },
};

export const RULE_SETS: Record<string, RuleSet> = {
  [zoneFirstRules.id]: zoneFirstRules,
  [rescueFirstRules.id]: rescueFirstRules,
};

/** 确定性平手裁决: id 字典序, 保证同输入同输出、可重放 */
export function tieBreak(a: HintId, b: HintId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
