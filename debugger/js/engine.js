/*
 * engine.js — 确定性动作状态机仿真核心
 *
 * 纯函数、固定时间步（TICK = 1/60s），不依赖 DOM，可直接在 Node 下测试。
 * 同一 config + timeline，任意 seek / 单步 / 跨循环边界，结果逐字节一致。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASDebug = root.ASDebug || {}; root.ASDebug.Engine = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TICK = 1 / 60;

  // ---------- 条件原子求值 ----------
  // 原子形式 { kind, button? }
  // kind: btn-press / btn-release / btn-held / btn-up / state-age / state-finished / always
  function evalAtom(atom, ctx) {
    switch (atom.kind) {
      case 'btn-press':
        return ctx.pressed.has(atom.button);
      case 'btn-release':
        return ctx.released.has(atom.button);
      case 'btn-held':
        return ctx.held.has(atom.button);
      case 'btn-up':
        return !ctx.held.has(atom.button);
      case 'state-age':
        return ctx.stateAge >= (atom.minSec || 0);
      case 'state-finished':
        return ctx.finished === true;
      case 'always':
        return true;
      default:
        return false;
    }
  }

  // 条件 = 原子的 AND 组合
  function evalCondition(gates, ctx) {
    return gates.every((g) => evalAtom(g, ctx));
  }

  // 排队受理条件：优先 acceptGates，缺省回退到 gates
  function acceptGatesOf(tr) {
    return tr.acceptGates && tr.acceptGates.length ? tr.acceptGates : (tr.gates || []);
  }

  // 原子 a 是否包含原子 b（b 满足时 a 必满足）
  function atomCovers(a, b) {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'state-age') return (a.minSec || 0) <= (b.minSec || 0);
    if (a.kind === 'state-finished' || a.kind === 'always') return true;
    return a.button === b.button;
  }

  // 条件 P 是否包含条件 Q：Q 满足 => P 必满足
  function conditionCovers(P, Q) {
    return P.every((pa) => Q.some((qb) => atomCovers(pa, qb)));
  }

  // ---------- 时间线预处理 ----------
  // intervals: [{button, start, end}]（秒），循环长度 loopSec
  // 生成每个 tick 的输入状态。
  function buildInputGrid(timeline) {
    const loopSec = Math.max(0.1, timeline.loopSec);
    const tickCount = Math.round(loopSec / TICK);
    const held = Array.from({ length: tickCount }, () => new Set());
    const pressed = Array.from({ length: tickCount }, () => new Set());
    const released = Array.from({ length: tickCount }, () => new Set());

    for (const iv of timeline.intervals || []) {
      const b = iv.button;
      const s = Math.max(0, Math.min(tickCount, Math.round(iv.start / TICK)));
      const e = Math.max(0, Math.min(tickCount, Math.round(iv.end / TICK)));
      if (e <= s) continue;
      for (let t = s; t < e; t++) held[t].add(b);
      pressed[s].add(b);
      if (e < tickCount) released[e].add(b);
      else released[0].add(b); // 跨循环边界：release 回绕到 tick 0
    }
    return { tickCount, held, pressed, released };
  }

  // ---------- 姿态计算 ----------
  // 关键帧 { t:0..1, pose:{...} }；loop=true 时 t 回绕，否则夹到末帧
  function lerp(a, b, k) { return a + (b - a) * k; }

  function statePoseAt(state, ageSec) {
    const kf = state.keyframes && state.keyframes.length ? state.keyframes : [{ t: 0, pose: {} }];
    const frames = kf.slice().sort((a, b) => a.t - b.t);
    let t;
    if (state.loop) {
      const dur = state.duration > 0 ? state.duration : 1;
      t = (ageSec % dur) / dur;
    } else {
      if (!state.duration || state.duration <= 0) return { pose: frames[frames.length - 1].pose, localT: 1, onLast: true };
      t = Math.min(1, ageSec / state.duration);
      if (t >= 1) return { pose: frames[frames.length - 1].pose, localT: 1, onLast: true };
    }
    let i = 0;
    while (i < frames.length - 1 && frames[i + 1].t <= t) i++;
    if (i >= frames.length - 1) {
      // 循环且回绕到开头
      if (state.loop && frames.length > 1 && t < frames[0].t) {
        const a = frames[frames.length - 1];
        const b = frames[0];
        const span = 1 + b.t - a.t;
        const k = span > 0 ? (t + 1 - a.t) / span : 0;
        return { pose: lerpPose(a.pose, b.pose, k), localT: t, onLast: false };
      }
      return { pose: frames[frames.length - 1].pose, localT: t, onLast: !state.loop };
    }
    const a = frames[i];
    const b = frames[i + 1];
    const span = b.t - a.t || 1;
    const k = (t - a.t) / span;
    return { pose: lerpPose(a.pose, b.pose, k), localT: t, onLast: false };
  }

  function lerpPose(p1, p2, k) {
    const keys = new Set([...Object.keys(p1 || {}), ...Object.keys(p2 || {})]);
    const out = {};
    for (const key of keys) {
      const a = p1 && p1[key] !== undefined ? p1[key] : (p2 ? p2[key] : 0);
      const b = p2 && p2[key] !== undefined ? p2[key] : (p1 ? p1[key] : 0);
      out[key] = lerp(a, b, k);
    }
    return out;
  }

  // ---------- 仿真主循环 ----------
  function simulate(config, timeline, options) {
    options = options || {};
    const grid = buildInputGrid(timeline);
    const n = grid.tickCount;
    const stateMap = new Map(config.states.map((s) => [s.id, s]));
    const initial = config.initialState && stateMap.has(config.initialState)
      ? config.initialState : config.states[0].id;

    const sim = {
      current: initial,
      age: 0,
      blend: null,          // { fromState, fromPose, duration, elapsed, transitionId }
      activeTransition: null,
      queue: [],            // { transitionId, waited }
    };
    const frames = [];
    const events = [];
    const firstEntry = {}; // stateId -> tick
    const entryCount = {};

    function logEvent(ev) {
      ev.tick = frames.length;
      ev.time = +(ev.tick * TICK).toFixed(4);
      events.push(ev);
    }

    for (let tick = 0; tick < n; tick++) {
      const ctx = {
        pressed: grid.pressed[tick],
        released: grid.released[tick],
        held: grid.held[tick],
        stateAge: sim.age,
        finished: false,
      };
      const curState = stateMap.get(sim.current);
      if (curState && !curState.loop && curState.duration > 0) {
        ctx.finished = sim.age >= curState.duration;
      }

      // 1) 推进当前过渡（混合）
      if (sim.blend) {
        sim.blend.elapsed += TICK;
        if (sim.blend.elapsed >= sim.blend.duration) {
          logEvent({ type: 'blend-end', state: sim.current, transitionId: sim.blend.transitionId });
          sim.blend = null;
          sim.activeTransition = null;
        }
      }

      // 2) 队列老化 / 超时丢弃（先于受理：等待已久的请求可能在本 tick 先超时）
      for (const q of sim.queue) q.waited += TICK;
      sim.queue = sim.queue.filter((q) => {
        const tr = config.transitions.find((x) => x.id === q.transitionId);
        if (!tr) { logEvent({ type: 'queue-drop', reason: 'transition-deleted', transitionId: q.transitionId }); return false; }
        if (tr.queueMaxWait > 0 && q.waited >= tr.queueMaxWait) {
          logEvent({ type: 'queue-timeout', transitionId: tr.id, from: tr.from, to: tr.to, waited: +q.waited.toFixed(3) });
          return false;
        }
        return true;
      });

      // 3) 处理队首请求（无活动过渡 / 活动过渡允许打断时才可受理）
      //    受理用 acceptGates（电平语义），即时触发用 gates（按下沿语义）
      let firedThisTick = false;
      if (sim.queue.length && (!sim.blend || sim.activeTransition && sim.activeTransition.interruptible)) {
        const q = sim.queue[0];
        const tr = config.transitions.find((x) => x.id === q.transitionId);
        if (tr && tr.from === sim.current && evalCondition(acceptGatesOf(tr), ctx)) {
          sim.queue.shift();
          fire(tr, 'queued', tick);
          firedThisTick = true;
        }
      }
      // 4) 评估本 tick 的候选切换
      if (!firedThisTick) {
        const candidates = [];
        for (const tr of config.transitions) {
          if (tr.from !== sim.current || !tr.enabled) continue;
          const gateOk = evalCondition(tr.gates || [], ctx);
          candidates.push({ tr, gateOk });
        }
        candidates.sort((a, b) => (b.tr.priority || 0) - (a.tr.priority || 0));
        const fireable = candidates.filter((c) => c.gateOk);

        if (fireable.length) {
          const winner = fireable[0].tr;
          // 命中明细：同 tick 满足的全部条件及优先级
          logEvent({
            type: 'condition-eval',
            state: sim.current,
            matches: fireable.map((c) => ({ id: c.tr.id, priority: c.tr.priority || 0, target: c.tr.to })),
            winner: winner.id,
            losers: fireable.slice(1).map((c) => c.tr.id),
            inputs: {
              pressed: [...ctx.pressed], released: [...ctx.released], held: [...ctx.held],
            },
          });
          if (sim.blend && !(sim.activeTransition && sim.activeTransition.interruptible)) {
            // 活动过渡不允许打断
            const act = sim.activeTransition;
            handleBlocked(winner, act);
          } else {
            fire(winner, 'immediate', tick, candidates);
          }
        } else if (candidates.length && tick >= (options.logConsiderFromTick || 0)) {
          // 记录“为何停在原动作”的线索（只在有键事件的 tick 记，避免刷屏）
          if (ctx.pressed.size || ctx.released.size) {
            logEvent({
              type: 'no-match',
              state: sim.current,
              considered: candidates.map((c) => ({
                id: c.tr.id, to: c.tr.to, priority: c.tr.priority || 0,
                unsatisfied: (c.tr.gates || []).filter((g) => !evalAtom(g, ctx)).map(describeGate),
              })),
              inputs: {
                pressed: [...ctx.pressed], released: [...ctx.released], held: [...ctx.held],
              },
            });
          }
        }
      }

      // 5) 状态年龄推进
      sim.age += TICK;

      // 6) 记录帧与视觉姿态
      const base = statePoseAt(curState, sim.age);
      let pose = base.pose;
      let blendInfo = null;
      if (sim.blend) {
        const k = Math.min(1, sim.blend.elapsed / sim.blend.duration);
        const targetNow = statePoseAt(stateMap.get(sim.current), sim.age).pose;
        pose = lerpPose(sim.blend.fromPose, targetNow, k);
        blendInfo = {
          fromState: sim.blend.fromState,
          progress: +k.toFixed(3),
          transitionId: sim.blend.transitionId,
          interruptible: !!(sim.activeTransition && sim.activeTransition.interruptible),
        };
      }
      frames.push({
        tick,
        state: sim.current,
        stateAge: +sim.age.toFixed(4),
        localT: +base.localT.toFixed(4),
        finished: base.onLast,
        blending: blendInfo,
        queued: sim.queue.map((q) => q.transitionId),
        pose,
      });
    }

    return { frames, events, firstEntry, entryCount, tickCount: n, tick: TICK };

    // ---- 内部：触发切换 ----
    function fire(tr, source, tick, candidates) {
      const fromState = sim.current;
      const fromPose = frames.length ? frames[frames.length - 1].pose : statePoseAt(stateMap.get(fromState), sim.age).pose;
      logEvent({
        type: 'transition',
        transitionId: tr.id, from: fromState, to: tr.to,
        source, // immediate | queued
        interrupt: !!sim.blend,
        blendDuration: tr.blendDuration || 0,
      });
      if (sim.blend) {
        logEvent({ type: 'blend-interrupted', state: sim.current, transitionId: sim.blend.transitionId, by: tr.id });
      }
      sim.current = tr.to;
      sim.age = 0;
      sim.activeTransition = tr;
      sim.blend = {
        fromState,
        fromPose,
        duration: Math.max(TICK, tr.blendDuration || TICK),
        elapsed: 0,
        transitionId: tr.id,
      };
      if (firstEntry[tr.to] === undefined) firstEntry[tr.to] = tick;
      entryCount[tr.to] = (entryCount[tr.to] || 0) + 1;
    }

    // ---- 内部：请求被活动过渡阻挡 ----
    function handleBlocked(tr, act) {
      if (tr.blockMode === 'queue') {
        if (!sim.queue.some((q) => q.transitionId === tr.id)) {
          sim.queue.push({ transitionId: tr.id, waited: 0 });
          logEvent({
            type: 'queued', transitionId: tr.id, from: tr.from, to: tr.to,
            blockedBy: act ? act.id : null,
            maxWait: tr.queueMaxWait || 0,
          });
        } else {
          logEvent({ type: 'request-discarded', reason: 'already-queued', transitionId: tr.id });
        }
      } else {
        logEvent({
          type: 'request-discarded',
          reason: 'not-interruptible',
          transitionId: tr.id, from: tr.from, to: tr.to,
          activeTransition: act ? act.id : null,
          blendRemaining: sim.blend ? +(sim.blend.duration - sim.blend.elapsed).toFixed(3) : 0,
        });
      }
    }
  }

  function describeGate(g) {
    switch (g.kind) {
      case 'btn-press': return `按下 ${g.button}`;
      case 'btn-release': return `松开 ${g.button}`;
      case 'btn-held': return `按住 ${g.button}`;
      case 'btn-up': return `${g.button} 未按下`;
      case 'state-age': return `状态持续 ≥ ${g.minSec}s`;
      case 'state-finished': return `动作播完`;
      case 'always': return `无条件`;
      default: return g.kind;
    }
  }

  // ---------- 配置静态分析（lint） ----------
  // 返回 { reachable:Set, unreachable:[stateId], shadows:[{by, victim, ...}], other: [...] }
  function lintConfig(config) {
    const issues = [];
    const states = new Set(config.states.map((s) => s.id));
    const stateMap = new Map(config.states.map((s) => [s.id, s]));

    if (!config.initialState || !states.has(config.initialState)) {
      issues.push({ severity: 'error', code: 'bad-initial', message: '初始状态不存在', refs: [] });
    }

    // 引用完整性
    for (const tr of config.transitions) {
      if (!states.has(tr.from)) issues.push({ severity: 'error', code: 'bad-from', message: `切换 ${tr.id} 的源状态 ${tr.from} 不存在`, refs: [tr.id] });
      if (!states.has(tr.to)) issues.push({ severity: 'error', code: 'bad-to', message: `切换 ${tr.id} 的目标状态 ${tr.to} 不存在`, refs: [tr.id] });
      for (const g of tr.gates || []) {
        if (g.button && !(config.buttons || []).some((b) => b.id === g.button)) {
          issues.push({ severity: 'warn', code: 'bad-button', message: `切换 ${tr.id} 引用了不存在的按键 ${g.button}`, refs: [tr.id, g.button] });
        }
      }
      if (!(tr.gates || []).length) {
        issues.push({ severity: 'warn', code: 'empty-gates', message: `切换 ${tr.id} 无条件，进入源状态后会立即触发`, refs: [tr.id] });
      }
    }

    // 可达性 BFS
    const reachable = new Set();
    const queue = config.initialState && states.has(config.initialState) ? [config.initialState] : [];
    while (queue.length) {
      const s = queue.shift();
      if (reachable.has(s)) continue;
      reachable.add(s);
      for (const tr of config.transitions) {
        if (tr.from === s && states.has(tr.to) && !reachable.has(tr.to)) queue.push(tr.to);
      }
    }
    const unreachable = config.states.map((s) => s.id).filter((id) => !reachable.has(id));
    for (const id of unreachable) {
      issues.push({ severity: 'warn', code: 'unreachable-state', message: `状态 ${id} 从初始状态不可达`, refs: [id] });
    }
    for (const tr of config.transitions) {
      if (!reachable.has(tr.from)) {
        issues.push({ severity: 'warn', code: 'dead-transition', message: `切换 ${tr.id}（${tr.from}→${tr.to}）永远进不去：源状态不可达`, refs: [tr.id, tr.from] });
      }
    }

    // 遮蔽分析：同源、同触发类型，优先级更高且条件覆盖
    const byFrom = new Map();
    for (const tr of config.transitions) {
      if (!byFrom.has(tr.from)) byFrom.set(tr.from, []);
      byFrom.get(tr.from).push(tr);
    }
    for (const [from, list] of byFrom.entries()) {
      for (const victim of list) {
        for (const by of list) {
          if (by === victim || (by.priority || 0) <= (victim.priority || 0)) continue;
          if (!by.enabled || !victim.enabled) continue;
          if (!reachable.has(from)) continue;
          const vKinds = new Set((victim.gates || []).map((g) => g.kind));
          const bKinds = new Set((by.gates || []).map((g) => g.kind));
          let sameTrigger = false;
          for (const k of vKinds) {
            if (k.startsWith('btn-') && bKinds.has(k)) { sameTrigger = true; break; }
          }
          if (!sameTrigger && vKinds.has('always') && bKinds.has('always')) sameTrigger = true;
          if (!sameTrigger) continue;
          if (conditionCovers(by.gates || [], victim.gates || [])) {
            issues.push({
              severity: 'warn', code: 'shadowed',
              message: `切换 ${victim.id} 可能永远进不去：${by.id} 优先级更高且条件更宽松，会先命中`,
              refs: [victim.id, by.id, from],
              by: by.id, victim: victim.id, state: from,
            });
          }
        }
      }
    }

    // 有限状态没有“播完”出路：会卡在末帧
    for (const s of config.states) {
      if (s.loop || !s.duration || s.duration <= 0) continue;
      const hasFinish = config.transitions.some((tr) =>
        tr.from === s.id && (tr.gates || []).some((g) => g.kind === 'state-finished' || g.kind === 'always'));
      if (!hasFinish) {
        issues.push({ severity: 'info', code: 'no-finish-exit', message: `有限动作 ${s.id} 播完后没有出口，将停在末帧`, refs: [s.id] });
      }
    }

    return { issues, reachable, unreachable };
  }

  // 给定一次条件编辑，返回受影响的状态与可能失效的切换（供页面高亮）
  function impactOfEdit(config, transitionId) {
    const tr = config.transitions.find((x) => x.id === transitionId);
    if (!tr) return { states: [], transitions: [] };
    const states = new Set([tr.from, tr.to]);
    const transitions = [];
    for (const other of config.transitions) {
      if (other.id === tr.id) continue;
      if (other.from === tr.from || other.to === tr.from) {
        states.add(other.from); states.add(other.to);
        transitions.push(other.id);
      }
    }
    const lint = lintConfig(config);
    const dead = lint.issues
      .filter((i) => i.code === 'shadowed' || i.code === 'dead-transition')
      .map((i) => ({ code: i.code, message: i.message, refs: i.refs }));
    return { states: [...states], transitions, dead };
  }

  return {
    TICK,
    simulate,
    lintConfig,
    impactOfEdit,
    evalAtom,
    evalCondition,
    conditionCovers,
    atomCovers,
    statePoseAt,
    lerpPose,
    buildInputGrid,
    describeGate,
  };
});
