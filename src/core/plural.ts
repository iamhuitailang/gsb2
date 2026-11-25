import type { PluralCategory } from './types.ts';

/**
 * 数量桶规则（本项目的策划约定，比纯 CLDR 更适合游戏文案）：
 * - n === 0 永远走 zero（英文 CLDR 本来把 0 归 other，但策划需要独立否定句）
 * - n === 1 永远走 one（中日文虽然没有形态复数，但译者常需要“仅剩一件”句式）
 * - 其余数量再按语言规则归桶（en -> other，zh/ja/ko -> other）
 */
export function pluralCategory(locale: string, n: number): PluralCategory {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'other';
  if (n === 0) return 'zero';
  if (n === 1) return 'one';
  const l = locale.toLowerCase();
  if (l.startsWith('en')) return 'other';
  if (l.startsWith('zh') || l.startsWith('ja') || l.startsWith('ko')) return 'other';
  return 'other';
}

/**
 * 当目标数量桶没有专用句式时，允许依次尝试的数量桶（约定回退）。
 * 最后一档由匹配器再尝试“完全不限定 count”的句式。
 */
export function countBucketFallback(order: PluralCategory): PluralCategory[] {
  switch (order) {
    case 'zero':
      return ['zero', 'other'];
    case 'one':
      return ['one', 'other'];
    case 'two':
      return ['two', 'few', 'other'];
    case 'few':
      return ['few', 'other'];
    case 'many':
      return ['many', 'other'];
    default:
      return ['other'];
  }
}

/** 建议一个能走到指定 when 条件的具体数量，用于“未走到句式”的修复提示 */
export function exampleCountForBucket(bucket: PluralCategory | undefined): number | undefined {
  switch (bucket) {
    case 'zero':
      return 0;
    case 'one':
      return 1;
    case 'two':
      return 2;
    case 'few':
      return 3;
    case 'many':
      return 9;
    case 'other':
      return 5;
    default:
      return undefined;
  }
}
