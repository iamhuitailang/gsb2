import type { EmitterConfig, Project } from '../core/types.ts';
import { createPresetProject } from '../core/presets.ts';

export interface PlaybackState {
  time: number;
  playing: boolean;
  loop: boolean;
  /** 逐帧步进使用的帧率，null 表示跟随场景 fps */
  stepFps: number | null;
}

export interface ViewState {
  selectedEmitterId: string | null;
  showGrid: boolean;
  showMarkers: boolean;
  autoPauseOnEdit: boolean;
}

export interface EmitterStat {
  id: string;
  name: string;
  count: number;
  alive: number;
  omitted: number;
  simMs: number;
  budget: number;
  enabled: boolean;
}

export interface StatsState {
  particleCount: number;
  simMs: number;
  drawMs: number;
  frameMs: number;
  fps: number;
  overCap: boolean;
  omitted: number;
  capped: boolean;
  scanReduced: boolean;
  aliveTotal: number;
  perEmitter: EmitterStat[];
}

export type ChangeReason = 'project' | 'playback' | 'selection' | 'view' | 'stats' | 'reload';

export interface AppState {
  project: Project;
  playback: PlaybackState;
  view: ViewState;
  stats: StatsState;
  /** 工程是否有未保存修改 */
  dirty: boolean;
  lastSavedAt: number | null;
  /** 外部整体替换工程（载入、撤销、新建）时递增，面板据此整体重建 */
  epoch: number;
}

export type Listener = (state: AppState, reason: ChangeReason) => void;

export interface Store {
  readonly state: AppState;
  subscribe(listener: Listener): () => void;
  update(mutator: (state: AppState) => void, reason: ChangeReason): void;
  setEmitter(
    id: string,
    mutator: (emitter: EmitterConfig) => void,
    options?: { markDirty?: boolean; pauseOnEdit?: boolean },
  ): void;
  replaceProject(project: Project, options?: { markDirty?: boolean; resetTime?: boolean }): void;
  markSaved(): void;
}export function emptyStats(): StatsState {
  return {
    particleCount: 0,
    simMs: 0,
    drawMs: 0,
    frameMs: 0,
    fps: 0,
    overCap: false,
    omitted: 0,
    capped: false,
    scanReduced: false,
    aliveTotal: 0,
    perEmitter: [],
  };
}

export function createInitialState(project: Project = createPresetProject('spark')): AppState {
  return {
    project,
    playback: { time: 0, playing: false, loop: true, stepFps: null },
    view: {
      selectedEmitterId: project.emitters[0]?.id ?? null,
      showGrid: true,
      showMarkers: true,
      autoPauseOnEdit: true,
    },
    stats: emptyStats(),
    dirty: false,
    lastSavedAt: null,
    epoch: 0,
  };
}

export function createStore(initial: AppState): Store {
  let state = initial;
  const listeners = new Set<Listener>();

  function emit(reason: ChangeReason) {
    for (const listener of listeners) listener(state, reason);
  }

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(mutator, reason) {
      mutator(state);
      emit(reason);
    },
    setEmitter(id, mutator, options = {}) {
      const emitter = state.project.emitters.find((item) => item.id === id);
      if (!emitter) return;
      mutator(emitter);
      if (options.markDirty !== false) state.dirty = true;
      // 编辑参数时若正在播放，暂停一下，避免播放推进与编辑互相干扰。
      if (state.view.autoPauseOnEdit && state.playback.playing) {
        state.playback.playing = false;
        emit('playback');
      }
      emit('project');
    },
    replaceProject(project, options = {}) {
      state.project = project;
      if (
        state.view.selectedEmitterId &&
        !project.emitters.some((e) => e.id === state.view.selectedEmitterId)
      ) {
        state.view.selectedEmitterId = project.emitters[0]?.id ?? null;
      }
      if (options.resetTime !== false) state.playback.time = 0;
      state.playback.playing = false;
      state.epoch += 1;
      if (options.markDirty !== false) state.dirty = true;
      emit('reload');
    },
    markSaved() {
      state.dirty = false;
      state.lastSavedAt = Date.now();
      emit('project');
    },
  };
}
