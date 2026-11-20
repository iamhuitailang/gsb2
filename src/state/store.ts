import type {
  PreviewSettings,
  ProjectData,
  ShaderDiagnostic,
  TimeState,
  UniformValue,
} from '../types';

/** 画布内部分辨率预设；切换只改变渲染像素数，不改变 uniform 的语义 */
export const RESOLUTION_PRESETS = [
  { key: '512x320', label: '512 × 320', width: 512, height: 320 },
  { key: '640x480', label: '640 × 480', width: 640, height: 480 },
  { key: '800x600', label: '800 × 600', width: 800, height: 600 },
  { key: '960x720', label: '960 × 720', width: 960, height: 720 },
  { key: 'custom', label: '自定义…', width: 0, height: 0 },
] as const;

export function resolveResolution(preview: PreviewSettings): { width: number; height: number } {
  const preset = RESOLUTION_PRESETS.find((p) => p.key === preview.resolutionKey);
  if (preset && preset.key !== 'custom') {
    return { width: preset.width, height: preset.height };
  }
  return {
    width: Math.min(1920, Math.max(64, preview.customWidth)),
    height: Math.min(1080, Math.max(64, preview.customHeight)),
  };
}

export interface AppState {
  projectName: string;
  mainSource: string;
  postSource: string;
  uniformValues: Record<string, UniformValue>;
  preview: PreviewSettings;
  time: TimeState;
  diagnostics: ShaderDiagnostic[];
  /** 主着色器是否处于编译失败状态 */
  mainFailed: boolean;
  activeTab: 'main' | 'post';
  dirty: boolean;
}

type Listener = (state: AppState) => void;

const AUTOSAVE_KEY = 'shader-lab/autosave/v1';

export function defaultState(): AppState {
  return {
    projectName: '未命名工程',
    mainSource: '',
    postSource: '',
    uniformValues: {},
    preview: {
      mode: 'fullscreen',
      resolutionKey: '640x480',
      customWidth: 640,
      customHeight: 480,
      postEnabled: true,
    },
    time: { playing: true, time: 0 },
    diagnostics: [],
    mainFailed: false,
    activeTab: 'main',
    dirty: false,
  };
}

class Store {
  private state: AppState = defaultState();
  private listeners = new Set<Listener>();

  get(): AppState {
    return this.state;
  }

  /** 局部更新；监听器收到的是同一份引用（浅合并） */
  update(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch, dirty: true };
    this.emit();
  }

  /** 不标记 dirty 的更新（如时间线每帧推进） */
  patchSilent(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  toProject(): ProjectData {
    const s = this.state;
    return {
      format: 'shader-lab-project',
      version: 1,
      name: s.projectName,
      savedAt: new Date().toISOString(),
      source: { main: s.mainSource, post: s.postSource },
      uniforms: structuredClone(s.uniformValues),
      preview: structuredClone(s.preview),
      time: { playing: false, time: s.time.time },
    };
  }

  loadProject(project: ProjectData): AppState {
    this.state = {
      ...defaultState(),
      projectName: project.name,
      mainSource: project.source.main,
      postSource: project.source.post,
      uniformValues: structuredClone(project.uniforms),
      preview: { ...this.state.preview, ...project.preview },
      time: project.time ?? { playing: false, time: 0 },
      dirty: false,
    };
    this.emit();
    return this.state;
  }

  saveAutosave() {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.toProject()));
    } catch {
      // 存储空间不足（通常是纹理 dataURL 太大）时静默降级
    }
  }

  loadAutosave(): ProjectData | null {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw) as ProjectData;
      if (data.format !== 'shader-lab-project') return null;
      return data;
    } catch {
      return null;
    }
  }

  markClean() {
    this.state = { ...this.state, dirty: false };
    this.emit();
  }
}

export const store = new Store();
