import {
  experiencedAccountLearned,
  newAccountLearned,
} from '../catalog/hints.js';
import type { Scenario } from './runner.js';

/**
 * 场景一: 新账号完整教学动线。
 * 覆盖: 位置解锁、位置+首用复合条件、看完、靠自己完成、失败解锁、
 *       前置链(h_pick -> h_inventory -> h_combine)、TTL 过时撤掉、场景退出清场。
 */
export const newAccountScenario: Scenario = {
  id: 'new-account-tour',
  label: '新账号: 从 hub 到工作台的完整教学动线',
  startLearned: newAccountLearned(),
  events: [
    { t: 0, event: { type: 'sceneEnter', scene: 'prototype' }, note: '进入原型场景' },
    { t: 100, event: { type: 'enterZone', zone: 'hub' }, note: '走到 hub, h_pick 解锁并上屏' },
    // 停留超过展示时长 => 看完
    { t: 14_000, event: { type: 'tick', now: 14_000 }, note: '展示时长走完, h_pick 标记 watched' },
    { t: 15_000, event: { type: 'enterZone', zone: 'door' }, note: '来到门前' },
    { t: 15_500, event: { type: 'actionUse', action: 'jump', success: false }, note: '第一次跳(失败), 复合条件满足, h_jumptip 入队' },
    { t: 18_500, event: { type: 'actionUse', action: 'jump', success: true }, note: '跳成功了 => 靠自己完成, 提示撤掉' },
    { t: 20_000, event: { type: 'enterZone', zone: 'hazard' }, note: '进入危险区, 紧急闪避提示上屏' },
    { t: 22_000, event: { type: 'actionUse', action: 'dodge', success: true }, note: '按提示闪避成功 => selfDone' },
    { t: 24_000, event: { type: 'enterZone', zone: 'hub' }, note: '回 hub' },
    // 首次接触背包动作但做失败 => 只解锁不自学, h_inventory 上屏后由玩家看完
    { t: 25_000, event: { type: 'actionUse', action: 'openInventory', success: false }, note: '首次用背包(失败) => h_inventory 解锁上屏' },
    { t: 41_000, event: { type: 'tick', now: 41_000 }, note: 'h_inventory 看完, 前置链打通' },
    { t: 50_000, event: { type: 'enterZone', zone: 'workbench' }, note: '到工作台, h_combine 前置已满足, 直接上屏' },
    { t: 52_000, event: { type: 'actionUse', action: 'craft', success: false }, note: '合成失败 1/2' },
    { t: 54_000, event: { type: 'actionUse', action: 'craft', success: false }, note: '合成失败 2/2 => h_craftfail 解锁排队(h_combine 正占着展示位)' },
    { t: 71_000, event: { type: 'tick', now: 71_000 }, note: 'h_combine 看完; 全局冷却后 h_craftfail 补位' },
    { t: 74_000, event: { type: 'dismiss' }, note: '主动略过失败排查提示' },
    { t: 120_000, event: { type: 'sceneLeave', scene: 'prototype' }, note: '退出场景: 运行期清场, learned 保留' },
  ],
};

/**
 * 场景二: 已懂两项操作的存档。
 * 覆盖: 存档沿用(已会的不再弹)、前置链直接打通、离开位置打断、
 *       回位置恢复、中断次数超限后取消。
 */
export const experiencedScenario: Scenario = {
  id: 'experienced-return',
  label: '老存档: 已会拾取+背包, 验证打断/恢复/中断额度',
  startLearned: experiencedAccountLearned(0),
  events: [
    { t: 0, event: { type: 'sceneEnter', scene: 'prototype' } },
    { t: 100, event: { type: 'enterZone', zone: 'hub' }, note: 'hub: h_pick 已会, 不应再弹' },
    { t: 1_000, event: { type: 'enterZone', zone: 'workbench' }, note: '前置已满足, h_combine 直接上屏' },
    { t: 2_000, event: { type: 'leaveZone', zone: 'workbench' }, note: '离开位置 => 挂起(第 1 次打断)' },
    { t: 3_000, event: { type: 'enterZone', zone: 'workbench' }, note: '回来 => 恢复上屏' },
    { t: 4_000, event: { type: 'leaveZone', zone: 'workbench' }, note: '再次离开 => 挂起(第 2 次, 达额度)' },
    { t: 5_000, event: { type: 'enterZone', zone: 'workbench' }, note: '回来 => 再次恢复' },
    { t: 6_000, event: { type: 'leaveZone', zone: 'workbench' }, note: '第 3 次离开 => 超出 maxInterruptions, 取消' },
    { t: 8_000, event: { type: 'enterZone', zone: 'workbench' }, note: '再回来: 重触发冷却内, 记 retriggerCooldown' },
    { t: 20_000, event: { type: 'enterZone', zone: 'workbench' }, note: '冷却过后重新触发' },
    { t: 50_000, event: { type: 'tick', now: 50_000 }, note: '看完' },
    { t: 51_000, event: { type: 'sceneLeave', scene: 'prototype' } },
  ],
};

/**
 * 场景三: 同一时刻多条同时有资格(密集触发)。
 * 用来对比两套规则的实际上屏次序, 以及队列上限/挤出行为。
 */
export const denseTriggerScenario: Scenario = {
  id: 'dense-trigger',
  label: '密集触发: 五条提示同时有资格, 对比规则次序',
  startLearned: newAccountLearned(),
  events: [
    { t: 0, event: { type: 'sceneEnter', scene: 'prototype' } },
    // 先自学拾取与背包, 打通合成前置
    { t: 100, event: { type: 'enterZone', zone: 'hub' } },
    { t: 200, event: { type: 'actionUse', action: 'pick', success: true }, note: 'pick 自学 => h_pick selfDone' },
    { t: 300, event: { type: 'actionUse', action: 'openInventory', success: true }, note: '背包自学 => h_inventory selfDone' },
    // 让 jump / dodge 的首用条件也接触过, 但不做成功(保持未学会)
    { t: 400, event: { type: 'enterZone', zone: 'door' } },
    { t: 500, event: { type: 'actionUse', action: 'jump', success: false }, note: 'h_jumptip 具备资格(未成功)' },
    { t: 600, event: { type: 'enterZone', zone: 'hazard' } },
    { t: 700, event: { type: 'actionUse', action: 'dodge', success: false }, note: 'h_dodge 具备资格' },
    // 合成连续失败两次 => 失败提示也具备资格
    { t: 800, event: { type: 'enterZone', zone: 'workbench' } },
    { t: 900, event: { type: 'actionUse', action: 'craft', success: false } },
    { t: 1_000, event: { type: 'actionUse', action: 'craft', success: false }, note: 'h_craftfail 达到阈值; h_combine 前置+位置同时满足' },
    // 此后只推进时间, 观察排队上屏次序与全局冷却
    { t: 30_000, event: { type: 'tick', now: 30_000 } },
    { t: 60_000, event: { type: 'tick', now: 60_000 } },
    { t: 90_000, event: { type: 'tick', now: 90_000 } },
    { t: 120_000, event: { type: 'tick', now: 120_000 } },
    { t: 150_000, event: { type: 'tick', now: 150_000 } },
    { t: 151_000, event: { type: 'sceneLeave', scene: 'prototype' } },
  ],
};

/**
 * 场景四: 规则分歧场景。
 * 工作台的合成提示先看完, 失败类提示(h_craftfail)留在队列里;
 * 玩家随后走进危险区, 眼前出现紧急的 h_dodge ——
 * zone-first 认为"先教眼前那一步", rescue-first 认为"先救连续失败的场"。
 * 两套规则在同一串事件下上屏次序不同, 这是规则对比的基准用例。
 */
export const divergenceScenario: Scenario = {
  id: 'rule-divergence',
  label: '规则分歧: 眼前一步 vs 失败救援',
  startLearned: experiencedAccountLearned(0),
  events: [
    { t: 0, event: { type: 'sceneEnter', scene: 'prototype' } },
    { t: 100, event: { type: 'enterZone', zone: 'workbench' } },
    { t: 200, event: { type: 'actionUse', action: 'craft', success: false } },
    { t: 300, event: { type: 'actionUse', action: 'craft', success: false }, note: 'h_craftfail 解锁并排队(h_combine 正占着展示位)' },
    { t: 25_000, event: { type: 'tick', now: 25_000 }, note: 'h_combine 看完, 展示位空出; h_craftfail 仍在 TTL 内排队' },
    { t: 26_000, event: { type: 'enterZone', zone: 'hazard' }, note: '眼前出现紧急 h_dodge: 两套规则在此分歧' },
    { t: 30_000, event: { type: 'tick', now: 30_000 }, note: '全局冷却结束, 救援规则下 h_craftfail 在此上屏' },
    { t: 61_000, event: { type: 'sceneLeave', scene: 'prototype' } },
  ],
};

export const ALL_SCENARIOS: Scenario[] = [
  newAccountScenario,
  experiencedScenario,
  denseTriggerScenario,
  divergenceScenario,
];
