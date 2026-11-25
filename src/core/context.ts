import type {
  AddressKind,
  CharacterDef,
  ItemCategory,
  ItemDef,
  LanguagePack,
  PluralCategory,
  TriggerSample,
} from './types.ts';
import { pluralCategory } from './plural.ts';

export interface MatchContext {
  countBucket?: PluralCategory;
  address?: AddressKind;
  category?: ItemCategory;
}

export interface BuiltContext {
  match: MatchContext;
  values: Record<string, unknown>;
  character?: CharacterDef;
  item?: ItemDef;
}

function localizedName(names: Record<string, string>, locale: string): string {
  return names[locale] ?? names['zh-CN'] ?? Object.values(names)[0] ?? '';
}

/** 事件变量也可能本身是三语值，用 lv() 构造 */
export interface LocalizedVar {
  $localized: Record<string, string>;
}

export function lv(values: Record<string, string>): LocalizedVar {
  return { $localized: values };
}

function resolveVar(value: unknown, locale: string): unknown {
  if (value && typeof value === 'object' && '$localized' in value) {
    const map = (value as LocalizedVar).$localized;
    return map[locale] ?? map['zh-CN'] ?? Object.values(map)[0] ?? '';
  }
  return value;
}

/**
 * 把一条触发样例补成渲染上下文：
 * 合并事件自带 vars、数量、角色称呼词、角色名、物品本地化名称。
 * 页面批量预演时，UI 先改写 sample 的 characterId/itemId/count 再走到这里。
 */
export function buildContext(
  sample: TriggerSample,
  locale: string,
  pack: LanguagePack,
  characters: Record<string, CharacterDef>,
  items: Record<string, ItemDef>,
): BuiltContext {
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sample.vars ?? {})) {
    values[k] = resolveVar(v, locale);
  }
  const match: MatchContext = {};

  if (typeof sample.count === 'number') {
    values.count = sample.count;
    match.countBucket = pluralCategory(locale, sample.count);
  }

  let character: CharacterDef | undefined;
  if (sample.characterId) {
    character = characters[sample.characterId];
    if (character) {
      match.address = character.address;
      values.address = pack.terms.address[character.address] ?? character.address;
      values.name = localizedName(character.name, locale);
    }
  }

  let item: ItemDef | undefined;
  if (sample.itemId) {
    item = items[sample.itemId];
    if (item) {
      match.category = item.category;
      values.item = localizedName(item.name, locale);
      values.category = item.category;
    }
  }

  return { match, values, character, item };
}
