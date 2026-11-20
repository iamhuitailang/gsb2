import type { SceneObjectData, TimelineKey } from '../core/types.js';
import type { CameraPathEditorUi } from './ui.js';
import type { Project } from '../core/types.js';

export interface LeftPanelApi {
  refresh(): void;
  refreshLight(): void;
}

export interface RightPanelApi {
  refresh(): void;
  refreshLight(): void;
}

export interface TransportApi {
  refresh(): void;
  sync(): void;
}

export interface TimelinePanelApi {
  refresh(): void;
  sync(): void;
}

export interface UiRefs {
  left: LeftPanelApi | null;
  right: RightPanelApi | null;
  transport: TransportApi | null;
  timeline: TimelinePanelApi | null;
  undoButton: HTMLButtonElement | null;
  redoButton: HTMLButtonElement | null;
  viewToggle: HTMLButtonElement | null;
  gridToggle: HTMLButtonElement | null;
  frustumToggle: HTMLButtonElement | null;
}

export type EditorUi = CameraPathEditorUi;
export type { SceneObjectData, TimelineKey, Project };
