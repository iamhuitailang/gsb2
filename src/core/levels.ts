// 关卡构造、复制与摆法应用

import { Cell, Level, MirrorCell } from './types';

export function emptyCell(): Cell {
  return { kind: 'empty' };
}

export function createLevel(size: number, name = '未命名关卡'): Level {
  const cells: Cell[][] = [];
  for (let r = 0; r < size; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < size; c++) row.push(emptyCell());
    cells.push(row);
  }
  return { name, size, cells };
}

export function cloneLevel(level: Level): Level {
  return {
    name: level.name,
    size: level.size,
    seed: level.seed,
    cells: level.cells.map((row) => row.map((cell) => ({ ...cell }))),
  };
}

export function inBounds(level: Level, r: number, c: number): boolean {
  return r >= 0 && c >= 0 && r < level.size && c < level.size;
}

/** 把一组反光片朝向(只含可转动片)应用到关卡副本上, 返回新关卡 */
export function applyOrientations(
  level: Level,
  assignments: Map<number, 0 | 1>,
): Level {
  const next = cloneLevel(level);
  let idx = 0;
  for (let r = 0; r < next.size; r++) {
    for (let c = 0; c < next.size; c++) {
      const cell = next.cells[r][c];
      if (cell.kind === 'mirror' && !cell.locked) {
        const orient = assignments.get(idx);
        if (orient !== undefined) cell.orient = orient;
        idx++;
      }
    }
  }
  return next;
}

/** 收集关卡中全部可转动反光片(求解变量), 顺序即变量编号 */
export function freeMirrors(level: Level): { r: number; c: number; cell: MirrorCell }[] {
  const out: { r: number; c: number; cell: MirrorCell }[] = [];
  for (let r = 0; r < level.size; r++) {
    for (let c = 0; c < level.size; c++) {
      const cell = level.cells[r][c];
      if (cell.kind === 'mirror' && !cell.locked) out.push({ r, c, cell });
    }
  }
  return out;
}

export interface LevelCheck {
  ok: boolean;
  errors: string[];
}

/** 结构性校验: 至少一个光源和一个收光点 */
export function checkLevel(level: Level): LevelCheck {
  const errors: string[] = [];
  let sources = 0;
  let targets = 0;
  for (const row of level.cells) {
    for (const cell of row) {
      if (cell.kind === 'source') sources++;
      if (cell.kind === 'target') targets++;
    }
  }
  if (sources === 0) errors.push('关卡中没有光源');
  if (targets === 0) errors.push('关卡中没有收光点');
  return { ok: errors.length === 0, errors };
}
