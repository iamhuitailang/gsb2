import type { PresetKey, TeamId } from '../domain/types.ts';
import type { GameStore } from './store.ts';
import { initialUi, renderApp, type RenderInput, type UiState } from './render.ts';

export type UiAction =
  | { type: 'accept-handoff'; team: TeamId }
  | { type: 'adjust'; team: TeamId; deviceId: string; delta: number }
  | { type: 'request-submit'; team: TeamId }
  | { type: 'confirm-submit'; team: TeamId }
  | { type: 'cancel-submit' }
  | { type: 'load-example'; team: TeamId }
  | { type: 'settle' }
  | { type: 'next-round' }
  | { type: 'toggle-rules' }
  | { type: 'toggle-device'; deviceId: string }
  | { type: 'open-history'; id: string }
  | { type: 'replay-history'; id: string }
  | { type: 'export-snapshot' }
  | { type: 'export-record' }
  | { type: 'set-import-text'; text: string }
  | { type: 'import-record' }
  | { type: 'set-seed'; text: string }
  | { type: 'set-preset'; preset: PresetKey }
  | { type: 'restart' }
  | { type: 'clear-save' };

/**
 * 把一次界面动作翻译成 store 调用 + UI 局部状态更新。
 * 与 DOM 无关，浏览器和测试共用同一份逻辑。
 */
export function dispatchAction(store: GameStore, ui: UiState, action: UiAction): UiState {
  const next: UiState = { ...ui };
  switch (action.type) {
    case 'accept-handoff':
      store.acceptHandoff(action.team);
      break;
    case 'adjust':
      store.adjustWork(action.team, action.deviceId, action.delta);
      break;
    case 'request-submit':
      next.confirmSubmit = action.team;
      break;
    case 'confirm-submit':
      next.confirmSubmit = null;
      store.submit(action.team);
      break;
    case 'cancel-submit':
      next.confirmSubmit = null;
      break;
    case 'load-example':
      store.loadExample(action.team);
      break;
    case 'settle':
      store.settle();
      break;
    case 'next-round':
      next.openDeviceId = null;
      store.startNextRound();
      break;
    case 'toggle-rules':
      next.showRules = !ui.showRules;
      break;
    case 'toggle-device':
      next.openDeviceId = ui.openDeviceId === action.deviceId ? null : action.deviceId;
      break;
    case 'open-history':
      next.openHistoryId = ui.openHistoryId === action.id ? null : action.id;
      next.replayMessage = null;
      break;
    case 'replay-history':
      next.replayMessage = store.replayHistoryRecord(action.id);
      break;
    case 'export-snapshot':
      copyToClipboard(store.exportSnapshot());
      break;
    case 'export-record':
      copyToClipboard(store.exportCurrentRecord());
      break;
    case 'set-import-text':
      next.importText = action.text;
      break;
    case 'import-record':
      store.importSettledRecord(ui.importText);
      next.importText = '';
      next.importMessage = store.getError() ?? store.getNotice();
      break;
    case 'set-seed':
      next.seedInput = action.text;
      break;
    case 'set-preset':
      next.presetInput = action.preset;
      break;
    case 'restart':
      next.confirmSubmit = null;
      next.openDeviceId = null;
      next.openHistoryId = null;
      store.restart(ui.seedInput, ui.presetInput);
      break;
    case 'clear-save':
      store.clearSavedGame();
      break;
  }
  return next;
}

export type ClipboardWriter = (text: string) => void;

let clipboard: ClipboardWriter = (text) => {
  void text;
};

export function setClipboardWriter(writer: ClipboardWriter): void {
  clipboard = writer;
}

function copyToClipboard(text: string): void {
  if (text) clipboard(text);
}

export function buildRenderInput(
  store: GameStore,
  ui: UiState,
): RenderInput {
  return {
    view: store.getViewModel(),
    ui,
    notice: store.getNotice(),
    error: store.getError(),
    saveError: store.getSaveError(),
    savedAt: store.getSavedAt(),
    restored: store.wasRestored(),
  };
}

export function makeInitialUi(store: GameStore): UiState {
  return initialUi(store.getViewModel());
}

export { renderApp };
