import type { AnyEntry, CardInstance, Deck, DeckEntry, UnresolvedEntry, ZoneId } from './types';
import { CURRENT_POOL, type PoolVersion } from './pool';

export function isEntry(e: AnyEntry): e is DeckEntry {
  return e.kind === 'entry';
}

export function isUnresolved(e: AnyEntry): e is UnresolvedEntry {
  return e.kind === 'unresolved';
}

export function zoneTotal(entries: AnyEntry[]): number {
  return entries.reduce((s, e) => s + e.count, 0);
}

export function findEntry(deck: Deck, uid: string): AnyEntry | undefined {
  return [...deck.main, ...deck.sideboard].find((e) => e.uid === uid);
}

export function findZoneOfUid(deck: Deck, uid: string): ZoneId | undefined {
  if (deck.main.some((e) => e.uid === uid)) return 'main';
  if (deck.sideboard.some((e) => e.uid === uid)) return 'sideboard';
  return undefined;
}

/** 条目当前能解析到的卡定义；缺失条目返回 undefined。 */
export function cardOfEntry(e: AnyEntry, pool: PoolVersion = CURRENT_POOL) {
  if (e.kind === 'entry') return pool.cardById.get(e.cardId);
  return undefined;
}

/** 按 cardId 聚合某区域内的同名总数（跨印次合并；缺失条目不参与）。 */
export function cardCounts(entries: AnyEntry[], pool: PoolVersion = CURRENT_POOL): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) {
    if (!isEntry(e)) continue;
    m.set(e.cardId, (m.get(e.cardId) ?? 0) + e.count);
  }
  return m;
}

/** 找出某 cardId 涉及的全部条目 uid（用于把规则错误挂到具体行）。 */
export function entryUidsForCard(entries: AnyEntry[], cardId: string): string[] {
  return entries.filter((e) => isEntry(e) && e.cardId === cardId).map((e) => e.uid);
}

let iidSeq = 1;
/** 把一个区域展开成单张实体列表（count=3 展开为 3 个 CardInstance）。 */
export function expandZone(deck: Deck, zone: ZoneId, pool: PoolVersion = CURRENT_POOL): CardInstance[] {
  const out: CardInstance[] = [];
  for (const e of zone === 'main' ? deck.main : deck.sideboard) {
    if (!isEntry(e)) continue;
    if (!pool.cardById.has(e.cardId)) continue;
    for (let i = 0; i < e.count; i++) {
      out.push({ iid: iidSeq++, cardId: e.cardId, printingId: e.printingId });
    }
  }
  return out;
}

export function entryLabel(e: AnyEntry, pool: PoolVersion = CURRENT_POOL): string {
  if (e.kind === 'unresolved') return `${e.exportedName}（新版本缺失：${e.cardId}）`;
  const c = pool.cardById.get(e.cardId);
  return c ? c.name : `未知卡 ${e.cardId}`;
}

/** 深拷贝牌组（内置牌组是模块级单例，编辑前必须拷）。 */
export function cloneDeck(d: Deck): Deck {
  return JSON.parse(JSON.stringify(d)) as Deck;
}
