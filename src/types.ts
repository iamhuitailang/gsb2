// 核心领域模型：卡牌、印次、牌组、开局目标、交换批次。
// 全部数据均为虚构，仅用于本地牌组规则演示。

export type FactionId = 'crimson' | 'tide' | 'grove' | 'neutral';

export type CardTypeId = 'core' | 'unit' | 'spell' | 'relic';

/** 印次：同一张卡（共享 cardId）可以有多个印次，不同印次插画 / 系列不同。 */
export interface PrintingDef {
  id: string;
  /** 印次名称，如「初版」「异画藏印」 */
  label: string;
  /** 所属系列 / 版本，如 ORIGIN */
  set: string;
  /** 该印次首次出现的卡池版本，如 '1.0' */
  since: string;
  foil?: boolean;
}

/**
 * 起手搭配资格：某些牌能否在开局出场，取决于起手里的其他牌。
 * - partner：起手必须同时持有搭档牌
 * - faction-other：起手另有 count 张指定阵营牌（不计自身）
 */
export type OpeningRule =
  | { kind: 'partner'; partnerId: string; text: string }
  | { kind: 'faction-other'; faction: FactionId; count: number; text: string };

export interface CardDef {
  /** 稳定神谕 id：跨版本重印保持不变，导入导出靠它认牌，而不是靠名字。 */
  id: string;
  name: string;
  faction: FactionId;
  type: CardTypeId;
  cost: number | null;
  /** 同卡（跨印次、同区域）共享数量上限，默认 3。 */
  limit: number;
  text: string;
  printings: PrintingDef[];
  /** 核心牌的阵营盟约：可同队的阵营（中立通常显式包含）。 */
  core?: { allied: FactionId[] };
  opening?: OpeningRule;
}

/** 牌组中的一条（某张卡的某个印次 × count）。 */
export interface DeckEntry {
  uid: string;
  kind: 'entry';
  cardId: string;
  printingId: string;
  count: number;
}

/**
 * 导入后无法在当前卡池解析的条目。
 * 关键：即使当前卡池存在同名但不同 id 的牌，也只记录候选，绝不自动替换。
 */
export interface UnresolvedEntry {
  uid: string;
  kind: 'unresolved';
  /** 导出文件里的原始 cardId */
  cardId: string;
  printingId?: string;
  count: number;
  exportedName: string;
  exportedPrintingLabel?: string;
  /** 当前卡池中同名但 id 不同的牌（仅作为可手动选择的候选） */
  sameNameCandidates: string[];
  /** 用户在预览中手动指定的替换牌；未指定则一直是缺失状态 */
  replacementCardId?: string;
  replacementPrintingId?: string;
}

export type AnyEntry = DeckEntry | UnresolvedEntry;

export type ZoneId = 'main' | 'sideboard';

/** 开局达标条件（用于种子试抽对比）。 */
export type OpeningGoal =
  | { kind: 'combo'; cardIds: string[]; label: string }
  | { kind: 'card-enabled'; cardId: string; label: string }
  | { kind: 'faction-count'; faction: FactionId; count: number; label: string }
  | { kind: 'any'; label: string; goals: OpeningGoal[] };

export interface Deck {
  id: string;
  name: string;
  tag: string;
  description: string;
  /** 预置「故意卡住」场景的说明卡片 */
  pitfall?: string;
  goal: OpeningGoal;
  main: AnyEntry[];
  sideboard: AnyEntry[];
  builtin?: boolean;
}

/** 一条交换动作：把 mainUid 指向的一张主牌，与 sideUid 指向的一张备选牌互换。 */
export interface SwapPair {
  id: string;
  mainUid: string;
  sideUid: string;
}

/** 更底层的单条移动（自定义批次可用，便于演示数量不等时的规则归属）。 */
export interface BatchAction {
  id: string;
  direction: 'out' | 'in';
  zone: ZoneId;
  entryUid: string;
  /** 移动数量，通常为 1 */
  qty: number;
}

export type RuleSeverity = 'error' | 'warning' | 'info';

/** 结构化规则命中，message 给人看，字段用于把错误归到原牌 / 换入牌。 */
export interface RuleHit {
  code:
    | 'R-UNRESOLVED'
    | 'R-PRINTING-MISSING'
    | 'R-DECK-SIZE'
    | 'R-SIDE-SIZE'
    | 'R-COPY-LIMIT'
    | 'R-CORE-MIN'
    | 'R-CORE-MAX'
    | 'R-CORE-FACTION'
    | 'R-ACTION-QTY';
  severity: RuleSeverity;
  message: string;
  cardId?: string;
  printingId?: string;
  coreCardId?: string;
  zone?: ZoneId;
  /** 关联的牌组条目 uid */
  entryUids?: string[];
}

export interface DeckReport {
  legal: boolean;
  errors: RuleHit[];
  warnings: RuleHit[];
  hits: RuleHit[];
}

/** 展开后的单张实体卡（同一条 ×3 会变成 3 个 iid）。 */
export interface CardInstance {
  iid: number;
  cardId: string;
  printingId: string;
}

export interface GoalCheck {
  pass: boolean;
  label: string;
  detail: string;
}

export interface EligibilityStatus {
  cardId: string;
  enabled: boolean;
  reason: string;
}

export interface DrawTrace {
  seedKey: string;
  seedNum: number;
  initial: CardInstance[];
  mulliganed: CardInstance[];
  kept: CardInstance[];
  drawn: CardInstance[];
  finalHand: CardInstance[];
  firstChecks: GoalCheck[];
  finalChecks: GoalCheck[];
  firstPass: boolean;
  finalPass: boolean;
  policy: MulliganPolicy;
}

export type MulliganPolicy = 'none' | 'all' | 'smart';
