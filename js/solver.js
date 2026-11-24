// 光照采样求解：探针权重、区域限制、门洞可见性、补缺值。
// 纯函数，不依赖 DOM；Node 测试直接调用。

import {
  DIVIDER,
  GRID,
  SAMPLE,
  LUM_UP_WEIGHT,
  LUM_SIDE_WEIGHT,
} from './config.js';
import { cellIndex, cellOfPoint, probeWorldPos, CARDINALS } from './model.js';
import {
  clamp,
  luminance,
  mixRgb,
  resamplePolyline,
} from './util.js';

export const MODE_LABEL = Object.freeze({
  restricted: '受区域限制',
  unrestricted: '无区域限制',
});

/**
 * 探针 → 查询点的权重核：水平距离越近越高，超出半径不参与。
 * 使用平方衰减，便于解释“比例”。
 */
export function distanceWeight(dist, radius, weight = 1) {
  if (!(radius > 0) || dist >= radius) return 0;
  const t = 1 - dist / radius;
  return t * t * weight;
}

/** 线段是否穿过门洞；返回 0..1 的通达系数。
 *  q 为查询点，p 为探针位置；只有跨过墙面的线段才检查门洞。
 *  门扇绕 z = -doorHalf 的铰链转动，门洞内未被门扇挡住的一段才透光。
 */
export function portalFactor(q, p, door, y = GRID.probeY) {
  const x0 = DIVIDER.x;
  const a = q.x - x0;
  const b = p.x - x0;
  if (a * b >= 0) return 0; // 两点在墙的同一侧，不穿墙
  const t = a / (a - b);
  if (!(t > 0 && t < 1)) return 0;
  const z = q.z + (p.z - q.z) * t;
  if (y >= DIVIDER.doorHeight) return 0;
  const open = clamp(Number(door?.open) ?? 0, 0, 1);
  if (open <= 0.001) return 0;
  // 门扇开启角：0 = 关，1 = 完全打开
  const angle = open * (Math.PI / 2);
  const half = DIVIDER.doorHalf;
  const blockedTo = -half + 2 * half * Math.cos(angle);
  const edge = 0.22;
  if (z <= blockedTo || z >= half) return 0;
  if (z < blockedTo + edge) return clamp((z - blockedTo) / edge, 0, 1);
  if (z > half - edge) return clamp((half - z) / edge, 0, 1);
  return 1;
}

function cellAt(state, col, row) {
  if (col < 0 || col >= GRID.cols || row < 0 || row >= GRID.rows) return null;
  return state.cells[cellIndex(col, row)];
}

/**
 * 支撑度：参与探针的权重和达到 supportTarget 时视为完全由实测覆盖。
 * 低于该值时按比例混入补缺值；没有任何探针参与则为 0。
 */
function computeSupport(contributions) {
  if (!contributions.length) return 0;
  let sum = 0;
  for (const c of contributions) sum += c.weight;
  return clamp(sum / Math.max(1e-6, SAMPLE.supportTarget), 0, 1);
}

export function zoneAt(state, x, z) {
  const c = cellOfPoint(x, z);
  if (!c) return { zone: null, blocked: true, cell: null, outside: true };
  const cell = cellAt(state, c.col, c.row);
  if (!cell) return { zone: null, blocked: true, cell: null, outside: true };
  return {
    zone: cell.zone ?? null,
    blocked: Boolean(cell.blocked),
    cell,
    outside: false,
    col: c.col,
    row: c.row,
    index: c.index,
  };
}

/**
 * 求解某一点的光照。
 * @param {object} state
 * @param {{x:number,z:number}} point
 * @param {{mode?:'restricted'|'unrestricted', doorOpen?:number}} opts
 */
export function sampleLighting(state, point, opts = {}) {
  const mode = opts.mode === 'unrestricted' ? 'unrestricted' : 'restricted';
  const doorOpen = Number.isFinite(opts.doorOpen)
    ? clamp(opts.doorOpen, 0, 1)
    : clamp(state.door?.hasOpening === false ? 0 : state.door?.open ?? 1, 0, 1);
  const door = { open: doorOpen, hasOpening: state.door?.hasOpening !== false };

  const here = zoneAt(state, point.x, point.z);
  const q = { x: point.x, z: point.z };

  const contributions = [];

  if (!here.outside && !here.blocked && here.zone) {
    for (const probe of state.probes) {
      if (probe.enabled === false) continue;
      const cell = cellAt(state, probe.col, probe.row);
      if (!cell || cell.blocked || !cell.zone) continue;
      const pos = probeWorldPos(probe);
      const dist = Math.hypot(pos.x - q.x, pos.z - q.z);
      let w = distanceWeight(dist, probe.radius ?? SAMPLE.radius, probe.weight ?? 1);
      if (w <= 0) continue;

      const crossSide = cell.zone !== here.zone;
      let viaPortal = 0;
      if (crossSide) {
        if (mode === 'restricted') {
          viaPortal = portalFactor(q, pos, door);
          if (viaPortal <= 0) continue;
          w *= viaPortal;
        } else {
          // 无区域限制：不检查墙和门，另一侧的亮色会直接参与混色
          viaPortal = 1;
        }
      }

      contributions.push({
        probeId: probe.id,
        col: probe.col,
        row: probe.row,
        zone: cell.zone,
        crossSide,
        viaPortal,
        distance: dist,
        weight: w,
        radius: probe.radius ?? SAMPLE.radius,
        up: probe.up,
        sides: probe.sides,
      });
    }
  }

  contributions.sort((a, b) => b.weight - a.weight);
  const sumUsed = contributions.reduce((acc, c) => acc + c.weight, 0);
  for (const c of contributions) {
    c.fraction = sumUsed > 0 ? c.weight / sumUsed : 0;
  }

  const support = computeSupport(contributions);

  let up = [0, 0, 0];
  const sides = { n: [0, 0, 0], e: [0, 0, 0], s: [0, 0, 0], w: [0, 0, 0] };
  if (sumUsed > 0) {
    for (const c of contributions) {
      const k = c.weight / sumUsed;
      up = [up[0] + c.up[0] * k, up[1] + c.up[1] * k, up[2] + c.up[2] * k];
      for (const dir of CARDINALS) {
        sides[dir][0] += c.sides[dir][0] * k;
        sides[dir][1] += c.sides[dir][1] * k;
        sides[dir][2] += c.sides[dir][2] * k;
      }
    }
  }

  const fb = SAMPLE.fallback;
  const fallbackFraction = 1 - support;
  const blendedUp = sumUsed > 0 ? mixRgb(fb.up, up, support) : [fb.up[0], fb.up[1], fb.up[2]];
  const blendedSides = {};
  for (const dir of CARDINALS) {
    blendedSides[dir] = sumUsed > 0
      ? mixRgb(fb.side[dir], sides[dir], support)
      : [fb.side[dir][0], fb.side[dir][1], fb.side[dir][2]];
  }

  const sideAvg = CARDINALS.reduce(
    (acc, dir) => [
      acc[0] + blendedSides[dir][0] / CARDINALS.length,
      acc[1] + blendedSides[dir][1] / CARDINALS.length,
      acc[2] + blendedSides[dir][2] / CARDINALS.length,
    ],
    [0, 0, 0],
  );

  return {
    point: { x: point.x, z: point.z },
    mode,
    doorOpen,
    doorBlocks: doorOpen <= 0.001 || door.hasOpening === false,
    zone: here.zone,
    blocked: here.blocked,
    outside: here.outside,
    col: here.col ?? null,
    row: here.row ?? null,
    contributions,
    usedProbeCount: contributions.length,
    totalWeight: sumUsed,
    support,
    fallbackFraction,
    usedFallback: fallbackFraction > 0.001,
    computed: { up, sides },
    colors: { up: blendedUp, sides: blendedSides },
    lum: luminance(mixRgb(
      blendedUp,
      sideAvg,
      LUM_SIDE_WEIGHT / (LUM_UP_WEIGHT + LUM_SIDE_WEIGHT),
    )),
    top: contributions.slice(0, 4),
  };
}

/**
 * 沿路径采样，同时给出两种区域策略的结果。
 */
export function samplePath(state, opts = {}) {
  const step = opts.step ?? state.step ?? 0.08;
  const doorOpen = Number.isFinite(opts.doorOpen)
    ? clamp(opts.doorOpen, 0, 1)
    : clamp(state.door?.hasOpening === false ? 0 : state.door?.open ?? 1, 0, 1);
  const points = resamplePolyline(state.path, step);
  return points.map((p, index) => {
    const restricted = sampleLighting(state, p, { mode: 'restricted', doorOpen });
    const unrestricted = sampleLighting(state, p, { mode: 'unrestricted', doorOpen });
    return {
      index,
      dist: p.dist,
      x: p.x,
      z: p.z,
      restricted,
      unrestricted,
    };
  });
}

/** 单步差异标记：穿过格边、门槛、区域变化、进入/离开补缺。 */
export function stepFlags(a, b) {
  const flags = [];
  if (!a || !b) return flags;
  const cellA = a.col === null ? null : `${a.col},${a.row}`;
  const cellB = b.col === null ? null : `${b.col},${b.row}`;
  if (cellA !== cellB) {
    flags.push({ type: 'cell', label: '跨过格边', detail: `${cellA ?? '网格外'} → ${cellB ?? '网格外'}` });
  }
  const ax = a.point?.x ?? a.x ?? NaN;
  const bx = b.point?.x ?? b.x ?? NaN;
  if (Number.isFinite(ax) && Number.isFinite(bx) && (ax < DIVIDER.x) !== (bx < DIVIDER.x)) {
    flags.push({ type: 'threshold', label: '穿过门槛', detail: `${DIVIDER.x.toFixed(2)} m 处墙上开口` });
  }
  if (a.zone !== b.zone) {
    flags.push({ type: 'zone', label: '区域切换', detail: `${a.zone ?? '未分配'} → ${b.zone ?? '未分配'}` });
  }
  const coverA = a.support >= 0.999;
  const coverB = b.support >= 0.999;
  if (coverA !== coverB) {
    flags.push({
      type: 'coverage',
      label: coverB ? '回到实测覆盖' : '脱离实测覆盖',
      detail: coverB ? '补缺占比归零' : `补缺占比升至 ${(b.fallbackFraction * 100).toFixed(0)}%`,
    });
  } else if (Math.abs(a.support - b.support) > 0.08) {
    flags.push({
      type: 'support',
      label: '支撑度跳变',
      detail: `${(a.support * 100).toFixed(0)}% → ${(b.support * 100).toFixed(0)}%`,
    });
  }
  const portalA = a.contributions.some((c) => c.crossSide && c.viaPortal > 0);
  const portalB = b.contributions.some((c) => c.crossSide && c.viaPortal > 0);
  if (portalA !== portalB) {
    flags.push({
      type: 'portal',
      label: portalB ? '门洞开始透光' : '门洞不再透光',
      detail: '跨侧探针只在门洞开口内参与',
    });
  }
  return flags;
}

/** 给整条路径标注事件，供单步检查器跳转。 */
export function pathEvents(samples) {
  const events = [];
  for (let i = 1; i < samples.length; i += 1) {
    const flags = stepFlags(samples[i - 1].restricted, samples[i].restricted);
    for (const flag of flags) {
      events.push({ ...flag, index: i, dist: samples[i].dist });
    }
  }
  return events;
}

/**
 * 覆盖审计：剩余探针/可用格能否支撑整条路径的预览。
 */
export function auditCoverage(state, opts = {}) {
  const step = opts.step ?? Math.max(0.25, (state.step ?? 0.08) * 2);
  const points = resamplePolyline(state.path, step);
  const doorOpen = Number.isFinite(opts.doorOpen)
    ? clamp(opts.doorOpen, 0, 1)
    : clamp(state.door?.hasOpening === false ? 0 : state.door?.open ?? 1, 0, 1);

  let covered = 0;
  const fallbackSegments = [];
  let run = null;

  for (const p of points) {
    const s = sampleLighting(state, p, { mode: 'restricted', doorOpen });
    if (s.support >= 0.999) {
      covered += 1;
      if (run) {
        fallbackSegments.push(run);
        run = null;
      }
    } else {
      if (!run) run = { from: p.dist, to: p.dist, worstSupport: s.support, reason: describeCoverageGap(state, p) };
      else {
        run.to = p.dist;
        run.worstSupport = Math.min(run.worstSupport, s.support);
      }
    }
  }
  if (run) fallbackSegments.push(run);

  const probeCells = new Set(state.probes.map((p) => `${p.col},${p.row}`));
  const emptyCells = state.cells.filter(
    (c) => !c.blocked && c.zone && !probeCells.has(`${c.col},${c.row}`),
  );

  const totalUsableCells = state.cells.filter((c) => !c.blocked && c.zone).length;
  const totalSamples = points.length;
  const coverageRatio = totalSamples ? covered / totalSamples : 0;

  return {
    samples: totalSamples,
    covered,
    uncovered: totalSamples - covered,
    coverageRatio,
    fallbackSegments,
    emptyCells: emptyCells.map((c) => ({ col: c.col, row: c.row, zone: c.zone })),
    usableCells: totalUsableCells,
    totalCells: state.cells.length,
    complete: fallbackSegments.length === 0,
    summary: fallbackSegments.length === 0
      ? `整条路径都由 ${state.probes.filter((p) => p.enabled).length} 个实测探针覆盖，补缺值为 0。`
      : `路径上有 ${fallbackSegments.length} 段缺少实测支撑，最长 ${formatSpan(fallbackSegments)}；这些位置的亮度是实测光照与补缺值按支撑度混合的结果。`,
  };
}

function formatSpan(segments) {
  let best = segments[0];
  for (const s of segments) if (s.to - s.from > best.to - best.from) best = s;
  return `${(best.to - best.from).toFixed(1)} m（${best.from.toFixed(1)}–${best.to.toFixed(1)} m）`;
}

function describeCoverageGap(state, p) {
  const here = zoneAt(state, p.x, p.z);
  if (here.outside) return '路径点在网格外';
  if (here.blocked) return `格子 ${here.col},${here.row} 被标为不可用`;
  if (!here.zone) return `格子 ${here.col},${here.row} 未分配区域`;
  const sameZone = state.probes.filter((probe) => {
    const c = cellAt(state, probe.col, probe.row);
    return probe.enabled !== false && c && !c.blocked && c.zone === here.zone;
  });
  if (sameZone.length === 0) return `区域 ${here.zone} 内没有可用探针`;
  let nearest = Infinity;
  for (const probe of sameZone) {
    const pos = probeWorldPos(probe);
    nearest = Math.min(nearest, Math.hypot(pos.x - p.x, pos.z - p.z));
  }
  if (nearest >= SAMPLE.radius) {
    return `最近探针在 ${nearest.toFixed(1)} m 外，超过 ${SAMPLE.radius.toFixed(1)} m 影响半径`;
  }
  return `附近探针权重不足（最近 ${nearest.toFixed(1)} m）`;
}
