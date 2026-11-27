import type { AnyEntry, Deck, DeckEntry, SwapPair } from './types';
import { CURRENT_POOL, defaultPrinting } from './pool';

let seq = 0;
export function genUid(prefix = 'u'): string {
  seq += 1;
  return `${prefix}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

type Spec = [cardId: string, count: number, printingId?: string, uid?: string];

function entries(specs: Spec[], zone: 'main' | 'sideboard'): AnyEntry[] {
  return specs.map(([cardId, count, printingId, uid]) => {
    const card = CURRENT_POOL.cardById.get(cardId);
    const e: DeckEntry = {
      kind: 'entry',
      uid: uid ?? genUid(zone === 'main' ? 'm' : 's'),
      cardId,
      printingId: printingId ?? (card ? defaultPrinting(card) : 'unknown'),
      count,
    };
    return e;
  });
}

function deck(d: Omit<Deck, 'main' | 'sideboard'> & { main: Spec[]; sideboard?: Spec[] }): Deck {
  return {
    ...d,
    builtin: true,
    main: entries(d.main, 'main'),
    sideboard: entries(d.sideboard ?? [], 'sideboard'),
  };
}

export const DEFAULT_DECKS: Deck[] = [
  deck({
    id: 'deck-aggro',
    name: '赤焰快攻（合规样板）',
    tag: '合规 · 快攻',
    description: '40 张主牌 + 7 张备选，赤焰盟约，曲线低，誓约骑士容易达成出场条件。',
    goal: {
      kind: 'card-enabled',
      cardId: 'c-oath',
      label: '誓约骑士在手，且起手另有 ≥2 张赤焰牌',
    },
    main: [
      ['core-flame', 1, undefined, 'aggro-core'],
      ['c-recruit', 4],
      ['c-blade', 4, 'c-blade-o', 'aggro-blade'],
      ['c-oath', 4],
      ['c-arrow', 4],
      ['c-berzerker', 4],
      ['c-drake', 3],
      ['n-courier', 4],
      ['n-scholar', 4],
      ['n-smith', 4],
      ['n-golem', 4],
    ],
    sideboard: [
      ['t-warden', 2, 't-warden-o', 'aggro-warden'],
      ['core-pact', 1, undefined, 'aggro-pact'],
      ['c-phoenix', 2],
      ['n-wish', 2],
    ],
  }),

  deck({
    id: 'deck-cycle',
    name: '四印轮转（单换失败 / 整批合法）',
    tag: '交换示例',
    description:
      '炎刃剑士与誓约骑士在主牌都已满 4 张，备选各放了 1 张异画印次。两对互换单独执行都会撞同名上限，两对一起换则总数不变、整批合法。',
    pitfall:
      '试试交换工作台里的预置方案：每一对单独换都失败，但两对作为同一批提交会整体合法并一次生效。',
    goal: {
      kind: 'card-enabled',
      cardId: 'c-oath',
      label: '誓约骑士在手，且起手另有 ≥2 张赤焰牌',
    },
    main: [
      ['core-flame', 1],
      ['c-blade', 4, 'c-blade-o', 'cycle-blade'],
      ['c-oath', 4, 'c-oath-o', 'cycle-oath'],
      ['c-recruit', 4],
      ['c-arrow', 4],
      ['c-berzerker', 4],
      ['c-drake', 4],
      ['c-phoenix', 4],
      ['n-courier', 4],
      ['n-scholar', 4],
      ['n-golem', 3],
    ],
    sideboard: [
      ['c-oath', 1, 'c-oath-aa', 'cycle-oath-aa'],
      ['c-blade', 1, 'c-blade-aa', 'cycle-blade-aa'],
      ['n-wish', 2],
    ],
  }),

  deck({
    id: 'deck-faction',
    name: '三色杂烩（核心阵营违规）',
    tag: '故意卡住 · 阵营',
    description: '带着赤焰盟主的盟约，却塞了苍澜潮卫和森罗弓手，核心不允许它们同队。',
    pitfall: '校验会分别指出：苍澜潮卫、林哨弓手触了 R-CORE-FACTION，违反赤焰盟主的盟约。',
    goal: { kind: 'faction-count', faction: 'crimson', count: 3, label: '起手至少 3 张赤焰牌' },
    main: [
      ['core-flame', 1],
      ['c-recruit', 4],
      ['c-blade', 4],
      ['c-arrow', 4],
      ['c-berzerker', 4],
      ['c-drake', 3],
      ['t-warden', 4],
      ['g-archer', 4],
      ['n-courier', 4],
      ['n-scholar', 4],
      ['n-golem', 4],
    ],
  }),

  deck({
    id: 'deck-printcap',
    name: '五张炎刃（印次超量）',
    tag: '故意卡住 · 数量上限',
    description: '炎刃剑士放了 3 张初版 + 2 张异画。印次不同，但共享 cardId 与总上限 4。',
    pitfall: 'R-COPY-LIMIT 会把两个印次合并计算为 5/4，而不是把异画当成另一张卡。',
    goal: {
      kind: 'card-enabled',
      cardId: 'c-oath',
      label: '誓约骑士在手且资格满足',
    },
    main: [
      ['core-flame', 1],
      ['c-blade', 3, 'c-blade-o', 'printcap-blade-o'],
      ['c-blade', 2, 'c-blade-aa', 'printcap-blade-aa'],
      ['c-recruit', 4],
      ['c-oath', 4],
      ['c-arrow', 4],
      ['c-berzerker', 4],
      ['c-drake', 4],
      ['n-courier', 4],
      ['n-scholar', 4],
      ['n-smith', 2],
      ['n-golem', 4],
    ],
  }),

  deck({
    id: 'deck-twocore',
    name: '赤蓝双核（盟约互斥）',
    tag: '故意卡住 · 双核心',
    description: '带了赤焰盟主与苍澜女王两枚核心（核心数量 2 本身合法），但两套盟约交集只剩中立，牌组里的赤焰牌被苍澜女王拒绝、苍澜牌被赤焰盟主拒绝。',
    pitfall: '错误会同时挂到「换入 / 涉事牌」和对应核心上，说明是哪枚核心不允许它同队。',
    goal: { kind: 'faction-count', faction: 'neutral', count: 3, label: '起手至少 3 张中立牌（两核互斥下唯一稳妥方向）' },
    main: [
      ['core-flame', 1],
      ['core-tide', 1],
      ['c-blade', 4],
      ['c-recruit', 4],
      ['t-warden', 4],
      ['t-oracle', 4],
      ['n-courier', 4],
      ['n-scholar', 4],
      ['n-smith', 4],
      ['n-golem', 4],
      ['n-wish', 4],
      ['n-lantern', 2],
    ],
  }),

  deck({
    id: 'deck-shortsize',
    name: '少两张（主牌数量不足）',
    tag: '故意卡住 · 牌库数量',
    description: '只有 38 张主牌。用来观察移除动作如何触发 R-DECK-SIZE，以及交换为何必须保持 1:1。',
    pitfall: '在交换工作台尝试只移走主牌、不换入备选牌，错误会归到「原牌」那一列。',
    goal: { kind: 'faction-count', faction: 'crimson', count: 3, label: '起手至少 3 张赤焰牌' },
    main: [
      ['core-flame', 1],
      ['c-recruit', 4],
      ['c-blade', 4],
      ['c-oath', 4],
      ['c-arrow', 4],
      ['c-berzerker', 4],
      ['c-drake', 3],
      ['n-courier', 4],
      ['n-scholar', 4],
      ['n-smith', 4],
      ['n-golem', 2],
    ],
  }),

  deck({
    id: 'deck-combo',
    name: '双生昼夜（低概率组合技）',
    tag: '种子对比 · 组合',
    description: '双生·昼与双生·夜各 1 张（传说上限 1），起手同时拿到才算开局成立，适合在种子对比里翻看失败起手。',
    goal: { kind: 'combo', cardIds: ['d-day', 'd-night'], label: '起手同时包含双生·昼与双生·夜' },
    main: [
      ['core-flame', 1],
      ['d-day', 1],
      ['d-night', 1],
      ['c-recruit', 4],
      ['c-blade', 4],
      ['c-oath', 4],
      ['c-arrow', 4],
      ['c-berzerker', 4],
      ['c-drake', 4],
      ['n-courier', 4],
      ['n-scholar', 4],
      ['n-golem', 4],
      ['n-wish', 1],
    ],
  }),

  deck({
    id: 'deck-grove',
    name: '森罗中速（阵营数量目标）',
    tag: '种子对比 · 中速',
    description: '高密度森罗牌，开局目标是起手至少 3 张森罗，护林狼还会检查起手里有没有林哨弓手。',
    goal: { kind: 'faction-count', faction: 'grove', count: 3, label: '起手至少 3 张森罗牌' },
    main: [
      ['core-wild', 1],
      ['g-archer', 4],
      ['g-wolf', 4],
      ['g-vine', 4],
      ['g-guardian', 4],
      ['g-treant', 4],
      ['n-courier', 4],
      ['n-scholar', 4],
      ['n-smith', 4],
      ['n-golem', 4],
      ['n-wish', 3],
    ],
  }),
];

export interface PresetPlan {
  id: string;
  deckId: string;
  name: string;
  blurb: string;
  pairs: SwapPair[];
}

export const PRESET_PLANS: PresetPlan[] = [
  {
    id: 'plan-cycle',
    deckId: 'deck-cycle',
    name: '限量轮转：炎刃 ↔ 誓约（两对一批）',
    blurb:
      '每一对单独换都会让换入牌达到 5/4；两对一起换时两张卡都是 −1+1，总数仍为 4。',
    pairs: [
      { id: 'pair-c1', mainUid: 'cycle-blade', sideUid: 'cycle-oath-aa' },
      { id: 'pair-c2', mainUid: 'cycle-oath', sideUid: 'cycle-blade-aa' },
    ],
  },
  {
    id: 'plan-pact',
    deckId: 'deck-aggro',
    name: '盟约升级：赤焰核心 → 熔潮盟核，并加入潮卫',
    blurb:
      '只把炎刃剑士换成苍澜潮卫：潮卫立刻触犯赤焰盟主的阵营盟约。同一批把核心换成允许苍澜的熔潮盟核后，整批合法。',
    pairs: [
      { id: 'pair-p1', mainUid: 'aggro-core', sideUid: 'aggro-pact' },
      { id: 'pair-p2', mainUid: 'aggro-blade', sideUid: 'aggro-warden' },
    ],
  },
];

export function cloneDefaultDecks(): Deck[] {
  return JSON.parse(JSON.stringify(DEFAULT_DECKS)) as Deck[];
}
