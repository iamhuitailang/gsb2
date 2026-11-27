import type {
  Deck,
  DeckEntry,
  DeckReport,
  RuleHit,
  SwapPair,
} from './types';
import { CURRENT_POOL, type PoolVersion } from './pool';
import { cloneDeck, findEntry, isEntry } from './deckUtils';
import { genUid } from './defaultDecks';
import { validateDeck } from './validate';

export interface AppliedBatch {
  /** 数量动作不合法时没有 final */
  final: Deck | null;
  qtyHits: RuleHit[];
  report: DeckReport | null;
  legal: boolean;
}

interface Snapshot {
  cardId: string;
  printingId: string;
  qty: number;
}

function entryDisplayName(e: Deck['main'][number], pool: PoolVersion): string {
  if (e.kind === 'unresolved') return e.exportedName;
  return pool.cardById.get(e.cardId)?.name ?? e.cardId;
}

function checkQty(deck: Deck, pairs: SwapPair[], pool: PoolVersion): RuleHit[] {
  const hits: RuleHit[] = [];
  const mainQty = new Map<string, number>();
  const sideQty = new Map<string, number>();
  for (const p of pairs) {
    mainQty.set(p.mainUid, (mainQty.get(p.mainUid) ?? 0) + 1);
    sideQty.set(p.sideUid, (sideQty.get(p.sideUid) ?? 0) + 1);
  }
  for (const [uid, q] of mainQty) {
    const e = deck.main.find((x) => x.uid === uid);
    if (!e) {
      hits.push({ code: 'R-ACTION-QTY', severity: 'error', message: `主牌条目 ${uid} 已不存在，无法移出。`, entryUids: [uid] });
    } else if (q > e.count) {
      hits.push({
        code: 'R-ACTION-QTY',
        severity: 'error',
        zone: 'main',
        entryUids: [uid],
        cardId: isEntry(e) ? e.cardId : e.cardId,
        message: `计划从「${entryDisplayName(e, pool)}」移出 ${q} 张，但该条目只有 ${e.count} 张。`,
      });
    }
  }
  for (const [uid, q] of sideQty) {
    const e = deck.sideboard.find((x) => x.uid === uid);
    if (!e) {
      hits.push({ code: 'R-ACTION-QTY', severity: 'error', message: `备选条目 ${uid} 已不存在，无法换入。`, entryUids: [uid] });
    } else if (q > e.count) {
      hits.push({
        code: 'R-ACTION-QTY',
        severity: 'error',
        zone: 'sideboard',
        entryUids: [uid],
        cardId: isEntry(e) ? e.cardId : e.cardId,
        message: `计划换入「${entryDisplayName(e, pool)}」${q} 张，但备选只有 ${e.count} 张。`,
      });
    }
  }
  return hits;
}

function drain(entries: Deck['main'], uid: string, qty: number): Snapshot | null {
  const idx = entries.findIndex((e) => e.uid === uid);
  if (idx < 0) return null;
  const e = entries[idx];
  if (e.kind !== 'entry') return { cardId: e.cardId, printingId: e.printingId ?? 'missing', qty };
  const snap: Snapshot = { cardId: e.cardId, printingId: e.printingId, qty };
  e.count -= qty;
  if (e.count <= 0) entries.splice(idx, 1);
  return snap;
}

function addCopy(entries: Deck['main'], snap: Snapshot) {
  const existing = entries.find(
    (e): e is DeckEntry => e.kind === 'entry' && e.cardId === snap.cardId && e.printingId === snap.printingId,
  );
  if (existing) {
    existing.count += snap.qty;
  } else {
    entries.push({ kind: 'entry', uid: genUid('moved'), cardId: snap.cardId, printingId: snap.printingId, count: snap.qty });
  }
}

/** 把一整批 SwapPair 同时结算：数量校验通过后，在同一个 final 牌组上一次性移动。 */
export function applyBatch(deck: Deck, pairs: SwapPair[], pool: PoolVersion = CURRENT_POOL): AppliedBatch {
  const qtyHits = checkQty(deck, pairs, pool);
  if (qtyHits.length > 0) {
    return { final: null, qtyHits, report: null, legal: false };
  }

  const final = cloneDeck(deck);
  const mainDrain = new Map<string, number>();
  const sideDrain = new Map<string, number>();
  for (const p of pairs) {
    mainDrain.set(p.mainUid, (mainDrain.get(p.mainUid) ?? 0) + 1);
    sideDrain.set(p.sideUid, (sideDrain.get(p.sideUid) ?? 0) + 1);
  }

  const mainOut: Snapshot[] = [];
  const sideOut: Snapshot[] = [];
  for (const [uid, q] of mainDrain) {
    const s = drain(final.main, uid, q);
    if (s) mainOut.push(s);
  }
  for (const [uid, q] of sideDrain) {
    const s = drain(final.sideboard, uid, q);
    if (s) sideOut.push(s);
  }
  // 主牌移出的进备选，备选移出的进主牌。
  for (const s of mainOut) addCopy(final.sideboard, s);
  for (const s of sideOut) addCopy(final.main, s);

  const report = validateDeck(final, pool);
  return { final, qtyHits: [], report, legal: report.legal };
}

export interface SideAnalysis {
  uid: string;
  cardId?: string;
  title: string;
  hits: RuleHit[];
  effects: string[];
}

export interface PairAnalysis {
  pair: SwapPair;
  out: SideAnalysis;
  incoming: SideAnalysis;
  singleLegal: boolean;
  singleReport: DeckReport;
}

function capLine(deck: Deck, cardId: string, zone: 'main' | 'sideboard', delta: number, pool: PoolVersion): string {
  const card = pool.cardById.get(cardId);
  const limit = card?.limit ?? 4;
  const n = (zone === 'main' ? deck.main : deck.sideboard)
    .filter((e) => isEntry(e) && e.cardId === cardId)
    .reduce((s, e) => s + e.count, 0);
  const after = n + delta;
  const mark = after > limit ? ' ⚠ 超限' : after === limit ? '（已满）' : '';
  return `${zone === 'main' ? '主牌' : '备选'}同名合计 ${n} → ${after}，上限 ${limit}${mark}`;
}

/** 只执行这一对交换时会发生什么 —— 对应「单张替换行不行」。 */
export function analyzePair(deck: Deck, pair: SwapPair, pool: PoolVersion = CURRENT_POOL): PairAnalysis {
  const outEntry = findEntry(deck, pair.mainUid);
  const inEntry = findEntry(deck, pair.sideUid);
  const outCardId = outEntry && isEntry(outEntry) ? outEntry.cardId : undefined;
  const inCardId = inEntry && isEntry(inEntry) ? inEntry.cardId : undefined;
  const outCard = outCardId ? pool.cardById.get(outCardId) : undefined;
  const inCard = inCardId ? pool.cardById.get(inCardId) : undefined;

  const applied = applyBatch(deck, [pair], pool);
  const singleReport: DeckReport = applied.report ?? {
    legal: false,
    errors: applied.qtyHits,
    warnings: [],
    hits: applied.qtyHits,
  };

  const outEffects: string[] = [];
  const inEffects: string[] = [];
  if (outCardId) {
    outEffects.push(capLine(deck, outCardId, 'main', -1, pool));
    if (outCard?.type === 'core') {
      const coreCount = deck.main.filter((e) => isEntry(e) && pool.cardById.get(e.cardId)?.type === 'core').reduce((s, e) => s + e.count, 0);
      if (coreCount <= 1 && inCard?.type !== 'core') {
        outEffects.push(`这是唯一核心，且换入的不是核心：移走后将不满足核心数量 ≥1（R-CORE-MIN）`);
      } else if (inCard?.type === 'core') {
        outEffects.push(`移走此核心后由换入的「${inCard.name}」接任核心位，核心数量不变`);
      } else {
        outEffects.push(`移走核心后，它的阵营盟约随之解除`);
      }
    }
  }
  if (inCardId) {
    inEffects.push(capLine(deck, inCardId, 'main', +1, pool));
    if (inCard?.type === 'core' && inCard.core) {
      inEffects.push(`新核心盟约允许：${inCard.core.allied.map((f) => FACTION_LABEL[f]).join(' / ')}`);
    }
  }

  const outHits: RuleHit[] = [];
  const inHits: RuleHit[] = [];
  for (const hit of singleReport.hits) {
    const side = attributeHit(hit, outCardId, inCardId);
    if (side === 'out') outHits.push(hit);
    else if (side === 'in') inHits.push(hit);
  }

  return {
    pair,
    singleLegal: singleReport.legal,
    singleReport,
    out: {
      uid: pair.mainUid,
      cardId: outCardId,
      title: outCard ? `原牌：♦ ${outCard.name}` : `原牌：${outEntry && !isEntry(outEntry) ? outEntry.exportedName : pair.mainUid}`,
      hits: outHits,
      effects: outEffects,
    },
    incoming: {
      uid: pair.sideUid,
      cardId: inCardId,
      title: inCard ? `换入：♦ ${inCard.name}` : `换入：${inEntry && !isEntry(inEntry) ? inEntry.exportedName : pair.sideUid}`,
      hits: inHits,
      effects: inEffects,
    },
  };
}

const FACTION_LABEL: Record<string, string> = { crimson: '赤焰', tide: '苍澜', grove: '森罗', neutral: '中立' };

/** 把一条整批校验错误归因到某一对的原牌 / 换入牌；无法归因返回 null（结构性问题）。 */
export function attributeHit(
  hit: RuleHit,
  outCardId?: string,
  inCardId?: string,
): 'out' | 'in' | null {
  if (inCardId && (hit.cardId === inCardId || hit.coreCardId === inCardId)) return 'in';
  if (outCardId && (hit.cardId === outCardId || hit.coreCardId === outCardId)) return 'out';
  if (hit.code === 'R-CORE-MIN') return 'out';
  if (hit.code === 'R-DECK-SIZE' && /当前 \d+ 张（差 -?\d+）/.test(hit.message) && hit.message.includes('差 -')) return 'in';
  if (hit.code === 'R-DECK-SIZE') return 'out';
  return null;
}
