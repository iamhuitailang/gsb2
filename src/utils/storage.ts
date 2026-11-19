import {
  IDB_NAME,
  IDB_STORE,
  PROJECT_STORAGE_KEY,
  VIEW_STORAGE_KEY,
  type Project,
  type ViewState,
} from '../types';
import { deepClone } from './helpers';

/* ---------------- localStorage：工程与视图状态 ---------------- */

export function saveProjectToStorage(project: Project): void {
  try {
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(project));
  } catch (err) {
    // 配额超限时（例如工程过大）给出明确错误，由调用方提示
    throw new Error(`工程保存失败：${(err as Error).message}`);
  }
}

export function loadProjectFromStorage(): Project | null {
  const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Project;
  } catch {
    return null;
  }
}

export function clearStoredProject(): void {
  localStorage.removeItem(PROJECT_STORAGE_KEY);
}

export function saveViewToStorage(view: ViewState): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    /* 视图状态丢失不影响工程，忽略 */
  }
}

export function loadViewFromStorage(): Partial<ViewState> | null {
  const raw = localStorage.getItem(VIEW_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<ViewState>;
  } catch {
    return null;
  }
}

/* ---------------- IndexedDB：录音音频 Blob ---------------- */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putRecordingBlob(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function getRecordingBlob(id: string): Promise<Blob | undefined> {
  const db = await openDb();
  try {
    return await new Promise<Blob | undefined>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(id);
      req.onsuccess = () => resolve(req.result as Blob | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function deleteRecordingBlob(id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** 合并恢复：以存储工程为基础，补齐缺失字段，防止旧版本数据导致崩溃 */
export function restoreProject(stored: Project, fallback: Project): Project {
  const base = deepClone(fallback);
  const project = deepClone(stored);
  base.name = project.name ?? fallback.name;
  base.tailFade = project.tailFade ?? fallback.tailFade;
  base.length = project.length ?? fallback.length;
  base.resources = { ...fallback.resources, ...(project.resources ?? {}) };
  base.tracks = Array.isArray(project.tracks) ? project.tracks : fallback.tracks;
  for (const track of base.tracks) {
    track.clips ??= [];
    track.automation ??= [];
    track.muted ??= false;
    track.solo ??= false;
    track.volume ??= 1;
  }
  return base;
}
