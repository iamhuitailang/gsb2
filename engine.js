/*
 * 检查点重生规则引擎（纯逻辑，无 DOM 依赖）
 * 浏览器中挂到 window.GEngine，Node 中通过 module.exports 导出。
 *
 * 三类保留策略（每个有状态对象独立配置）：
 *   keep       本局一直保留：死亡/重生不动它
 *   checkpoint 恢复到最近检查点：取该检查点启用瞬间记录的快照
 *   init       每次回到起始状态
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.GEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TILE = { WALL: '#', FLOOR: '.', PIT: 'P', LAVA: 'L', SPIKE: 'S' };
  const POLICY = { KEEP: 'keep', CHECKPOINT: 'checkpoint', INIT: 'init' };
  const POLICY_LABEL = {
    keep: '本局一直保留',
    checkpoint: '恢复到最近检查点',
    init: '每次回到起始状态',
  };
  const DIRS = {
    up: { dx: 0, dy: -1 },
    down: { dx: 0, dy: 1 },
    left: { dx: -1, dy: 0 },
    right: { dx: 1, dy: 0 },
  };

  /* ------------------------------------------------------------------ *
   * 关卡定义：17 列 × 10 行，俯视方格地图
   * 静态底图只负责墙/地板/坑/岩浆/尖刺；
   * 检查点、开关、门、桥、道具均为叠加对象。
   * ------------------------------------------------------------------ */
  const LEVEL = {
    id: 'cp-respawn-demo',
    version: 1,
    width: 17,
    height: 10,
    base: [
      '#################', // y0
      '#...............#', // y1
      '#...............#', // y2  cp1(3) cp3(13) finish(15)
      '#........P......#', // y3  黄门(7) 坑+吊桥=cp2(9)
      '#...............#', // y4
      '#...LLLL.LLLLLL.#', // y5  岩浆带，(3,x=3..6)(x=8..14)，列 7、15 为通道
      '#...SS..........#', // y6  尖刺 (4,6)(5,6)
      '#...............#', // y7
      '#...............#', // y8  开关与道具行
      '#################', // y9
    ],
    start: { x: 3, y: 3 },
    finish: { x: 15, y: 2 },
    // 检查点按数组顺序编号 0、1、2；起点视作编号 -1 的隐式检查点
    checkpoints: [
      { id: 'cp1', x: 3, y: 2, name: '检查点一' },
      { id: 'cp2', x: 9, y: 3, name: '检查点二（桥上）' },
      { id: 'cp3', x: 13, y: 2, name: '检查点三' },
    ],
    switches: [
      { id: 'sw1', x: 2, y: 8, name: '黄开关·东门', initial: false, policy: 'checkpoint', color: '#eab308',
        targets: ['g1'], desc: '控制 7 列的黄门' },
      { id: 'sw2', x: 8, y: 8, name: '蓝开关·吊桥', initial: false, policy: 'keep', color: '#3b82f6',
        targets: ['b1'], desc: '控制检查点二下方坑洞的吊桥' },
      { id: 'sw3', x: 14, y: 8, name: '红开关·永久门', initial: false, policy: 'keep', color: '#ef4444',
        targets: ['g3', 'g4'], desc: '本局保留：控制检查点三门与东侧红门' },
    ],
    mechanisms: [
      { id: 'g1', type: 'gate', x: 7, y: 3, name: '黄门', switchId: 'sw1' },
      { id: 'b1', type: 'bridge', x: 9, y: 3, name: '吊桥', switchId: 'sw2' },
      { id: 'g3', type: 'gate', x: 13, y: 2, name: '红门·检查点三', switchId: 'sw3' },
      { id: 'g4', type: 'gate', x: 15, y: 3, name: '红门·东侧通道', switchId: 'sw3' },
    ],
    items: [
      { id: 'it1', x: 4, y: 8, name: '能量块', max: 2, policy: 'checkpoint' },
      { id: 'it2', x: 12, y: 8, name: '护盾', max: 1, policy: 'init' },
      { id: 'it3', x: 15, y: 4, name: '钥匙', max: 1, policy: 'keep' },
    ],
  };

  /* 两条可重复执行的内置路线（见 README 路线说明）。
     path() 由相邻坐标点自动生成方向指令，避免手写方向串错步。 */
  const M = (dir) => ({ type: 'move', dir });
  const ACT = () => ({ type: 'interact' });
  function path(points) {
    const out = [];
    for (let i = 1; i < points.length; i++) {
      const dx = points[i][0] - points[i - 1][0];
      const dy = points[i][1] - points[i - 1][1];
      if (dx !== 0 && dy !== 0) {
        throw new Error('路线点必须同行或同列：' + points[i - 1] + '→' + points[i]);
      }
      const dir = dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'down' : 'up';
      const steps = Math.abs(dx) + Math.abs(dy);
      for (let n = 0; n < steps; n++) out.push(M(dir));
    }
    return out;
  }
  const ROUTES = {
    A: {
      name: '路线 A：完整通关（1 次尖刺死亡，重生后展示逐对象取值来源）',
      commands: [
        ...path([[3, 3], [3, 8], [2, 8]]),       // 走到黄开关
        ACT(),                                   // 黄开关 ON
        ...path([[2, 8], [4, 8], [8, 8]]),       // 能量块 2→1，到蓝开关
        ACT(),                                   // 吊桥展开（keep）
        ...path([[8, 8], [8, 3], [9, 3]]),       // 检查点二（快照：sw1 ON, it1=1）
        ...path([[9, 3], [3, 3], [3, 2]]),       // 检查点一（回踩不回倒）
        ...path([[3, 2], [3, 7], [4, 7], [4, 6]]), // 尖刺死亡 → 重生 cp2 (9,3)
        // 重生来源：能量块 checkpoint→恢复 1；黄开关 checkpoint→仍 ON；蓝开关 keep→仍 ON
        ...path([[9, 3], [8, 3], [8, 8], [14, 8]]), // 走列 8 穿过岩浆带，底排到红开关
        ACT(),                                   // 红门打开（keep）
        ...path([[14, 8], [15, 8], [15, 3]]),    // 走列 15 上行（y3 拿钥匙后停在终点下方）
        ...path([[15, 3], [14, 3], [13, 3], [13, 2]]), // 绕到检查点三
        ...path([[13, 2], [15, 2]]),             // 终点
      ],
    },
    B: {
      name: '路线 B：规则专项（同步死亡/邻格备选/回踩不倒退/策略对比/反复重生）',
      commands: [
        ...path([[3, 3], [3, 2]]),               // 检查点一
        ...path([[3, 2], [3, 8], [8, 8]]),       // 蓝开关
        ACT(),                                   // 吊桥展开
        ...path([[8, 8], [8, 3], [9, 3]]),       // 检查点二
        ...path([[9, 3], [10, 3], [9, 3]]),      // 回踩 cp2：不回倒
        ...path([[9, 3], [8, 3], [8, 8]]),       // 回蓝开关
        ACT(),                                   // 蓝开关 OFF，桥收起
        ...path([[8, 8], [8, 3], [9, 3]]),       // 同一步：cp2 不更新→坑洞死亡，来路 (8,3) 备选重生
        ...path([[8, 3], [8, 8]]),               // 回蓝开关
        ACT(),                                   // 桥重新展开
        ...path([[8, 8], [8, 3], [9, 3]]),       // 安全回到 cp2
        ...path([[9, 3], [9, 2], [3, 2], [3, 3]]), // 绕 y=2 回踩 cp1 不回倒
        ...path([[3, 3], [3, 8], [2, 8]]),       // 黄开关
        ACT(),                                   // 黄开关 ON（cp2 快照里它是 OFF）
        ...path([[2, 8], [4, 8]]),               // 能量块 2→1（快照里是 2）
        ...path([[4, 8], [3, 8], [3, 6], [4, 6]]), // 尖刺死亡（同格无检查点）→ 重生 cp2
        // 来源对比：sw1 checkpoint→OFF；it1 checkpoint→2；sw2 keep→ON；it3 keep 未动
        ...path([[9, 3], [9, 2], [3, 2], [3, 8], [4, 8]]), // 绕 y=2 再捡能量块 2→1
        ...path([[4, 8], [14, 8]]),               // 底排直达红开关
        ACT(),                                    // 红开关 ON（红门打开）
        ...path([[14, 8], [15, 8], [15, 3]]),     // 走列 15 上行拿钥匙（keep）
        ...path([[15, 3], [14, 3], [13, 3], [13, 2]]), // 绕到检查点三
        ...path([[13, 2], [15, 2]]),              // 终点
      ],
    },
  };

  /* ------------------------------------------------------------------ *
   * 基础查询
   * ------------------------------------------------------------------ */
  function key(x, y) { return x + ',' + y; }
  function tileAt(level, x, y) {
    if (x < 0 || y < 0 || x >= level.width || y >= level.height) return TILE.WALL;
    return level.base[y][x];
  }
  function findCheckpoint(level, x, y) {
    return level.checkpoints.find((c) => c.x === x && c.y === y) || null;
  }
  function findSwitch(level, x, y) {
    return level.switches.find((s) => s.x === x && s.y === y) || null;
  }
  function mechsAt(level, x, y) {
    return level.mechanisms.filter((m) => m.x === x && m.y === y);
  }
  function itemAt(level, x, y) {
    return level.items.find((i) => i.x === x && i.y === y) || null;
  }

  // 机关当前是否“闭合/收起”——门闭合挡路，桥收起时坑洞裸露
  function mechanismClosed(level, state, m) {
    return state.switches[m.switchId] === false;
  }

  /* 该格当前是否致死（动态：吊桥、演练封锁都会影响） */
  function hazardAt(level, state, x, y) {
    if (state.overrideHazards && state.overrideHazards.has(key(x, y))) {
      return { deadly: true, reason: '演练封锁（辅助演示标记）' };
    }
    const t = tileAt(level, x, y);
    if (t === TILE.LAVA) return { deadly: true, reason: '岩浆' };
    if (t === TILE.SPIKE) return { deadly: true, reason: '尖刺' };
    if (t === TILE.PIT) {
      const bridge = level.mechanisms.find(
        (m) => m.type === 'bridge' && m.x === x && m.y === y
      );
      if (bridge && !mechanismClosed(level, state, bridge)) {
        return { deadly: false, reason: '坑洞（吊桥已展开）' };
      }
      return { deadly: true, reason: '坑洞且吊桥收起' };
    }
    return { deadly: false, reason: '' };
  }

  /* 该格能否走入：墙/闭合的门不可走；危险格可走入但会触发死亡 */
  function blockedAt(level, state, x, y) {
    if (tileAt(level, x, y) === TILE.WALL) return { blocked: true, reason: '墙' };
    for (const m of mechsAt(level, x, y)) {
      if (m.type === 'gate' && mechanismClosed(level, state, m)) {
        const sw = level.switches.find((s) => s.id === m.switchId);
        return { blocked: true, reason: m.name + '闭合（' + sw.name + ' OFF）' };
      }
    }
    return { blocked: false, reason: '' };
  }

  function isSafe(level, state, x, y) {
    const b = blockedAt(level, state, x, y);
    if (b.blocked) return { safe: false, reason: b.reason };
    const h = hazardAt(level, state, x, y);
    if (h.deadly) return { safe: false, reason: h.reason };
    return { safe: true, reason: '安全' };
  }

  /* ------------------------------------------------------------------ *
   * 建局
   * ------------------------------------------------------------------ */
  function createGame(policyOverrides) {
    const policies = {};
    for (const s of LEVEL.switches) policies[s.id] = (policyOverrides && policyOverrides[s.id]) || s.policy;
    for (const i of LEVEL.items) policies[i.id] = (policyOverrides && policyOverrides[i.id]) || i.policy;

    const state = {
      levelId: LEVEL.id,
      step: 0,
      seq: 0,
      runId: 0,                        // 整局重置（reset-init）次数
      player: { ...LEVEL.start },
      activeCheckpointId: null,        // null 表示起点（隐式 -1 号检查点）
      activeCheckpointIndex: -1,
      switches: {},
      items: {},
      cpSnapshots: {},                 // cpId -> 启用瞬间的开关/道具快照
      events: [],
      history: [],
      deaths: 0,
      finished: false,
      pendingRespawn: null,            // 死亡后、重生未决时的候选评估
      overrideHazards: new Set(),
      lastSafeTile: { ...LEVEL.start }, // 每次踏入安全格时更新，死亡时作为首选邻格
      policies,
    };
    for (const s of LEVEL.switches) state.switches[s.id] = s.initial;
    for (const i of LEVEL.items) state.items[i.id] = i.max;
    return state;
  }

  function cpIndex(state, cpId) {
    if (cpId === null) return -1;
    return LEVEL.checkpoints.findIndex((c) => c.id === cpId);
  }

  function snapshotStateful(state) {
    return {
      switches: { ...state.switches },
      items: { ...state.items },
    };
  }

  function pushEvent(state, type, message, data) {
    const ev = { seq: state.seq++, step: state.step, type, message, data: data || {} };
    state.events.push(ev);
    return ev;
  }

  function stateHash(state) {
    return JSON.stringify({
      p: state.player,
      cp: state.activeCheckpointId,
      sw: state.switches,
      it: state.items,
      fin: state.finished,
      d: state.deaths,
      last: state.lastSafeTile,
    });
  }

  function recordHistory(state, cmd) {
    state.history.push({
      step: state.step,
      cmd,
      stateHash: stateHash(state),
      player: { ...state.player },
      activeCheckpointId: state.activeCheckpointId,
      switches: { ...state.switches },
      items: { ...state.items },
      deaths: state.deaths,
      finished: state.finished,
    });
  }

  /* ------------------------------------------------------------------ *
   * 备选重生点：有效检查点 → 致死来路邻格 → 其余邻格 → 上一检查点 → 起点
   * ------------------------------------------------------------------ */
  function buildCandidates(state) {
    const list = [];
    const seen = new Set();
    const add = (x, y, label) => {
      const k = key(x, y);
      if (seen.has(k)) return;
      if (x < 0 || y < 0 || x >= LEVEL.width || y >= LEVEL.height) return;
      seen.add(k);
      const r = isSafe(LEVEL, state, x, y);
      list.push({ x, y, label, safe: r.safe, reason: r.reason });
    };

    const idx = state.activeCheckpointIndex;
    // 1) 当前有效检查点本身
    if (idx >= 0) {
      const cp = LEVEL.checkpoints[idx];
      add(cp.x, cp.y, '有效检查点：' + cp.name);
      // 2) 致死前所在格（来路）优先，其次其余邻格按上/右/下/左
      const from = state.lastSafeTile;
      if (from) add(from.x, from.y, cp.name + ' 邻格（致死来路）');
      add(cp.x, cp.y - 1, cp.name + ' 上方邻格');
      add(cp.x + 1, cp.y, cp.name + ' 右方邻格');
      add(cp.x, cp.y + 1, cp.name + ' 下方邻格');
      add(cp.x - 1, cp.y, cp.name + ' 左方邻格');
      // 3) 上一检查点
      if (idx - 1 >= 0) {
        const prev = LEVEL.checkpoints[idx - 1];
        add(prev.x, prev.y, '上一检查点：' + prev.name);
      }
    }
    // 4) 起点
    add(LEVEL.start.x, LEVEL.start.y, '起始位置');
    // 起点邻格兜底
    add(LEVEL.start.x, LEVEL.start.y - 1, '起点上方邻格');
    add(LEVEL.start.x + 1, LEVEL.start.y, '起点右方邻格');
    add(LEVEL.start.x, LEVEL.start.y + 1, '起点下方邻格');
    add(LEVEL.start.x - 1, LEVEL.start.y, '起点左方邻格');
    return list;
  }

  /* ------------------------------------------------------------------ *
   * 死亡与重生
   * ------------------------------------------------------------------ */
  function kill(state, reason) {
    state.deaths += 1;
    const candidates = buildCandidates(state);
    pushEvent(state, 'death', '死亡：' + reason, {
      reason,
      at: { ...state.player },
      candidates,
    });
    state.pendingRespawn = { reason, candidates };
    return candidates;
  }

  /* 计算按策略重生后每个有状态对象的取值来源（需求 2：逐对象列出用了哪一次的值） */
  function computeRespawnSources(state) {
    const idx = state.activeCheckpointIndex;
    const snap = idx >= 0 ? state.cpSnapshots[LEVEL.checkpoints[idx].id] : null;
    const sources = [];

    for (const sw of LEVEL.switches) {
      const before = state.switches[sw.id];
      const policy = state.policies[sw.id];
      let after, from;
      if (policy === POLICY.KEEP) { after = before; from = 'keep'; }
      else if (policy === POLICY.CHECKPOINT) {
        if (snap) { after = snap.switches[sw.id]; from = 'checkpoint'; }
        else { after = sw.initial; from = 'init'; }
      } else { after = sw.initial; from = 'init'; }
      sources.push({ kind: 'switch', id: sw.id, name: sw.name, policy, from, before, after });
    }
    for (const it of LEVEL.items) {
      const before = state.items[it.id];
      const policy = state.policies[it.id];
      let after, from;
      if (policy === POLICY.KEEP) { after = before; from = 'keep'; }
      else if (policy === POLICY.CHECKPOINT) {
        if (snap) { after = snap.items[it.id]; from = 'checkpoint'; }
        else { after = it.max; from = 'init'; }
      } else { after = it.max; from = 'init'; }
      sources.push({ kind: 'item', id: it.id, name: it.name, policy, from, before, after });
    }
    return { sources, snapshot: snap };
  }

  const FROM_LABEL = {
    keep: '本局现值（一直保留）',
    checkpoint: '检查点启用瞬间快照',
    init: '关卡起始值',
  };

  function applyRespawn(state, target, sources) {
    // 绝对值写回，绝不做 +=，因此反复重生不会重复发放/回加次数
    for (const s of sources) {
      if (s.kind === 'switch') state.switches[s.id] = s.after;
      else state.items[s.id] = s.after;
    }
    state.player = { x: target.x, y: target.y };
    state.overrideHazards = new Set();
    state.pendingRespawn = null;
  }

  /**
   * 处理重生。mode：
   *   undefined    按候选表寻找安全备选点
   *   'reset-init' 先整局重置到起始状态，再在起点重生
   *   'reset-mech' 先把本局保留的开关拨回初始（门打开/桥按初始），再重试候选
   */
  function doRespawn(state, mode) {
    if (!state.pendingRespawn) return { ok: false, error: '当前没有待处理的死亡' };

    if (mode === 'reset-init') {
      state.runId += 1;
      for (const sw of LEVEL.switches) state.switches[sw.id] = sw.initial;
      for (const it of LEVEL.items) state.items[it.id] = it.max;
      state.cpSnapshots = {};
      state.activeCheckpointId = null;
      state.activeCheckpointIndex = -1;
      state.overrideHazards = new Set();
      pushEvent(state, 'state', '整局重置：所有对象回到起始状态', { kind: 'reset-init' });
    } else if (mode === 'reset-mech') {
      const flipped = [];
      for (const sw of LEVEL.switches) {
        if (state.policies[sw.id] === POLICY.KEEP && state.switches[sw.id] !== sw.initial) {
          state.switches[sw.id] = sw.initial;
          flipped.push(sw.id);
          pushEvent(state, 'state', sw.name + ' 被重置为初始值（' + (sw.initial ? 'ON' : 'OFF') + '）', {
            kind: 'mech-reset', id: sw.id, value: sw.initial,
          });
        }
      }
      state.overrideHazards = new Set();
      if (!flipped.length) {
        pushEvent(state, 'state', '没有需要重置的永久机关', { kind: 'mech-reset', empty: true });
      }
    }

    const candidates = buildCandidates(state);
    const target = candidates.find((c) => c.safe);
    if (!target) {
      // 刷新待处理候选，UI 继续显示原因与重置选择
      state.pendingRespawn.candidates = candidates;
      pushEvent(state, 'respawn-blocked', '所有备选位置仍不安全', { candidates });
      return { ok: false, candidates };
    }

    const { sources } = computeRespawnSources(state);
    const cpName = state.activeCheckpointIndex >= 0
      ? LEVEL.checkpoints[state.activeCheckpointIndex].name
      : '起点';
    applyRespawn(state, target, sources);
    pushEvent(state, 'respawn', '在「' + target.label + '」重生（有效点：' + cpName + '）', {
      target,
      checkpointId: state.activeCheckpointId,
      sources: sources.map((s) => ({ ...s, fromLabel: FROM_LABEL[s.from] })),
      candidates,
    });
    return { ok: true, target, sources };
  }

  /* ------------------------------------------------------------------ *
   * 单步指令
   * ------------------------------------------------------------------ */
  function stepCommand(state, cmd) {
    if (state.pendingRespawn) {
      pushEvent(state, 'blocked', '死亡待重生：请先选择重生或重置', {});
      return state.events[state.events.length - 1];
    }
    if (state.finished) {
      pushEvent(state, 'blocked', '已到达终点，请开新局', {});
      return state.events[state.events.length - 1];
    }
    state.step += 1;

    if (cmd.type === 'emergency') return runEmergency(state, cmd);
    if (cmd.type === 'interact') return runInteract(state, cmd);
    if (cmd.type === 'move') return runMove(state, cmd);
    pushEvent(state, 'blocked', '未知指令：' + JSON.stringify(cmd), {});
    return state.events[state.events.length - 1];
  }

  function runMove(state, cmd) {
    const d = DIRS[cmd.dir];
    const tx = state.player.x + d.dx;
    const ty = state.player.y + d.dy;
    const b = blockedAt(LEVEL, state, tx, ty);
    if (b.blocked) {
      pushEvent(state, 'blocked', '无法进入 (' + tx + ',' + ty + ')：' + b.reason, { at: { x: tx, y: ty } });
      recordHistory(state, cmd);
      return state.events[state.events.length - 1];
    }

    const origin = { ...state.player };
    state.player = { x: tx, y: ty };
    pushEvent(state, 'move', '移动到 (' + tx + ',' + ty + ')', { at: { x: tx, y: ty } });

    const hazard = hazardAt(LEVEL, state, tx, ty);
    if (!hazard.deadly) state.lastSafeTile = { x: tx, y: ty };
    else state.lastSafeTile = origin; // 死亡时来路保持为上一个安全格

    // —— 同一步内的固定先后顺序（需求 3）：
    // 1. 关卡状态变化（拾取） 2. 检查点记录（仅当该格不致死）
    // 3. 死亡判定；致死格上的检查点永不激活，但顺序仍在日志中可见
    const item = itemAt(LEVEL, tx, ty);
    if (item && state.items[item.id] > 0) {
      state.items[item.id] -= 1;   // 仅在实际踏入且有余量时消耗，绝对值记录
      pushEvent(state, 'item', '拾取 ' + item.name + '，剩余 ' + state.items[item.id],
        { id: item.id, remaining: state.items[item.id] });
    }

    const cp = findCheckpoint(LEVEL, tx, ty);
    if (cp && !hazard.deadly) {
      const incoming = LEVEL.checkpoints.findIndex((c) => c.id === cp.id);
      if (incoming > state.activeCheckpointIndex) {
        state.activeCheckpointId = cp.id;
        state.activeCheckpointIndex = incoming;
        state.cpSnapshots[cp.id] = snapshotStateful(state);
        pushEvent(state, 'checkpoint', '启用 ' + cp.name + '，并记录当前开关/道具快照', {
          id: cp.id, index: incoming, recorded: true,
          snapshot: state.cpSnapshots[cp.id],
        });
      } else {
        // 回头经过已启用（或更早）的点：只发事件，不覆盖快照、不回倒进度
        pushEvent(state, 'checkpoint', '经过 ' + cp.name + '：该点未更新，有效检查点保持不变', {
          id: cp.id, index: incoming, recorded: false,
          activeIndex: state.activeCheckpointIndex,
        });
      }
    } else if (cp && hazard.deadly) {
      // 同一步兼有触发与死亡：先记录“尝试触发”，再死亡，明确先后
      pushEvent(state, 'checkpoint', '经过 ' + cp.name + '：该格正在致死（' +
        hazard.reason + '），检查点不激活；随后判定死亡', {
        id: cp.id, recorded: false, suppressedByDeath: true,
      });
    }

    if (hazard.deadly) {
      kill(state, hazard.reason + '（位置 ' + tx + ',' + ty + '）');
    }

    if (tx === LEVEL.finish.x && ty === LEVEL.finish.y) {
      state.finished = true;
      pushEvent(state, 'finish', '到达终点，通关！', { at: { x: tx, y: ty } });
    }

    recordHistory(state, cmd);
    return state.events[state.events.length - 1];
  }

  function runInteract(state, cmd) {
    const candidates = [
      { x: state.player.x, y: state.player.y },
      { x: state.player.x, y: state.player.y - 1 },
      { x: state.player.x + 1, y: state.player.y },
      { x: state.player.x, y: state.player.y + 1 },
      { x: state.player.x - 1, y: state.player.y },
    ];
    const sw = candidates
      .map((c) => findSwitch(LEVEL, c.x, c.y))
      .find(Boolean);
    if (!sw) {
      pushEvent(state, 'blocked', '身边没有可操作的开关', {});
    } else {
      state.switches[sw.id] = !state.switches[sw.id];
      pushEvent(state, 'state', sw.name + ' 拨到 ' + (state.switches[sw.id] ? 'ON' : 'OFF') +
        '（策略：' + POLICY_LABEL[state.policies[sw.id]] + '）', {
        kind: 'switch', id: sw.id, value: state.switches[sw.id], policy: state.policies[sw.id],
      });
    }
    recordHistory(state, cmd);
    return state.events[state.events.length - 1];
  }

  /* 演练辅助：制造“所有备选都不安全”的局面（需求 4 的极端分支演示） */
  function runEmergency(state, cmd) {
    // 先按当前局面算出全部候选，再逐格封死，并把永久红门闭合
    const candidates = buildCandidates(state);
    for (const sw of LEVEL.switches) {
      if (state.switches[sw.id] !== false) {
        state.switches[sw.id] = false;
        pushEvent(state, 'state', sw.name + ' 被演练脚本拨到 OFF', { kind: 'emergency', id: sw.id });
      }
    }
    for (const c of buildCandidates(state)) state.overrideHazards.add(key(c.x, c.y));
    pushEvent(state, 'state', '演练封锁：标记全部候选格为危险，用于验证全不安全分支', {
      kind: 'emergency', sealed: candidates.length,
    });
    kill(state, '演练封锁触发的死亡');
    recordHistory(state, cmd);
    return state.events[state.events.length - 1];
  }

  /* ------------------------------------------------------------------ *
   * 策略修改（界面下拉框）；检查点本身无策略，只对开关/道具生效
   * ------------------------------------------------------------------ */
  function setPolicy(state, id, policy) {
    if (!state.policies.hasOwnProperty(id)) return { ok: false };
    state.policies[id] = policy;
    const obj = LEVEL.switches.find((s) => s.id === id) || LEVEL.items.find((i) => i.id === id);
    pushEvent(state, 'state', obj.name + ' 的保留策略改为：' + POLICY_LABEL[policy], {
      kind: 'policy-change', id, policy,
    });
    return { ok: true };
  }

  /* ------------------------------------------------------------------ *
   * 存档 / 重放校验
   * ------------------------------------------------------------------ */
  function buildBundle(state, meta) {
    return {
      format: 'cp-respawn-bundle/1',
      levelId: LEVEL.id,
      levelVersion: LEVEL.version,
      savedAt: new Date().toISOString(),
      meta: meta || {},
      policies: { ...state.policies },
      commands: state.history.map((h) => h.cmd),
      history: state.history,
      events: state.events,
      final: {
        player: { ...state.player },
        activeCheckpointId: state.activeCheckpointId,
        switches: { ...state.switches },
        items: { ...state.items },
        deaths: state.deaths,
        finished: state.finished,
        stateHash: stateHash(state),
      },
    };
  }

  function verifyBundle(bundle) {
    const sim = createGame(bundle.policies);
    const mismatches = [];
    const deathReports = [];
    let pendingDeath = null;

    bundle.commands.forEach((cmd, i) => {
      const before = JSON.parse(JSON.stringify({
        player: sim.player, switches: sim.switches, items: sim.items,
        activeCheckpointId: sim.activeCheckpointId, deaths: sim.deaths,
      }));
      doCommand(sim, cmd);
      // 死亡后引擎进入 pending，由后续 respawn 指令推进；存档同样保存了这些指令
      if (sim.pendingRespawn && !pendingDeath) {
        pendingDeath = { step: sim.step, before };
      }
      const recorded = bundle.history[i];
      if (recorded && recorded.stateHash !== stateHash(sim)) {
        mismatches.push({ index: i, cmd, expected: recorded.stateHash, actual: stateHash(sim) });
      }
      const lastEv = sim.events[sim.events.length - 1];
      if (lastEv && lastEv.type === 'respawn' && pendingDeath) {
        deathReports.push({
          step: pendingDeath.step,
          before: pendingDeath.before,
          after: {
            player: { ...sim.player }, switches: { ...sim.switches }, items: { ...sim.items },
          },
          sources: lastEv.data.sources,
          target: lastEv.data.target,
        });
        pendingDeath = null;
      }
    });

    // 重放中若停在 pending，补上一次普通重生以便核对最终位置（与界面按钮同路径）
    let finalRespawn = null;
    if (sim.pendingRespawn) {
      const r = doRespawn(sim);
      if (r.ok) finalRespawn = r;
    }

    return {
      ok: mismatches.length === 0 && bundle.final.stateHash === stateHash(sim),
      commandCount: bundle.commands.length,
      mismatches,
      deathReports,
      finalState: {
        player: sim.player, activeCheckpointId: sim.activeCheckpointId,
        switches: sim.switches, items: sim.items, deaths: sim.deaths, finished: sim.finished,
      },
      finalRespawn,
    };
  }

  /* 重放过程中，死亡后的重生也是一条指令（界面按钮按下即记录） */
  function respawnCommand(mode) { return { type: 'respawn', mode: mode || null }; }

  /* 统一入口：普通指令走 stepCommand；respawn 指令走 doRespawn 并记录历史。
     verifyBundle 也通过它重放，保证与界面完全同路径。 */
  function doCommand(state, cmd) {
    if (cmd && cmd.type === 'respawn') {
      state.step += 1;
      const r = doRespawn(state, cmd.mode);
      recordHistory(state, cmd);
      return r;
    }
    return stepCommand(state, cmd);
  }

  return {
    LEVEL, TILE, POLICY, POLICY_LABEL, DIRS, ROUTES, FROM_LABEL,
    createGame, doCommand, doRespawn, respawnCommand,
    setPolicy, buildBundle, verifyBundle,
    isSafe, hazardAt, blockedAt, buildCandidates, stateHash,
    tileAt, findCheckpoint, findSwitch, mechsAt, itemAt, mechanismClosed,
  };
});
