// 光线模拟引擎
//
// 规则:
// - 每个光源按其颜色掩码的每个原色位各发射一束光, 沿 dir 前进
// - 空直道直行; 反光片转向: '/' = dir XOR 1, '\\' = dir XOR 3
// - 撞墙、出界、射到光源本体即终止; 射到收光点被吸收终止
// - 同一 (格子, 方向, 颜色) 再次出现 => 形成回路, 立即停下并标出回路
// - 同一收光点收到多束光时, 颜色按位或合并(红+绿=黄, 三色=白)
//
// 因此每束光只携带一个原色位, "混色"只发生在收光点的合并上, 规则清晰可验。

import {
  BeamTrace,
  Cell,
  COLOR_BITS,
  DIR_VECTORS,
  Direction,
  Level,
  SimResult,
  TargetState,
  cellKey,
} from './types';

interface RayState {
  r: number;
  c: number;
  dir: Direction;
  color: number;
}

const stateKey = (s: RayState): string => `${s.r},${s.c},${s.dir},${s.color}`;

/** 反光片转向: orient 0 = '/', 1 = '\\' */
function reflect(dir: Direction, orient: 0 | 1): Direction {
  return ((orient === 0 ? dir ^ 1 : dir ^ 3) as Direction);
}

export function simulate(level: Level): SimResult {
  const { size, cells } = level;
  const beams: BeamTrace[] = [];
  const targets = new Map<string, TargetState>();
  let beamId = 0;
  let loopCount = 0;

  // 预置所有收光点状态, 即使没有光到达也要参与判定
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (cells[r][c].kind === 'target') {
        targets.set(cellKey(r, c), {
          pos: [r, c],
          got: 0,
          beamIds: [],
          satisfied: false,
        });
      }
    }
  }

  const traceRay = (start: RayState): void => {
    const path: [number, number][] = [[start.r, start.c]];
    const seen = new Map<string, number>(); // stateKey -> 该状态进入时 path 的长度
    let cur: RayState = { ...start };
    let end: BeamTrace['end'] = 'escape';
    let loopStart: number | undefined;
    let hitTarget: [number, number] | undefined;

    seen.set(stateKey(cur), path.length);

    for (;;) {
      const [dr, dc] = DIR_VECTORS[cur.dir];
      const nr = cur.r + dr;
      const nc = cur.c + dc;

      // 出界
      if (nr < 0 || nc < 0 || nr >= size || nc >= size) {
        end = 'escape';
        break;
      }

      const cell: Cell = cells[nr][nc];
      path.push([nr, nc]);

      switch (cell.kind) {
        case 'wall':
          end = 'wall';
          break;
        case 'source': {
          // 射线拐回自己出发的光源格 => 闭合回路(无论从哪个方向回来);
          // 射到其他光源 => 被光源挡住
          if (nr === start.r && nc === start.c) {
            end = 'loop';
            // 回路从路径第一格(光源格)开始
            loopStart = 0;
          } else {
            end = 'source';
          }
          break;
        }
        case 'target': {
          end = 'target';
          hitTarget = [nr, nc];
          break;
        }
        case 'mirror': {
          const nextDir = reflect(cur.dir, cell.orient);
          const next: RayState = { r: nr, c: nc, dir: nextDir, color: cur.color };
          const key = stateKey(next);
          const prevLen = seen.get(key);
          if (prevLen !== undefined) {
            // 同一状态第二次出现: 从第一次进入该格起构成闭合回路
            end = 'loop';
            loopStart = prevLen - 1;
          } else {
            seen.set(key, path.length);
            cur = next;
            continue;
          }
          break;
        }
        case 'empty': {
          const next: RayState = { r: nr, c: nc, dir: cur.dir, color: cur.color };
          const key = stateKey(next);
          const prevLen = seen.get(key);
          if (prevLen !== undefined) {
            end = 'loop';
            loopStart = prevLen - 1;
          } else {
            seen.set(key, path.length);
            cur = next;
            continue;
          }
          break;
        }
      }
      break;
    }

    const trace: BeamTrace = {
      id: beamId++,
      color: start.color,
      source: [start.r, start.c],
      path,
      end,
      target: hitTarget,
      loopStart,
    };
    beams.push(trace);
    if (end === 'loop') loopCount++;

    if (hitTarget) {
      const key = cellKey(hitTarget[0], hitTarget[1]);
      const st = targets.get(key)!;
      st.got |= start.color;
      st.beamIds.push(trace.id);
    }
  };

  // 从每个光源的每个原色位各发一束
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const cell = cells[r][c];
      if (cell.kind !== 'source') continue;
      for (const bit of [COLOR_BITS.R, COLOR_BITS.G, COLOR_BITS.B]) {
        if (cell.colors & bit) {
          traceRay({ r, c, dir: cell.dir, color: bit });
        }
      }
    }
  }

  // 收光点判定:
  // required === 0 -> 至少一束光到达 (got !== 0)
  // required  >  0 -> 到达颜色必须"恰好"等于要求颜色
  //   (缺色不满足, 多色也不满足, 规则明确无歧义)
  let allSatisfied = true;
  for (const st of targets.values()) {
    const cell = cells[st.pos[0]][st.pos[1]];
    if (cell.kind !== 'target') continue;
    st.satisfied = cell.required === 0 ? st.got !== 0 : st.got === cell.required;
    if (!st.satisfied) allSatisfied = false;
  }

  return { beams, targets, loopCount, allTargetsSatisfied: allSatisfied };
}

/** 判断一整套摆法是否为解: 所有收光点满足, 且不存在回路(回路中的光到不了任何收光点) */
export function isSolution(result: SimResult): boolean {
  return result.loopCount === 0 && result.allTargetsSatisfied;
}
