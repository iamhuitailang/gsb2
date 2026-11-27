import { compatViolation, getClan } from './generator.js';
import type { NamingRules, Resident } from './types.js';

export interface NameViolation {
  residentId: string;
  fullName: string;
  grandfathered: boolean;
  reasons: string[];
}

/** 用一套规则校验一个已生成的名字，返回不符合之处（空数组 = 符合）。 */
export function validateAgainst(resident: Resident, rules: NamingRules): string[] {
  const reasons: string[] = [];
  const clan = rules.clans.find((c) => c.id === resident.clanId);
  if (!clan) {
    return [`族群 ${resident.clanId} 在新规则中已不存在`];
  }
  if (!clan.surnames.includes(resident.surname)) {
    reasons.push(`姓氏 ${resident.surname} 不在${clan.label}新姓氏词库中`);
  }
  if (!clan.givens.includes(resident.given)) {
    reasons.push(`名字 ${resident.given} 不在${clan.label}新名字词库中`);
  }
  if (resident.suffix === null) {
    if (!clan.suffixOptional) reasons.push('新规则要求必须带后缀');
  } else if (!clan.suffixes.includes(resident.suffix)) {
    reasons.push(`后缀 ${resident.suffix} 不在新后缀词库中`);
  }
  const violation = compatViolation(clan, resident.surname, resident.given);
  if (violation) {
    reasons.push(`触犯新禁忌「${violation.note}」`);
  }
  return reasons;
}

/**
 * 规则更新前预览：哪些旧名字在新规则下不再符合。
 * 已标记 grandfathered 的居民单独列出，默认不强制改名。
 */
export function previewRuleUpdate(
  residents: readonly Resident[],
  newRules: NamingRules,
): { violations: NameViolation[]; grandfatheredViolations: NameViolation[]; cleanCount: number } {
  const violations: NameViolation[] = [];
  const grandfatheredViolations: NameViolation[] = [];
  let cleanCount = 0;
  for (const r of residents) {
    const reasons = validateAgainst(r, newRules);
    if (reasons.length === 0) {
      cleanCount++;
    } else {
      const entry: NameViolation = {
        residentId: r.id,
        fullName: r.fullName,
        grandfathered: r.grandfathered === true,
        reasons,
      };
      (r.grandfathered ? grandfatheredViolations : violations).push(entry);
    }
  }
  return { violations, grandfatheredViolations, cleanCount };
}

/**
 * 应用规则更新：
 * - 指定 grandfather 的居民打上“沿用旧名”标记，不批量改名；
 * - 其余居民保持原名（是否改名由调用方决定，本库绝不静默改写老名字）；
 * - 之后新生成的居民一律走新规则。
 */
export function applyRuleUpdate(
  residents: Resident[],
  newRules: NamingRules,
  grandfatherIds: string[],
): { grandfathered: string[] } {
  const marked: string[] = [];
  for (const id of grandfatherIds) {
    const r = residents.find((x) => x.id === id);
    if (!r) throw new Error(`applyRuleUpdate: 没有居民 ${id}`);
    r.grandfathered = true;
    marked.push(id);
  }
  return { grandfathered: marked };
}

export { getClan };
