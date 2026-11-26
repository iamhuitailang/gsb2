import type { ProjectData } from '../core/types';

/** UI → 主程序的操作集合，由 main.ts 实现 */
export interface AppDeps {
  project: ProjectData;

  readonly selectedZoneId: string | null;
  selectZone: (id: string | null) => void;
  addZone: () => void;
  removeZone: (id: string) => void;
  duplicateZone: (id: string) => void;

  /** 数据被编辑：main 负责持久化 + 重建对应 Gizmo */
  notifyChange: (kind: 'zones' | 'route' | 'params' | 'all') => void;

  readonly groundAddMode: boolean;
  setGroundAddMode: (on: boolean) => void;
  addWaypointAtCharacter: () => void;
  removeWaypoint: (id: string) => void;
  seekToWaypoint: (id: string) => void;
}
