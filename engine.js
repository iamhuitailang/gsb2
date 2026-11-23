/* =========================================================================
 * 视野规则引擎（纯逻辑，不依赖 DOM，可在 Node 中直接测试）
 *
 * 核心模型：
 *  - 格子类型：普通地板 / 墙 / 门（open 全开 | half 半开 | closed 关闭）
 *      open   ：可通过，不挡视线
 *      half   ：可挤过，但阻挡视线
 *      closed ：不可通过，阻挡视线
 *  - 每个阵营各自维护：
 *      memory    每格记忆：visible 当前可见 / remembered 以前见过 / unknown 从未见过
 *      knowledge 对敌方单位与可搬动物件（箱子）的最后已知信息
 *  - 同队多名角色的视野取并集；并记录当前是“谁”看得见每一格
 *  - 视线用网格 DDA 射线步进：射线穿过的中间阻挡格即遮挡；
 *    对角线同时碰角时保守判定为遮挡（不产生墙角漏光）
 *  - 每一步固定按三个阶段结算：移动 -> 门 -> 视野（顺序固定，保证可重放）
 * ========================================================================= */

const TEAMS = ['A', 'B'];

const K = (x, y) => x + ',' + y;
const parseK = (k) => k.split(',').map(Number);

/* ----------------------------- 场景定义 ----------------------------- */

/* 场景里用 paths 描述每个单位/箱子的逐格路径，引擎编译成有序移动事件；
   doorScript 描述每一步的门状态变化；label 是该步的人工说明。 */

const SCENARIOS = [
  {
    id: 'cross',
    name: '两队交叉',
    desc: '蓝红两队隔内墙巡逻，在唯一的门口附近互相发现；半开门会切断南侧通道的视线。',
    w: 16, h: 12, range: 5,
    walls: [
      // 外墙
      ...borderWalls(16, 12),
      // 纵向内墙 x=7，门在 (7,5)
      [7, 1], [7, 2], [7, 3], [7, 4], [7, 6], [7, 7], [7, 8], [7, 9],
      // 横向内墙 y=8，门在 (10,8)
      [2, 8], [3, 8], [4, 8], [5, 8], [6, 8],
      [8, 8], [9, 8], [11, 8], [12, 8], [13, 8],
    ],
    doors: [
      { x: 7, y: 5, state: 'open' },
      { x: 10, y: 8, state: 'open' },
    ],
    units: [
      { id: 'A1', team: 'A', x: 2, y: 2 },
      { id: 'A2', team: 'A', x: 3, y: 10 },
      { id: 'B1', team: 'B', x: 13, y: 3 },
      { id: 'B2', team: 'B', x: 12, y: 10 },
    ],
    crates: [{ id: 'C1', x: 8, y: 7 }],
    paths: {
      A1: [[3, 2], [4, 2], [5, 2], [6, 2], [6, 3], [6, 4], [6, 5], [7, 5], [8, 5]],
      B1: [[12, 3], [11, 3], [10, 3], [9, 3], [9, 4], [9, 5], [8, 5], [8, 6]],
      A2: [[4, 10], [5, 10], [6, 10], [7, 10], [8, 10], [9, 10], [10, 10], [10, 9]],
      B2: [[11, 10], [10, 10], [10, 9], [9, 9], [9, 10], [10, 10], [11, 10], [11, 9]],
      C1: [[9, 7], [9, 6], [9, 5], [8, 5], [8, 6], [8, 7], [8, 6], [8, 5]],
    },
    doorScript: {
      4: [{ x: 10, y: 8, state: 'half' }],
      6: [{ x: 10, y: 8, state: 'open' }],
    },
    labels: {
      4: '南门变为半开：挡视线但仍可通过',
      6: '南门重新全开',
      7: 'A1 与 B1 隔门互相发现（门全开，视线贯通）',
    },
  },
  {
    id: 'door-close',
    name: '门闭合',
    desc: 'A1 穿过全开的门（移动阶段先刷新门格记忆），下一步门关闭，视野阶段按关闭后的门结算遮挡。',
    w: 12, h: 10, range: 5,
    walls: [
      ...borderWalls(12, 10),
      [6, 1], [6, 2], [6, 3], [6, 5], [6, 6], [6, 7], [6, 8],
    ],
    doors: [{ x: 6, y: 4, state: 'open' }],
    units: [
      { id: 'A1', team: 'A', x: 2, y: 4 },
      { id: 'A2', team: 'A', x: 2, y: 7 },
      { id: 'B1', team: 'B', x: 9, y: 2 },
      { id: 'B2', team: 'B', x: 9, y: 8 },
    ],
    crates: [
      { id: 'C1', x: 8, y: 5 },
      { id: 'C2', x: 3, y: 2 },
    ],
    paths: {
      A1: [[3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4]],
      A2: [[3, 7], [4, 7], [5, 7], [5, 6], [5, 5], [5, 6]],
      B1: [[8, 2], [8, 3], [8, 4], [8, 3], [8, 2], [9, 2]],
      B2: [[8, 8], [9, 8], [9, 7], [8, 7], [8, 8], [9, 8]],
      C1: [[7, 5], [7, 6], [7, 7], [8, 7], [8, 6], [8, 5]],
      C2: [[4, 2], [5, 2], [5, 3], [4, 3], [3, 3], [3, 2]],
    },
    doorScript: {
      5: [{ x: 6, y: 4, state: 'closed' }],
    },
    labels: {
      4: 'A1 在移动阶段穿过全开的门，门格留下移动刷新痕迹',
      5: '门阶段关闭门；视野阶段按关闭后的门重新结算遮挡',
      6: 'A2 对门和 C1 的记忆停留在关闭前（过期信息）',
    },
  },
  {
    id: 'handoff',
    name: '队友交接视野',
    desc: 'B1 绕中央墙柱穿过缺口：A1 失去视线时 A2 正好接上，同队视野合并使该格始终是“当前可见”。',
    w: 14, h: 10, range: 5,
    walls: [
      ...borderWalls(14, 10),
      [6, 2], [6, 3], [6, 4], [6, 6], [6, 7], [6, 8],
    ],
    doors: [],
    units: [
      { id: 'A1', team: 'A', x: 2, y: 4 },
      { id: 'A2', team: 'A', x: 10, y: 4 },
      { id: 'B1', team: 'B', x: 2, y: 7 },
      { id: 'B2', team: 'B', x: 11, y: 8 },
    ],
    crates: [{ id: 'C1', x: 2, y: 2 }],
    paths: {
      B1: [[3, 7], [4, 7], [5, 7], [5, 6], [5, 5], [6, 5], [7, 5], [8, 5]],
      A1: [[3, 4], [3, 3], [2, 3], [2, 4], [3, 4], [3, 5], [4, 5], [5, 5]],
      A2: [[9, 4], [8, 4], [7, 4], [7, 5], [8, 5], [8, 4], [9, 4], [10, 4]],
      B2: [[10, 8], [9, 8], [9, 7], [10, 7], [11, 7], [11, 8], [10, 8], [9, 8]],
      C1: [[3, 2], [4, 2], [5, 2], [5, 3], [4, 3], [3, 3], [3, 2], [2, 2]],
    },
    doorScript: {},
    labels: {
      5: 'B1 进入墙柱缺口，观察者由 A1 交接给 A2',
      6: 'B1 已在墙东侧：A1 完全被挡，A2 持续可见',
    },
  },
  {
    id: 'occlusion',
    name: '半开门与墙角遮挡',
    desc: '专用小图：L 形墙展示墙角漏光规则，右侧门在 全开/半开/关闭 之间循环，点格可追查遮挡来源。',
    w: 13, h: 9, range: 5,
    walls: [
      ...borderWalls(13, 9),
      [4, 2], [4, 3], [4, 4], [5, 4], [6, 4],
      [9, 1], [9, 2], [9, 3], [9, 5], [9, 6], [9, 7],
    ],
    doors: [{ x: 9, y: 4, state: 'open' }],
    units: [
      { id: 'A1', team: 'A', x: 2, y: 4 },
      { id: 'A2', team: 'A', x: 2, y: 6 },
      { id: 'B1', team: 'B', x: 11, y: 4 },
      { id: 'B2', team: 'B', x: 11, y: 6 },
    ],
    crates: [{ id: 'C1', x: 11, y: 2 }],
    paths: {
      A1: [[3, 4], [3, 3], [3, 2], [2, 2], [2, 3], [2, 4]],
      A2: [[3, 6], [3, 7], [2, 7], [2, 6], [3, 6], [3, 7]],
      B1: [[10, 4], [10, 3], [10, 2], [11, 2], [11, 3], [10, 3]],
      B2: [[10, 6], [10, 7], [11, 7], [11, 6], [10, 6], [10, 7]],
      C1: [[10, 2], [10, 3], [11, 3], [11, 2], [11, 3], [10, 3]],
    },
    doorScript: {
      1: [{ x: 9, y: 4, state: 'half' }],
      2: [{ x: 9, y: 4, state: 'closed' }],
      4: [{ x: 9, y: 4, state: 'open' }],
      6: [{ x: 9, y: 4, state: 'half' }],
    },
    labels: {
      1: '门变为半开：视线立即被切断，单位仍可贴近门口',
      2: '门关闭',
      4: '门重新全开，两侧视野贯通',
      6: '再次半开',
    },
  },
];

function borderWalls(w, h) {
  const cells = [];
  for (let x = 0; x < w; x++) { cells.push([x, 0], [x, h - 1]); }
  for (let y = 1; y < h - 1; y++) { cells.push([0, y], [w - 1, y]); }
  return cells;
}

/* 把路径编译成逐步事件脚本（移动按 id 排序，保证确定性） */
function compileScenario(sc) {
  const start = {};
  sc.units.forEach(u => { start[u.id] = [u.x, u.y]; });
  sc.crates.forEach(c => { start[c.id] = [c.x, c.y]; });
  const pathLen = Math.max(0, ...Object.values(sc.paths).map(p => p.length));
  const doorLen = Math.max(-1, ...Object.keys(sc.doorScript).map(Number));
  const total = Math.max(pathLen, doorLen);
  const steps = [];
  for (let i = 0; i < total; i++) {
    const moves = [];
    for (const id of Object.keys(sc.paths).sort()) {
      const path = sc.paths[id];
      if (i < path.length) {
        const prev = i === 0 ? start[id] : path[i - 1];
        moves.push({ id, dx: path[i][0] - prev[0], dy: path[i][1] - prev[1] });
      }
    }
    steps.push({
      moves,
      // doorScript 的键是“1 基步号”（与 labels 一致），这里换算成脚本下标
      doors: (sc.doorScript[i + 1] || []).map(d => ({ ...d })),
      label: (sc.labels && sc.labels[i + 1]) || '',
    });
  }
  return steps;
}

/* ----------------------------- 状态构造 ----------------------------- */

function createState(sc, opts = {}) {
  const walls = new Set(sc.walls.map(([x, y]) => K(x, y)));
  const doors = new Map(sc.doors.map(d => [K(d.x, d.y), { state: d.state }]));
  const units = sc.units.map(u => ({ id: u.id, team: u.team, x: u.x, y: u.y }));
  const crates = sc.crates.map(c => ({ id: c.id, x: c.x, y: c.y }));
  const state = {
    scenarioId: sc.id,
    w: sc.w, h: sc.h, range: sc.range,
    walls, doors, units, crates,
    step: 0,
    script: compileScenario(sc),
    logs: [],
    teams: {},
  };
  for (const team of TEAMS) {
    state.teams[team] = {
      fov: new Set(),
      fovDetail: new Map(),   // cellKey -> 当前看见该格的本队单位 id
      memory: new Map(),      // cellKey -> 记忆条目
      knowledge: new Map(),   // 实体 id -> 最后已知信息
      retention: opts.retention !== false,
    };
  }
  // 第 0 步先结算一次初始视野
  refreshVision(state);
  return state;
}

function findEntity(state, id) {
  return state.units.find(u => u.id === id) || state.crates.find(c => c.id === id);
}

function allEntities(state) {
  return [...state.units, ...state.crates];
}

function inBounds(state, x, y) {
  return x >= 0 && y >= 0 && x < state.w && y < state.h;
}

function truthType(state, x, y) {
  const k = K(x, y);
  if (state.walls.has(k)) return 'wall';
  const d = state.doors.get(k);
  if (d) return 'door:' + d.state;
  return 'floor';
}

/* ----------------------------- 视线 DDA ----------------------------- */

/* 从 (ox,oy) 格中心到 (tx,ty) 格中心做网格射线步进。
   返回 {blocked, reason, cell}；目标格本身若是墙/门，视为“看得见其表面”，不挡。 */
function losTrace(state, ox, oy, tx, ty) {
  if (ox === tx && oy === ty) return { blocked: false, reason: null, cell: null };
  const dx = tx - ox, dy = ty - oy;
  const stepX = Math.sign(dx), stepY = Math.sign(dy);
  let tMaxX = stepX === 0 ? Infinity : 0.5 / Math.abs(dx);
  let tMaxY = stepY === 0 ? Infinity : 0.5 / Math.abs(dy);
  const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dy);
  let cx = ox, cy = oy;
  while (cx !== tx || cy !== ty) {
    if (tMaxX < tMaxY) {
      cx += stepX; tMaxX += tDeltaX;
    } else if (tMaxY < tMaxX) {
      cy += stepY; tMaxY += tDeltaY;
    } else {
      // 对角线同时撞角：两格都进入，任一阻挡即遮挡（保守，防墙角漏光）
      cx += stepX; cy += stepY;
      tMaxX += tDeltaX; tMaxY += tDeltaY;
    }
    if (cx === tx && cy === ty) return { blocked: false, reason: null, cell: null };
    if (!inBounds(state, cx, cy)) return { blocked: true, reason: 'edge', cell: [cx, cy] };
    const k = K(cx, cy);
    if (state.walls.has(k)) return { blocked: true, reason: 'wall', cell: [cx, cy] };
    const d = state.doors.get(k);
    if (d && d.state !== 'open') {
      return { blocked: true, reason: 'door:' + d.state, cell: [cx, cy] };
    }
  }
  return { blocked: false, reason: null, cell: null };
}

function unitFOV(state, unit) {
  const vis = new Set([K(unit.x, unit.y)]);
  const r = state.range;
  for (let y = Math.max(0, unit.y - r); y <= Math.min(state.h - 1, unit.y + r); y++) {
    for (let x = Math.max(0, unit.x - r); x <= Math.min(state.w - 1, unit.x + r); x++) {
      const ed = Math.hypot(x - unit.x, y - unit.y);
      if (ed > r + 1e-9) continue;
      const trace = losTrace(state, unit.x, unit.y, x, y);
      if (!trace.blocked) vis.add(K(x, y));
    }
  }
  return vis;
}

/* 计算某阵营的合并视野及每格观察者 */
function computeTeamVision(state, team) {
  const fov = new Set();
  const detail = new Map();
  for (const u of state.units.filter(u => u.team === team)) {
    const v = unitFOV(state, u);
    for (const k of v) {
      fov.add(k);
      if (!detail.has(k)) detail.set(k, []);
      detail.get(k).push(u.id);
    }
  }
  return { fov, detail };
}

/* ----------------------------- 记忆与知识 ----------------------------- */

function refreshVision(state) {
  const stepNo = state.step;
  for (const team of TEAMS) {
    const tm = state.teams[team];
    const { fov, detail } = computeTeamVision(state, team);
    tm.fov = fov;
    tm.fovDetail = detail;

    for (const k of fov) {
      const [x, y] = parseK(k);
      const prev = tm.memory.get(k);
      tm.memory.set(k, {
        state: 'visible',
        observedType: truthType(state, x, y),
        lastStep: stepNo,
        lastPhase: 'vision',
        moveRefreshStep: prev ? prev.moveRefreshStep : null,
        seenByNow: detail.get(k).slice(),
        lastSeenBy: detail.get(k).slice(),
      });
    }
    // 这一轮没进合并视野的旧可见格 -> 降为“以前见过”，并清空当前观察者
    for (const [k, m] of tm.memory) {
      if (m.state === 'visible' && !fov.has(k)) {
        m.state = 'remembered';
        m.seenByNow = [];
      }
    }

    // 实体知识：只在“当前确实看得见所在格”时更新，暗处移动绝不同步
    for (const e of allEntities(state)) {
      if (e.team === team) continue;
      const k = K(e.x, e.y);
      if (fov.has(k)) {
        tm.knowledge.set(e.id, {
          id: e.id,
          kind: e.team ? 'unit' : 'crate',
          team: e.team || null,
          pos: [e.x, e.y],
          lastStep: stepNo,
          lastPhase: 'vision',
          seenBy: detail.get(k).slice(),
          currentlyVisible: true,
        });
      } else if (tm.knowledge.has(e.id)) {
        if (tm.retention) {
          tm.knowledge.get(e.id).currentlyVisible = false;
        } else {
          tm.knowledge.delete(e.id);
        }
      }
    }
  }
}

/* ----------------------------- 逐步结算 ----------------------------- */

/* 固定顺序：1 移动（按事件序）-> 2 门状态（按事件序）-> 3 双方视野结算 */
function applyStep(state, ev) {
  state.step += 1;
  const stepNo = state.step;
  const entry = { step: stepNo, label: ev.label || '', events: [], fovSnapshot: {} };

  // 阶段 1：移动。单位途经格在“移动阶段”立即留下记忆刷新痕迹
  for (const m of ev.moves) {
    const e = findEntity(state, m.id);
    const from = [e.x, e.y];
    e.x += m.dx;
    e.y += m.dy;
    if (e.team) {
      const tm = state.teams[e.team];
      const k = K(e.x, e.y);
      tm.memory.set(k, {
        state: 'visible',
        observedType: truthType(state, e.x, e.y),
        lastStep: stepNo,
        lastPhase: 'move',
        moveRefreshStep: stepNo, // 记录最后一次“移动阶段”途经；视野阶段若再看见会保留它
        seenByNow: [e.id],
        lastSeenBy: [e.id],
      });
    }
    entry.events.push({
      phase: 'move',
      id: m.id,
      from,
      to: [e.x, e.y],
      text: `移动阶段：${m.id} ${from.join(',')} → ${e.x},${e.y}` +
        (e.team ? '，途经格在移动阶段刷新记忆' : '（箱子不产生阵营记忆）'),
    });
  }

  // 阶段 2：门开合
  for (const d of ev.doors) {
    const door = state.doors.get(K(d.x, d.y));
    const fromState = door.state;
    door.state = d.state;
    entry.events.push({
      phase: 'door',
      x: d.x, y: d.y,
      from: fromState, to: d.state,
      text: `门阶段：门 ${d.x},${d.y} ${fromState} → ${d.state}`,
    });
  }

  // 阶段 3：双方按结算后的世界刷新视野（门关闭效果在本阶段才体现）
  refreshVision(state);
  for (const team of TEAMS) {
    entry.fovSnapshot[team] = [...state.teams[team].fov].sort();
  }
  entry.events.push({
    phase: 'vision',
    text: '视野阶段：双方按移动后位置与门的最终状态重新结算合并视野、记忆与实体知识',
  });

  state.logs.push(entry);
  return entry;
}

/* 从头重放到第 upTo 步（含），用于回退与确定性校验 */
function replay(scenario, upTo, opts = {}) {
  const s = createState(scenario, opts);
  for (let i = 0; i < upTo && i < s.script.length; i++) applyStep(s, s.script[i]);
  return s;
}

/* ----------------------------- 选格追查 ----------------------------- */

function inspectCell(state, x, y) {
  const k = K(x, y);
  const occupants = [
    ...state.units.filter(u => u.x === x && u.y === y).map(u => ({ id: u.id, kind: 'unit', team: u.team })),
    ...state.crates.filter(c => c.x === x && c.y === y).map(c => ({ id: c.id, kind: 'crate' })),
  ];
  const result = {
    x, y,
    truth: truthType(state, x, y),
    occupants,
    teams: {},
  };
  for (const team of TEAMS) {
    const tm = state.teams[team];
    const mem = tm.memory.get(k);
    const diagnosis = [];
    for (const u of state.units.filter(u => u.team === team)) {
      const dist = Math.hypot(x - u.x, y - u.y);
      if (dist > state.range + 1e-9) {
        diagnosis.push({ unit: u.id, from: [u.x, u.y], dist: Number(dist.toFixed(2)), blocked: true, reason: 'range' });
        continue;
      }
      const trace = losTrace(state, u.x, u.y, x, y);
      diagnosis.push({
        unit: u.id, from: [u.x, u.y], dist: Number(dist.toFixed(2)),
        blocked: trace.blocked, reason: trace.reason, blockerCell: trace.cell,
      });
    }
    const ghosts = [];
    for (const [, kn] of tm.knowledge) {
      if (kn.pos[0] === x && kn.pos[1] === y && !tm.fov.has(k)) {
        const live = findEntity(state, kn.id);
        ghosts.push({ id: kn.id, rememberedAt: kn.pos, lastStep: kn.lastStep, livePos: [live.x, live.y] });
      }
    }
    result.teams[team] = { memory: mem || null, diagnosis, ghosts };
  }
  return result;
}

/* ----------------------------- 导出 ----------------------------- */

function exportTeamView(state, team) {
  const tm = state.teams[team];
  const cells = [];
  for (let y = 0; y < state.h; y++) {
    for (let x = 0; x < state.w; x++) {
      const m = tm.memory.get(K(x, y));
      if (!m) {
        cells.push({ x, y, state: 'unknown' }); // 从未见过：不含任何地形信息
      } else {
        cells.push({
          x, y,
          state: m.state,
          observedType: m.observedType,
          lastStep: m.lastStep,
          lastPhase: m.lastPhase,
          moveRefreshStep: m.moveRefreshStep,
          seenByNow: m.seenByNow,
          lastSeenBy: m.lastSeenBy,
        });
      }
    }
  }
  const entities = [];
  for (const [, kn] of tm.knowledge) {
    const live = findEntity(state, kn.id);
    entities.push({
      id: kn.id, kind: kn.kind, team: kn.team,
      lastKnownPos: kn.pos,
      lastStep: kn.lastStep,
      currentlyVisible: !!live && live.x === kn.pos[0] && live.y === kn.pos[1] && tm.fov.has(K(kn.pos[0], kn.pos[1])),
      // 注意：刻意不导出 livePos —— 真实当前位置是该阵营无权知道的信息
    });
  }
  return {
    viewOf: team,
    scenarioId: state.scenarioId,
    step: state.step,
    retention: tm.retention,
    cells,
    knownEntities: entities,
  };
}

function exportStepRecord(state) {
  return {
    scenarioId: state.scenarioId,
    totalSteps: state.script.length,
    currentStep: state.step,
    range: state.range,
    steps: state.logs.map(l => ({
      step: l.step,
      label: l.label,
      events: l.events,
      fovSnapshot: l.fovSnapshot,
    })),
  };
}

/* 规范化序列化（键排序）后做 FNV-1a 哈希，用于重放确定性校验 */
function stableStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, value) => {
    if (value instanceof Map) {
      return { __map: true, entries: [...value.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))) };
    }
    if (value instanceof Set) return { __set: true, values: [...value].sort() };
    if (value && typeof value === 'object') {
      if (seen.has(value)) return { __cycle: true };
      seen.add(value);
      if (Array.isArray(value)) return value;
      const sorted = {};
      for (const k of Object.keys(value).sort()) sorted[k] = value[k];
      return sorted;
    }
    return value;
  }, 2);
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function stateHash(state) {
  return fnv1a(stableStringify({
    step: state.step,
    doors: state.doors,
    units: state.units,
    crates: state.crates,
    teams: state.teams,
  }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCENARIOS, compileScenario, createState, applyStep, replay,
    losTrace, unitFOV, computeTeamVision, inspectCell,
    exportTeamView, exportStepRecord, stableStringify, stateHash, fnv1a,
    K, parseK,
  };
}
