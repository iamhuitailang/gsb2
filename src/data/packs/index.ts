import type { LanguagePack } from '../../core/types.ts';
import { zhCN } from './zh-CN.ts';
import { enUS } from './en-US.ts';
import { jaJP } from './ja-JP.ts';

export const BASELINE_PACKS: Record<string, LanguagePack> = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'ja-JP': jaJP,
};

export const REFERENCE_LOCALE = 'zh-CN';

export const LOCALE_ORDER = ['zh-CN', 'en-US', 'ja-JP'];

export function clonePacks(packs: Record<string, LanguagePack>): Record<string, LanguagePack> {
  return JSON.parse(JSON.stringify(packs)) as Record<string, LanguagePack>;
}
