// core.js —— 纯逻辑内核：时序原语、路线模拟、批量试跑、结果对比
// 所有状态都是「绝对时间 t」的纯函数，不依赖 DOM，可在 Node 中直接测试。
//
// 半开区间约定（关键，保证「刚好错过」不被算成通过）：
//   停靠区间统一为 [start, end)；门的开启区间为 [open, close)。
//   恰好在关闭/离站时刻到达 => 判定失败。

export const EPS = 1e-7; // 时间吸附精度（秒），远小于任何可调步长，吞掉浮点尾差
export const snap = (t) => Math.round(t / EPS) * EPS;

// ---------- 最小公倍数（周期可能为小数，统一放大到整数） ----------
export function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b > EPS) { [a, b] = [b, a % b]; }
  return a;
}
export function lcm2(a, b) {
  const g = gcd(a, b);
  if (g < EPS) return a || b;
  return Math.round(a / g) * b;
}
export function lcmAll(nums) {
  return nums.reduce((acc, n) => lcm2(acc, n), 1);
}

// ---------- 振荡器原语 ----------
// 每个周期实体的运动被抽象成四段（按相位排列）：
//   A→B 移动 halfT、B 端停靠 dwellB、B→A 移动 halfT、A 端停靠 dwellA
// halfT = (周期 - 两段停靠) / 2
export function halfTravel(ent) {
  return Math.max(0, (ent.period - (ent.dwellA ?? 0) - (ent.dwellB ?? 0)) / 2);
}

// 返回 { phase, f, moving, dwellA, dwellB }
// f∈[0,1]：A 端为 0，B 端为 1；平台取线性插值，门 f=0 关 / f=1 开
// 注意：边界用 snap 后的精确比较，保证半开区间语义（末端时刻不属于停靠段）
export function oscillatorState(ent, t) {
  const period = ent.period;
  const dA = ent.dwellA ?? 0;
  const dB = ent.dwellB ?? 0;
  const halfT = halfTravel(ent);
  let x = ((t - (ent.phase ?? 0)) % period + period) % period;
  x = snap(x);
  if (x < halfT) {
    return { phase: x, f: halfT > EPS ? x / halfT : 0, moving: 'AB', dwellA: false, dwellB: false };
  }
  if (x < halfT + dB) {
    return { phase: x, f: 1, moving: null, dwellA: false, dwellB: true };
  }
  if (x < 2 * halfT + dB) {
    return { phase: x, f: halfT > EPS ? 1 - (x - halfT - dB) / halfT : 1, moving: 'BA', dwellA: false, dwellB: false };
  }
  return { phase: x, f: 0, moving: null, dwellA: true, dwellB: false };
}

export function platformPos(p, t) {
  const s = oscillatorState(p, t);
  return {
    x: p.ax + (p.bx - p.ax) * s.f,
    y: p.ay + (p.by - p.ay) * s.f,
    moving: s.moving,
    dwellA: s.dwellA,
    dwellB: s.dwellB,
  };
}

export function doorState(d, t) {
  const s = oscillatorState(d, t);
  return { open: s.dwellB, f: s.f }; // 只有停在 B 端才算开
}

// ---------- 停靠/开启区间查询 ----------
// 绝对相位锚点：每周期第 k 个分段边界的绝对时间 = anchor + k*period
// 锚点统一归一到 [0, period)，超出周期的部分由 k*period 承载
function phaseAnchors(ent) {
  const P = ent.period;
  const halfT = halfTravel(ent);
  const dB = ent.dwellB ?? 0;
  const dA = ent.dwellA ?? 0;
  const ph = (((ent.phase ?? 0) % P) + P) % P;
  // 分段点都写成 ph + 段内偏移；偏移取模到 [0,P)，保证锚点落在 [ph, ph+P)
  const norm = (offsetFromPh) => ph + (((offsetFromPh) % P + P) % P);
  return {
    bStart: norm(halfT),                            // B 端停靠开始
    bEnd: norm(halfT + dB),                         // B 端停靠结束
    aStart: norm(2 * halfT + dB),                   // A 端停靠开始
    aEnd: norm(2 * halfT + dB + dA),                // 周期末（下周期 AB 起点）
  };}

// 取 >= t 的下一个 B 端停靠区间 [start,end)；t 若已在区间内则返回当前区间
// t 恰等于某区间 end（半开末端）时，必须跳到下一周期
export function nextDwellB(ent, t) {
  const a = phaseAnchors(ent);
  const dwell = ent.dwellB ?? 0;
  let k = Math.floor((t - a.bStart) / ent.period);
  let start = a.bStart + k * ent.period;
  // 不属于 [start, end)（含恰等于 end 的半开末端）就推进到下一周期
  if (t < start - EPS || t + EPS >= start + dwell) start += ent.period;
  return { start: snap(start), end: snap(start + dwell) };
}

// 取 >= t 的下一次门开启区间 [open,close)（门即 dwellB）
export const nextOpen = nextDwellB;

// [from,to) 内全部 B 端停靠区间（左闭右开，跨端点的不截断）
export function dwellsBetween(ent, from, to) {
  const out = [];
  let cur = nextDwellB(ent, from);
  let guard = 0;
  while (cur.start < to - EPS && guard++ < 10000) {
    out.push(cur);
    cur = nextDwellB(ent, cur.end + EPS);
  }
  return out;
}

// ---------- 场景周期 ----------
export function superPeriod(scene) {
  const periods = [
    ...scene.platforms.map((p) => p.period),
    ...scene.doors.map((d) => d.period),
  ];
  return lcmAll(periods.length ? periods : [1]);
}

// ---------- 几何工具 ----------
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const lerpPt = (a, b, f) => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });

function pointById(scene, id) {
  return scene.points.find((p) => p.id === id);
}
function platformById(scene, id) {
  return scene.platforms.find((p) => p.id === id);
}
function doorById(scene, id) {
  return scene.doors.find((d) => d.id === id);
}

// 失败/成功原因文案（集中管理，UI 与测试共用）
export const REASONS = {
  DOOR_CLOSED: '门已关闭：刚好错过关门时刻，不允许通过',
  DOOR_TIMEOUT: '等待开门超时',
  NO_RIDE_DWELL: '平台在时限内没有可搭乘的停靠',
  RIDE_TIMEOUT: '搭乘超时：平台未在时限内到达对端',
  EXIT_MISSED: '到达对端时平台已离站，未能下车',
  PLATFORM_MISSED: '平台已离站：刚好错过靠站时刻，不允许登乘',
  HORIZON: '超出路线时限，路线未能走完',
  BAD_TARGET: '路线引用了场景中不存在的对象',
  SUCCESS: '路线走通',
};

// ---------- 单条路线模拟 ----------
// action: {type:'walk', to, waitForDoor?[]}
//         {type:'wait', point, duration}
//         {type:'ride', platform, to, side:'A'|'B'}
// 返回 { ok, reason, failStep, failAt, tEnd, steps[], horizon, t0, charAt(t) }
export function simulateRoute(scene, actions, t0, horizon = 120) {
  const startPoint = scene.points[0];
  const steps = [];
  let char = { ...startPoint };
  let t = snap(t0);
  const deadline = snap(t0 + horizon);

  const pushStep = (base, extra) => steps.push({ ...base, ...extra });

  for (let i = 0; i < actions.length; i++) {
    const act = actions[i];

    if (act.type === 'walk') {
      const target = pointById(scene, act.to);
      if (!target) return fail(REASONS.BAD_TARGET, i);
      const step = { index: i, type: 'walk', action: act, from: { ...char }, to: { ...target }, segments: [], notes: [] };
      const total = dist(char, target);
      const dur = total / scene.walkSpeed;
      // 按与路径的交点远近排序途经门
      const doors = (act.waitForDoor ?? [])
        .map((id) => doorById(scene, id))
        .filter(Boolean)
        .map((d) => ({ d, along: dist(char, d) }))
        .sort((a, b) => a.along - b.along);

      let segStart = t;
      let pos = { ...char };
      for (const { d } of doors) {
        const reach = snap(t + dist(pos, d) / scene.walkSpeed);
        step.segments.push({ kind: 'walk', from: { ...pos }, to: { ...d }, t0: t, t1: reach });
        t = reach; pos = { ...d };
        const st = doorState(d, t);
        if (!st.open) {
          if (!act.allowWait) {
            step.endAt = t;
            step.ok = false;
            return fail(REASONS.DOOR_CLOSED, i, t, step);
          }
          const win = nextOpen(d, t + EPS);
          if (win.start >= deadline - EPS) {
            step.endAt = t;
            return fail(REASONS.DOOR_TIMEOUT, i, t, step);
          }
          step.segments.push({ kind: 'wait', at: { ...d }, t0: t, t1: win.start, doorId: d.id });
          step.notes.push(`${d.name}：${fmt(t)} 到达时已关，等至 ${fmt(win.start)} 开门`);
          t = win.start; // 半开区间：开门瞬间可过
        }
      }
      const arrive = snap(t + dist(pos, target) / scene.walkSpeed);
      step.segments.push({ kind: 'walk', from: { ...pos }, to: { ...target }, t0: t, t1: arrive });
      t = arrive; char = { ...target };
      step.endAt = t; step.duration = snap(t - segStart); step.ok = true;
      pushStep(step, {});
      if (t > deadline + EPS) return fail(REASONS.HORIZON, i, t);
      continue;
    }

    if (act.type === 'wait') {
      const wp = pointById(scene, act.point);
      if (!wp) return fail(REASONS.BAD_TARGET, i);
      const duration = Math.max(0, act.duration ?? 0);
      const end = snap(t + duration);
      pushStep({
        index: i, type: 'wait', action: act, at: { ...wp },
        segments: [{ kind: 'wait', at: { ...wp }, t0: t, t1: end }],
        duration, endAt: end, ok: true,
        notes: duration > 0 ? [`在 ${wp.name} 等待 ${duration.toFixed(1)}s`] : [`在 ${wp.name} 不停留`],
      });
      t = end; char = { ...wp };
      if (t > deadline + EPS) return fail(REASONS.HORIZON, i, t);
      continue;
    }

    if (act.type === 'ride') {
      const plat = platformById(scene, act.platform);
      const target = pointById(scene, act.to);
      if (!plat || !target) return fail(REASONS.BAD_TARGET, i);
      const step = { index: i, type: 'ride', action: act, platform: plat, segments: [], notes: [] };

      // 1) 走到本端停靠点
      const fromSide = act.side === 'B' ? 'B' : 'A';
      const toSide = fromSide === 'A' ? 'B' : 'A';
      const dockFrom = sidePoint(plat, fromSide);
      const walkEnd = snap(t + dist(char, dockFrom) / scene.walkSpeed);
      step.segments.push({ kind: 'walk', from: { ...char }, to: { ...dockFrom }, t0: t, t1: walkEnd });
      t = walkEnd;

      // 2) 等本端停靠（停靠为 [start,end)，末端时刻到达算错过）
      const current = sideDwellContaining(plat, fromSide, t);
      if (current) {
        // 已在停靠窗口内，立即登乘
        step.notes.push(`${fmt(t)} 登上 ${plat.name}（${fromSide} 端停靠中）`);
      } else {
        // 最近一个本端停靠窗口；只有「恰好在离站末端到达」才判错过，
        // 晚于末端到达则继续等下一停靠班次
        const justMissed = sideDwellBefore(plat, fromSide, t);
        if (justMissed && Math.abs(t - justMissed.end) <= EPS) {
          step.endAt = t;
          return fail(REASONS.PLATFORM_MISSED, i, t, step);
        }
        const dockWin = sideDwell(plat, fromSide, t);
        if (dockWin.start >= deadline - EPS) {
          step.endAt = t;
          return fail(REASONS.NO_RIDE_DWELL, i, t, step);
        }
        step.segments.push({ kind: 'wait', at: { ...dockFrom }, t0: t, t1: dockWin.start, platformId: plat.id });
        step.notes.push(`${plat.name}：等至 ${fmt(dockWin.start)} 靠站`);
        t = dockWin.start;
      }
      const boardAt = t;
      step.boardAt = boardAt;
      if (!current) step.notes.push(`${fmt(boardAt)} 登上 ${plat.name}（${fromSide} 端）`);

      // 3) 随平台移动到对端
      const arriveDock = sideDwell(plat, toSide, boardAt + EPS);
      if (arriveDock.start >= deadline - EPS) {
        step.endAt = t;
        return fail(REASONS.RIDE_TIMEOUT, i, t, step);
      }
      step.segments.push({
        kind: 'ride', platform: plat, fromSide, toSide,
        t0: boardAt, t1: arriveDock.start,
      });
      t = snap(arriveDock.start);

      // 4) 在对端停靠窗口内下车并走到目标点（末端离站即失败）
      if (t >= arriveDock.end - EPS) {
        step.endAt = t;
        return fail(REASONS.EXIT_MISSED, i, t, step);
      }
      const exitEnd = snap(t + dist(sidePoint(plat, toSide), target) / scene.walkSpeed);
      if (exitEnd > arriveDock.end + EPS) {
        step.endAt = t;
        return fail(REASONS.EXIT_MISSED, i, t, step);
      }
      step.segments.push({ kind: 'walk', from: sidePoint(plat, toSide), to: { ...target }, t0: t, t1: exitEnd });
      step.notes.push(`${fmt(t)} 抵达 ${toSide} 端，${fmt(exitEnd)} 下车到 ${target.name}`);
      t = exitEnd; char = { ...target };
      step.endAt = t; step.ok = true; step.duration = snap(t - walkEnd);
      pushStep(step, {});
      if (t > deadline + EPS) return fail(REASONS.HORIZON, i, t);
      continue;
    }

    return fail(REASONS.BAD_TARGET, i);
  }

  const result = {
    ok: true, reason: REASONS.SUCCESS, failStep: -1, failAt: null,
    tEnd: snap(t), steps, horizon, t0: snap(t0),
  };
  result.charAt = makeCharAt(startPoint, steps);
  return result;

  function fail(reason, failStep, failAt = t, partialSteps = null) {
    const finalSteps = partialSteps ? (Array.isArray(partialSteps) ? partialSteps : [...steps, partialSteps]) : steps;
    const r = {
      ok: false, reason, failStep, failAt: snap(failAt),
      tEnd: snap(failAt), steps: finalSteps, horizon, t0: snap(t0),
    };
    r.charAt = makeCharAt(startPoint, r.steps);
    return r;
  }
}

function sidePoint(plat, side) {
  return side === 'B' ? { x: plat.bx, y: plat.by } : { x: plat.ax, y: plat.ay };
}

// 指定端（A/B）>= t 的下一个停靠区间；t 恰等于窗口末端时跳到下一周期
function sideDwell(plat, side, t) {
  const w = sideDwellContaining(plat, side, t);
  if (w) return w;
  const a = phaseAnchors(plat);
  const anchor = side === 'B' ? a.bStart : a.aStart;
  const dwell = side === 'B' ? (plat.dwellB ?? 0) : (plat.dwellA ?? 0);
  const k = Math.floor((t - anchor) / plat.period);
  let start = anchor + k * plat.period;
  if (start < t - EPS) start += plat.period;
  return { start: snap(start), end: snap(start + dwell) };
}

// 若 t 落在某停靠窗口 [start,end) 内则返回该窗口，否则 null
function sideDwellContaining(plat, side, t) {
  const a = phaseAnchors(plat);
  const anchor = side === 'B' ? a.bStart : a.aStart;
  const dwell = side === 'B' ? (plat.dwellB ?? 0) : (plat.dwellA ?? 0);
  const k = Math.floor((t - anchor) / plat.period);
  const start = anchor + k * plat.period;
  if (t >= start - EPS && t < start + dwell - EPS) {
    return { start: snap(start), end: snap(start + dwell) };
  }
  return null;
}

// t 所在周期的同端停靠窗口（不判断是否在窗口内），用于判断「刚好离站」
function sideDwellBefore(plat, side, t) {
  const a = phaseAnchors(plat);
  const anchor = side === 'B' ? a.bStart : a.aStart;
  const dwell = side === 'B' ? (plat.dwellB ?? 0) : (plat.dwellA ?? 0);
  const k = Math.floor((t - anchor) / plat.period);
  const start = anchor + k * plat.period;
  return { start: snap(start), end: snap(start + dwell) };
}

// 由步骤分段构造 charAt(t)：角色在任意时刻的位置（用于拖时间轴回放）
function makeCharAt(startPoint, steps) {
  const segs = [];
  for (const s of steps) {
    for (const seg of s.segments ?? []) segs.push(seg);
  }
  return function charAt(t) {
    if (!segs.length || t <= segs[0].t0 + EPS) return { ...startPoint, state: segs.length ? 'idle' : 'done' };
    for (const seg of segs) {
      if (t < seg.t0 - EPS) continue;
      if (seg.kind === 'wait') {
        if (t < seg.t1 - EPS) return { ...seg.at, state: 'wait' };
        continue;
      }
      if (t >= seg.t1 - EPS) continue;
      const f = (t - seg.t0) / Math.max(EPS, seg.t1 - seg.t0);
      if (seg.kind === 'ride') {
        const p = seg.platform;
        const pos = platformPos(p, t); // 车上：直接取平台实时位置，保证与画面一致
        return { x: pos.x, y: pos.y, state: 'ride' };
      }
      return { ...lerpPt(seg.from, seg.to, f), state: 'walk' };
    }
    const last = segs[segs.length - 1];
    return { ...(last.to ?? last.at), state: 'done' };
  };
}

// ---------- 批量试跑 ----------
// 在 [0, superPeriod) 内以 step 为采样间隔扫描全部出发时点
export function sweep(scene, actions, opts = {}) {
  const step = opts.step ?? 0.1;
  const horizon = opts.horizon ?? 120;
  const T = superPeriod(scene);
  const n = Math.max(1, Math.round(T / step));
  const samples = [];
  const failMap = new Map(); // reason -> {count, earliest:{t0,step,at}}

  for (let k = 0; k < n; k++) {
    const t0 = snap(k * T / n);
    const r = simulateRoute(scene, actions, t0, horizon);
    samples.push({ t0, ok: r.ok, reason: r.reason, failStep: r.failStep, failAt: r.failAt });
    if (!r.ok) {
      const cur = failMap.get(r.reason) ?? { count: 0, earliest: null };
      cur.count++;
      if (!cur.earliest || r.failAt < cur.earliest.at) {
        cur.earliest = { t0, step: r.failStep, at: r.failAt };
      }
      failMap.set(r.reason, cur);
    }
  }

  // 聚合成败窗口，并在边界处二分细化到 EPS 精度
  const windows = [];
  let runStart = null;
  for (let k = 0; k <= n; k++) {
    const ok = k < n && samples[k].ok;
    if (ok && runStart === null) runStart = k;
    if (!ok && runStart !== null) {
      windows.push(refineWindow(scene, actions, horizon, T, n, runStart, k - 1));
      runStart = null;
    }
  }
  const failures = [...failMap.entries()].map(([reason, v]) => ({ reason, ...v }));
  return {
    T, n, step: T / n, samples, windows, failures, horizon,
    successCount: samples.filter((s) => s.ok).length,
  };
}

function refineWindow(scene, actions, horizon, T, n, i0, i1) {
  const grid = T / n;
  const okAt = (t0) => simulateRoute(scene, actions, snap(t0), horizon).ok;
  // 左边界：窗口首个成功时点（首格窗口向左只能探到 0）
  let lo, hi;
  if (i0 === 0) {
    lo = 0; hi = 0;
  } else {
    lo = (i0 - 1) * grid; hi = i0 * grid;
    for (let it = 0; it < 45; it++) {
      const mid = (lo + hi) / 2;
      if (okAt(mid)) hi = mid; else lo = mid;
    }
  }
  const start = snap(hi);
  // 右边界：窗口最后成功时点（半开，end 本身已失败）；末格窗口向右只能到 T
  if (i1 === n - 1) {
    lo = T; hi = T;
  } else {
    lo = i1 * grid; hi = (i1 + 1) * grid;
    for (let it = 0; it < 45; it++) {
      const mid = (lo + hi) / 2;
      if (okAt(mid)) lo = mid; else hi = mid;
    }
  }
  const end = snap(hi);
  return { start, end, wraps: false };
}

// ---------- 锁路线后的结果对比 ----------
// base / cur 为两次 sweep 结果（同一采样网格），按样本逐格比较
export function diffSweeps(base, cur) {
  const n = Math.min(base.n, cur.n);
  const T = Math.min(base.T, cur.T);
  const grid = T / n;
  const tags = new Array(n).fill('same');
  for (let k = 0; k < n; k++) {
    const a = base.samples[k].ok, b = cur.samples[k].ok;
    if (a === b) tags[k] = 'same';
    else if (a && !b) tags[k] = 'lost';   // 原本能走通 -> 失败
    else tags[k] = 'gained';              // 原本失败 -> 救回
  }
  const runs = [];
  let run = null;
  for (let k = 0; k <= n; k++) {
    const tag = k < n ? tags[k] : 'end';
    if ((tag === 'lost' || tag === 'gained') && (!run || run.tag !== tag)) {
      if (run) runs.push(run);
      run = { tag, startIdx: k, endIdx: k };
    } else if (run && run.tag === tag) {
      run.endIdx = k;
    } else if (tag === 'same' && run) {
      runs.push(run); run = null;
    }
  }
  const segments = runs.map((r) => ({
    tag: r.tag,
    start: snap(r.startIdx * grid),
    end: snap((r.endIdx + 1) * grid),
  }));
  return {
    tags,
    segments,
    lost: segments.filter((s) => s.tag === 'lost'),
    gained: segments.filter((s) => s.tag === 'gained'),
  };
}

// ---------- 确定性自检：同一瞬间反复求值必须完全一致 ----------
export function consistencyCheck(scene, actions, t0, horizon = 120) {
  const r1 = simulateRoute(scene, actions, t0, horizon);
  const probes = [];
  for (let k = 0; k <= 20; k++) probes.push(snap(t0 + (r1.tEnd - t0) * k / 20));
  const rows = [];
  for (const t of probes) {
    const a = snapshot(scene, r1, t);
    const r2 = simulateRoute(scene, actions, t0, horizon); // 重算一遍
    const b = snapshot(scene, r2, t);
    rows.push({ t, equal: JSON.stringify(a) === JSON.stringify(b), a, b });
  }
  return { ok: rows.every((r) => r.equal), rows };
}

function snapshot(scene, result, t) {
  return {
    char: result.charAt(t),
    platforms: scene.platforms.map((p) => platformPos(p, t)),
    doors: scene.doors.map((d) => doorState(d, t)),
  };
}

export function fmt(t) {
  return `${Number(t).toFixed(1)}s`;
}
