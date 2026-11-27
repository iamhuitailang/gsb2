// 引导提示系统的核心领域类型。引擎不依赖 DOM / Node API, 同一份实现跑在 CLI、测试和浏览器调试页里。

/** 场景里的位置标识 */
export type ZoneId = 'hub' | 'bench' | 'door' | 'workbench' | 'hazard';

/** 玩家可执行的动作标识 */
export type ActionId =
  | 'move'
  | 'pick'
  | 'jump'
  | 'dodge'
  | 'openInventory'
  | 'craft';

/** 提示的稳定标识, 同时也是存档 key */
export type HintId =
  | 'h_pick'
  | 'h_jumptip'
  | 'h_dodge'
  | 'h_inventory'
  | 'h_combine'
  | 'h_craftfail';

/** 位置/位置+动作 解锁 */
export interface ZoneUnlock {
  kind: 'zone';
  zone: ZoneId;
  /** 仅当玩家在该位置首次执行此动作时才有资格(位置+首用复合条件); 不填则进入位置即有资格 */
  action?: ActionId;
}

/** 某动作第 N 次执行时解锁(首次用到的动作) */
export interface FirstUseUnlock {
  kind: 'firstUse';
  action: ActionId;
  /** 第几次执行触发, 默认 1 */
  atUse?: number;
}

/** 同一动作累计失败达到阈值时解锁 */
export interface FailureUnlock {
  kind: 'failure';
  action: ActionId;
  threshold: number;
}

/** 前置依赖: 必须先学会(看完或自己做对)某条提示才有资格 —— "先学会一项才出现下一项" */
export interface PrereqUnlock {
  kind: 'prereq';
  requires: HintId;
}

export type UnlockRule =
  | ZoneUnlock
  | FirstUseUnlock
  | FailureUnlock
  | PrereqUnlock;

/** 一条教学提示的静态定义 */
export interface HintSpec {
  id: HintId;
  title: string;
  text: string;
  /** 绑定位置: 玩家离开该位置时, 展示/排队中的它会被打断或撤掉 */
  zone?: ZoneId;
  /** 玩家在没看提示的情况下做对这个动作 => 标记为 selfDone(靠自己完成) */
  objectiveAction?: ActionId;
  /** 高紧迫提示可以打断正在展示的普通提示 */
  urgent?: boolean;
  /** 解锁条件, 全部满足才有资格出现 */
  unlock: UnlockRule[];
  /** 展示后多长时间(虚拟毫秒)未处理就算过时, 从队列撤掉 */
  ttlMs: number;
  /** 允许被打断(离开位置/被抢占)的次数; 超过则直接取消 */
  maxInterruptions: number;
}

/** 学习结论: 三种"了结"方式 */
export type LearnedOutcome =
  | 'watched' // 看完(在屏停留到展示时长)
  | 'skipped' // 主动略过
  | 'selfDone'; // 没靠提示, 自己完成了目标动作

/** 持久化的学习状态(进出场景、重开页面后沿用) */
export interface LearnedState {
  outcome: LearnedOutcome;
  at: number; // 虚拟时间戳
}

/** 进入引擎的游戏事件; tick 由虚拟时钟驱动, 不碰真实时间 */
export type GameEvent =
  | { type: 'enterZone'; zone: ZoneId }
  | { type: 'leaveZone'; zone: ZoneId }
  | { type: 'actionUse'; action: ActionId; success: boolean }
  | { type: 'sceneEnter'; scene: string }
  | { type: 'sceneLeave'; scene: string }
  /** 玩家点了"略过"按钮 */
  | { type: 'dismiss' }
  /** 时钟推进, 驱动 TTL / 冷却 / 自动看完 */
  | { type: 'tick'; now: number };

export type StampedEvent = GameEvent & { seq: number };

/**
 * 一条提示在其生命周期某一时刻留下的"原因记录"。
 * 每条提示保留最近一次 trigger / filter / cancel, 供调试页读出。
 */
export type TraceReason =
  | { kind: 'triggered'; eligible: true }
  | { kind: 'filtered'; reason: FilterReason }
  | {
      kind: 'cancelled';
      reason: CancelReason;
    }
  | { kind: 'shown' }
  | { kind: 'learned'; outcome: LearnedOutcome }
  | { kind: 'queued' }
  | { kind: 'resumed' }
  | { kind: 'suspended'; reason: 'zoneLeave' | 'preempted' };

export type FilterReason =
  | 'alreadyLearned' // 玩家已经会了(看完/自己做对), 不再弹
  | 'prereqNotMet' // 前置技能还没学会
  | 'zoneMismatch' // 不在提示绑定的位置
  | 'zoneActionPending' // 位置+首用复合条件: 人到了但还没执行指定动作
  | 'notInScene' // 当前没有进行中的场景
  | 'useCountNotMet' // 首用次数未到
  | 'failureCountNotMet' // 失败次数未到
  | 'inQueue' // 已在排队, 不重复入队
  | 'active' // 正在展示
  | 'suspended' // 已挂起, 等回位置恢复
  | 'retriggerCooldown' // 取消后短期内不允许再次触发, 防刷屏
  | 'skipCooldown' // 主动略过后的冷静期内
  | 'queueOverflow'; // 队列已满, 候选被丢弃

export type CancelReason =
  | 'ttlExpired' // 排队期间过时, 撤掉
  | 'zoneLeft' // 离开绑定位置
  | 'preempted' // 被更紧急的提示抢占且中断额度耗尽
  | 'superseded' // 排队期间目标动作已自己完成
  | 'interruptionBudget' // 挂起次数超限
  | 'queueEvicted' // 队列满, 作为最低优先候选被挤出
  | 'sceneLeft'; // 场景退出, 全部清场

export interface TraceEntry {
  seq: number;
  now: number;
  hintId: HintId;
  reason: TraceReason;
}

/** 操作日志: 输入事件 + 引擎产生的原因记录, 严格按序追加, 是重放的数据源 */
export type LogRecord =
  | { kind: 'event'; event: StampedEvent }
  | { kind: 'trace'; entry: TraceEntry };
