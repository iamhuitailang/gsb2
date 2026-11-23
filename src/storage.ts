import type { CameraSnapshot } from './camera';
import type { PickResult, SerializedLayout } from './types';

const LAYOUT_KEY = 'instanced-pick/layout/v1';
const PICKS_KEY = 'instanced-pick/picks/v1';

interface PersistedLayout {
  instances: SerializedLayout['instances'];
  nextId: number;
  nextBatchId: number;
  drawOrder: number[];
  cameraSnapshot: CameraSnapshot;
  savedAt: string;
}

export const storage = {
  saveLayout(data: PersistedLayout): void {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(data));
  },

  loadLayout(): PersistedLayout | null {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PersistedLayout;
    } catch {
      return null;
    }
  },

  savePicks(picks: PickResult[]): void {
    localStorage.setItem(PICKS_KEY, JSON.stringify(picks));
  },

  loadPicks(): PickResult[] {
    const raw = localStorage.getItem(PICKS_KEY);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as PickResult[];
    } catch {
      return [];
    }
  },

  download(filename: string, payload: unknown): void {
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};
