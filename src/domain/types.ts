/**
 * 核心类型定义。
 *
 * 说明：项目同时被 Node 原生 TypeScript 执行（node --test）与浏览器构建脚本使用，
 * 因此只使用“可擦除”的 TypeScript 语法（interface/type/泛型），不使用 enum / namespace。
 */

export type TeamId = 'A' | 'B';

export const TEAM_IDS: readonly TeamId[] = ['A', 'B'] as const;

export const TEAM_NAMES: Record<TeamId, string> = {
  A: '甲队',
  B: '乙队',
};

/** 每台公共设备的静态参数。 */
export interface Device {
  id: string;
  name: string;
  /** 修复阈值：需要多少“有效单位”才能修复。 */
  severity: number;
  /** 本轮两队合计最多能计入这台设备的工时（上限）。 */
  cap: number;
  /** 修复成功后发放的总收益。 */
  reward: number;
}

/** 设备 id -> 工时单位数。 */
export type Allocation = Record<string, number>;

export interface TeamDraft {
  allocations: Allocation;
  /** null 表示尚未密封提交。 */
  submittedAt: number | null;
}

/**
 * 轮次状态机：
 * handoff-a → editing-a → handoff-b → editing-b → awaiting-settlement → settled
 */
export type Phase =
  | 'handoff-a'
  | 'editing-a'
  | 'handoff-b'
  | 'editing-b'
  | 'awaiting-settlement'
  | 'settled';

export const PHASE_LABELS: Record<Phase, string> = {
  'handoff-a': '等待甲队接手',
  'editing-a': '甲队编辑中',
  'handoff-b': '等待乙队接手',
  'editing-b': '乙队编辑中',
  'awaiting-settlement': '等待结算',
  settled: '本轮已结算',
};

export type TrimKind = 'cap';

export interface TrimEvent {
  kind: TrimKind;
  side: TeamId;
  /** 这一步是否由“双方持平”触发（固定平手规则：从后手乙队扣）。 */
  tieBreak: boolean;
  before: Record<TeamId, number>;
  after: Record<TeamId, number>;
  limit: number;
}

export interface RewardSplit {
  /** 参与按比例分配的总分。 */
  pool: number;
  /** 最终整数分（已含余数分配）。 */
  base: Record<TeamId, number>;
  /** 按比例取整后剩下的点数（两队时只可能是 0 或 1）。 */
  remainder: number;
  remainderTo: TeamId | null;
  /** 放下第 severity 个单位的一方；余数点归此人。 */
  finisher: TeamId | null;
}

/** 单台设备一份“可核对”的结算结果。 */
export interface DeviceSettlement {
  deviceId: string;
  name: string;
  severity: number;
  cap: number;
  reward: number;
  /** 双方原始派工。 */
  raw: Record<TeamId, number>;
  /** 扣除超过设备上限的工时后。 */
  capped: Record<TeamId, number>;
  /** 扣除超额维修后、真正计入修复的工时。 */
  used: Record<TeamId, number>;
  /** 因超过上限被作废的工时。 */
  trimmed: Record<TeamId, number>;
  /** 修复阈值已满后多派、不计分的工时。 */
  overRepair: Record<TeamId, number>;
  progress: number;
  repaired: boolean;
  /** 作废后第一个计入修复的单位来自哪一方（投入较少者先，相同则甲队）。 */
  first: TeamId;
  /** 作废后的逐单位放入顺序；counted 之前计入修复，之后为超额维修。 */
  order: TeamId[];
  counted: number;
  /** 在固定的交错计入顺序中，放下第 severity 个单位的一方。 */
  finisher: TeamId | null;
  rewardPool: number;
  rewardSplit: RewardSplit | null;
  awarded: Record<TeamId, number>;
  /** 双方计入的有效工时相同（且设备修复）时为 true。 */
  tie: boolean;
  /** 超上限作废时是否使用过平手规则。 */
  tieTrimUsed: boolean;
  trims: TrimEvent[];
  /** 逐条中文核对记录。 */
  steps: string[];
}

export interface RoundRecord {
  id: string;
  round: number;
  seed: string;
  budget: number;
  devices: Device[];
  /** 结算后公开的两队投入。 */
  plans: Record<TeamId, Allocation>;
  settlements: DeviceSettlement[];
  totals: Record<TeamId, number>;
  submittedAt: Record<TeamId, number>;
  settledAt: number;
  rulesVersion: string;
  checksum: string;
}

export interface ReplayResult {
  matches: boolean;
  checksumMatches: boolean;
  totalsMatch: boolean;
  settlementsMatch: boolean;
  replayed: RoundRecord;
  comparison: string;
}

export interface CurrentRound {
  round: number;
  seed: string;
  devices: Device[];
  phase: Phase;
  drafts: Record<TeamId, TeamDraft>;
  createdAt: number;
}

export interface GameState {
  version: 1;
  baseSeed: string;
  preset: PresetKey;
  budget: number;
  current: CurrentRound;
  /** 只存放已结算、已公开的轮次；新一轮私有草稿不在其中。 */
  history: RoundRecord[];
}

export interface PersistedGame {
  schemaVersion: 1;
  savedAt: number;
  state: GameState;
}

export interface HistoryEntry {
  id: string;
  round: number;
  seed: string;
  totals: Record<TeamId, number>;
  checksum: string;
  settledAt: number;
  /** 已结算轮次的完整记录；已公开，因此可以出现在普通历史里。 */
  record: RoundRecord;
}

export interface HandoffView {
  team: TeamId;
  title: string;
  detail: string;
  /** 上一位玩家是否已经密封提交（用于文案，绝不包含其选择）。 */
  previousSubmitted: boolean;
}

export interface EditingView {
  team: TeamId;
  allocations: Record<string, number>;
  spent: number;
  budget: number;
  sealed: boolean;
  /** 固定场景下是否提供了内置示例分工。 */
  exampleAvailable: boolean;
}

export interface AwaitingView {
  submitted: Record<TeamId, boolean>;
  detail: string;
}

export interface SettledView {
  record: RoundRecord;
  totals: Record<TeamId, number>;
  /** 重播结果，用于界面上展示“同一记录 → 同一分值”。 */
  replay: ReplayResult;
  plans: Record<TeamId, Record<string, number>>;
}

/**
 * 视图模型：界面只能消费它，而不直接读 GameState。
 * 该结构按阶段只包含“当前玩家有权看到”的信息。
 */
export interface ViewModel {
  baseSeed: string;
  preset: PresetKey;
  presetName: string;
  round: number;
  seed: string;
  budget: number;
  devices: Device[];
  phase: Phase;
  phaseLabel: string;
  submitted: Record<TeamId, boolean>;
  submittedAt: Record<TeamId, number | null>;
  handoff: HandoffView | null;
  editing: EditingView | null;
  awaiting: AwaitingView | null;
  settled: SettledView | null;
  history: HistoryEntry[];
  pendingRecordCount: number;
  autosaveKey: string;
}

export type PresetKey = 'contested' | 'one-short' | 'random';

export interface ScenarioDefinition {
  key: PresetKey;
  name: string;
  summary: string;
  budget: number;
  /** 固定场景的设备；random 场景由种子生成。 */
  devices: Device[] | null;
  /** 内置示例分工（仅固定场景、且设备仍是该场景那几台时可用）。 */
  examplePlans?: Record<TeamId, Allocation>;
  exampleNote?: string;
}
