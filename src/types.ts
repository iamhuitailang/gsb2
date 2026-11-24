/**
 * 资源包解析试验场 —— 领域模型
 *
 * 一个「道具」(item) 在某个「场景 × 语言」查询下，
 * 经过一组有优先级、有依赖、可移除资源的资源包解析，
 * 最终确定实际使用的图片（这里用色块 SVG 模拟）。
 */

export type PackKind = 'base' | 'replace' | 'language';

/** 色块演示图的生成参数，必须可 JSON 序列化（导出 / 导入需要） */
export interface BlockStyle {
  /** 主色 / 副色（可选第三色），使用 #rrggbb */
  colors: string[];
  pattern: 'solid' | 'stripe' | 'dots' | 'grid' | 'diagonal' | 'ring';
  /** 色块中央绘制的短文字，如「剑」「HP」 */
  glyph: string;
  /** 图案与文字的强调色，默认白色 */
  ink?: string;
}

/**
 * 一个具体变体。
 * scene / lang 既可以是具体值（world、zh-CN），也可以是 '*' 通配键；
 * lang 允许填主语言标签（如 zh），查询 zh-CN 时会经语言回退命中。
 */
export interface Variant {
  scene: string;
  lang: string;
  block: BlockStyle;
  note?: string;
}

/** 显式移除规则：把某道具（可限定场景 / 语言范围）从覆盖结果中删掉 */
export interface RemovalRule {
  item: string;
  /** '*' 表示所有场景 */
  scene?: string;
  /** '*' 表示所有语言；也可填 zh 这类主标签 */
  lang?: string;
  reason?: string;
}

/** 资源包清单（manifest） */
export interface PackManifest {
  id: string;
  name: string;
  kind: PackKind;
  version: string;
  /** 数值越大优先级越高；同值即「同级」，多个同级包对同一道具表态会判为冲突 */
  priority: number;
  description?: string;
  /** UI 上包标识条的颜色 */
  accent?: string;
  /** 依赖的其他包 id */
  dependencies?: string[];
  /** itemId -> 变体列表 */
  resources?: Record<string, Variant[]>;
  removals?: RemovalRule[];
  /** 演示数据里用于批量应用面板的标记，不参与解析 */
  batchCandidate?: boolean;
}

export interface ItemDef {
  id: string;
  name: string;
  category: string;
}

export interface SceneDef {
  id: string;
  name: string;
}

export interface LanguageDef {
  id: string;
  name: string;
}

/* ------------------------------ 依赖校验 ------------------------------ */

export type PackIssueCode =
  | 'missing-dependency' // 依赖的包在库中根本不存在（缺依赖）
  | 'dependency-disabled' // 依赖存在，但当前未开启
  | 'dependency-invalid' // 依赖已开启，但其自身不可用（成环 / 缺依赖）
  | 'cycle'; // 该包处于依赖环中

export interface PackIssue {
  code: PackIssueCode;
  /** 面向用户的中文说明 */
  message: string;
  depId?: string;
  /** 成环时的完整路径，如 a -> b -> a */
  cyclePath?: string;
}

export interface PackStatus {
  pack: PackManifest;
  enabled: boolean;
  /** 清单级问题：缺依赖（库中不存在）、依赖成环。与是否开启无关，始终展示 */
  manifestIssues: PackIssue[];
  /** 运行时问题：依赖未开启 / 依赖不可用。仅在包开启时有实际影响 */
  runtimeIssues: PackIssue[];
  /** 开启且没有任何阻断问题时才可用（才会参与解析） */
  usable: boolean;
}

export interface CycleInfo {
  nodes: string[];
  path: string;
}

/* ------------------------------ 解析追踪 ------------------------------ */

export type RungState =
  | 'miss' // 该回退层级未命中
  | 'hit-selected' // 命中并最终被采用
  | 'hit-tie-loser' // 命中，但同级冲突中落选
  | 'hit-overridden' // 本层命中，但被更高优先级包盖过
  | 'removal-selected' // 移除规则生效（最终）
  | 'removal-tie-loser'
  | 'removal-overridden'
  | 'not-reached'; // 包内在更早层级已有结论，后续层级不再检查

export interface RungTrace {
  index: number;
  sceneKey: string;
  langKey: string;
  /** 层级的人类可读名称，如「场景精确 · 语言主标签回退(zh)」 */
  label: string;
  state: RungState;
  reason: string;
  variant?: Variant;
}

export type PackOutcome =
  | 'won' // 本包提供最终图片
  | 'removed' // 本包执行了最终移除
  | 'tie-winner' // 同级冲突中按确定性规则胜出
  | 'tie-loser' // 同级冲突中落选
  | 'overridden' // 有候选但被更高优先级压过
  | 'missed' // 包内所有层级都没找到
  | 'skipped-disabled' // 包未开启
  | 'skipped-unusable'; // 包不可用（缺依赖 / 成环等），跳过

export interface PackTrace {
  packId: string;
  packName: string;
  kind: PackKind;
  priority: number;
  enabled: boolean;
  usable: boolean;
  outcome: PackOutcome;
  outcomeReason: string;
  /** 被跳过时的问题说明 */
  skipIssues?: string[];
  rungs: RungTrace[];
}

export type ResolveStatus = 'found' | 'conflict' | 'removed' | 'missing';

export interface ConflictInfo {
  priority: number;
  /** 同级且都对该道具有表态的包，按确定性顺序排列 */
  packIds: string[];
  chosenPackId: string;
  /** 冲突裁决说明，例如「按匹配精度，赤包的 battle 变体更精确」 */
  resolution: string;
}

export interface ResolvedItem {
  itemId: string;
  status: ResolveStatus;
  /** found / conflict 且有图时的最终图源包 */
  winnerPackId?: string;
  winnerVariant?: Variant;
  winnerRungLabel?: string;
  /** removed / conflict 裁决为移除时 */
  removedByPackId?: string;
  removalRule?: RemovalRule;
  conflict?: ConflictInfo;
  /** 每个包的逐级追踪，按页面包堆栈顺序 */
  trace: PackTrace[];
}

/* ---------------------------- 来源清单 / 导入导出 ---------------------------- */

export interface ProvenanceRow {
  itemId: string;
  itemName: string;
  scene: string;
  language: string;
  status: ResolveStatus;
  sourcePackId: string | null;
  sourcePackName: string | null;
  /** 命中的完整键，如 world / zh-CN；未命中为 null */
  matchedSceneKey: string | null;
  matchedLangKey: string | null;
  removedByPackId: string | null;
  conflictPackIds: string[];
  block: BlockStyle | null;
}

/** 可序列化的当前配置 */
export interface LabConfig {
  query: { scene: string; language: string };
  selectedItemId: string;
  /** packId -> 是否开启（缺省视为清单默认开启状态） */
  enabled: Record<string, boolean>;
  /** packId -> 实际优先级（相对清单默认值可被 UI 调整） */
  priorities: Record<string, number>;
}

export interface ExportDoc {
  app: 'asset-pack-lab';
  schema: 1;
  exportedAt: string;
  config: LabConfig;
  items: ItemDef[];
  scenes: SceneDef[];
  languages: LanguageDef[];
  /** 完整包清单随文件导出，保证换一份内置库也能重现同一结果 */
  library: PackManifest[];
  /** 全量「道具 × 场景 × 语言」来源清单 */
  provenance: ProvenanceRow[];
}
