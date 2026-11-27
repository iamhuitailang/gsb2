import type { HintId, HintSpec, LearnedState, LearnedOutcome } from '../core/types.js';

/**
 * 教学提示目录。覆盖全部四种解锁方式:
 *  - zone:      走到位置 / 在某位置首次做某动作
 *  - firstUse:  第一次用到某动作
 *  - failure:   同动作失败次数达到阈值
 *  - prereq:    先学会一项, 下一项才有资格
 */
export const HINT_CATALOG: HintSpec[] = [
  {
    id: 'h_pick',
    title: '拾取物品',
    text: '靠近发光物品按 pick 把它捡起来。',
    zone: 'hub',
    objectiveAction: 'pick',
    unlock: [{ kind: 'zone', zone: 'hub' }],
    ttlMs: 12_000,
    maxInterruptions: 2,
  },
  {
    id: 'h_jumptip',
    title: '跳过缺口',
    text: '门前有缺口, 按 jump 跳过去。',
    zone: 'door',
    objectiveAction: 'jump',
    unlock: [
      // 复合条件: 在 door 位置首次执行 jump 时才进入候选
      { kind: 'zone', zone: 'door', action: 'jump' },
    ],
    ttlMs: 10_000,
    maxInterruptions: 1,
  },
  {
    id: 'h_dodge',
    title: '紧急闪避',
    text: '危险区出现红色闪光时立刻 dodge!',
    zone: 'hazard',
    objectiveAction: 'dodge',
    urgent: true,
    unlock: [{ kind: 'zone', zone: 'hazard' }],
    ttlMs: 6_000,
    maxInterruptions: 1,
  },
  {
    id: 'h_inventory',
    title: '打开背包',
    text: '按 openInventory 查看刚捡到的材料。',
    objectiveAction: 'openInventory',
    unlock: [
      // 首次用到 openInventory 时(做失败/做对都算接触到该动作)
      { kind: 'firstUse', action: 'openInventory', atUse: 1 },
    ],
    ttlMs: 15_000,
    maxInterruptions: 2,
  },
  {
    id: 'h_combine',
    title: '合成入门',
    text: '在工作台把两个材料用 craft 合成组件。',
    zone: 'workbench',
    objectiveAction: 'craft',
    unlock: [
      // 前置链: 先学会拾取、再学会开背包, 合成提示才有资格
      { kind: 'prereq', requires: 'h_pick' },
      { kind: 'prereq', requires: 'h_inventory' },
      { kind: 'zone', zone: 'workbench' },
    ],
    ttlMs: 20_000,
    maxInterruptions: 2,
  },
  {
    id: 'h_craftfail',
    title: '合成失败排查',
    text: '连续合成失败? 先确认背包里有两种基础材料。',
    zone: 'workbench',
    unlock: [{ kind: 'failure', action: 'craft', threshold: 2 }],
    ttlMs: 40_000,
    maxInterruptions: 2,
  },
];

export const HINTS_BY_ID: ReadonlyMap<HintId, HintSpec> = new Map(
  HINT_CATALOG.map((h) => [h.id, h]),
);

/** 全局冷却: 一条提示消失后, 至少间隔这么久才允许下一条上屏, 防止密集触发遮住操作 */
export const GLOBAL_COOLDOWN_MS = 2_500;

/** 被取消的提示短期内不得重新触发(同一事件抖动防刷) */
export const RETRIGGER_COOLDOWN_MS = 4_000;

/** 主动略过后的冷静期: 期间不再弹同一条 */
export const SKIP_COOLDOWN_MS = 30_000;

/** 排队上限: 触发来得再密, 屏外也只保留这么多条候选 */
export const MAX_QUEUE = 4;

function learned(outcome: LearnedOutcome, at: number): LearnedState {
  return { outcome, at };
}

/** 新账号: 没有任何学习记录 */
export function newAccountLearned(): Record<string, LearnedState> {
  return {};
}

/**
 * 已经懂两项操作的存档: 拾取和开背包都标记为"靠自己完成"。
 * 走到工作台时, 合成提示的两条前置直接满足 —— 用来验证前置链与存档沿用。
 */
export function experiencedAccountLearned(
  now = 0,
): Record<string, LearnedState> {
  return {
    h_pick: learned('selfDone', now),
    h_inventory: learned('selfDone', now),
  };
}
