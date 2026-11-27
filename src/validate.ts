import type { Deck, DeckReport, RuleHit } from './types';
import { CURRENT_POOL, RULES, type PoolVersion } from './pool';
import { cardCounts, entryUidsForCard, isEntry, isUnresolved, zoneTotal } from './deckUtils';

/**
 * 牌组规则校验。所有错误都是结构化 RuleHit：
 * 带 cardId / coreCardId / entryUids，交换批次才能把错误归到原牌或换入牌。
 */
export function validateDeck(deck: Deck, pool: PoolVersion = CURRENT_POOL): DeckReport {
  const hits: RuleHit[] = [];
  const push = (h: RuleHit) => hits.push(h);

  // 1) 导入遗留：新版本卡池解析不了的牌 —— 最高优先级，且明确没有同名顶替。
  for (const e of [...deck.main, ...deck.sideboard]) {
    if (isUnresolved(e)) {
      const sameName = e.sameNameCandidates
        .map((id) => pool.cardById.get(id)?.name)
        .filter(Boolean);
      push({
        code: 'R-UNRESOLVED',
        severity: 'error',
        zone: deck.main.includes(e) ? 'main' : 'sideboard',
        entryUids: [e.uid],
        cardId: e.cardId,
        message:
          `「${e.exportedName}」在当前卡池 ${pool.version} 中不存在（导出 id：${e.cardId}）。` +
          (sameName.length
            ? `发现同名新牌「${sameName.join('、')}」但 id 不同，未自动替换；请手动决定映射或保留缺失。`
            : '没有找到可映射的牌，未按名字猜测替换。'),
      });
      continue;
    }

    const card = pool.cardById.get(e.cardId);
    if (!card) {
      push({
        code: 'R-UNRESOLVED',
        severity: 'error',
        message: `条目 ${e.cardId} 无法在卡池 ${pool.version} 中解析。`,
        cardId: e.cardId,
        entryUids: [e.uid],
      });
      continue;
    }
    if (!card.printings.some((p) => p.id === e.printingId)) {
      push({
        code: 'R-PRINTING-MISSING',
        severity: 'error',
        cardId: card.id,
        printingId: e.printingId,
        entryUids: [e.uid],
        message: `「${card.name}」的印次 ${e.printingId} 在卡池 ${pool.version} 中不存在，印次不能被静默改写。`,
      });
    }
  }

  // 2) 区域数量：主牌正好 40，备选最多 10。
  const mainTotal = zoneTotal(deck.main);
  if (mainTotal !== RULES.mainSize) {
    push({
      code: 'R-DECK-SIZE',
      severity: 'error',
      zone: 'main',
      message: `主牌必须正好 ${RULES.mainSize} 张，当前 ${mainTotal} 张（差 ${mainTotal - RULES.mainSize}）。`,
    });
  }
  const sideTotal = zoneTotal(deck.sideboard);
  if (sideTotal > RULES.sideboardMax) {
    push({
      code: 'R-SIDE-SIZE',
      severity: 'error',
      zone: 'sideboard',
      message: `备选牌最多 ${RULES.sideboardMax} 张，当前 ${sideTotal} 张。`,
    });
  }

  // 3) 同名数量上限：同一 cardId 跨印次合并，主牌 / 备选分别结算。
  for (const zone of ['main', 'sideboard'] as const) {
    const entries = zone === 'main' ? deck.main : deck.sideboard;
    const counts = cardCounts(entries, pool);
    for (const [cardId, total] of counts) {
      const card = pool.cardById.get(cardId);
      if (!card) continue;
      if (total > card.limit) {
        push({
          code: 'R-COPY-LIMIT',
          severity: 'error',
          zone,
          cardId,
          entryUids: entryUidsForCard(entries, cardId),
          message:
            `${zone === 'main' ? '主牌' : '备选'}中「${card.name}」合计 ${total} 张` +
            `（不同印次共享上限 ${card.limit}），超出 ${total - card.limit} 张。`,
        });
      }
    }
  }

  // 4) 核心数量（只看主牌）：1–2 枚。
  const mainEntries = deck.main.filter(isEntry);
  const coreEntries = mainEntries.filter((e) => pool.cardById.get(e.cardId)?.type === 'core');
  const coreCount = coreEntries.reduce((s, e) => s + e.count, 0);
  if (coreCount < RULES.coreMin) {
    push({
      code: 'R-CORE-MIN',
      severity: 'error',
      zone: 'main',
      message: `牌组至少需要 ${RULES.coreMin} 枚核心牌，当前 ${coreCount} 枚。`,
      entryUids: coreEntries.map((e) => e.uid),
    });
  }
  if (coreCount > RULES.coreMax) {
    push({
      code: 'R-CORE-MAX',
      severity: 'error',
      zone: 'main',
      message: `核心牌最多 ${RULES.coreMax} 枚，当前 ${coreCount} 枚。`,
      entryUids: coreEntries.map((e) => e.uid),
    });
  }

  // 5) 核心阵营盟约：每枚核心逐一检查，多个核心 = 必须同时满足所有盟约。
  for (const coreEntry of coreEntries) {
    const core = pool.cardById.get(coreEntry.cardId);
    if (!core?.core) continue;
    const allied = new Set(core.core.allied);
    const badByCard = new Map<string, number>();
    for (const e of mainEntries) {
      if (e.uid === coreEntry.uid && e.cardId === core.id) continue;
      const c = pool.cardById.get(e.cardId);
      if (!c || c.faction === 'neutral') continue;
      if (!allied.has(c.faction)) {
        badByCard.set(c.id, (badByCard.get(c.id) ?? 0) + e.count);
      }
    }
    for (const [badCardId, n] of badByCard) {
      const bad = pool.cardById.get(badCardId);
      push({
        code: 'R-CORE-FACTION',
        severity: 'error',
        zone: 'main',
        coreCardId: core.id,
        cardId: badCardId,
        entryUids: entryUidsForCard(deck.main, badCardId),
        message:
          `核心「${core.name}」的盟约只允许 ${core.core.allied
            .map((f) => pool && FACTION_NAME[f])
            .join(' / ')} 同队；` +
          `「${bad?.name ?? badCardId}」×${n} 不在允许阵营内。`,
      });
    }
  }

  const errors = hits.filter((h) => h.severity === 'error');
  const warnings = hits.filter((h) => h.severity === 'warning');
  return { legal: errors.length === 0, errors, warnings, hits };
}

const FACTION_NAME: Record<string, string> = {
  crimson: '赤焰',
  tide: '苍澜',
  grove: '森罗',
  neutral: '中立',
};
