// engine.js — 纯规则引擎，不依赖 DOM。所有对外更新函数都返回新状态，不修改入参。
// 核心链路：行动 → 事件 → 规则(priority 排序) → 效果(数组顺序) → 新事件 → FIFO 队列

// ---------- 基础工具 ----------

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function hashRuleset(ruleset) {
  return fnv1a(stableStringify(omit(ruleset, ['version', 'name'])));
}
export function hashAction(action) {
  return fnv1a(stableStringify(omit(action, ['name', 'description'])));
}
export function hashRule(rule) {
  return fnv1a(stableStringify(omit(rule, ['name', 'description'])));
}

function omit(obj, keys) {
  const out = {};
  for (const k of Object.keys(obj)) if (!keys.includes(k)) out[k] = obj[k];
  return out;
}

export function cloneState(state) {
  return structuredClone(state);
}

// ---------- 棋盘查询 ----------

export function cellMarkers(state, cellId) {
  return state.board.markers[cellId] ?? {};
}
export function countAt(state, cellId, markerId) {
  return cellMarkers(state, cellId)[markerId] ?? 0;
}
export function cellTotal(state, cellId) {
  return Object.values(cellMarkers(state, cellId)).reduce((a, b) => a + b, 0);
}
export function boardCount(state, markerId) {
  let n = 0;
  for (const cell of state.board.cells) n += countAt(state, cell.id, markerId);
  return n;
}
export function markerName(ruleset, id) {
  return ruleset.markers.find((m) => m.id === id)?.name ?? id;
}
export function cellName(ruleset, id) {
  return ruleset.cells.find((c) => c.id === id)?.name ?? id;
}

// ---------- 参数 / 条件求值 ----------

// $ 前缀表示从事件/行动参数里取实际值
function resolve(value, ctx) {
  if (typeof value === 'string' && value.startsWith('$')) {
    const key = value.slice(1);
    return ctx.params?.[key] ?? ctx.event?.[key];
  }
  return value;
}

function describeRef(value, ruleset) {
  if (typeof value !== 'string') return String(value);
  if (!value.startsWith('$')) {
    return cellName(ruleset, value) && ruleset.cells.some((c) => c.id === value)
      ? cellName(ruleset, value)
      : markerName(ruleset, value);
  }
  const map = {
    cellId: '目标单元',
    from: '来源单元',
    to: '目标单元',
    marker: '标记',
    count: '数量',
  };
  return map[value.slice(1)] ?? value;
}

export function describeCondition(cond, ruleset) {
  const r = (v) => describeRef(v, ruleset);
  switch (cond.type) {
    case 'cellHas':
      return `单元「${r(cond.cell)}」中至少有 ${cond.count ?? 1} 个${cond.marker ? '「' + r(cond.marker) + '」' : '标记'}`;
    case 'cellEmpty':
      return `单元「${r(cond.cell)}」为空`;
    case 'cellIs':
      return `单元等于「${r(cond.value)}」`;
    case 'not':
      return `不满足：${describeCondition(cond.cond, ruleset)}`;
    case 'markerCountAtLeast':
      return `棋盘上「${r(cond.marker)}」总数至少 ${cond.count}`;
    case 'resourceAtLeast':
      return `资源池「${poolName(ruleset, cond.pool)}」余量至少 ${cond.count}`;
    case 'turnLimitRemaining':
      return `行动「${actionName(ruleset, cond.actionId)}」本轮还有可用次数`;
    case 'activeSideIs':
      return `当前轮到「${cond.side}」方`;
    default:
      return cond.type;
  }
}

function poolName(ruleset, id) {
  return ruleset.pools.find((p) => p.id === id)?.name ?? id;
}
function actionName(ruleset, id) {
  return ruleset.actions.find((a) => a.id === id)?.name ?? id;
}

// 返回 { ok, reason? }
function evalCondition(cond, ctx) {
  const { state, ruleset } = ctx;
  const R = (v) => resolve(v, ctx);
  switch (cond.type) {
    case 'cellHas': {
      const cell = R(cond.cell);
      const need = cond.count ?? 1;
      const have = cond.marker
        ? countAt(state, cell, R(cond.marker))
        : cellTotal(state, cell);
      const what = cond.marker ? markerName(ruleset, R(cond.marker)) : '标记';
      return okOr(have >= need, `单元「${cellName(ruleset, cell)}」中${what}不足（有 ${have}，需 ${need}）`);
    }
    case 'cellEmpty': {
      const cell = R(cond.cell);
      const total = cellTotal(state, cell);
      return okOr(total === 0, `单元「${cellName(ruleset, cell)}」非空（现有 ${total} 个标记）`);
    }
    case 'cellIs': {
      const a = R(cond.cell);
      const b = R(cond.value);
      return okOr(a === b, `单元为 ${cellName(ruleset, a)}，要求 ${cellName(ruleset, b)}`);
    }
    case 'not': {
      const inner = evalCondition(cond.cond, ctx);
      return inner.ok ? { ok: false, reason: describeCondition(cond.cond, ruleset) + '（实际成立）' } : { ok: true };
    }
    case 'markerCountAtLeast': {
      const have = boardCount(state, R(cond.marker));
      return okOr(have >= cond.count, `棋盘上「${markerName(ruleset, R(cond.marker))}」只有 ${have} 个，需 ${cond.count}`);
    }
    case 'resourceAtLeast': {
      const have = state.poolValues[cond.pool] ?? 0;
      return okOr(have >= cond.count, `资源池「${poolName(ruleset, cond.pool)}」余量 ${have}，需 ${cond.count}`);
    }
    case 'turnLimitRemaining': {
      const limit = ruleset.turnLimits?.[cond.actionId];
      if (limit === undefined) return { ok: true };
      const used = state.turn.used[cond.actionId] ?? 0;
      return okOr(used < limit, `「${actionName(ruleset, cond.actionId)}」本轮次数已用完（${used}/${limit}）`);
    }
    case 'activeSideIs': {
      return okOr(state.turn.side === cond.side, `当前是「${state.turn.side}」方，要求「${cond.side}」方`);
    }
    default:
      return { ok: false, reason: `未知条件类型 ${cond.type}` };
  }
}
function okOr(ok, reason) {
  return ok ? { ok: true } : { ok: false, reason };
}

// ---------- 行动预览 ----------

export function previewAction(state, ruleset, actionId, params = {}) {
  const action = ruleset.actions.find((a) => a.id === actionId);
  if (!action) return { ok: false, checks: [], reason: `未知行动 ${actionId}` };
  const ctx = { state, ruleset, params, event: null };
  const checks = [];

  // 参数完整性
  for (const p of action.params ?? []) {
    const v = params[p.key];
    const exists = v !== undefined && v !== '';
    let valid = exists;
    let reason = '缺少参数';
    if (exists && p.kind === 'cell') {
      valid = state.board.cells.some((c) => c.id === v);
      reason = `单元 ${v} 不存在`;
    }
    if (exists && p.kind === 'marker') {
      valid = ruleset.markers.some((m) => m.id === v);
      reason = `标记 ${v} 不存在`;
    }
    checks.push({ description: `参数「${p.label}」已提供且合法`, ok: valid, ...(valid ? {} : { reason }) });
  }

  // 本轮次数
  const limit = ruleset.turnLimits?.[actionId];
  if (limit !== undefined) {
    const r = evalCondition({ type: 'turnLimitRemaining', actionId }, ctx);
    checks.push({ description: `本轮次数限制（已用 ${state.turn.used[actionId] ?? 0}/${limit}）`, ...r });
  }

  // 声明式条件
  for (const cond of action.checks ?? []) {
    const r = evalCondition(cond, ctx);
    checks.push({ description: describeCondition(cond, ruleset), ...r });
  }

  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    action,
    checks,
    reason: failed.length ? failed.map((f) => f.reason ?? f.description).join('；') : undefined,
  };
}

// ---------- 开局 / 回合 ----------

export function createGame(ruleset) {
  const markers = {};
  for (const cell of ruleset.cells) markers[cell.id] = {};
  for (const item of ruleset.initialBoard ?? []) {
    markers[item.cell][item.marker] = (markers[item.cell][item.marker] ?? 0) + (item.count ?? 1);
  }
  const poolValues = {};
  for (const pool of ruleset.pools ?? []) poolValues[pool.id] = pool.initial;
  const state = {
    schema: 1,
    rulesetId: ruleset.id,
    rulesetHash: hashRuleset(ruleset),
    board: { cells: ruleset.cells.map((c) => ({ ...c })), markers },
    turn: {
      index: 1,
      side: ruleset.config.turnOrder[0],
      sides: [...ruleset.config.turnOrder],
      used: {},
    },
    poolValues,
    history: [],
    log: [],
    seq: 1,
    branchTag: null,
  };
  log(state, 'turn', `开局：第 1 回合，轮到「${state.turn.side}」方`);
  return state;
}

export function endTurn(state, ruleset) {
  const s = cloneState(state);
  log(s, 'turn', `「${s.turn.side}」方结束第 ${s.turn.index} 回合`);
  const idx = s.turn.sides.indexOf(s.turn.side);
  const nextIdx = (idx + 1) % s.turn.sides.length;
  if (nextIdx <= idx) s.turn.index += 1;
  s.turn.side = s.turn.sides[nextIdx];
  s.turn.used = {};
  const reset = [];
  const kept = [];
  for (const pool of ruleset.pools ?? []) {
    if (pool.scope === 'turn') {
      s.poolValues[pool.id] = pool.initial;
      reset.push(`${pool.name}→${pool.initial}`);
    } else {
      kept.push(`${pool.name}=${s.poolValues[pool.id]}`);
    }
  }
  log(s, 'turn', `进入第 ${s.turn.index} 回合，轮到「${s.turn.side}」方；重置本轮资源（${reset.join('，') || '无'}），保留全局资源（${kept.join('，') || '无'}），行动次数清零`);
  return s;
}

// ---------- 行动执行 ----------

export function applyAction(state, ruleset, actionId, params = {}) {
  const s = cloneState(state);
  const preview = previewAction(s, ruleset, actionId, params);
  if (!preview.ok) {
    log(s, 'blocked', `⛔ 行动「${preview.action?.name ?? actionId}」被阻止：${preview.reason}`);
    return { ok: false, state: s, preview };
  }
  const action = preview.action;
  s.turn.used[actionId] = (s.turn.used[actionId] ?? 0) + 1;

  if (action.cost) {
    s.poolValues[action.cost.pool] -= action.cost.count;
    log(s, 'effect', `扣除资源「${poolName(ruleset, action.cost.pool)}」${action.cost.count}`);
  }

  const events = [];
  const p = { ...params };
  if (action.kind === 'place') {
    const cell = p.cellId;
    const marker = p.marker ?? action.marker;
    const count = p.count ?? action.count ?? 1;
    addMarker(s, cell, marker, count);
    log(s, 'action', `▶ 行动「${action.name}」：在「${cellName(ruleset, cell)}」放置 ${count} 个「${markerName(ruleset, marker)}」`);
    events.push({ type: 'placed', cell, marker, count, cause: actionId });
  } else if (action.kind === 'move') {
    const { from, to, marker } = p;
    const count = p.count ?? 1;
    addMarker(s, from, marker, -count);
    addMarker(s, to, marker, count);
    log(s, 'action', `▶ 行动「${action.name}」：将 ${count} 个「${markerName(ruleset, marker)}」从「${cellName(ruleset, from)}」移到「${cellName(ruleset, to)}」`);
    events.push({ type: 'moved', from, to, marker, count, cause: actionId });
  } else if (action.kind === 'consume') {
    const { cellId: cell, marker } = p;
    const count = p.count ?? 1;
    addMarker(s, cell, marker, -count);
    log(s, 'action', `▶ 行动「${action.name}」：消耗「${cellName(ruleset, cell)}」的 ${count} 个「${markerName(ruleset, marker)}」`);
    events.push({ type: 'consumed', cell, marker, count, cause: actionId });
  } else {
    return { ok: false, state: s, preview, reason: `未知行动类型 ${action.kind}` };
  }

  const fired = runChain(s, ruleset, events, actionId);
  s.history.push({
    seq: s.seq,
    turnIndex: s.turn.index,
    side: s.turn.side,
    actionId,
    actionHash: hashAction(action),
    params: structuredClone(params),
    fired, // 实际触发过的规则哈希，供重放漂移检测
  });
  return { ok: true, state: s, preview };
}

function addMarker(state, cell, marker, delta) {
  const bucket = state.board.markers[cell];
  bucket[marker] = (bucket[marker] ?? 0) + delta;
  if (bucket[marker] <= 0) delete bucket[marker];
}

// ---------- 连锁结算引擎 ----------

function runChain(state, ruleset, initialEvents, actionId) {
  const globalCap = ruleset.config.chainCap ?? 24;
  const defaultCap = ruleset.config.perRuleDefaultCap ?? 8;
  const queue = [...initialEvents];
  const fireCount = {};
  const firedHashes = [];
  let steps = 0;

  while (queue.length) {
    const event = queue.shift();
    log(state, 'event', `事件「${eventLabel(event, ruleset)}」进入结算队列`);

    const matches = ruleset.rules
      .filter((r) => {
        const types = Array.isArray(r.trigger.type) ? r.trigger.type : [r.trigger.type];
        return types.includes(event.type) && matchFilter(r.trigger.filter, event);
      })
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

    for (const rule of matches) {
      steps += 1;
      if (steps > globalCap) {
        log(state, 'loop', `⛔ 达到全局连锁步数上限 ${globalCap}，连锁被强制停止（规则「${rule.name}」未再结算）`);
        return firedHashes;
      }
      const cap = rule.cap ?? defaultCap;
      const times = fireCount[rule.id] ?? 0;
      if (times >= cap) {
        log(state, 'loop', `⏹ 规则「${rule.name}」已触发 ${times} 次，达到单规则上限 ${cap}，本次跳过——连锁在此处被截断`);
        continue;
      }
      const ctx = { state, ruleset, params: eventParams(event), event };
      const failedConds = (rule.conditions ?? []).filter((c) => !evalCondition(c, ctx).ok);
      if (failedConds.length) {
        const reasons = failedConds.map((c) => evalCondition(c, ctx).reason).join('；');
        log(state, 'skip', `↷ 规则「${rule.name}」条件不满足，跳过：${reasons}`);
        continue;
      }

      fireCount[rule.id] = times + 1;
      if (!firedHashes.some((f) => f.ruleId === rule.id)) {
        firedHashes.push({ ruleId: rule.id, hash: hashRule(rule) });
      }
      log(state, 'trigger', `⚡ 规则「${rule.name}」触发（第 ${times + 1}/${cap} 次，优先级 ${rule.priority}）`);

      for (const effect of rule.effects) {
        const ectx = { state, ruleset, params: eventParams(event), event };
        const bad = (effect.conditions ?? []).map((c) => evalCondition(c, ectx)).find((r) => !r.ok);
        if (bad) {
          log(state, 'skip', `  ↳ 效果跳过：${bad.reason}`);
          continue;
        }
        const newEvents = applyEffect(state, ruleset, effect, ectx, rule);
        queue.push(...newEvents);
      }
    }
  }
  return firedHashes;
}

function eventParams(event) {
  // 事件字段直接作为 $ 引用的来源
  return { ...event, cellId: event.cell ?? event.to };
}

function matchFilter(filter, event) {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => event[k] === v);
}

function eventLabel(event, ruleset) {
  switch (event.type) {
    case 'placed':
      return `放置 ${markerName(ruleset, event.marker)} → ${cellName(ruleset, event.cell)}`;
    case 'moved':
      return `移动 ${markerName(ruleset, event.marker)}：${cellName(ruleset, event.from)} → ${cellName(ruleset, event.to)}`;
    case 'consumed':
      return `消耗 ${markerName(ruleset, event.marker)} @ ${cellName(ruleset, event.cell)}`;
    case 'resourceSpent':
      return `资源支出 ${event.pool} -${event.count}`;
    default:
      return event.type;
  }
}

function applyEffect(state, ruleset, effect, ctx, rule) {
  const R = (v) => resolve(v, ctx);
  const events = [];
  switch (effect.type) {
    case 'place': {
      const cell = R(effect.cell);
      const marker = R(effect.marker);
      const count = R(effect.count) ?? 1;
      addMarker(state, cell, marker, count);
      log(state, 'effect', `  ↳ 在「${cellName(ruleset, cell)}」放置 ${count} 个「${markerName(ruleset, marker)}」`);
      events.push({ type: 'placed', cell, marker, count, cause: rule.id });
      break;
    }
    case 'move': {
      const from = R(effect.from);
      const to = R(effect.to);
      const marker = R(effect.marker);
      const count = R(effect.count) ?? 1;
      addMarker(state, from, marker, -count);
      addMarker(state, to, marker, count);
      log(state, 'effect', `  ↳ 移动 ${count} 个「${markerName(ruleset, marker)}」：${cellName(ruleset, from)} → ${cellName(ruleset, to)}`);
      events.push({ type: 'moved', from, to, marker, count, cause: rule.id });
      break;
    }
    case 'consume': {
      const cell = R(effect.cell);
      const marker = R(effect.marker);
      const count = R(effect.count) ?? 1;
      addMarker(state, cell, marker, -count);
      log(state, 'effect', `  ↳ 消耗「${cellName(ruleset, cell)}」的 ${count} 个「${markerName(ruleset, marker)}」`);
      events.push({ type: 'consumed', cell, marker, count, cause: rule.id });
      break;
    }
    case 'spendResource': {
      const pool = R(effect.pool);
      const count = R(effect.count) ?? 1;
      state.poolValues[pool] -= count;
      log(state, 'effect', `  ↳ 资源池「${poolName(ruleset, pool)}」-${count}（余 ${state.poolValues[pool]}）`);
      events.push({ type: 'resourceSpent', pool, count, cause: rule.id });
      break;
    }
    case 'log':
      log(state, 'effect', `  ↳ ${effect.text}`);
      break;
    default:
      log(state, 'skip', `  ↳ 未知效果类型 ${effect.type}`);
  }
  return events;
}

function log(state, kind, text) {
  state.log.push({ seq: state.seq++, kind, text, turnIndex: state.turn.index, side: state.turn.side });
}
