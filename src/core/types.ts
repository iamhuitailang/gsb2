/**
 * 核心领域模型：语言包、句式、触发样例、质检问题与渲染结果。
 * 该文件不依赖 DOM / Node API，浏览器 bundle 与 CLI 共用。
 */

export type Locale = string;

/** 游戏约定的数量句式桶（0 在本项目中优先走 zero，再按 CLDR 规则） */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/** 说话对象 / 角色称呼类别 */
export type AddressKind = 'oldfriend' | 'captain' | 'kid' | 'stranger';

/** 物品类别：中文量词、外文变格都可能按它分支 */
export type ItemCategory = 'potion' | 'weapon' | 'food' | 'material';

export type VarType = 'string' | 'number' | 'integer' | 'boolean';

export type VarValue = string | number | boolean | null | undefined;

/** 一条句式的触发条件；缺省字段表示“不限” */
export interface FormWhen {
  count?: PluralCategory;
  address?: AddressKind;
  category?: ItemCategory;
}

export interface MessageForm {
  when: FormWhen;
  text: string;
  /** 给译者/质检看的句式说明 */
  note?: string;
}

export interface ParamSpec {
  type: VarType;
  /** 默认 true；false 时允许样例不提供该变量 */
  required?: boolean;
}

export interface MessageEntry {
  id: string;
  description: string;
  /** 变量契约：名称 -> 期望类型 */
  params?: Record<string, ParamSpec>;
  forms: MessageForm[];
}

export interface LanguagePack {
  locale: Locale;
  label: string;
  /** 基准语言（变量集合以它选中的句式为参照） */
  isReference?: boolean;
  /** 跨语言回退约定，通常指向 en-US */
  fallbackLocale?: Locale;
  terms: {
    /** 称呼类别 -> 该语言下的具体称呼词 */
    address: Record<AddressKind, string>;
  };
  entries: Record<string, MessageEntry>;
}

export interface CharacterDef {
  id: string;
  /** 该角色决定使用哪一类称呼句式 */
  address: AddressKind;
  name: Record<Locale, string>;
}

export interface ItemDef {
  id: string;
  category: ItemCategory;
  name: Record<Locale, string>;
}

/**
 * 触发样例：一次具体的游戏上下文。
 * 质检报告中的“触发样例”就是它。
 */
export interface TriggerSample {
  id: string;
  eventId: string;
  lineId: string;
  label: string;
  entryId: string;
  speakerId?: string;
  characterId?: string;
  itemId?: string;
  count?: number;
  /** 事件自带的额外变量（报酬、地点等），类型错误通常埋在这里 */
  vars?: Record<string, unknown>;
  /** 批量预演时是否允许控制台覆盖角色/物品/数量，默认 true */
  rehearse?: boolean;
}

/** 页面批量预演控制台给出的覆盖上下文 */
export interface RehearsalControls {
  locale: Locale;
  characterId: string;
  itemId: string;
  count: number;
}

export type SourceVia =
  | 'exact' // 精确命中专用句式
  | 'generic-form' // 缺少称呼/类别专用句式，落到不限定的通用句式
  | 'count-fallback' // 缺少 zero/one/... 数量式，按约定落到 other / 通用句
  | 'locale-fallback' // 本语言没有可用条目，跨语言回退
  | 'missing'; // 整条回退链都失败

export interface FormSource {
  locale: Locale;
  entryId: string;
  /** 实际命中的条件；null 表示条目缺失 */
  when: FormWhen | null;
  formIndex: number;
  via: SourceVia;
  /** 是否属于“非本语言专用句式”的回退（跨语言一定为 true） */
  isFallback: boolean;
  /** 人类可读的回退轨迹 */
  hops: string[];
  /** 稳定的来源坐标，用于 diff 判断“仅来源变了” */
  signature: string;
  label: string;
}

export type IssueKind =
  | 'var-missing'
  | 'var-extra'
  | 'type-mismatch'
  | 'unreached-form'
  | 'fallback-used'
  | 'missing-entry';

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface QaIssue {
  kind: IssueKind;
  /** 机器可读的细类，如 placeholder-dropped / placeholder-undeclared / value-unused */
  code: string;
  severity: IssueSeverity;
  /** '*' 表示样例数据问题，影响所有语言 */
  locale: Locale | '*';
  entryId: string;
  sampleId?: string;
  sampleLabel?: string;
  eventId?: string;
  when?: FormWhen;
  message: string;
  expected?: string;
  actual?: string;
  /** 复现用的触发上下文 */
  trigger?: Record<string, unknown>;
  /** 未走到的句式：建议补的触发样例 */
  suggestedTrigger?: string;
  /** 同一缺陷聚合了多少个触发样例 */
  sampleCount?: number;
  relatedSampleIds?: string[];
}

export interface TemplatePart {
  type: 'text' | 'var';
  value: string;
  varName?: string;
  state?: 'ok' | 'missing' | 'bad-type';
  shown?: string;
}

export interface RenderResult {
  sampleId: string;
  eventId: string;
  lineId: string;
  entryId: string;
  locale: Locale;
  ok: boolean;
  /** 纯文本结果（用于 CLI / diff / 导出） */
  text: string;
  parts: TemplatePart[];
  source: FormSource;
  issues: QaIssue[];
  values: Record<string, unknown>;
  placeholders: string[];
}

export interface SnapshotRow {
  sampleId: string;
  sampleLabel: string;
  eventId: string;
  entryId: string;
  locale: Locale;
  text: string;
  sourceSignature: string;
  sourceLabel: string;
  ok: boolean;
}

export type DiffStatus = 'unchanged' | 'text-changed' | 'source-only' | 'status-changed';

export interface DiffRow {
  key: string;
  sampleId: string;
  sampleLabel: string;
  eventId: string;
  entryId: string;
  status: DiffStatus;
  before: SnapshotRow;
  after: SnapshotRow;
}

export interface DiffReport {
  locale: Locale;
  generatedAt: string;
  total: number;
  textChanged: DiffRow[];
  sourceOnly: DiffRow[];
  statusChanged: DiffRow[];
  unchangedCount: number;
  rows: DiffRow[];
}
