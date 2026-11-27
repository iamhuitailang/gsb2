import { streamFor } from './rng.js';
import type {
  ClanRules,
  NamingRules,
  ProvenanceEntry,
  Resident,
  ResidentSpec,
} from './types.js';
import { ExhaustedError } from './types.js';

/** 单个居民最多尝试次数：超过即认为词库组合耗尽。 */
const MAX_ATTEMPTS = 256;

export function getClan(rules: NamingRules, clanId: string): ClanRules {
  const clan = rules.clans.find((c) => c.id === clanId);
  if (!clan) throw new Error(`未知族群: ${clanId}`);
  return clan;
}

/** 检查 姓+名 是否触犯某条声节禁忌，返回触犯的规则（未触犯返回 null）。 */
export function compatViolation(
  clan: ClanRules,
  surname: string,
  given: string,
): { ruleIndex: number; note: string } | null {
  const s = surname.toLowerCase();
  const g = given.toLowerCase();
  for (let i = 0; i < clan.incompatible.length; i++) {
    const r = clan.incompatible[i]!;
    if (s.endsWith(r.surnameEnding.toLowerCase()) && g.startsWith(r.givenInitial.toLowerCase())) {
      return { ruleIndex: i, note: r.note };
    }
  }
  return null;
}

export function joinName(surname: string, given: string, suffix: string | null): string {
  return `${surname} ${given}${suffix ?? ''}`;
}

export interface GenerateContext {
  townId: string;
  seed: string;
  rules: NamingRules;
  /** 查询某个全名当前在城里的撞名数（用于撞车限制） */
  countFullName: (fullName: string) => number;
  /** 继承到的姓（来自父家或母家）；无则自行抽取 */
  inheritedSurname?: { surname: string; side: 'father' | 'mother' };
}

/**
 * 为单个居民生成名字。
 * 随机流只依赖 (seed, townId, residentId)，与其他居民无关：
 * 因此新增居民不会改变已有居民的名字（追加稳定），
 * 同一 (规则, 种子, 操作序列) 重放结果完全一致（可重建）。
 */
export function generateResident(spec: ResidentSpec, ctx: GenerateContext): Resident {
  // 迁居居民：名字原样保留，只追加迁居来历
  if (spec.migratedFrom) {
    const m = spec.migratedFrom;
    return {
      ...spec,
      surname: m.surname,
      given: m.given,
      suffix: m.suffix,
      fullName: m.name,
      originTownId: m.townId,
      provenance: [
        ...m.provenance,
        { rule: 'migrate:keep', detail: `自 ${m.townId} 迁居，保留原名 ${m.name}` },
      ],
    };
  }

  const clan = getClan(ctx.rules, spec.clanId);
  const stream = streamFor(ctx.seed, ctx.townId, spec.id);
  const swaps: ProvenanceEntry[] = [];

  // 定姓 + 定名 + 定后缀在同一个重试循环里：
  // 触犯声节禁忌或全名撞车时按规则换词（未继承时连姓也可以换），
  // 只推进本人的随机流，不影响其他居民。
  let surname = ctx.inheritedSurname?.surname ?? '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!ctx.inheritedSurname) surname = stream.pick(clan.surnames);
    const given = stream.pick(clan.givens);
    const suffix = clan.suffixOptional && stream.int(2) === 0 ? null : stream.pick(clan.suffixes);

    const violation = compatViolation(clan, surname, given);
    if (violation) {
      swaps.push({
        rule: 'compat:swap',
        detail: `${surname}+${given} 触犯禁忌「${violation.note}」，换词重抽`,
      });
      continue;
    }

    const fullName = joinName(surname, given, suffix);
    if (ctx.countFullName(fullName) > ctx.rules.maxFullNameCollisions) {
      swaps.push({
        rule: 'collision:retry',
        detail: `全名 ${fullName} 在城内撞车超过上限，换词重抽`,
      });
      continue;
    }

    const provenance: ProvenanceEntry[] = [];
    if (ctx.inheritedSurname) {
      provenance.push({
        rule: `inherit:${ctx.inheritedSurname.side}`,
        detail: `继承${ctx.inheritedSurname.side === 'father' ? '父' : '母'}家姓 ${surname}`,
      });
    } else {
      provenance.push({
        rule: `clan:${clan.id}.surname`,
        detail: `从${clan.label}姓氏词库抽取 ${surname}`,
      });
    }
    provenance.push(...swaps);
    provenance.push({
      rule: `clan:${clan.id}.given`,
      detail: `从${clan.label}名字词库抽取 ${given}`,
    });
    provenance.push({
      rule: `clan:${clan.id}.suffix`,
      detail: suffix ? `取后缀 ${suffix}` : '按规则省略后缀',
    });

    return {
      ...spec,
      surname,
      given,
      suffix,
      fullName,
      originTownId: ctx.townId,
      provenance,
    };
  }

  throw new ExhaustedError(ctx.townId, clan.id, spec.id);
}

/** 一个族群在规则下的理论组合容量（姓×合法名×后缀选项）。 */
export function clanCapacity(clan: ClanRules): number {
  const suffixOptions = clan.suffixes.length + (clan.suffixOptional ? 1 : 0);
  let combos = 0;
  for (const surname of clan.surnames) {
    for (const given of clan.givens) {
      if (!compatViolation(clan, surname, given)) combos += suffixOptions;
    }
  }
  return combos;
}
