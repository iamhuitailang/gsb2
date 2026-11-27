import type { CardDef, FactionId } from './types';

export const RULES = {
  mainSize: 40,
  sideboardMax: 10,
  defaultCopyLimit: 4,
  coreMin: 1,
  coreMax: 2,
  openingHandSize: 5,
} as const;

export const FACTIONS: Record<
  FactionId,
  { id: FactionId; name: string; short: string; color: string; soft: string }
> = {
  crimson: { id: 'crimson', name: '赤焰', short: '赤', color: '#c93b3b', soft: '#fdecec' },
  tide: { id: 'tide', name: '苍澜', short: '澜', color: '#1f6fc4', soft: '#e9f2fc' },
  grove: { id: 'grove', name: '森罗', short: '森', color: '#2f8a4f', soft: '#eaf6ee' },
  neutral: { id: 'neutral', name: '中立', short: '中', color: '#4b5563', soft: '#eef1f5' },
};

export const FACTION_ORDER: FactionId[] = ['crimson', 'tide', 'grove', 'neutral'];

// ---------------------------------------------------------------------------
// 卡牌定义。id 是稳定身份：导入导出、跨版本认牌都只认 id，名字仅用于展示。
// ---------------------------------------------------------------------------

const COMMON_CARDS: CardDef[] = [
  // ---- 核心牌：阵营盟约 ----
  {
    id: 'core-flame',
    name: '赤焰盟主·烨',
    faction: 'crimson',
    type: 'core',
    cost: null,
    limit: 1,
    text: '核心 · 盟约【赤焰】：同队牌组中只允许出现赤焰与中立阵营。',
    core: { allied: ['crimson', 'neutral'] },
    printings: [
      { id: 'core-flame-o', label: '初版', set: 'ORIGIN', since: '1.0' },
      { id: 'core-flame-aa', label: '异画藏印', set: 'ALTARTS', since: '1.0', foil: true },
    ],
  },
  {
    id: 'core-tide',
    name: '苍澜女王·汐',
    faction: 'tide',
    type: 'core',
    cost: null,
    limit: 1,
    text: '核心 · 盟约【苍澜】：同队牌组中只允许出现苍澜与中立阵营。',
    core: { allied: ['tide', 'neutral'] },
    printings: [{ id: 'core-tide-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 'core-wild',
    name: '森罗古灵·苔',
    faction: 'grove',
    type: 'core',
    cost: null,
    limit: 1,
    text: '核心 · 盟约【森罗】：同队牌组中只允许出现森罗与中立阵营。',
    core: { allied: ['grove', 'neutral'] },
    printings: [{ id: 'core-wild-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 'core-pact',
    name: '熔潮盟核·焱汐',
    faction: 'neutral',
    type: 'core',
    cost: null,
    limit: 1,
    text: '核心 · 盟约【熔潮】：允许赤焰、苍澜与中立同队（不允许森罗）。',
    core: { allied: ['crimson', 'tide', 'neutral'] },
    printings: [{ id: 'core-pact-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },

  // ---- 赤焰 ----
  {
    id: 'c-recruit',
    name: '赤焰新兵',
    faction: 'crimson',
    type: 'unit',
    cost: 1,
    limit: 4,
    text: '冲锋：入场当回合可攻击。',
    printings: [{ id: 'c-recruit-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 'c-blade',
    name: '炎刃剑士',
    faction: 'crimson',
    type: 'unit',
    cost: 2,
    limit: 4,
    text: '攻击时附加 1 点灼烧。',
    printings: [
      { id: 'c-blade-o', label: '初版', set: 'ORIGIN', since: '1.0' },
      { id: 'c-blade-aa', label: '异画藏印', set: 'ALTARTS', since: '1.0', foil: true },
      { id: 'c-blade-neo', label: '新纪元重绘', set: 'NEO', since: '2.0' },
    ],
  },
  {
    id: 'c-oath',
    name: '誓约骑士',
    faction: 'crimson',
    type: 'unit',
    cost: 3,
    limit: 4,
    text: '起手誓约：开局起手中另有至少 2 张赤焰牌时，此牌才有出场资格（1 费冲锋）。',
    opening: {
      kind: 'faction-other',
      faction: 'crimson',
      count: 2,
      text: '起手中另有至少 2 张赤焰阵营牌',
    },
    printings: [
      { id: 'c-oath-o', label: '初版', set: 'ORIGIN', since: '1.0' },
      { id: 'c-oath-aa', label: '异画藏印', set: 'ALTARTS', since: '1.0', foil: true },
    ],
  },
  {
    id: 'c-arrow',
    name: '火箭齐射',
    faction: 'crimson',
    type: 'spell',
    cost: 2,
    limit: 4,
    text: '对一个目标造成 3 点伤害。',
    printings: [{ id: 'c-arrow-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 'c-berzerker',
    name: '狂斧手',
    faction: 'crimson',
    type: 'unit',
    cost: 3,
    limit: 4,
    text: '血量越低，攻击力越高。',
    printings: [{ id: 'c-berzerker-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 'c-drake',
    name: '幼焰龙',
    faction: 'crimson',
    type: 'unit',
    cost: 4,
    limit: 4,
    text: '登场：对所有敌方随从造成 1 点灼烧。',
    printings: [{ id: 'c-drake-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 'c-phoenix',
    name: '不死凤凰',
    faction: 'crimson',
    type: 'unit',
    cost: 5,
    limit: 4,
    text: '死亡后以 1 血形态复活一次。',
    printings: [{ id: 'c-phoenix-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },

  // ---- 苍澜 ----
  {
    id: 't-mist',
    name: '迷雾水手',
    faction: 'tide',
    type: 'unit',
    cost: 1,
    limit: 4,
    text: '潜行：首次攻击前不可被指定。',
    printings: [{ id: 't-mist-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 't-warden',
    name: '潮卫',
    faction: 'tide',
    type: 'unit',
    cost: 2,
    limit: 4,
    text: '护卫：相邻友军不会被远程攻击。',
    printings: [
      { id: 't-warden-o', label: '初版', set: 'ORIGIN', since: '1.0' },
      { id: 't-warden-aa', label: '异画藏印', set: 'ALTARTS', since: '1.0', foil: true },
    ],
  },
  {
    id: 't-frost',
    name: '寒霜回响',
    faction: 'tide',
    type: 'spell',
    cost: 2,
    limit: 4,
    text: '冻结一个目标，并抽一张牌。',
    printings: [{ id: 't-frost-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 't-siren',
    name: '深潮歌者',
    faction: 'tide',
    type: 'unit',
    cost: 3,
    limit: 4,
    text: '出场资格：起手中另有至少 1 张苍澜牌来和歌。',
    opening: {
      kind: 'faction-other',
      faction: 'tide',
      count: 1,
      text: '起手中另有至少 1 张苍澜阵营牌',
    },
    printings: [{ id: 't-siren-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 't-oracle',
    name: '神谕者',
    faction: 'tide',
    type: 'unit',
    cost: 3,
    limit: 4,
    text: '预言：查看牌库顶三张牌并放回。',
    printings: [{ id: 't-oracle-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 't-kraken',
    name: '深渊巨鱿',
    faction: 'tide',
    type: 'unit',
    cost: 6,
    limit: 1,
    text: '传说 · 登场：淹没对方半场。',
    printings: [{ id: 't-kraken-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },

  // ---- 森罗 ----
  {
    id: 'g-archer',
    name: '林哨弓手',
    faction: 'grove',
    type: 'unit',
    cost: 1,
    limit: 4,
    text: '远程：可直接攻击后排。',
    printings: [
      { id: 'g-archer-o', label: '初版', set: 'ORIGIN', since: '1.0' },
      { id: 'g-archer-aa', label: '异画藏印', set: 'ALTARTS', since: '1.0', foil: true },
    ],
  },
  {
    id: 'g-vine',
    name: '缠绕藤蔓',
    faction: 'grove',
    type: 'spell',
    cost: 1,
    limit: 4,
    text: '束缚一个目标两回合。',
    printings: [{ id: 'g-vine-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 'g-wolf',
    name: '护林狼',
    faction: 'grove',
    type: 'unit',
    cost: 2,
    limit: 4,
    text: '结伴：起手中有「林哨弓手」时才获得出场资格，并肩作战 +2 攻。',
    opening: { kind: 'partner', partnerId: 'g-archer', text: '起手中同时持有「林哨弓手」' },
    printings: [{ id: 'g-wolf-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 'g-guardian',
    name: '翠林守卫',
    faction: 'grove',
    type: 'unit',
    cost: 3,
    limit: 4,
    text: '嘲讽，荆棘 2。',
    printings: [{ id: 'g-guardian-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 'g-treant',
    name: '古树人',
    faction: 'grove',
    type: 'unit',
    cost: 4,
    limit: 4,
    text: '回合结束时恢复 2 点生命。',
    printings: [{ id: 'g-treant-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },

  // ---- 中立 ----
  {
    id: 'n-courier',
    name: '行商',
    faction: 'neutral',
    type: 'unit',
    cost: 1,
    limit: 4,
    text: '进场：抽一张牌。',
    printings: [{ id: 'n-courier-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 'n-lantern',
    name: '引路灯',
    faction: 'neutral',
    type: 'relic',
    cost: 1,
    limit: 4,
    text: '使一个随从本回合获得先锋。',
    printings: [{ id: 'n-lantern-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 'n-golem',
    name: '方片魔像',
    faction: 'neutral',
    type: 'unit',
    cost: 3,
    limit: 4,
    text: '构装体，没有阵营，不受盟约限制。',
    printings: [
      { id: 'n-golem-o', label: '初版', set: 'ORIGIN', since: '1.0' },
      { id: 'n-golem-aa', label: '异画藏印', set: 'ALTARTS', since: '1.0' },
    ],
  },
  {
    id: 'n-scholar',
    name: '博学者',
    faction: 'neutral',
    type: 'unit',
    cost: 2,
    limit: 4,
    text: '进场：查看牌库顶两张牌。',
    printings: [{ id: 'n-scholar-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 'n-smith',
    name: '锻炉匠',
    faction: 'neutral',
    type: 'unit',
    cost: 2,
    limit: 4,
    text: '战吼：使手牌中一张武器牌 -1 费。',
    printings: [{ id: 'n-smith-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 'n-wish',
    name: '许愿方片',
    faction: 'neutral',
    type: 'spell',
    cost: 2,
    limit: 4,
    text: '选择：回 3 血，或获得一个空法力水晶。',
    printings: [{ id: 'n-wish-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },

  // ---- 传说组合技 ----
  {
    id: 'd-day',
    name: '双生·昼',
    faction: 'neutral',
    type: 'unit',
    cost: 3,
    limit: 1,
    text: '传说 · 双生：起手中同时有「双生·夜」时，两牌才都具有出场资格，联手造成 6 点伤害。',
    opening: { kind: 'partner', partnerId: 'd-night', text: '起手中同时持有「双生·夜」' },
    printings: [{ id: 'd-day-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
  {
    id: 'd-night',
    name: '双生·夜',
    faction: 'neutral',
    type: 'unit',
    cost: 3,
    limit: 1,
    text: '传说 · 双生：起手中同时有「双生·昼」时，两牌才都具有出场资格，联手造成 6 点伤害。',
    opening: { kind: 'partner', partnerId: 'd-day', text: '起手中同时持有「双生·昼」' },
    printings: [{ id: 'd-night-o', label: '初版', set: 'ORIGIN', since: '1.0' }],
  },
];

/** 1.0 版本的旧「赤焰老兵」，在 2.0 被同名重做牌替换（id 改变）。 */
const VETERAN_OLD: CardDef = {
  id: 'c-veteran',
  name: '赤焰老兵',
  faction: 'crimson',
  type: 'unit',
  cost: 3,
  limit: 4,
  text: '旧版：3/4，每回合 +1 攻击力。已在 2.0 退役。',
  printings: [
    { id: 'c-veteran-o', label: '初版', set: 'ORIGIN', since: '1.0' },
    { id: 'c-veteran-foil', label: '闪印纪念', set: 'PROMO', since: '1.0', foil: true },
  ],
};

/** 2.0 的同名重做：名字一样，但 id / 费用 / 文本全变了，不能悄悄顶替。 */
const VETERAN_NEW: CardDef = {
  id: 'c-veteran-neo',
  name: '赤焰老兵',
  faction: 'crimson',
  type: 'unit',
  cost: 2,
  limit: 4,
  text: '新版重做：2/2，战吼造成 1 点伤害（与旧版不是同一张牌）。',
  printings: [{ id: 'c-veteran-neo-o', label: '新纪元', set: 'NEO', since: '2.0' }],
};

export interface PoolVersion {
  version: string;
  label: string;
  released: string;
  cards: CardDef[];
  cardById: Map<string, CardDef>;
}

function makePool(version: string, label: string, released: string, cards: CardDef[]): PoolVersion {
  return { version, label, released, cards, cardById: new Map(cards.map((c) => [c.id, c])) };
}

export const POOL_V1 = makePool('1.0', '创世初印', '虚构 2024', [...COMMON_CARDS, VETERAN_OLD]);
export const POOL_V2 = makePool('2.0', '新纪元', '虚构 2026', [...COMMON_CARDS, VETERAN_NEW]);

/** 整个应用默认运行在最新卡池 2.0。 */
export const CURRENT_POOL: PoolVersion = POOL_V2;

export function defaultPrinting(card: CardDef): string {
  return card.printings[0]?.id ?? '';
}

export function findPrinting(card: CardDef | undefined, printingId: string | undefined) {
  return card?.printings.find((p) => p.id === printingId);
}
