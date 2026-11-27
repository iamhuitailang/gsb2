/** 核心数据模型：规则、居民规格、生成结果、城镇状态。 */

/** 声节不兼容规则：姓氏尾音 + 名字首音 不允许相邻。 */
export interface CompatRule {
  /** 姓氏结尾（小写匹配，如 "n"、"ash"） */
  surnameEnding: string;
  /** 名字开头（小写匹配，如 "n"、"sh"） */
  givenInitial: string;
  /** 人类可读的禁忌说明 */
  note: string;
}

/** 一个族群的命名规则。 */
export interface ClanRules {
  id: string;
  label: string;
  surnames: string[];
  givens: string[];
  /** 后缀列表（如 "-rok"、"二世"）；suffixOptional 为真时允许无后缀 */
  suffixes: string[];
  suffixOptional: boolean;
  incompatible: CompatRule[];
}

/** 一套完整命名规则（可整体版本化、替换）。 */
export interface NamingRules {
  version: number;
  clans: ClanRules[];
  /** 同城允许的全名撞车上限：0 = 全名必须唯一；姓氏撞车永远允许 */
  maxFullNameCollisions: number;
}

export interface ProvenanceEntry {
  /** 规则标识，如 "clan:yan.surname"、"inherit:father"、"compat:swap"、"collision:retry" */
  rule: string;
  detail: string;
}

/**
 * 居民规格：重建名册所需的全部输入。
 * 生成结果（姓氏/名字/后缀）不放进规格，保证 replay 可验证。
 */
export interface ResidentSpec {
  id: string;
  clanId: string;
  fatherId?: string;
  motherId?: string;
  /** 继承哪一边的姓；auto 时由该居民自己的随机流决定 */
  inheritFrom?: 'father' | 'mother' | 'auto';
  /** 迁居来源：原样保留旧城的名字与来历 */
  migratedFrom?: {
    townId: string;
    name: string;
    surname: string;
    given: string;
    suffix: string | null;
    provenance: ProvenanceEntry[];
  };
}

export interface Resident extends ResidentSpec {
  surname: string;
  given: string;
  suffix: string | null;
  fullName: string;
  /** 出生/原籍城镇；迁居后仍保留 */
  originTownId: string;
  provenance: ProvenanceEntry[];
  /** 规则更新后被标记“沿用旧名”，不参与批量改名 */
  grandfathered?: boolean;
}

/** 可持久化的城镇完整状态。 */
export interface TownState {
  townId: string;
  seed: string;
  rules: NamingRules;
  residents: Resident[];
  nextSerial: number;
}

/** 词库/组合耗尽时抛出，指明卡住的族群。 */
export class ExhaustedError extends Error {
  constructor(
    public readonly townId: string,
    public readonly clanId: string,
    public readonly residentId: string,
  ) {
    super(`城镇 ${townId} 的族群 ${clanId} 词库组合已用尽，无法为 ${residentId} 生成不冲突的名字`);
    this.name = 'ExhaustedError';
  }
}
