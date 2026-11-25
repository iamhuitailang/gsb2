import type { CharacterDef, ItemDef } from '../core/types.ts';

/**
 * 可在页面切换的角色。address 决定“说话对象”句式分支，
 * name 提供 {name} 变量的本地化值。
 */
export const CHARACTERS: CharacterDef[] = [
  {
    id: 'lynn',
    address: 'oldfriend',
    name: { 'zh-CN': '林恩', 'en-US': 'Lynn', 'ja-JP': 'リン' },
  },
  {
    id: 'vera',
    address: 'captain',
    name: { 'zh-CN': '薇拉', 'en-US': 'Vera', 'ja-JP': 'ヴェラ' },
  },
  {
    id: 'milo',
    address: 'kid',
    name: { 'zh-CN': '米洛', 'en-US': 'Milo', 'ja-JP': 'マイロ' },
  },
  {
    id: 'shade',
    address: 'stranger',
    name: { 'zh-CN': '兜帽客', 'en-US': 'Shade', 'ja-JP': 'シェイド' },
  },
];

export const CHARACTERS_BY_ID: Record<string, CharacterDef> = Object.fromEntries(
  CHARACTERS.map((c) => [c.id, c]),
);

/** 物品同时提供 {item} 名称与 category（决定量词句式） */
export const ITEMS: ItemDef[] = [
  {
    id: 'moon_tonic',
    category: 'potion',
    name: { 'zh-CN': '月露药水', 'en-US': 'Moondew Tonic', 'ja-JP': '月の雫薬' },
  },
  {
    id: 'ember_blade',
    category: 'weapon',
    name: { 'zh-CN': '余烬短刃', 'en-US': 'Ember Dagger', 'ja-JP': '残火の短剣' },
  },
  {
    id: 'berry_bun',
    category: 'food',
    name: { 'zh-CN': '麦香果包', 'en-US': 'Berry Bun', 'ja-JP': 'ベリーまん' },
  },
  {
    id: 'crystal_shard',
    category: 'material',
    name: { 'zh-CN': '共鸣晶簇', 'en-US': 'Resonant Shard', 'ja-JP': '共鳴結晶' },
  },
];

export const ITEMS_BY_ID: Record<string, ItemDef> = Object.fromEntries(
  ITEMS.map((i) => [i.id, i]),
);

/** 店主等 NPC，不参与称呼分支，只用于说话人名字 */
export const SPEAKERS: Record<string, Record<string, string>> = {
  moss: { 'zh-CN': '苔姨', 'en-US': 'Aunt Moss', 'ja-JP': '苔おば' },
  narrator: { 'zh-CN': '旁白', 'en-US': 'Narrator', 'ja-JP': 'ナレーション' },
};

export const CATEGORY_LABEL: Record<string, Record<string, string>> = {
  'zh-CN': { potion: '药水', weapon: '武器', food: '食物', material: '材料' },
  'en-US': { potion: 'potion', weapon: 'weapon', food: 'food', material: 'material' },
  'ja-JP': { potion: '薬', weapon: '武器', food: '食べ物', material: '素材' },
};

export function categoryLabel(category: string, locale: string): string {
  return CATEGORY_LABEL[locale]?.[category] ?? CATEGORY_LABEL['zh-CN'][category] ?? category;
}
