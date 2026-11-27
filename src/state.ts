// 全局应用状态与纯状态变更函数(UI 层只负责渲染和事件绑定)

import { simulate } from './core/engine';
import {
  Cell,
  Direction,
  Level,
  MirrorCell,
  SimResult,
} from './core/types';
import {
  applyOrientations,
  checkLevel,
  createLevel,
  freeMirrors,
} from './core/levels';
import { DEFAULT_SOLVER_OPTIONS, SolveReport, solve } from './core/solver';
import { exportLevel, importLevel, ImportResult } from './core/io';
import { generateLevel, GeneratedLevel } from './core/generator';

export type Mode = 'edit' | 'play';
export type ToolKind =
  | 'empty'
  | 'wall'
  | 'source'
  | 'mirror'
  | 'mirror-locked'
  | 'target';

export interface AppState {
  level: Level;
  /** 试玩模式下的临时摆法; null 表示与关卡中反光片朝向一致 */
  playOverrides: Map<number, 0 | 1> | null;
  mode: Mode;
  tool: ToolKind;
  /** 光源编辑用: 方向与颜色掩码 */
  sourceDir: Direction;
  sourceColors: number;
  /** 收光点编辑用: 必要颜色掩码 */
  targetRequired: number;
  /** 生成用种子编号(纳入状态, 避免重渲染把输入框重置回默认值) */
  seed: number;
  sim: SimResult;
  /** 逐束查看: 当前选中的光束 id; null = 显示全部 */
  selectedBeam: number | null;
  report: SolveReport | null;
  solving: boolean;
  message: string;
  messageKind: 'info' | 'ok' | 'error';
  lastImport: ImportResult | null;
}

export function createInitialState(): AppState {
  const level = createLevel(6, '我的灯路关');
  return {
    level,
    playOverrides: null,
    mode: 'edit',
    tool: 'mirror',
    sourceDir: 1,
    sourceColors: 3,
    targetRequired: 1,
    seed: 42,
    sim: simulate(level),
    selectedBeam: null,
    report: null,
    solving: false,
    message: '从左侧工具选格子, 在棋盘上点击摆放; 或直接生成/导入关卡',
    messageKind: 'info',
    lastImport: null,
  };
}

export function effectiveLevel(state: AppState): Level {
  if (state.mode === 'play' && state.playOverrides) {
    return applyOrientations(state.level, state.playOverrides);
  }
  return state.level;
}

export function recomputeSim(state: AppState): void {
  state.sim = simulate(effectiveLevel(state));
}

export function setMessage(
  state: AppState,
  message: string,
  kind: AppState['messageKind'] = 'info',
): void {
  state.message = message;
  state.messageKind = kind;
}

// ---------------------------------------------------------------------------
// 编辑操作
// ---------------------------------------------------------------------------

export function paintCell(state: AppState, r: number, c: number): void {
  if (state.mode !== 'edit') return;
  const cell = state.level.cells[r][c];

  // 点到已有同类格子: 反光片旋转 / 锁定片切换锁定, 其余工具则擦除
  if (cell.kind === 'mirror' && (state.tool === 'mirror' || state.tool === 'mirror-locked')) {
    cell.orient = cell.orient === 0 ? 1 : 0;
  } else if (cell.kind === 'source' && state.tool === 'source') {
    cell.dir = ((cell.dir + 1) % 4) as Direction;
  } else {
    state.level.cells[r][c] = buildCell(state.tool, state);
  }
  state.report = null;
  recomputeSim(state);
}

function buildCell(tool: ToolKind, state: AppState): Cell {
  switch (tool) {
    case 'empty':
      return { kind: 'empty' };
    case 'wall':
      return { kind: 'wall' };
    case 'source':
      return { kind: 'source', dir: state.sourceDir, colors: state.sourceColors };
    case 'mirror':
      return { kind: 'mirror', orient: 0, locked: false };
    case 'mirror-locked':
      return { kind: 'mirror', orient: 0, locked: true };
    case 'target':
      return { kind: 'target', required: state.targetRequired };
  }
}

/** 右键: 锁定/解锁已有反光片, 或擦除非空格 */
export function secondaryClick(state: AppState, r: number, c: number): void {
  if (state.mode !== 'edit') return;
  const cell = state.level.cells[r][c];
  if (cell.kind === 'mirror') {
    cell.locked = !cell.locked;
  } else {
    state.level.cells[r][c] = { kind: 'empty' };
  }
  state.report = null;
  recomputeSim(state);
}

export function rotateMirrorInPlay(state: AppState, r: number, c: number): void {
  if (state.mode !== 'play') return;
  const base = state.level.cells[r][c];
  if (base.kind !== 'mirror' || base.locked) return;

  if (!state.playOverrides) state.playOverrides = new Map();
  const idx = mirrorVariableIndex(state.level, r, c);
  const current = state.playOverrides.get(idx) ?? base.orient;
  state.playOverrides.set(idx, current === 0 ? 1 : 0);
  state.report = null;
  recomputeSim(state);
}

export function mirrorVariableIndex(level: Level, r: number, c: number): number {
  const vars = freeMirrors(level);
  return vars.findIndex((v) => v.r === r && v.c === c);
}

export function enterPlayMode(state: AppState): void {
  state.mode = 'play';
  state.playOverrides = new Map();
  state.selectedBeam = null;
  recomputeSim(state);
}

export function enterEditMode(state: AppState): void {
  state.mode = 'edit';
  state.playOverrides = null;
  state.selectedBeam = null;
  state.report = null;
  recomputeSim(state);
}

export function resetPlay(state: AppState): void {
  state.playOverrides = new Map();
  state.selectedBeam = null;
  recomputeSim(state);
}

export function resizeBoard(state: AppState, size: number): void {
  const next = createLevel(size, state.level.name);
  const old = state.level.cells;
  for (let r = 0; r < Math.min(size, state.level.size); r++) {
    for (let c = 0; c < Math.min(size, state.level.size); c++) {
      next.cells[r][c] = { ...old[r][c] };
    }
  }
  state.level = next;
  state.playOverrides = null;
  state.report = null;
  recomputeSim(state);
}

// ---------------------------------------------------------------------------
// 求解
// ---------------------------------------------------------------------------

export async function runSolve(state: AppState): Promise<void> {
  const check = checkLevel(state.level);
  if (!check.ok) {
    setMessage(state, check.errors.join('; '), 'error');
    return;
  }
  state.solving = true;
  setMessage(state, '搜索中…');
  try {
    const report = await solve(state.level, DEFAULT_SOLVER_OPTIONS);
    state.report = report;
    state.selectedBeam = null;
    const detail = `访问 ${report.nodes} 节点 / ${report.totalCombinations} 种摆法, 耗时 ${report.elapsedMs.toFixed(1)}ms`;
    switch (report.status) {
      case 'unsat':
        setMessage(state, `无解: 所有摆法都试过, 没有能满足全部收光点的方案。${detail}`, 'error');
        break;
      case 'unique':
        setMessage(state, `唯一解: 全部 ${report.totalCombinations} 种摆法搜完, 恰好 1 组解。${detail}`, 'ok');
        break;
      case 'multi':
        setMessage(state, `至少两解: 已找到 ${report.solutions.length} 组真正不同的摆法(展示前两组)。${detail}`, 'ok');
        break;
      case 'incomplete':
        setMessage(
          state,
          `没搜完: 达到${report.canceled ? '取消' : '预算'}上限, 不能判定是否唯一。${detail}`,
          'error',
        );
        break;
    }
  } finally {
    state.solving = false;
  }
}

/** 把某一组求解摆法放回试玩面板 */
export function loadSolutionIntoPlay(state: AppState, solutionIndex: number): void {
  const sol = state.report?.solutions[solutionIndex];
  if (!sol) return;
  state.mode = 'play';
  state.playOverrides = new Map(sol.assignments);
  state.selectedBeam = null;
  recomputeSim(state);
  setMessage(state, `已把第 ${solutionIndex + 1} 组摆法放入试玩面板, 可逐束查看光路`, 'ok');
}

// ---------------------------------------------------------------------------
// 生成 / 导入导出
// ---------------------------------------------------------------------------

export async function generate(state: AppState, seed: number): Promise<void> {
  state.solving = true;
  setMessage(state, `正在按种子 ${seed} 生成并验证唯一解…`);
  try {
    const got: GeneratedLevel = await generateLevel(seed);
    state.level = got.level;
    state.playOverrides = null;
    state.report = null;
    state.selectedBeam = null;
    recomputeSim(state);
    setMessage(
      state,
      got.source === 'random'
        ? `种子 ${seed}: 随机尝试 ${got.attemptsUsed} 次后得到唯一解关卡`
        : `种子 ${seed}: 随机候选均不唯一, 已回退到内置已知唯一解样例`,
      'ok',
    );
  } finally {
    state.solving = false;
  }
}

export function saveToText(state: AppState): string {
  return exportLevel(state.level);
}

/** 导入失败时保留上一份可用关卡(state.level 不变), 并回报逐格冲突 */
export function loadFromText(state: AppState, text: string): boolean {
  const result = importLevel(text);
  state.lastImport = result;
  if (!result.ok) {
    const cellErrors = result.errors
      .map((e) =>
        e.r < 0 ? e.reason : `第 (${e.r + 1}, ${e.c + 1}) 格: ${e.reason}`,
      )
      .join('; ');
    const all = [result.globalErrors.join('; '), cellErrors].filter(Boolean).join(' | ');
    setMessage(state, `导入被拒绝, 仍保留当前关卡 — ${all}`, 'error');
    return false;
  }
  state.level = result.level!;
  state.playOverrides = null;
  state.report = null;
  state.selectedBeam = null;
  recomputeSim(state);
  setMessage(state, '导入成功, 已切换到新关卡', 'ok');
  return true;
}

export function currentMirrorCell(
  state: AppState,
  r: number,
  c: number,
): MirrorCell | undefined {
  const cell = effectiveLevel(state).cells[r][c];
  return cell.kind === 'mirror' ? cell : undefined;
}
