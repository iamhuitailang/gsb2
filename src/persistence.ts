import { readFileSync, writeFileSync } from 'node:fs';
import { Town } from './town.js';
import type { TownState } from './types.js';

/** 把城镇状态（规则 + 名册 + 种子）写入 JSON 文件。 */
export function saveTown(town: Town, path: string): void {
  writeFileSync(path, JSON.stringify(town.state, null, 2), 'utf8');
}

/** 从 JSON 文件恢复城镇；重开以后继续生成，结果与存档前一致。 */
export function loadTown(path: string): Town {
  const state = JSON.parse(readFileSync(path, 'utf8')) as TownState;
  return new Town(state);
}
