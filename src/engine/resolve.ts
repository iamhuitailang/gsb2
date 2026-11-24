import type {
  PackManifest,
  PackTrace,
  RemovalRule,
  ResolvedItem,
  RungTrace,
  Variant,
} from '../types';
import { analyzePacks, type Analysis } from './graph';

export interface Query {
  scene: string;
  language: string;
}

interface RungKey {
  sceneKey: string;
  langKey: string;
}

/** zh-CN -> [zh-CN, zh, *]；en-US -> [en-US, en, *]；无区域标签时去重 */
export function languageChain(language: string): string[] {
  const macro = language.includes('-') ? language.split('-')[0] : language;
  return [...new Set([language, macro, '*'])];
}

/**
 * 回退阶梯（最多 6 级）：场景链 [当前场景, *] 在外，语言链在内。
 * 即先退语言、再退场景的组合顺序由该笛卡尔积固定下来，追踪 UI 会逐行解释。
 */
export function buildRungs(scene: string, language: string): RungKey[] {
  const sceneKeys = [...new Set([scene, '*'])];
  const langKeys = languageChain(language);
  const rungs: RungKey[] = [];
  for (const sceneKey of sceneKeys) {
    for (const langKey of langKeys) {
      rungs.push({ sceneKey, langKey });
    }
  }
  return rungs;
}

function rungLabel(rung: RungKey, query: Query): string {
  const scenePart =
    rung.sceneKey === query.scene
      ? `场景精确(${rung.sceneKey})`
      : '场景通配(*)';
  let langPart: string;
  if (rung.langKey === query.language) {
    langPart = `语言精确(${rung.langKey})`;
  } else if (rung.langKey === '*') {
    langPart = '语言通配(*)';
  } else {
    langPart = `语言主标签回退(${rung.langKey})`;
  }
  return `${scenePart} · ${langPart}`;
}

const keyOf = (sceneKey: string, langKey: string): string =>
  `${sceneKey} ${langKey}`;

interface PackOpinion {
  pack: PackManifest;
  priority: number;
  /** 该包最早命中的阶梯序号（越小越精确） */
  rungIndex: number;
  type: 'variant' | 'removal';
  variant?: Variant;
  removal?: RemovalRule;
  /** rungIndex 上的事件是否为移除（同层同时存在时移除优先） */
  removalAtEarliest: boolean;
  variantAt: Map<number, Variant>;
  removalRungIndex?: number;
  removalRule?: RemovalRule;
}

/** 计算一个包对某道具在当前查询下的「意见」：最早的变体命中或移除锚点 */
function inspectPack(
  pack: PackManifest,
  itemId: string,
  rungs: RungKey[],
  priority: number,
): PackOpinion | null {
  const variants = pack.resources?.[itemId] ?? [];
  const variantMap = new Map<string, Variant>();
  for (const v of variants) {
    variantMap.set(keyOf(v.scene, v.lang), v);
  }

  const variantAt = new Map<number, Variant>();
  rungs.forEach((r, i) => {
    const v = variantMap.get(keyOf(r.sceneKey, r.langKey));
    if (v) variantAt.set(i, v);
  });

  // 移除规则锚定到它声明的 (scene, lang) 键所在阶梯；不在当前查询阶梯中 = 不适用
  let removalRungIndex: number | undefined;
  let removalRule: RemovalRule | undefined;
  for (const rule of pack.removals ?? []) {
    if (rule.item !== itemId) continue;
    const rs = rule.scene ?? '*';
    const rl = rule.lang ?? '*';
    const idx = rungs.findIndex(
      (r) => r.sceneKey === rs && r.langKey === rl,
    );
    if (idx >= 0 && (removalRungIndex === undefined || idx < removalRungIndex)) {
      removalRungIndex = idx;
      removalRule = rule;
    }
  }

  const firstVariant = variantAt.size > 0 ? Math.min(...variantAt.keys()) : undefined;

  let rungIndex: number;
  let type: 'variant' | 'removal';
  let removalAtEarliest = false;

  if (firstVariant === undefined && removalRungIndex === undefined) {
    return null;
  }
  if (firstVariant !== undefined && removalRungIndex !== undefined) {
    // 同层或移除更早：移除优先；变体更早则采用变体
    if (removalRungIndex <= firstVariant) {
      rungIndex = removalRungIndex;
      type = 'removal';
      removalAtEarliest = true;
    } else {
      rungIndex = firstVariant;
      type = 'variant';
    }
  } else if (removalRungIndex !== undefined) {
    rungIndex = removalRungIndex;
    type = 'removal';
    removalAtEarliest = true;
  } else {
    rungIndex = firstVariant!;
    type = 'variant';
  }

  return {
    pack,
    priority,
    rungIndex,
    type,
    variant: type === 'variant' ? variantAt.get(rungIndex) : undefined,
    removal: type === 'removal' ? removalRule : undefined,
    removalAtEarliest,
    variantAt,
    removalRungIndex,
    removalRule,
  };
}

interface Decision {
  priority: number;
  opinions: PackOpinion[];
  chosen: PackOpinion;
  conflict: boolean;
  resolution: string;
}

/** 在可用包中按优先级逐层找第一个「有意见」的同级组，并做冲突裁决 */
function decide(
  usableOpinions: PackOpinion[],
): Decision | null {
  const byPriority = new Map<number, PackOpinion[]>();
  for (const op of usableOpinions) {
    const list = byPriority.get(op.priority) ?? [];
    list.push(op);
    byPriority.set(op.priority, list);
  }
  const priorities = [...byPriority.keys()].sort((a, b) => b - a);

  for (const priority of priorities) {
    // 同优先级内按 (阶梯精度, 包 id) 排序，保证结果确定
    const opinions = byPriority
      .get(priority)!
      .sort(
        (a, b) =>
          a.rungIndex - b.rungIndex || a.pack.id.localeCompare(b.pack.id),
      );
    if (opinions.length === 0) continue;

    const chosen = opinions[0];
    let conflict = false;
    let resolution = '';

    if (opinions.length >= 2) {
      conflict = true;
      const bestRung = chosen.rungIndex;
      const tiedAtBest = opinions.filter((o) => o.rungIndex === bestRung);
      if (tiedAtBest.length >= 2) {
        resolution = `多个同级包都在第 ${bestRung + 1} 层同精度表态，按包 ID 固定次序选择「${chosen.pack.name}」(${chosen.pack.id})；调整优先级或停用其一可消除冲突`;
      } else {
        const otherNames = opinions
          .slice(1)
          .map((o) => `「${o.pack.name}」第 ${o.rungIndex + 1} 层`)
          .join('、');
        resolution = `「${chosen.pack.name}」在第 ${bestRung + 1} 层命中，比 ${otherNames} 更精确，故由它胜出（仍记为同级冲突）`;
      }
    }

    return { priority, opinions, chosen, conflict, resolution };
  }
  return null;
}

/** 解析单个道具，并为堆栈中的每个包生成逐级追踪 */
export function resolveItem(
  itemId: string,
  query: Query,
  _library: PackManifest[],
  analysis: Analysis,
): ResolvedItem {
  const rungs = buildRungs(query.scene, query.language);

  // 仅可用包产生意见
  const opinionByPack = new Map<string, PackOpinion | null>();
  const usableOpinions: PackOpinion[] = [];
  for (const id of analysis.order) {
    const status = analysis.byId.get(id)!;
    if (!status.usable) continue;
    const op = inspectPack(
      status.pack,
      itemId,
      rungs,
      analysis.priorityOf.get(id) ?? status.pack.priority,
    );
    opinionByPack.set(id, op);
    if (op) usableOpinions.push(op);
  }

  const decision = decide(usableOpinions);
  const chosenId = decision?.chosen.pack.id;
  const tieIds = new Set(decision?.opinions.map((o) => o.pack.id) ?? []);

  const trace: PackTrace[] = analysis.order.map((packId) => {
    const status = analysis.byId.get(packId)!;
    const pack = status.pack;
    const priority = analysis.priorityOf.get(packId) ?? pack.priority;

    if (!status.enabled) {
      return {
        packId,
        packName: pack.name,
        kind: pack.kind,
        priority,
        enabled: false,
        usable: false,
        outcome: 'skipped-disabled',
        outcomeReason: '该包未开启，不参与本次解析',
        rungs: [],
      };
    }

    if (!status.usable) {
      const issues = [
        ...status.manifestIssues.map((i) => i.message),
        ...status.runtimeIssues.map((i) => i.message),
      ];
      return {
        packId,
        packName: pack.name,
        kind: pack.kind,
        priority,
        enabled: true,
        usable: false,
        outcome: 'skipped-unusable',
        outcomeReason: '包不可用，已整体跳过；不影响其他包 / 道具继续预览',
        skipIssues: issues,
        rungs: [],
      };
    }

    const opinion = opinionByPack.get(packId) ?? null;
    const isChosen = packId === chosenId;
    const isTieMember = !!decision?.conflict && tieIds.has(packId);
    const isLowerPriority =
      decision !== null && priority < decision.priority;

    // 生成逐级追踪
    const rungTraces: RungTrace[] = rungs.map((rung, i) => {
      const base = {
        index: i,
        sceneKey: rung.sceneKey,
        langKey: rung.langKey,
        label: rungLabel(rung, query),
      };

      const variant = opinion?.variantAt.get(i);
      const isRemovalRung = opinion?.removalRungIndex === i;

      if (opinion && i > opinion.rungIndex) {
        const hasLaterVariant = !!variant;
        return {
          ...base,
          state: 'not-reached' as const,
          reason: hasLaterVariant
            ? `该层虽存在变体，但包已在第 ${opinion.rungIndex + 1} 层得出结论，不再继续回退`
            : `已在第 ${opinion.rungIndex + 1} 层得出结论，后续层级不再检查`,
          variant,
        };
      }

      if (isRemovalRung) {
        let state: RungTrace['state'];
        let reason: string;
        const rule = opinion!.removalRule!;
        if (isChosen) {
          state = 'removal-selected';
          reason = `命中显式移除规则（${rule.reason ?? 'manifest.removals'}），最终移除`;
        } else if (isTieMember) {
          state = 'removal-tie-loser';
          reason = '同级冲突中该移除意见未被采纳';
        } else if (isLowerPriority || decision) {
          state = 'removal-overridden';
          reason = `移除规则命中，但更高优先级包「${decision!.chosen.pack.name}」已先表态`;
        } else {
          state = 'removal-selected';
          reason = '命中显式移除规则';
        }
        return { ...base, state, reason };
      }

      if (variant) {
        let state: RungTrace['state'];
        let reason: string;
        const note = variant.note ? `；${variant.note}` : '';
        if (isChosen && opinion?.type === 'variant') {
          state = 'hit-selected';
          reason = `命中 ${rung.sceneKey} / ${rung.langKey}，采用为实际图片${note}`;
        } else if (isTieMember) {
          state = 'hit-tie-loser';
          reason = `命中 ${rung.sceneKey} / ${rung.langKey}，但在同级冲突裁决中落选${note}`;
        } else if (decision) {
          state = 'hit-overridden';
          reason = `本层命中，但更高优先级 / 更精确的「${decision.chosen.pack.name}」已胜出${note}`;
        } else {
          state = 'hit-selected';
          reason = `命中 ${rung.sceneKey} / ${rung.langKey}${note}`;
        }
        return { ...base, state, reason, variant };
      }

      return {
        ...base,
        state: 'miss' as const,
        reason: `该包在这一层没有 ${rung.sceneKey} / ${rung.langKey} 键，继续逐级回退`,
      };
    });

    let outcome: PackTrace['outcome'];
    let outcomeReason: string;

    if (!opinion) {
      outcome = 'missed';
      outcomeReason = `包内 ${rungs.length} 个回退层级均未命中该道具`;
    } else if (isChosen && decision?.conflict) {
      outcome = 'tie-winner';
      outcomeReason = `同级冲突裁决后由本包胜出（第 ${opinion.rungIndex + 1} 层）。${decision.resolution}`;
    } else if (isChosen && opinion.type === 'removal') {
      outcome = 'removed';
      outcomeReason = `本包移除规则最终生效（第 ${opinion.rungIndex + 1} 层）：${opinion.removal?.reason ?? ''}`;
    } else if (isChosen) {
      outcome = 'won';
      outcomeReason = `最终图片来自本包，命中第 ${opinion.rungIndex + 1} 层（${rungLabel(rungs[opinion.rungIndex], query)}）`;
    } else if (isTieMember) {
      outcome = 'tie-loser';
      outcomeReason = `与同级包同时对该道具有表态，冲突裁决后落选（本包最佳为第 ${opinion.rungIndex + 1} 层）`;
    } else if (decision && priority < decision.priority) {
      outcome = 'overridden';
      outcomeReason = `本包在第 ${opinion.rungIndex + 1} 层有候选，但优先级 ${priority} 低于决胜组 ${decision.priority}，被覆盖`;
    } else {
      outcome = 'missed';
      outcomeReason = '未命中';
    }

    return {
      packId,
      packName: pack.name,
      kind: pack.kind,
      priority,
      enabled: true,
      usable: true,
      outcome,
      outcomeReason,
      rungs: rungTraces,
    };
  });

  if (!decision) {
    return { itemId, status: 'missing', trace };
  }

  const chosen = decision.chosen;
  const base: ResolvedItem = {
    itemId,
    status: decision.conflict ? 'conflict' : chosen.type === 'removal' ? 'removed' : 'found',
    trace,
  };

  if (decision.conflict) {
    base.conflict = {
      priority: decision.priority,
      packIds: decision.opinions.map((o) => o.pack.id),
      chosenPackId: chosen.pack.id,
      resolution: decision.resolution,
    };
  }

  if (chosen.type === 'variant' && chosen.variant) {
    base.winnerPackId = chosen.pack.id;
    base.winnerVariant = chosen.variant;
    base.winnerRungLabel = rungLabel(rungs[chosen.rungIndex], query);
  } else if (chosen.type === 'removal' && chosen.removal) {
    base.removedByPackId = chosen.pack.id;
    base.removalRule = chosen.removal;
  }

  return base;
}

export interface ResolveAllArgs {
  items: { id: string }[];
  scene: string;
  language: string;
  library: PackManifest[];
  enabled: Record<string, boolean>;
  priorities?: Record<string, number>;
}

export function resolveAll(args: ResolveAllArgs): {
  analysis: Analysis;
  results: Map<string, ResolvedItem>;
} {
  const analysis = analyzePacks(
    args.library,
    args.enabled,
    args.priorities ?? {},
  );
  const results = new Map<string, ResolvedItem>();
  for (const item of args.items) {
    results.set(
      item.id,
      resolveItem(item.id, { scene: args.scene, language: args.language }, args.library, analysis),
    );
  }
  return { analysis, results };
}
