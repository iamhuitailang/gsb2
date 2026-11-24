import {
  DEFAULT_ENABLED_IDS,
  DEFAULT_LANGUAGE,
  DEFAULT_SCENE,
  DEFAULT_SELECTED_ITEM,
  DEMO_LIBRARY,
  ITEMS,
  LANGUAGES,
  SCENES,
} from './demoData';
import type {
  ItemDef,
  LabConfig,
  LanguageDef,
  PackManifest,
  SceneDef,
} from './types';
import type { ApplyPlan } from './engine/batch';

export interface ToastState {
  kind: 'ok' | 'error' | 'info';
  text: string;
}

export type ModalState =
  | { type: 'diff'; plan: ApplyPlan; selectedIds: string[] }
  | {
      type: 'import-report';
      ok: boolean;
      title: string;
      lines: string[];
      verification?: { checked: number; consistent: number; mismatchCount: number } | null;
    }
  | null;

export interface AppState {
  library: PackManifest[];
  items: ItemDef[];
  scenes: SceneDef[];
  languages: LanguageDef[];
  config: LabConfig;
  /** 批量面板中勾选的「待启用」包 id */
  batchSelection: string[];
  expandAllTraces: boolean;
  modal: ModalState;
  toast: ToastState | null;
  /** 每次导入 / 重置后自增，用于触发一些只在状态来源变化时才做的事 */
  revision: number;
}

export function createInitialState(): AppState {
  const enabled: Record<string, boolean> = {};
  for (const p of DEMO_LIBRARY) enabled[p.id] = false;
  for (const id of DEFAULT_ENABLED_IDS) enabled[id] = true;

  return {
    library: DEMO_LIBRARY,
    items: ITEMS,
    scenes: SCENES,
    languages: LANGUAGES,
    config: {
      query: { scene: DEFAULT_SCENE, language: DEFAULT_LANGUAGE },
      selectedItemId: DEFAULT_SELECTED_ITEM,
      enabled,
      priorities: {},
    },
    batchSelection: [],
    expandAllTraces: false,
    modal: null,
    toast: null,
    revision: 0,
  };
}
