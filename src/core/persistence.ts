import type { AppState } from './state.ts';
import { STORAGE_KEY, defaultState } from './state.ts';

/** 全量状态落 localStorage，刷新/重开后一键复现 */
export function saveState(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('状态保存失败', err);
  }
}

export function loadState(): AppState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return mergeWithDefaults(JSON.parse(raw) as Partial<AppState>);
  } catch (err) {
    console.warn('状态读取失败', err);
    return null;
  }
}

export function clearSavedState(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** 向前兼容：补全后续版本新增的字段 */
function mergeWithDefaults(parsed: Partial<AppState>): AppState {
  const d = defaultState();
  return {
    ...d,
    ...parsed,
    camera: { ...d.camera, ...(parsed.camera ?? {}) },
    model: { ...d.model, ...(parsed.model ?? {}) },
    light: { ...d.light, ...(parsed.light ?? {}) },
    selection: { ...d.selection, ...(parsed.selection ?? {}) },
  };
}
