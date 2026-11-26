import { DEFAULT_PARAMS, STORAGE_KEY, createDefaultProject } from './defaults';
import { uid } from './easing';
import type {
  CameraZone,
  ProjectData,
  RuntimeCameraConfig,
  Waypoint,
} from './types';

export function persistProject(project: ProjectData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  } catch (err) {
    console.warn('[camera-debugger] 写入 localStorage 失败', err);
  }
}

export function loadPersistedProject(): ProjectData | null {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return null;
    return normalizeProject(JSON.parse(text));
  } catch (err) {
    console.warn('[camera-debugger] 读取本地项目失败，使用示例项目', err);
    return null;
  }
}

export function clearPersistedProject(): void {
  localStorage.removeItem(STORAGE_KEY);
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

function tuple3(v: unknown, fallback: [number, number, number]): [number, number, number] {
  if (Array.isArray(v) && v.length >= 3) {
    return [num(v[0], fallback[0]), num(v[1], fallback[1]), num(v[2], fallback[2])];
  }
  return [...fallback];
}

/** 宽容恢复：缺字段补默认，保证旧/手改 JSON 也能打开 */
export function normalizeProject(raw: unknown): ProjectData {
  const base = createDefaultProject();
  if (!raw || typeof raw !== 'object') throw new Error('项目文件不是合法 JSON 对象');
  const r = raw as Partial<ProjectData>;

  const defaultParams = { ...DEFAULT_PARAMS, ...(r.defaultParams ?? {}) } as ProjectData['defaultParams'];
  // 数值字段逐个兜底
  (Object.keys(DEFAULT_PARAMS) as (keyof typeof DEFAULT_PARAMS)[]).forEach((k) => {
    defaultParams[k] = num((r.defaultParams as Record<string, unknown> | undefined)?.[k], DEFAULT_PARAMS[k]);
  });

  const zones: CameraZone[] = Array.isArray(r.zones)
    ? r.zones.map((zRaw, i) => {
        const z = (zRaw ?? {}) as Partial<CameraZone>;
        const fallback = base.zones[i] ?? base.zones[0];
        return {
          id: str(z.id, uid('zone')),
          name: str(z.name, `镜头区域 ${i + 1}`),
          color: str(z.color, fallback.color),
          center: tuple3(z.center, fallback.center),
          size: tuple3(z.size, fallback.size),
          rotationY: num(z.rotationY, 0),
          priority: num(z.priority, i),
          hysteresis: num(z.hysteresis, 0.25),
          transitionTime: num(z.transitionTime, 0.6),
          easing: (str(z.easing, 'smoothstep') as CameraZone['easing']) ?? 'smoothstep',
          params: { ...fallback.params, ...(z.params ?? {}) },
          bounds: {
            enabled: bool(z.bounds?.enabled, fallback.bounds.enabled),
            min: tuple3(z.bounds?.min, fallback.bounds.min),
            max: tuple3(z.bounds?.max, fallback.bounds.max),
          },
        };
      })
    : base.zones;

  const waypoints: Waypoint[] =
    r.route && Array.isArray(r.route.waypoints)
      ? r.route.waypoints.map((wRaw, i) => {
          const w = (wRaw ?? {}) as Partial<Waypoint>;
          return {
            id: str(w.id, uid('wp')),
            name: str(w.name, `路径点 ${i + 1}`),
            x: num(w.x, 0),
            y: num(w.y, 0),
            z: num(w.z, 0),
            moveTime: num(w.moveTime, 3),
            hold: num(w.hold, 0),
          };
        })
      : base.route.waypoints;

  return {
    appId: 'third-person-camera-debugger',
    schemaVersion: 1,
    name: str(r.name, base.name),
    savedAt: typeof r.savedAt === 'string' ? r.savedAt : undefined,
    defaultParams,
    occlusion: { ...base.occlusion, ...(r.occlusion ?? {}) },
    zones,
    route: {
      loopMode:
        r.route?.loopMode === 'once' || r.route?.loopMode === 'loop' || r.route?.loopMode === 'pingpong'
          ? r.route.loopMode
          : 'pingpong',
      waypoints,
    },
  };
}

export function parseProjectJson(text: string): ProjectData {
  return normalizeProject(JSON.parse(text));
}

export function toRuntimeConfig(project: ProjectData): RuntimeCameraConfig {
  return {
    format: 'tpc-camera-config',
    formatVersion: 1,
    defaultParams: project.defaultParams,
    occlusion: project.occlusion,
    zones: project.zones.map((z) => ({
      id: z.id,
      name: z.name,
      priority: z.priority,
      shape: {
        type: 'box' as const,
        center: z.center,
        size: z.size,
        rotationY: z.rotationY,
        hysteresis: z.hysteresis,
      },
      transition: { time: z.transitionTime, easing: z.easing },
      params: z.params,
      bounds: z.bounds,
    })),
  };
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function timestampSlug(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
