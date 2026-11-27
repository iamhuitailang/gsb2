// 灯路谜题核心类型与规则常量

/** 方向: 0=北(上) 1=东(右) 2=南(下) 3=西(左) */
export type Direction = 0 | 1 | 2 | 3;

export const DIR_VECTORS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
];

export const DIR_NAMES = ['北', '东', '南', '西'] as const;

/** 颜色用位掩码表示, 三原色各占 1 位, 混色为按位或 */
export const COLOR_BITS = {
  R: 1,
  G: 2,
  B: 4,
} as const;

/** 1..7 的掩码 -> 中文名 / 英文码 */
const MASK_INFO: Record<number, { name: string; code: string; css: string }> = {
  1: { name: '红', code: 'R', css: '#e5484d' },
  2: { name: '绿', code: 'G', css: '#30a46c' },
  4: { name: '蓝', code: 'B', css: '#3e63dd' },
  3: { name: '黄(红+绿)', code: 'Y', css: '#e2c241' },
  5: { name: '品红(红+蓝)', code: 'M', css: '#b455c9' },
  6: { name: '青(绿+蓝)', code: 'C', css: '#28a4b8' },
  7: { name: '白(红+绿+蓝)', code: 'W', css: '#8b93a7' },
};

export function maskName(mask: number): string {
  return MASK_INFO[mask]?.name ?? `空(0)`;
}

export function maskCode(mask: number): string {
  return MASK_INFO[mask]?.code ?? '·';
}

export function maskCss(mask: number): string {
  return MASK_INFO[mask]?.css ?? '#9aa0ad';
}

export type CellKind = 'empty' | 'wall' | 'source' | 'mirror' | 'target';

export interface EmptyCell {
  kind: 'empty';
}
export interface WallCell {
  kind: 'wall';
}
export interface SourceCell {
  kind: 'source';
  dir: Direction;
  /** 发光颜色掩码 1..7; 双色光源即两个原色位, 如 3=红+绿 */
  colors: number;
}
export interface MirrorCell {
  kind: 'mirror';
  /** 0 = '/' 斜片, 1 = '\\' 反斜片 */
  orient: 0 | 1;
  /** 锁定后不参与求解搜索, 试玩中也不能转动 */
  locked: boolean;
}
export interface TargetCell {
  kind: 'target';
  /** 必要颜色掩码; 0 表示任意光均可, 但至少要有一束光到达 */
  required: number;
}

export type Cell = EmptyCell | WallCell | SourceCell | MirrorCell | TargetCell;

export interface Level {
  name: string;
  size: number;
  cells: Cell[][];
  seed?: number;
}

export interface BeamTrace {
  id: number;
  /** 单束光始终是一个原色位 (1/2/4) */
  color: number;
  source: [number, number];
  /** 依次经过的格子, 含光源格与终止格 */
  path: [number, number][];
  end: 'target' | 'escape' | 'wall' | 'source' | 'loop';
  target?: [number, number];
  /** 成环时, 回路在 path 中的起点下标 */
  loopStart?: number;
}

export interface TargetState {
  pos: [number, number];
  /** 到达光束按位或合并后的颜色 */
  got: number;
  beamIds: number[];
  satisfied: boolean;
}

export interface SimResult {
  beams: BeamTrace[];
  /** key = `r,c` */
  targets: Map<string, TargetState>;
  loopCount: number;
  allTargetsSatisfied: boolean;
}

export const cellKey = (r: number, c: number): string => `${r},${c}`;
