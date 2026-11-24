import type { PresetKey, TeamId } from '../domain/types.ts';
import { GameStore, browserStorage } from './store.ts';
import { buildRenderInput, dispatchAction, makeInitialUi, renderApp, setClipboardWriter, type UiAction } from './controller.ts';
import type { UiState } from './render.ts';

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 容器');

const store = new GameStore({ storage: browserStorage() });
let ui: UiState = makeInitialUi(store);

setClipboardWriter((text) => {
  navigator.clipboard?.writeText(text).catch(() => {
    /* 剪贴板被拒绝时忽略，用户仍可从 textarea 手动复制 */
  });
});

function draw(): void {
  root!.innerHTML = renderApp(buildRenderInput(store, ui));
}

/** 所有状态修改都经过 dispatchAction，结束后统一按最新的 store + ui 重绘。 */
function run(action: UiAction): void {
  ui = dispatchAction(store, ui, action);
  draw();
}

root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
  if (!target) return;
  const action = target.dataset.action ?? '';
  const team = target.dataset.team as TeamId | undefined;
  const deviceId = target.dataset.device;
  const id = target.dataset.id;
  switch (action) {
    case 'accept-handoff':
      if (team) run({ type: 'accept-handoff', team });
      break;
    case 'inc':
      if (team && deviceId) run({ type: 'adjust', team, deviceId, delta: 1 });
      break;
    case 'dec':
      if (team && deviceId) run({ type: 'adjust', team, deviceId, delta: -1 });
      break;
    case 'request-submit':
      if (team) run({ type: 'request-submit', team });
      break;
    case 'confirm-submit':
      if (team) run({ type: 'confirm-submit', team });
      break;
    case 'cancel-submit':
      run({ type: 'cancel-submit' });
      break;
    case 'load-example':
      if (team) run({ type: 'load-example', team });
      break;
    case 'settle':
      run({ type: 'settle' });
      break;
    case 'next-round':
      run({ type: 'next-round' });
      break;
    case 'toggle-rules':
      run({ type: 'toggle-rules' });
      break;
    case 'toggle-device':
      if (deviceId) run({ type: 'toggle-device', deviceId });
      break;
    case 'open-history':
      if (id) run({ type: 'open-history', id });
      break;
    case 'replay-history':
      if (id) run({ type: 'replay-history', id });
      break;
    case 'export-snapshot':
      run({ type: 'export-snapshot' });
      break;
    case 'export-record':
      run({ type: 'export-record' });
      break;
    case 'import-record':
      run({ type: 'import-record' });
      break;
    case 'restart':
      run({ type: 'restart' });
      break;
    case 'clear-save':
      run({ type: 'clear-save' });
      break;
    default:
      break;
  }
});

root.addEventListener('input', (event) => {
  const el = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (!el || !el.dataset) return;
  const field = (el as HTMLElement).dataset.field;
  if (field === 'import' && el instanceof HTMLTextAreaElement) {
    ui = { ...ui, importText: el.value };
  } else if (field === 'seed' && el instanceof HTMLInputElement) {
    ui = { ...ui, seedInput: el.value };
  } else if (field === 'preset' && el instanceof HTMLSelectElement) {
    ui = { ...ui, presetInput: el.value as PresetKey };
  }
});

draw();
