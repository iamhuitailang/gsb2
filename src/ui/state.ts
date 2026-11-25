import type { DiffReport, IssueKind, LanguagePack, QaIssue } from '../core/types.ts';
import { BASELINE_PACKS, clonePacks } from '../data/packs/index.ts';
import { CHARACTERS, ITEMS } from '../data/game-data.ts';
import { ALL_SAMPLES } from '../data/events.ts';
import { runChecks, aggregateIssues } from '../core/checks.ts';
import { REFERENCE_LOCALE } from '../data/packs/index.ts';

export type TabId = 'play' | 'qa' | 'diff';
export type DiffFilter = 'all' | 'text-changed' | 'source-only' | 'status-changed' | 'unchanged';

export interface AppState {
  tab: TabId;
  locale: string;
  characterId: string;
  itemId: string;
  count: number;

  characters: typeof CHARACTERS;
  items: typeof ITEMS;

  baselinePacks: Record<string, LanguagePack>;
  packs: Record<string, LanguagePack>;

  rawIssues: QaIssue[];
  issues: QaIssue[];
  issueFilter: IssueKind | 'all';
  checklistOpen: boolean;

  diffLocale: string;
  diff: DiffReport | null;
  diffFilter: DiffFilter;
  packJson: string;
  jsonError: string | null;
}

export function recomputeIssues(packs: Record<string, LanguagePack>) {
  const rawIssues = runChecks({
    packs,
    characters: Object.fromEntries(CHARACTERS.map((c) => [c.id, c])),
    items: Object.fromEntries(ITEMS.map((i) => [i.id, i])),
    referenceLocale: REFERENCE_LOCALE,
    samples: ALL_SAMPLES,
  });
  return { rawIssues, issues: aggregateIssues(rawIssues) };
}

export function createInitialState(): AppState {
  const packs = clonePacks(BASELINE_PACKS);
  const { rawIssues, issues } = recomputeIssues(packs);
  return {
    tab: 'play',
    locale: 'zh-CN',
    characterId: 'vera',
    itemId: 'moon_tonic',
    count: 2,
    characters: CHARACTERS,
    items: ITEMS,
    baselinePacks: clonePacks(BASELINE_PACKS),
    packs,
    rawIssues,
    issues,
    issueFilter: 'all',
    checklistOpen: false,
    diffLocale: 'ja-JP',
    diff: null,
    diffFilter: 'all',
    packJson: JSON.stringify(BASELINE_PACKS['ja-JP'], null, 2),
    jsonError: null,
  };
}
