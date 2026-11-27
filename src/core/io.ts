// 关卡保存与导入
//
// 文件格式(JSON):
// {
//   "format": "light-path-puzzle/v1",
//   "name": "...", "size": 6, "seed": 42,
//   "cells": [
//     { "r": 0, "c": 1, "kind": "source", "dir": 1, "colors": 3 },
//     { "r": 2, "c": 2, "kind": "mirror", "orient": 0, "locked": false },
//     ...
//   ]
// }
//
// 导入采用"整盘校验, 全绿才替换"策略: 任何一格有问题都不破坏当前正在玩的关卡,
// 并把每个冲突格的行列与原因列出来。

import { Cell, Direction, Level } from './types';
import { createLevel } from './levels';

export const SAVE_FORMAT = 'light-path-puzzle/v1';

export interface SerializedCell {
  r: unknown;
  c: unknown;
  kind: unknown;
  dir?: unknown;
  colors?: unknown;
  orient?: unknown;
  locked?: unknown;
  required?: unknown;
}

export interface SerializedLevel {
  format?: unknown;
  name?: unknown;
  size?: unknown;
  seed?: unknown;
  cells?: unknown;
}

export interface ImportResult {
  ok: boolean;
  /** 校验通过时的新关卡 */
  level?: Level;
  /** 逐格冲突/错误信息, 含行列号 */
  errors: ImportError[];
  /** 非格子层面的整体错误(缺字段、格式不符等) */
  globalErrors: string[];
}

export interface ImportError {
  r: number;
  c: number;
  reason: string;
}

const isInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v);

const isDir = (v: unknown): v is Direction =>
  v === 0 || v === 1 || v === 2 || v === 3;

function validateCell(raw: SerializedCell, size: number): ImportError | Cell {
  if (!isInt(raw.r) || !isInt(raw.c)) {
    return { r: -1, c: -1, reason: '格子坐标 r/c 必须是整数' };
  }
  const { r, c } = raw;
  const fail = (reason: string): ImportError => ({ r, c, reason });

  if (r < 0 || c < 0 || r >= size || c >= size) {
    return fail(`坐标超出 ${size}×${size} 棋盘范围`);
  }

  switch (raw.kind) {
    case 'wall':
      return { kind: 'wall' };
    case 'source': {
      if (!isDir(raw.dir)) return fail('光源 dir 必须是 0..3(北东南西)');
      if (!isInt(raw.colors) || raw.colors < 1 || raw.colors > 7) {
        return fail('光源 colors 必须是 1..7 的颜色掩码');
      }
      return { kind: 'source', dir: raw.dir, colors: raw.colors };
    }
    case 'mirror': {
      if (raw.orient !== 0 && raw.orient !== 1) {
        return fail('反光片 orient 必须是 0(/) 或 1(\\)');
      }
      return { kind: 'mirror', orient: raw.orient, locked: raw.locked === true };
    }
    case 'target': {
      if (!isInt(raw.required) || raw.required < 0 || raw.required > 7) {
        return fail('收光点 required 必须是 0..7 的颜色掩码(0=任意)');
      }
      return { kind: 'target', required: raw.required };
    }
    case 'empty':
      return { kind: 'empty' };
    default:
      return fail(`未知格子类型 "${String(raw.kind)}"`);
  }
}

export function exportLevel(level: Level): string {
  const cells: Record<string, unknown>[] = [];
  for (let r = 0; r < level.size; r++) {
    for (let c = 0; c < level.size; c++) {
      const cell = level.cells[r][c];
      if (cell.kind === 'empty') continue;
      cells.push({ r, c, ...cell });
    }
  }
  const payload: SerializedLevel = {
    format: SAVE_FORMAT,
    name: level.name,
    size: level.size,
    ...(level.seed !== undefined ? { seed: level.seed } : {}),
    cells,
  };
  return JSON.stringify(payload, null, 2);
}

export function importLevel(text: string): ImportResult {
  const globalErrors: string[] = [];
  const errors: ImportError[] = [];

  let data: SerializedLevel;
  try {
    data = JSON.parse(text) as SerializedLevel;
  } catch (e) {
    return {
      ok: false,
      errors: [],
      globalErrors: [`JSON 解析失败: ${(e as Error).message}`],
    };
  }

  if (data === null || typeof data !== 'object') {
    return { ok: false, errors, globalErrors: ['文件内容不是 JSON 对象'] };
  }
  if (data.format !== SAVE_FORMAT) {
    globalErrors.push(`格式标识不符: 期望 ${SAVE_FORMAT}, 实际为 "${String(data.format)}"`);
  }
  if (!isInt(data.size) || data.size < 2 || data.size > 12) {
    globalErrors.push('size 必须是 2..12 之间的整数');
    return { ok: false, errors, globalErrors };
  }
  const size = data.size;
  if (!Array.isArray(data.cells)) {
    globalErrors.push('cells 必须是数组');
    return { ok: false, errors, globalErrors };
  }

  const level = createLevel(size, typeof data.name === 'string' ? data.name : '导入的关卡');
  if (isInt(data.seed)) level.seed = data.seed;

  const occupied = new Set<string>();
  let sourceCount = 0;
  let targetCount = 0;

  data.cells.forEach((item, index) => {
    if (item === null || typeof item !== 'object') {
      errors.push({ r: -1, c: -1, reason: `第 ${index} 项不是格子对象` });
      return;
    }
    const raw = item as SerializedCell;
    const checked = validateCell(raw, size);
    if ('reason' in checked) {
      errors.push(checked);
      return;
    }
    const r = raw.r as number;
    const c = raw.c as number;
    const key = `${r},${c}`;
    if (occupied.has(key)) {
      // 同一格出现两次 = 格子冲突
      errors.push({ r, c, reason: `第 (${r + 1}, ${c + 1}) 格被重复定义` });
      return;
    }
    occupied.add(key);
    level.cells[r][c] = checked;
    if (checked.kind === 'source') sourceCount++;
    if (checked.kind === 'target') targetCount++;
  });

  if (sourceCount === 0) globalErrors.push('布局中没有光源');
  if (targetCount === 0) globalErrors.push('布局中没有收光点');

  if (errors.length > 0 || globalErrors.length > 0) {
    return { ok: false, errors, globalErrors };
  }
  return { ok: true, level, errors: [], globalErrors: [] };
}
