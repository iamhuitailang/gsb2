import type { AppState } from './state.ts';

export interface UiContext {
  state: AppState;
  /** 合并状态并整体重渲染（textarea 等非受控局部除外） */
  update(patch: Partial<AppState>): void;
  rerender(): void;
}
