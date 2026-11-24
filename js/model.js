// 场景状态模型：格子、区域、探针、门、路径。
// 这里不依赖 DOM，可直接在 Node 里做序列化 / 求解测试。

import {
  GRID,
  DIVIDER,
  SAMPLE,
  DEFAULT_PATH,
  DEFAULT_STEP,
} from './config.js';
import { clamp, deepClone, hash01 } from './util.js';

export const CARDINALS = Object.freeze(['n', 'e', 's', 'w']);
export const SIDES_LABEL = Object.freeze({ n: '北', e: '东', s: '南', w: '西' });

export const cellIndex = (col, row) => row * GRID.cols + col;

export function cellOfPoint(x, z) {
  const col = Math.floor((x - GRID.originX) / GRID.cell);
  const row = Math.floor((z - GRID.originZ) / GRID.cell);
  if (col < 0 || col >= GRID.cols || row < 0 || row >= GRID.rows) return null;
  return { col, row, index: cellIndex(col, row) };
}

export function cellCenter(col, row) {
  return {
    x: GRID.originX + (col + 0.5) * GRID.cell,
    z: GRID.originZ + (row + 0.5) * GRID.cell,
  };
}

export const defaultZoneForCol = (col) => (col * GRID.cell + GRID.originX < DIVIDER.x ? 'interior' : 'exterior');

export function probeWorldPos(probe) {
  const c = cellCenter(probe.col, probe.row);
  return {
    x: c.x + clamp(probe.ox ?? 0, -0.85, 0.85),
    y: GRID.probeY,
    z: c.z + clamp(probe.oz ?? 0, -0.85, 0.85),
  };
}

export function makeCells() {
  const cells = [];
  for (let row = 0; row < GRID.rows; row += 1) {
    for (let col = 0; col < GRID.cols; col += 1) {
      cells.push({
        col,
        row,
        zone: defaultZoneForCol(col),
        blocked: false,
      });
    }
  }
  return cells;
}

function jitterColor(rgb, a, b, amount) {
  const j = (hash01(a, b, rgb[0] * 10) - 0.5) * 2 * amount;
  return rgb.map((v) => clamp(v + j, 0, 1));
}

export function defaultProbeColors(col, row) {
  const zone = defaultZoneForCol(col);
  if (zone === 'interior') {
    const nearDoor = col === 2 ? 1 : 0;
    const sideBase = nearDoor ? [0.32, 0.26, 0.2] : [0.235, 0.19, 0.145];
    return {
      up: jitterColor(nearDoor ? [0.54, 0.4, 0.26] : [0.47, 0.345, 0.225], col, row, 0.012),
      sides: {
        n: jitterColor(sideBase.map((v) => v * 0.86), col, row, 0.008),
        e: jitterColor(sideBase.map((v) => v * 1.02), col, row, 0.008),
        s: jitterColor(sideBase.map((v) => v * 1.08), col, row, 0.008),
        w: jitterColor(sideBase.map((v) => v * 0.92), col, row, 0.008),
      },
    };
  }
  return {
    up: jitterColor([0.8, 0.88, 0.99], col, row, 0.012),
    sides: {
      n: jitterColor([0.58, 0.63, 0.7], col, row, 0.01),
      e: jitterColor([0.76, 0.79, 0.83], col, row, 0.01),
      s: jitterColor([0.71, 0.74, 0.78], col, row, 0.01),
      w: jitterColor([0.62, 0.66, 0.72], col, row, 0.01),
    },
  };
}

export function makeProbe(col, row, overrides = {}) {
  const colors = defaultProbeColors(col, row);
  // 靠门两列的探针默认向门口收一点：否则离墙 1 m，门洞通光几乎参与不进来。
  const centerX = cellCenter(col, row).x;
  const doorSideOffset = Math.abs(centerX - DIVIDER.x) <= GRID.cell
    ? Math.sign(DIVIDER.x - centerX) * 0.7
    : 0;
  return {
    id: overrides.id ?? `p${col}${row}`,
    col,
    row,
    ox: doorSideOffset,
    oz: 0,
    enabled: true,
    weight: 1,
    radius: SAMPLE.radius,
    up: colors.up,
    sides: colors.sides,
    ...overrides,
  };
}

export function makeProbes() {
  const probes = [];
  for (let row = 0; row < GRID.rows; row += 1) {
    for (let col = 0; col < GRID.cols; col += 1) {
      probes.push(makeProbe(col, row));
    }
  }
  return probes;
}

export function makeDoor(open = 1) {
  return { hasOpening: true, open };
}

export function makeState() {
  const path = DEFAULT_PATH.map((p) => ({ x: p.x, z: p.z }));
  return {
    version: 2,
    grid: { ...GRID },
    door: makeDoor(1),
    cells: makeCells(),
    probes: makeProbes(),
    path,
    mover: { x: path[0].x, z: path[0].z },
    followPath: false,
    playhead: 0,
    step: DEFAULT_STEP,
    view: {
      floorMode: 'restricted', // restricted | unrestricted | off
      showRays: true,
      showProbes: true,
      selectedProbeId: null,
      selectedCellIndex: null,
    },
  };
}

/** 三个演示场景共用一套探针数据，只改门与区域标记。 */
export function applyDemo(demoId) {
  const next = makeState();
  if (demoId === 'closed') {
    next.door = makeDoor(0);
  } else if (demoId === 'gap') {
    next.door = makeDoor(1);
    // 区域罩不全：最后一列被标为不可用；倒数第二列区域声明还在，但探针缺失。
    // 路径会先经历「探针不足 → 补缺占比上升」，再进入「整格不可用 → 纯补缺」。
    for (const cell of next.cells) {
      if (cell.col === GRID.cols - 1) {
        cell.zone = null;
        cell.blocked = true;
      }
    }
    next.probes = next.probes.filter((p) => p.col < GRID.cols - 2);
  } else {
    next.door = makeDoor(1);
  }
  return next;
}

export const DEMO_IDS = Object.freeze(['open', 'closed', 'gap']);

export function nextProbeId(state) {
  let n = 1;
  const used = new Set(state.probes.map((p) => p.id));
  while (used.has(`p${n}`)) n += 1;
  return `p${n}`;
}

/** 将探针偏移限制在所属格子内（与 probeWorldPos 的夹取范围一致）。 */
export function clampProbeToCell(probe, x, z) {
  const c = cellCenter(probe.col, probe.row);
  const half = 0.85;
  return {
    ox: clamp(x - c.x, -half, half),
    oz: clamp(z - c.z, -half, half),
  };
}

/**
 * 把任意对象规范成可用的场景状态；供“读回文件”使用，避免坏数据打断渲染。
 */
export function normalizeLoadedState(raw) {
  const out = makeState();
  if (!raw || typeof raw !== 'object') return out;

  if (raw.door && typeof raw.door === 'object') {
    out.door.hasOpening = raw.door.hasOpening !== false;
    const open = Number(raw.door.open);
    out.door.open = Number.isFinite(open) ? clamp(open, 0, 1) : 1;
  }

  if (Array.isArray(raw.cells)) {
    for (const cell of raw.cells) {
      const col = Number(cell?.col);
      const row = Number(cell?.row);
      if (!Number.isInteger(col) || !Number.isInteger(row)) continue;
      if (col < 0 || col >= GRID.cols || row < 0 || row >= GRID.rows) continue;
      const target = out.cells[cellIndex(col, row)];
      target.zone = cell.zone === 'interior' || cell.zone === 'exterior' ? cell.zone : null;
      target.blocked = Boolean(cell.blocked);
    }
  } else {
    // 旧格式：只有区域标记
    if (raw.zoneMarks && typeof raw.zoneMarks === 'object') {
      for (const [key, zone] of Object.entries(raw.zoneMarks)) {
        const [col, row] = key.split(',').map(Number);
        if (!Number.isInteger(col) || !Number.isInteger(row)) continue;
        if (col < 0 || col >= GRID.cols || row < 0 || row >= GRID.rows) continue;
        out.cells[cellIndex(col, row)].zone = zone === 'interior' || zone === 'exterior' ? zone : null;
      }
    }
  }

  if (Array.isArray(raw.probes)) {
    const seenIds = new Set();
    const probes = [];
    for (const p of raw.probes) {
      const col = Number(p?.col);
      const row = Number(p?.row);
      if (!Number.isInteger(col) || !Number.isInteger(row)) continue;
      if (col < 0 || col >= GRID.cols || row < 0 || row >= GRID.rows) continue;
      const base = makeProbe(col, row);
      let id = typeof p.id === 'string' && p.id ? p.id : base.id;
      if (seenIds.has(id)) id = nextProbeId({ probes });
      seenIds.add(id);
      const sides = {};
      for (const dir of CARDINALS) {
        sides[dir] = normalizeColor(p.sides?.[dir], base.sides[dir]);
      }
      probes.push({
        id,
        col,
        row,
        ox: Number.isFinite(Number(p.ox)) ? clamp(Number(p.ox), -0.85, 0.85) : base.ox,
        oz: Number.isFinite(Number(p.oz)) ? clamp(Number(p.oz), -0.85, 0.85) : base.oz,
        enabled: p.enabled !== false,
        weight: Number.isFinite(Number(p.weight)) ? clamp(Number(p.weight), 0.05, 2) : 1,
        radius: Number.isFinite(Number(p.radius)) ? clamp(Number(p.radius), 0.5, 8) : base.radius,
        up: normalizeColor(p.up, base.up),
        sides,
      });
    }
    out.probes = probes;
    // 被标为不可用的格子不应再有探针
    out.probes = out.probes.filter((p) => !out.cells[cellIndex(p.col, p.row)].blocked);
  }

  if (Array.isArray(raw.path)) {
    const path = raw.path
      .map((p) => ({ x: Number(p?.x), z: Number(p?.z) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z));
    if (path.length >= 2) out.path = path;
  }

  if (raw.mover && Number.isFinite(Number(raw.mover.x)) && Number.isFinite(Number(raw.mover.z))) {
    out.mover = { x: Number(raw.mover.x), z: Number(raw.mover.z) };
    out.followPath = Boolean(raw.followPath);
  } else {
    out.mover = { x: out.path[0].x, z: out.path[0].z };
  }

  if (Number.isFinite(Number(raw.step))) out.step = clamp(Number(raw.step), 0.02, 0.5);
  if (raw.view && typeof raw.view === 'object') {
    if (['restricted', 'unrestricted', 'off'].includes(raw.view.floorMode)) {
      out.view.floorMode = raw.view.floorMode;
    }
    out.view.showRays = raw.view.showRays !== false;
    out.view.showProbes = raw.view.showProbes !== false;
  }
  return out;
}

function normalizeColor(value, fallback) {
  if (!Array.isArray(value) || value.length < 3) return deepClone(fallback);
  return [0, 1, 2].map((i) => clamp(Number(value[i]), 0, 1));
}

/** 序列化场景本身（不含求解结果）。 */
export function serializeScene(state) {
  return {
    format: 'light-probe-previewer',
    version: state.version,
    savedAt: new Date().toISOString(),
    grid: { ...GRID },
    divider: { ...DIVIDER },
    door: deepClone(state.door),
    cells: state.cells.map((c) => ({ col: c.col, row: c.row, zone: c.zone, blocked: c.blocked })),
    probes: deepClone(state.probes),
    path: deepClone(state.path),
    mover: deepClone(state.mover),
    followPath: Boolean(state.followPath),
    step: state.step,
    view: { ...state.view },
  };
}
