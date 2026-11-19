/** 工程数据模型：所有时间单位均为秒，音量为 0..1 的线性增益。 */

export interface Clip {
  id: string;
  name: string;
  /** 引用的音频资源 id（resources 表的键，或录音资源 id） */
  resourceId: string;
  /** 在时间线上的起点（秒） */
  start: number;
  /** 从音频源的哪个位置开始播放（裁切起点） */
  offset: number;
  /** 片段时长（裁切长度） */
  duration: number;
  muted: boolean;
}

export interface AutomationPoint {
  id: string;
  /** 时间（秒） */
  time: number;
  /** 增益值 0..1，最终与轨道音量相乘 */
  value: number;
}

export interface Track {
  id: string;
  name: string;
  /** 轨道基础音量（线性增益 0..1，UI 上以百分比显示） */
  volume: number;
  muted: boolean;
  solo: boolean;
  clips: Clip[];
  automation: AutomationPoint[];
}

export interface ResourceMeta {
  id: string;
  name: string;
  duration: number;
  /** 内置示例为 url；录音资源为 blob，音频数据存 IndexedDB */
  kind: 'sample' | 'recording';
  url?: string;
}

export interface Project {
  version: 1;
  name: string;
  tracks: Track[];
  resources: Record<string, ResourceMeta>;
  /** 导出时末尾淡出时长（秒），0 表示不淡出 */
  tailFade: number;
  /** 播放/工程时长缓存，由片段末端推导，也可被 UI 覆盖 */
  length: number;
}

export interface ViewState {
  /** 每秒对应的像素数 */
  pxPerSecond: number;
  /** 可视区域左边缘对应的时间（秒） */
  scrollTime: number;
  snap: boolean;
  /** 当前显示自动化编辑层的轨道 id；null 表示不显示 */
  automationTrackId: string | null;
  selectedClipId: string | null;
}

export const PROJECT_STORAGE_KEY = 'multitrack-arranger:project';
export const VIEW_STORAGE_KEY = 'multitrack-arranger:view';
export const IDB_NAME = 'multitrack-arranger-db';
export const IDB_STORE = 'recordings';

export const TRACK_HEIGHT = 96;
export const RULER_HEIGHT = 32;
export const HEADER_WIDTH = 220;
export const MIN_CLIP_DURATION = 0.05;
