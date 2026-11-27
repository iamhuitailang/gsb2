import type { AnyEntry, Deck, OpeningGoal } from './types';
import { CURRENT_POOL, POOL_V1, POOL_V2, type PoolVersion } from './pool';
import { genUid } from './defaultDecks';

export const APP_ID = 'diamond-deck-lab';
export const EXPORT_FORMAT = 1;

interface ExportEntryJSON {
  cardId: string;
  printingId?: string;
  count: number;
}

export interface ExportFileJSON {
  app: string;
  format: number;
  exportedAt: string;
  poolVersion: string;
  deck: {
    name: string;
    tag?: string;
    description?: string;
    goal?: OpeningGoal;
    main: ExportEntryJSON[];
    sideboard: ExportEntryJSON[];
  };
  snapshot?: {
    cards?: Record<
      string,
      { name?: string; printings?: Record<string, string> }
    >;
  };
}

/** 导出牌组 + 每条的印次选择 + 名字快照（名字只用于人读和缺失展示，绝不用于认牌）。 */
export function exportDeck(deck: Deck, pool: PoolVersion = CURRENT_POOL): string {
  const used = new Set<string>();
  const pick = (e: AnyEntry): ExportEntryJSON | null => {
    if (e.kind === 'unresolved') {
      return { cardId: e.cardId, printingId: e.printingId, count: e.count };
    }
    used.add(e.cardId);
    return { cardId: e.cardId, printingId: e.printingId, count: e.count };
  };
  const main = deck.main.map(pick).filter((x): x is ExportEntryJSON => !!x);
  const sideboard = deck.sideboard.map(pick).filter((x): x is ExportEntryJSON => !!x);

  const cards: NonNullable<ExportFileJSON['snapshot']>['cards'] = {};
  for (const id of used) {
    const c = pool.cardById.get(id);
    if (!c || !cards) continue;
    const printings: Record<string, string> = {};
    for (const p of c.printings) printings[p.id] = p.label;
    cards[id] = { name: c.name, printings };
  }

  const file: ExportFileJSON = {
    app: APP_ID,
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    poolVersion: pool.version,
    deck: {
      name: deck.name,
      tag: deck.tag,
      description: deck.description,
      goal: deck.goal,
      main,
      sideboard,
    },
    snapshot: { cards },
  };
  return JSON.stringify(file, null, 2);
}

export type RowStatus = 'exact' | 'printing-missing' | 'same-name' | 'removed';

export interface PreviewRow {
  rowId: string;
  zone: 'main' | 'sideboard';
  cardId: string;
  printingId?: string;
  count: number;
  exportedName: string;
  exportedPrintingLabel?: string;
  status: RowStatus;
  statusText: string;
  /** 当前卡池中的同名异 id 候选 */
  candidates: { id: string; name: string }[];
  /** exact / printing-missing 时解析到的当前卡 */
  resolvedCardId?: string;
  /** printing-missing 时预览默认选的现行印次（必须经预览确认，不是静默替换） */
  fallbackPrintingId?: string;
  /** 用户选择：保持缺失 / 手动映射到某张当前卡 */
  choice:
    | { mode: 'default' }
    | { mode: 'unresolved' }
    | { mode: 'map'; cardId: string; printingId: string };
}

export interface ImportPreview {
  fileName?: string;
  sourcePoolVersion?: string;
  deckName: string;
  tag?: string;
  description?: string;
  goal?: OpeningGoal;
  rows: PreviewRow[];
  parseWarning?: string;
}

function asEntryList(v: unknown): ExportEntryJSON[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      cardId: String(x.cardId ?? ''),
      printingId: x.printingId != null ? String(x.printingId) : undefined,
      count: Number(x.count ?? 1) || 1,
    }))
    .filter((x) => x.cardId);
}

/** 解析导入 JSON 并生成「不做任何自动同名替换」的差异预览。 */
export function previewImport(text: string, targetPool: PoolVersion): ImportPreview {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON 解析失败：${(err as Error).message}`);
  }
  const obj = raw as Partial<ExportFileJSON> & Record<string, unknown>;
  // 兼容两种外壳：我们的导出格式 {deck:{...}} 或直接就是牌组
  const d = (obj.deck ?? obj) as NonNullable<ExportFileJSON['deck']>;
  if (!d || typeof d !== 'object') throw new Error('文件里没有找到 deck 牌组对象。');

  const snapshotCards = obj.snapshot?.cards ?? {};
  const sourcePoolVersion = typeof obj.poolVersion === 'string' ? obj.poolVersion : undefined;

  const rows: PreviewRow[] = [];
  const buildRow = (zone: 'main' | 'sideboard', e: ExportEntryJSON, idx: number): PreviewRow => {
    const snap = snapshotCards[e.cardId];
    const exportedName = snap?.name ?? e.cardId;
    const exportedPrintingLabel = e.printingId ? snap?.printings?.[e.printingId] : undefined;
    const card = targetPool.cardById.get(e.cardId);

    const base: PreviewRow = {
      rowId: `${zone}-${idx}-${e.cardId}-${e.printingId ?? 'none'}`,
      zone,
      cardId: e.cardId,
      printingId: e.printingId,
      count: e.count,
      exportedName,
      exportedPrintingLabel,
      status: 'removed',
      statusText: '',
      candidates: [],
      choice: { mode: 'default' },
    };

    if (card) {
      const printingOk = !e.printingId || card.printings.some((p) => p.id === e.printingId);
      if (printingOk) {
        base.status = 'exact';
        base.statusText = '牌与印次都匹配';
        base.resolvedCardId = card.id;
      } else {
        base.status = 'printing-missing';
        base.statusText = `牌仍在，但印次 ${e.printingId} 在 ${targetPool.version} 卡池中不存在`;
        base.resolvedCardId = card.id;
        base.fallbackPrintingId = card.printings[0]?.id;
      }
      return base;
    }

    // 牌 id 在新版本消失：只收集同名候选，绝不自动选择。
    const sameName = targetPool.cards.filter((c) => c.name === exportedName && c.id !== e.cardId);
    base.candidates = sameName.map((c) => ({ id: c.id, name: c.name }));
    if (sameName.length > 0) {
      base.status = 'same-name';
      base.statusText = `新版本没有 id 为 ${e.cardId} 的牌；但有同名异 id 牌，未自动替换`;
    } else {
      base.status = 'removed';
      base.statusText = `新版本已无此牌（id：${e.cardId}），也没有同名牌`;
    }
    base.choice = { mode: 'unresolved' };
    return base;
  };

  asEntryList(d.main).forEach((e, i) => rows.push(buildRow('main', e, i)));
  asEntryList(d.sideboard).forEach((e, i) => rows.push(buildRow('sideboard', e, i)));

  return {
    sourcePoolVersion,
    deckName: typeof d.name === 'string' && d.name ? d.name : '导入的牌组',
    tag: d.tag,
    description: d.description,
    goal: d.goal,
    rows,
  };
}

/** 按预览中用户确认 / 手动选择的结果生成真正的 Deck。 */
export function deckFromPreview(preview: ImportPreview, targetPool: PoolVersion): Deck {
  const convert = (zone: 'main' | 'sideboard'): AnyEntry[] =>
    preview.rows
      .filter((r) => r.zone === zone)
      .map((r) => {
        // 手动映射优先
        if (r.choice.mode === 'map') {
          return {
            kind: 'entry' as const,
            uid: genUid('imp'),
            cardId: r.choice.cardId,
            printingId: r.choice.printingId || targetPool.cardById.get(r.choice.cardId)?.printings[0]?.id || '',
            count: r.count,
          };
        }
        if (r.status === 'exact' && r.resolvedCardId) {
          return {
            kind: 'entry' as const,
            uid: genUid('imp'),
            cardId: r.resolvedCardId,
            printingId: r.printingId || targetPool.cardById.get(r.resolvedCardId)!.printings[0].id,
            count: r.count,
          };
        }
        if (r.status === 'printing-missing' && r.choice.mode === 'default' && r.fallbackPrintingId) {
          return {
            kind: 'entry' as const,
            uid: genUid('imp'),
            cardId: r.resolvedCardId!,
            printingId: r.fallbackPrintingId,
            count: r.count,
          };
        }
        // 保持缺失：成为 unresolved 条目，校验页会持续报错，而不是被同名牌顶替
        return {
          kind: 'unresolved' as const,
          uid: genUid('miss'),
          cardId: r.cardId,
          printingId: r.printingId,
          count: r.count,
          exportedName: r.exportedName,
          exportedPrintingLabel: r.exportedPrintingLabel,
          sameNameCandidates: r.candidates.map((c) => c.id),
        };
      });

  return {
    id: `deck-import-${Date.now().toString(36)}`,
    name: preview.deckName,
    tag: preview.tag ?? '导入',
    description: preview.description ?? '',
    goal: preview.goal ?? { kind: 'faction-count', faction: 'crimson', count: 3, label: '起手至少 3 张同阵营牌' },
    main: convert('main'),
    sideboard: convert('sideboard'),
  };
}

// ---------------------------------------------------------------------------
// 内置旧版导出示例：v1 牌组，2.0 导入时必然出现「新版本没牌 + 同名异 id」
// ---------------------------------------------------------------------------

export const SAMPLE_OLD_EXPORT: string = JSON.stringify(
  {
    app: APP_ID,
    format: EXPORT_FORMAT,
    exportedAt: '2025-11-01T10:00:00.000Z',
    poolVersion: POOL_V1.version,
    deck: {
      name: '旧版赤焰老兵套（v1 文件，往 2.0 导）',
      tag: '旧版本示例',
      description: '包含 2 张闪印旧赤焰老兵，以及 1 张卡池里不存在的 Beta 测试印次炎刃。',
      goal: { kind: 'faction-count', faction: 'crimson', count: 3, label: '起手至少 3 张赤焰牌' },
      main: [
        { cardId: 'core-flame', printingId: 'core-flame-o', count: 1 },
        { cardId: 'c-veteran', printingId: 'c-veteran-foil', count: 2 },
        { cardId: 'c-blade', printingId: 'c-blade-beta-test', count: 1 },
        { cardId: 'c-blade', printingId: 'c-blade-o', count: 3 },
        { cardId: 'c-recruit', printingId: 'c-recruit-o', count: 4 },
        { cardId: 'c-oath', printingId: 'c-oath-o', count: 4 },
        { cardId: 'c-arrow', printingId: 'c-arrow-o', count: 4 },
        { cardId: 'c-berzerker', printingId: 'c-berzerker-o', count: 4 },
        { cardId: 'c-drake', printingId: 'c-drake-o', count: 3 },
        { cardId: 'n-courier', printingId: 'n-courier-o', count: 4 },
        { cardId: 'n-scholar', printingId: 'n-scholar-o', count: 4 },
        { cardId: 'n-golem', printingId: 'n-golem-o', count: 3 },
        { cardId: 'n-smith', printingId: 'n-smith-o', count: 3 },
      ],
      sideboard: [{ cardId: 'c-veteran', printingId: 'c-veteran-o', count: 1 }],
    },
    snapshot: {
      cards: {
        'core-flame': { name: '赤焰盟主·烨', printings: { 'core-flame-o': '初版' } },
        'c-veteran': { name: '赤焰老兵', printings: { 'c-veteran-o': '初版', 'c-veteran-foil': '闪印纪念' } },
        'c-blade': { name: '炎刃剑士', printings: { 'c-blade-o': '初版', 'c-blade-beta-test': 'Beta 测试印（已销毁）' } },
        'c-recruit': { name: '赤焰新兵', printings: { 'c-recruit-o': '初版' } },
        'c-oath': { name: '誓约骑士', printings: { 'c-oath-o': '初版' } },
        'c-arrow': { name: '火箭齐射', printings: { 'c-arrow-o': '初版' } },
        'c-berzerker': { name: '狂斧手', printings: { 'c-berzerker-o': '初版' } },
        'c-drake': { name: '幼焰龙', printings: { 'c-drake-o': '初版' } },
        'n-courier': { name: '行商', printings: { 'n-courier-o': '初版' } },
        'n-scholar': { name: '博学者', printings: { 'n-scholar-o': '初版' } },
        'n-golem': { name: '方片魔像', printings: { 'n-golem-o': '初版' } },
        'n-smith': { name: '锻炉匠', printings: { 'n-smith-o': '初版' } },
      },
    },
  } satisfies ExportFileJSON,
  null,
  2,
);

export const IMPORT_POOL_CHOICES = [
  { id: POOL_V2.version, label: `${POOL_V2.version} ${POOL_V2.label}（当前新版本）`, pool: POOL_V2 },
  { id: POOL_V1.version, label: `${POOL_V1.version} ${POOL_V1.label}（旧版本，可对比）`, pool: POOL_V1 },
];
