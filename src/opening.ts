import type {
  CardInstance,
  Deck,
  EligibilityStatus,
  GoalCheck,
  MulliganPolicy,
  OpeningGoal,
  DrawTrace,
} from './types';
import { CURRENT_POOL, RULES, type PoolVersion } from './pool';
import { expandZone } from './deckUtils';
import { makeRng, mulberry32, shuffleInPlace } from './rng';

// ---------------------------------------------------------------------------
// 起手资格
// ---------------------------------------------------------------------------

/** 评估起手中所有带 opening 规则的牌（按 cardId 去重）的出场资格。 */
export function eligibilityInHand(hand: CardInstance[], pool: PoolVersion = CURRENT_POOL): EligibilityStatus[] {
  const ids = new Set(hand.map((c) => c.cardId));
  const factions = hand.map((c) => pool.cardById.get(c.cardId)?.faction);
  const out: EligibilityStatus[] = [];
  const seen = new Set<string>();

  for (const inst of hand) {
    if (seen.has(inst.cardId)) continue;
    seen.add(inst.cardId);
    const card = pool.cardById.get(inst.cardId);
    if (!card?.opening) continue;
    const rule = card.opening;
    if (rule.kind === 'partner') {
      const ok = ids.has(rule.partnerId);
      const p = pool.cardById.get(rule.partnerId);
      out.push({
        cardId: card.id,
        enabled: ok,
        reason: ok ? `起手已包含「${p?.name ?? rule.partnerId}」，搭配成立` : `需要起手同时持有「${p?.name ?? rule.partnerId}」`,
      });
    } else {
      // 「另有」：减去这张牌自身所属的一个实例
      const count = factions.filter((f) => f === rule.faction).length - 1;
      const ok = count >= rule.count;
      const fname = rule.faction;
      out.push({
        cardId: card.id,
        enabled: ok,
        reason: ok
          ? `起手另有 ${count} 张同需阵营牌（要求 ≥${rule.count}）`
          : `起手另有 ${Math.max(count, 0)} 张${FACTION_LABEL[fname]}牌，还需 ${rule.count - Math.max(count, 0)} 张`,
      });
    }
  }
  return out;
}

const FACTION_LABEL: Record<string, string> = { crimson: '赤焰', tide: '苍澜', grove: '森罗', neutral: '中立' };

// ---------------------------------------------------------------------------
// 开局目标
// ---------------------------------------------------------------------------

export function evaluateGoal(goal: OpeningGoal, hand: CardInstance[], pool: PoolVersion = CURRENT_POOL): GoalCheck[] {
  const has = (id: string) => hand.some((c) => c.cardId === id);
  const name = (id: string) => pool.cardById.get(id)?.name ?? id;

  switch (goal.kind) {
    case 'combo': {
      return goal.cardIds.map((id) => ({
        pass: has(id),
        label: `♦ ${name(id)}`,
        detail: has(id) ? '已在起手' : '不在起手',
      }));
    }
    case 'card-enabled': {
      const card = pool.cardById.get(goal.cardId);
      const inHand = has(goal.cardId);
      const elig = eligibilityInHand(hand, pool).find((e) => e.cardId === goal.cardId);
      return [
        { pass: inHand, label: `起手有 ♦ ${name(goal.cardId)}`, detail: inHand ? '已抽到' : '没抽到' },
        {
          pass: inHand && !!elig?.enabled,
          label: `♦ ${name(goal.cardId)} 的出场搭配成立`,
          detail: !inHand ? '牌不在起手，无法判定出场资格' : elig ? elig.reason : card?.opening?.text ?? '该牌没有额外资格要求',
        },
      ];
    }
    case 'faction-count': {
      const n = hand.filter((c) => pool.cardById.get(c.cardId)?.faction === goal.faction).length;
      return [
        {
          pass: n >= goal.count,
          label: `起手 ${FACTION_LABEL[goal.faction]}牌 ≥ ${goal.count}`,
          detail: `当前 ${n} 张`,
        },
      ];
    }
    case 'any': {
      const subResults = goal.goals.map((g) => ({ g, checks: evaluateGoal(g, hand, pool) }));
      const passed = subResults.find((r) => r.checks.every((c) => c.pass));
      return [
        {
          pass: !!passed,
          label: goal.label,
          detail: passed ? `满足分支：${passed.g.label}` : ` ${goal.goals.length} 个分支均未达成`,
        },
      ];
    }
  }
}

export function goalPasses(goal: OpeningGoal, hand: CardInstance[], pool: PoolVersion = CURRENT_POOL): boolean {
  return evaluateGoal(goal, hand, pool).every((c) => c.pass);
}

/** 智能留牌策略：尽量保留对开局目标有贡献的牌，其余换掉（仅模拟用）。 */
export function suggestMulligan(goal: OpeningGoal, hand: CardInstance[], pool: PoolVersion = CURRENT_POOL): CardInstance[] {
  const keepIds = new Set<string>();
  const keepFactions = new Set<string>();

  const planFor = (g: OpeningGoal) => {
    if (g.kind === 'combo') g.cardIds.forEach((id) => keepIds.add(id));
    else if (g.kind === 'card-enabled') {
      keepIds.add(g.cardId);
      const card = pool.cardById.get(g.cardId);
      if (card?.opening?.kind === 'partner') keepIds.add(card.opening.partnerId);
      if (card?.opening?.kind === 'faction-other') keepFactions.add(card.opening.faction);
    } else if (g.kind === 'faction-count') keepFactions.add(g.faction);
    else g.goals.forEach(planFor);
  };
  planFor(goal);

  const mull = hand.filter((c) => {
    if (keepIds.has(c.cardId)) return false;
    const f = pool.cardById.get(c.cardId)?.faction;
    if (f && keepFactions.has(f)) return false;
    return true;
  });
  // 目标尚未达成时不允许「一张都不换」的假策略
  return mull.length === 0 ? hand.slice() : mull;
}

// ---------------------------------------------------------------------------
// 可交互的起手会话（固定种子，最多一次换手）
// ---------------------------------------------------------------------------

export interface OpeningSession {
  seedText: string;
  seedNum: number;
  rng: () => number;
  hand: CardInstance[];
  library: CardInstance[];
  mulliganUsed: boolean;
  lastMulligan?: { sentBack: CardInstance[]; drawn: CardInstance[] };
}

export function createSession(deck: Deck, seedText: string, pool: PoolVersion = CURRENT_POOL): OpeningSession {
  const { seedNum, rng } = makeRng(seedText);
  const all = shuffleInPlace(expandZone(deck, 'main', pool), rng);
  const hand = all.splice(0, RULES.openingHandSize);
  return { seedText, seedNum, rng, hand, library: all, mulliganUsed: false };
}

/** 一次按规则换手：选中的牌洗回牌库，再抽等量。整局只能调用一次。 */
export function applyMulligan(session: OpeningSession, iids: number[]): OpeningSession {
  if (session.mulliganUsed) return session;
  const chosen = new Set(iids);
  const sentBack = session.hand.filter((c) => chosen.has(c.iid));
  if (sentBack.length === 0) return session;

  const kept = session.hand.filter((c) => !chosen.has(c.iid));
  const library = shuffleInPlace([...session.library, ...sentBack], session.rng);
  const drawn = library.splice(0, sentBack.length);
  return {
    ...session,
    hand: [...kept, ...drawn],
    library,
    mulliganUsed: true,
    lastMulligan: { sentBack, drawn },
  };
}

// ---------------------------------------------------------------------------
// 种子试抽：同一 seedNum 对每个牌组都是独立、确定的一局
// ---------------------------------------------------------------------------

export function trialForSeed(
  deck: Deck,
  seedNum: number,
  policy: MulliganPolicy,
  pool: PoolVersion = CURRENT_POOL,
): DrawTrace {
  const rng = mulberry32(seedNum >>> 0);
  const all = shuffleInPlace(expandZone(deck, 'main', pool), rng);
  const initial = all.splice(0, RULES.openingHandSize);
  const firstChecks = evaluateGoal(deck.goal, initial, pool);
  const firstPass = firstChecks.every((c) => c.pass);

  let finalHand = initial;
  let mulliganed: CardInstance[] = [];
  let drawn: CardInstance[] = [];

  if (!firstPass && policy !== 'none') {
    const toMull =
      policy === 'all' ? initial.slice() : suggestMulligan(deck.goal, initial, pool);
    const iids = new Set(toMull.map((c) => c.iid));
    mulliganed = toMull;
    const kept = initial.filter((c) => !iids.has(c.iid));
    const library = shuffleInPlace([...all, ...toMull], rng);
    drawn = library.splice(0, toMull.length);
    finalHand = [...kept, ...drawn];
  }

  const finalChecks = evaluateGoal(deck.goal, finalHand, pool);
  const finalPass = finalChecks.every((c) => c.pass);

  return {
    seedKey: String(seedNum),
    seedNum,
    initial,
    mulliganed,
    kept: initial.filter((c) => !new Set(mulliganed.map((m) => m.iid)).has(c.iid)),
    drawn,
    finalHand,
    firstChecks,
    finalChecks,
    firstPass,
    finalPass,
    policy,
  };
}
