// 棋盘渲染: CSS Grid 格子 + 绝对定位 SVG 光束层

import type { AppState } from './state';
import { effectiveLevel } from './state';
import { BeamTrace, Level, maskCode, maskCss, maskName } from './core/types';

const CELL_PX = 48;
const GAP = 3;
const PAD = 10;

/** 格子中心点在 SVG 坐标系中的像素位置 */
function center(r: number, c: number): { x: number; y: number } {
  return {
    x: PAD + c * (CELL_PX + GAP) + CELL_PX / 2 - PAD,
    y: PAD + r * (CELL_PX + GAP) + CELL_PX / 2 - PAD,
  };
}

function colorDots(mask: number): string {
  const bits: [string, number][] = [
    ['r', 1],
    ['g', 2],
    ['b', 4],
  ];
  return bits
    .map(([cls, bit]) => `<span class="dot ${mask & bit ? cls : 'off'}"></span>`)
    .join('');
}

/** 把一束光的路径转成 SVG 路径 d 属性 */
function polylineToPath(beam: BeamTrace): string {
  if (beam.path.length === 0) return '';
  const pts = beam.path.map(([r, c]) => center(r, c));
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i].x} ${pts[i].y}`;
  }
  return d;
}

const DIR_ARROW = ['↑', '→', '↓', '←'];

function cellHtml(
  state: AppState,
  level: Level,
  r: number,
  c: number,
  loopCells: Set<string>,
): string {
  const cell = level.cells[r][c];
  const loop = loopCells.has(`${r},${c}`) ? ' loop-cell' : '';

  if (cell.kind === 'empty') {
    return `<div class="cell${loop}" data-r="${r}" data-c="${c}"></div>`;
  }
  if (cell.kind === 'wall') {
    return `<div class="cell wall${loop}" data-r="${r}" data-c="${c}">🧱</div>`;
  }
  if (cell.kind === 'source') {
    return `
      <div class="cell source-cell${loop}" data-r="${r}" data-c="${c}">
        <span class="dir-arrow">${DIR_ARROW[cell.dir]}</span>
        <div>
          <div style="font-size:15px;font-weight:700">光</div>
          <div class="source-dots">${colorDots(cell.colors)}</div>
        </div>
      </div>`;
  }
  if (cell.kind === 'mirror') {
    const glyph = cell.orient === 0 ? '╱' : '╲';
    return `
      <div class="cell${loop}" data-r="${r}" data-c="${c}" title="${cell.orient === 0 ? '/' : '\\'} 反光片${cell.locked ? '(已锁定)' : ''}">
        <span class="mirror-glyph">${glyph}</span>
        ${cell.locked ? '<span class="lock-badge">🔒</span>' : ''}
      </div>`;
  }
  // target
  const key = `${r},${c}`;
  const t = state.sim.targets.get(key);
  const cls = t?.satisfied ? 'target-good' : 'target-bad';
  return `
    <div class="cell target-cell ${cls}${loop}" data-r="${r}" data-c="${c}">
      <div style="text-align:center">
        <div style="font-size:13px;font-weight:700">收</div>
        <div class="target-dots">${colorDots(cell.required)}</div>
        <div class="target-label">${cell.required === 0 ? '任意' : maskCode(cell.required)} · 到${t ? maskName(t.got) : '无'}</div>
      </div>
    </div>`;
}

export function renderBoard(state: AppState): string {
  const level = effectiveLevel(state);
  const n = level.size;

  // 回路覆盖的格子(用于高亮)
  const loopCells = new Set<string>();
  for (const beam of state.sim.beams) {
    if (beam.end !== 'loop' || beam.loopStart === undefined) continue;
    for (let i = beam.loopStart; i < beam.path.length; i++) {
      const [r, c] = beam.path[i];
      loopCells.add(`${r},${c}`);
    }
  }

  const cells: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      cells.push(cellHtml(state, level, r, c, loopCells));
    }
  }

  // 光束 SVG
  const boardPx = n * CELL_PX + (n - 1) * GAP;
  const paths = state.sim.beams
    .map((beam: BeamTrace) => {
      const dim =
        state.selectedBeam !== null && beam.id !== state.selectedBeam ? ' dimmed' : '';
      const loopCls = beam.end === 'loop' ? ' loop' : '';
      const css = maskCss(beam.color);
      return `<path class="${dim}${loopCls}" stroke="${css}" d="${polylineToPath(beam)}" />`;
    })
    .join('');

  return `
    <div class="board">
      <div class="grid" style="grid-template-columns: repeat(${n}, ${CELL_PX}px); width: ${boardPx}px">
        ${cells.join('')}
      </div>
      <svg class="beam-layer" width="${boardPx}" height="${boardPx}" viewBox="0 0 ${boardPx} ${boardPx}">
        ${paths}
      </svg>
    </div>`;
}

/** 供 UI 事件把像素坐标换算回格子(本项目直接用 data 属性, 保留备用) */
export function pixelToCell(x: number, y: number): [number, number] {
  const c = Math.floor((x - PAD) / (CELL_PX + GAP));
  const r = Math.floor((y - PAD) / (CELL_PX + GAP));
  return [r, c];
}
