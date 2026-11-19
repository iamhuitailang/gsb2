import type { Project, ViewState } from './types';
import { clamp, deepClone, uid } from './utils/helpers';
import {
  clearStoredProject,
  loadProjectFromStorage,
  loadViewFromStorage,
  restoreProject,
  saveProjectToStorage,
  saveViewToStorage,
} from './utils/storage';
import { createSampleProject } from './sampleProject';
import { MIN_CLIP_DURATION } from './types';

type Listener = () => void;

/**
 * 单一状态仓库：保存工程与视图状态，变更后通知订阅者并防抖持久化。
 * 录音 Blob 不进 localStorage，由 IndexedDB 单独管理。
 */
export class Store {
  project: Project;
  view: ViewState;
  private listeners = new Set<Listener>();
  private saveTimer: number | null = null;

  constructor() {
    const fallback = createSampleProject();
    const stored = loadProjectFromStorage();
    this.project = stored ? restoreProject(stored, fallback) : fallback;
    const storedView = loadViewFromStorage();
    this.view = {
      pxPerSecond: clamp(storedView?.pxPerSecond ?? 60, 8, 600),
      scrollTime: Math.max(0, storedView?.scrollTime ?? 0),
      snap: storedView?.snap ?? true,
      automationTrackId: storedView?.automationTrackId ?? this.project.tracks[0]?.id ?? null,
      selectedClipId: storedView?.selectedClipId ?? null,
    };
    this.recomputeLength();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 变更入口：所有修改完成后调用，触发 UI 更新与持久化 */
  commit(): void {
    for (const fn of this.listeners) fn();
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        saveProjectToStorage(this.project);
        saveViewToStorage(this.view);
      } catch (err) {
        console.error(err);
      }
    }, 300);
  }

  /** 立即保存（导出前、页面隐藏时调用） */
  flushSave(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    saveProjectToStorage(this.project);
    saveViewToStorage(this.view);
  }

  resetToSample(): void {
    this.project = createSampleProject();
    this.view.selectedClipId = null;
    this.view.automationTrackId = this.project.tracks[0]?.id ?? null;
    this.view.scrollTime = 0;
    this.recomputeLength();
    this.commit();
  }

  clearProject(): void {
    const sample = createSampleProject();
    this.project = {
      ...sample,
      name: '未命名工程',
      tracks: [],
      tailFade: 1.5,
      length: 0,
    };
    this.view.selectedClipId = null;
    this.view.automationTrackId = null;
    this.view.scrollTime = 0;
    this.commit();
  }

  clearStorage(): void {
    clearStoredProject();
  }

  /* ---------------- 工程长度 ---------------- */

  /** 工程长度 = 所有片段末端的最大值；空工程为 0 */
  recomputeLength(): void {
    let end = 0;
    for (const track of this.project.tracks) {
      for (const clip of track.clips) {
        end = Math.max(end, clip.start + clip.duration);
      }
    }
    this.project.length = Math.max(0, end);
  }

  /* ---------------- 轨道操作 ---------------- */

  addTrack(): string {
    const id = uid('track');
    this.project.tracks.push({
      id,
      name: `轨道 ${this.project.tracks.length + 1}`,
      volume: 1,
      muted: false,
      solo: false,
      clips: [],
      automation: [],
    });
    this.view.automationTrackId = id;
    this.commit();
    return id;
  }

  renameTrack(trackId: string, name: string): void {
    const track = this.findTrack(trackId);
    if (track) {
      track.name = name.trim() || track.name;
      this.commit();
    }
  }

  toggleMute(trackId: string): void {
    const track = this.findTrack(trackId);
    if (track) {
      track.muted = !track.muted;
      this.commit();
    }
  }

  toggleSolo(trackId: string): void {
    const track = this.findTrack(trackId);
    if (track) {
      track.solo = !track.solo;
      this.commit();
    }
  }

  setTrackVolume(trackId: string, volume: number): void {
    const track = this.findTrack(trackId);
    if (track) {
      track.volume = clamp(volume, 0, 1);
      this.commit();
    }
  }

  removeTrack(trackId: string): void {
    this.project.tracks = this.project.tracks.filter((t) => t.id !== trackId);
    if (this.view.automationTrackId === trackId) {
      this.view.automationTrackId = this.project.tracks[0]?.id ?? null;
    }
    if (this.view.selectedClipId && !this.findClip(this.view.selectedClipId)) {
      this.view.selectedClipId = null;
    }
    this.recomputeLength();
    this.commit();
  }

  findTrack(trackId: string) {
    return this.project.tracks.find((t) => t.id === trackId);
  }

  /* ---------------- 片段操作 ---------------- */

  findClip(clipId: string) {
    for (const track of this.project.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return { track, clip };
    }
    return undefined;
  }

  addClip(trackId: string, resourceId: string, start: number): string | null {
    const track = this.findTrack(trackId);
    const resource = this.project.resources[resourceId];
    if (!track || !resource) return null;
    const id = uid('clip');
    track.clips.push({
      id,
      name: resource.name,
      resourceId,
      start: Math.max(0, start),
      offset: 0,
      duration: resource.duration,
      muted: false,
    });
    this.recomputeLength();
    this.view.selectedClipId = id;
    this.commit();
    return id;
  }

  /** 复制片段（含静音状态与裁切信息），默认放在原片段后 0.5 秒 */
  duplicateClip(clipId: string): string | null {
    const found = this.findClip(clipId);
    if (!found) return null;
    const { track, clip } = found;
    const id = uid('clip');
    const copy = deepClone(clip);
    copy.id = id;
    copy.name = `${clip.name} 副本`;
    copy.start = clip.start + clip.duration + 0.5;
    track.clips.push(copy);
    this.recomputeLength();
    this.view.selectedClipId = id;
    this.commit();
    return id;
  }

  removeClip(clipId: string): void {
    const found = this.findClip(clipId);
    if (!found) return;
    found.track.clips = found.track.clips.filter((c) => c.id !== clipId);
    if (this.view.selectedClipId === clipId) this.view.selectedClipId = null;
    this.recomputeLength();
    this.commit();
  }

  renameClip(clipId: string, name: string): void {
    const found = this.findClip(clipId);
    if (found && name.trim()) {
      found.clip.name = name.trim();
      this.commit();
    }
  }

  toggleClipMute(clipId: string): void {
    const found = this.findClip(clipId);
    if (found) {
      found.clip.muted = !found.clip.muted;
      this.commit();
    }
  }

  /** 拖动过程中的实时更新（不做合法性钳制以外的处理，结束时再持久化一次） */
  updateClipLive(clipId: string, patch: Partial<{ start: number; offset: number; duration: number }>): void {
    const found = this.findClip(clipId);
    if (!found) return;
    const resource = this.project.resources[found.clip.resourceId];
    if (patch.start !== undefined) found.clip.start = Math.max(0, patch.start);
    if (patch.duration !== undefined) {
      found.clip.duration = clamp(patch.duration, MIN_CLIP_DURATION, resource?.duration ?? patch.duration);
    }
    if (patch.offset !== undefined && resource) {
      found.clip.offset = clamp(patch.offset, 0, Math.max(0, resource.duration - found.clip.duration));
    }
    this.recomputeLength();
    this.commit();
  }

  /** 移动片段到指定轨道（拖动跨越轨道头部边界时使用） */
  moveClipToTrack(clipId: string, targetTrackId: string): void {
    const found = this.findClip(clipId);
    const target = this.findTrack(targetTrackId);
    if (!found || !target || found.track.id === targetTrackId) return;
    const [clip] = found.track.clips.splice(found.track.clips.indexOf(found.clip), 1);
    target.clips.push(clip);
    this.commit();
  }

  /* ---------------- 自动化关键点（严格按轨道隔离） ---------------- */

  addAutomationPoint(trackId: string, time: number, value: number): string | null {
    const track = this.findTrack(trackId);
    if (!track) return null;
    const id = uid('auto');
    track.automation.push({ id, time: Math.max(0, time), value: clamp(value, 0, 1) });
    this.commit();
    return id;
  }

  updateAutomationPoint(trackId: string, pointId: string, patch: Partial<{ time: number; value: number }>): void {
    const track = this.findTrack(trackId);
    const point = track?.automation.find((p) => p.id === pointId);
    if (!track || !point) return;
    if (patch.time !== undefined) point.time = Math.max(0, patch.time);
    if (patch.value !== undefined) point.value = clamp(patch.value, 0, 1);
    this.commit();
  }

  removeAutomationPoint(trackId: string, pointId: string): void {
    const track = this.findTrack(trackId);
    if (!track) return;
    // 只操作传入轨道自身的数组，其他轨道的关键点不受影响
    track.automation = track.automation.filter((p) => p.id !== pointId);
    this.commit();
  }

  /* ---------------- 资源 ---------------- */

  addResource(meta: Project['resources'][string]): void {
    this.project.resources[meta.id] = meta;
    this.commit();
  }
}
