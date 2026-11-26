// 触发区事件引擎：确定性、无 DOM 依赖，可在浏览器与 Node 中运行。
//
// 设计要点：
// - 固定区域顺序：事件按 zones 数组顺序（id 升序）逐区评估，同一时刻多区变化
//   也保持确定顺序，不依赖哈希遍历。
// - 每区独立计时：停留累计、宽限窗、一次性标记互不影响。
// - 边界闭区间 + 退出宽限（graceMs）：线上挪动/抖动不会重复刷进入事件。
// - 动作规则按区配置：walk / teleportLand / teleportExit / dash 决定是否算数。
// - 禁用期间冻结一切；重新启用时按当前实际位置对账并给出明确原因。

import { pointInZone, sampleSegment, segmentIntersectsZone } from './geometry.js';
import { ACTION, EVENT, normalizeRules } from './events.js';

let zoneSeq = 0;

export function createZone(config) {
  const id = config.id ?? `z${++zoneSeq}`;
  const rules = normalizeRules(config.rules ?? {});
  return {
    id,
    name: config.name ?? id,
    color: config.color ?? '#2a78d6',
    shape: config.shape, // 'circle' | 'rect' | 'polygon'
    center: config.center,
    radius: config.radius,
    rect: config.rect,
    points: config.points,
    // 触发模式：once = 一次触发（每类事件各一次），every = 每次都触发
    triggerMode: config.triggerMode ?? 'every',
    // 停留事件间隔（ms）；0 表示不产生停留事件
    stayIntervalMs: config.stayIntervalMs ?? 500,
    // 退出宽限：离开后多少 ms 内回来视为未离开，抑制重复进入
    graceMs: config.graceMs ?? 120,
    enabled: config.enabled !== false,
    rules,
    createdAt: config.createdAt ?? 0,
  };
}

function freshZoneState() {
  return {
    inside: false,          // 当前是否在区内
    dwellMs: 0,             // 本次在内累计停留（宽限返回时保留，正式退出后清零）
    nextStayAt: 0,          // 下一次停留事件的时间阈值
    sinceFrame: -1,         // 本次连续在内的起始帧
    sinceTime: 0,
    graceUntil: -1,         // 宽限截止时间；-1 表示不在宽限中
    fired: { enter: false, exit: false, stay: false }, // once 模式的已发标记
    counts: { enter: 0, exit: 0, stay: 0 },
    lastEvent: null,
  };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

export function createEngine() {
  const zones = [];
  const state = new Map(); // zoneId -> runtime state
  const events = [];
  let frameIndex = -1;
  let currentTime = 0;
  let pos = null;
  let lastFrame = null;
  let eventSeq = 0;

  function zoneById(id) {
    return zones.find((z) => z.id === id);
  }

  function ensureState(id) {
    if (!state.has(id)) state.set(id, freshZoneState());
    return state.get(id);
  }

  function emit(zone, st, type, frame, reason, extra = {}) {
    if (zone.triggerMode === 'once' && st.fired[type]) return null;
    const ev = {
      seq: ++eventSeq,
      frame: frame.index,
      time: frame.time,
      zoneId: zone.id,
      zoneName: zone.name,
      type,
      action: frame.action,
      reason,
      ...extra,
    };
    events.push(ev);
    st.counts[type]++;
    st.fired[type] = true;
    st.lastEvent = ev;
    return ev;
  }

  // 计算一帧内每个区域的几何/策略事实（按 zones 固定顺序）
  function evaluateFrame(frame) {
    const facts = [];
    for (const zone of zones) {
      const fact = {
        zone,
        insideNow: false,      // 策略判定下本帧是否“在内”
        geometricInside: false,
        crossed: false,
        crossAtMs: null,
        teleportFromInside: false,
        exitIgnored: false,    // 本动作的离开按规则应被忽略
      };
      if (!zone.enabled) {
        facts.push(fact);
        continue;
      }
      const p = frame.pos;
      fact.geometricInside = pointInZone(p, zone);

      if (frame.action === ACTION.TELEPORT) {
        // 瞬移是不连续跳变：只看落点与起点，不做线段穿越
        fact.teleportFromInside = frame.from ? pointInZone(frame.from, zone) : false;
        if (fact.geometricInside && zone.rules.teleportLand) fact.insideNow = true;
        // 瞬移出区且规则不算时，忽略本次离开（状态直接静默置外，不发退出）
        if (
          fact.teleportFromInside &&
          !fact.geometricInside &&
          !zone.rules.teleportExit
        ) {
          fact.exitIgnored = true;
        }
      } else if (frame.action === ACTION.DASH) {
        const from = frame.from ?? p;
        const samples = sampleSegment(from, p, zone.rules.dashSampleStep);
        const hitIdx = samples.findIndex((s) => pointInZone(s, zone));
        fact.crossed = segmentIntersectsZone(from, p, zone) || hitIdx >= 0;
        fact.sampleHit = hitIdx;
        fact.sampleCount = samples.length;
        if (zone.rules.dash && (fact.crossed || fact.geometricInside)) {
          fact.insideNow = true;
          if (hitIdx > 0) {
            fact.crossAtMs = Math.round(
              (hitIdx / (samples.length - 1 || 1)) * frame.durationMs
            );
          }
        }
      } else {
        // walk / idle
        if (fact.geometricInside && zone.rules.walk) fact.insideNow = true;
      }
      facts.push(fact);
    }
    return facts;
  }

  function reasonEnter(frame, zone, fact) {
    switch (frame.action) {
      case ACTION.WALK:
        return '步行越过边界，落点在区内';
      case ACTION.IDLE:
        return '静止状态位于区内';
      case ACTION.TELEPORT:
        return `瞬移落点在区内（teleportLand=${zone.rules.teleportLand ? '算' : '不算'}）`;
      case ACTION.DASH:
        return fact.crossAtMs != null
          ? `高速线段采样第 ${fact.sampleHit + 1}/${fact.sampleCount} 点穿入，约 +${fact.crossAtMs}ms（dash=${zone.rules.dash ? '算' : '不算'}）`
          : `高速移动终点落在区内（dash=${zone.rules.dash ? '算' : '不算'}）`;
      default:
        return '进入区域';
    }
  }

  function reasonExit(frame, zone, fact, disabled = false) {
    if (disabled) return '区域被禁用，按当前位置对账强制退出';
    switch (frame.action) {
      case ACTION.TELEPORT:
        return fact.teleportFromInside
          ? `瞬移起点在区内、落点在区外（teleportExit=${zone.rules.teleportExit ? '算' : '不算'}）`
          : '瞬移后位于区外';
      case ACTION.DASH:
        return '高速移动后位于区外';
      case ACTION.IDLE:
        return '静止/停住后位于区外，宽限到期';
      default:
        return '步行离开区域，宽限到期';
    }
  }

  // 推进一帧。frame: { time, pos, action, from?, durationMs? }
  function pushFrame(frame) {
    frameIndex++;
    currentTime = frame.time;
    pos = frame.pos;
    const dt = lastFrame ? frame.time - lastFrame.time : 0;
    const f = { ...frame, index: frameIndex, dtMs: dt };
    const facts = evaluateFrame(f);
    const produced = [];

    facts.forEach((fact) => {
      const zone = fact.zone;
      const st = ensureState(zone.id);

      if (!zone.enabled) {
        if (st.inside) {
          st.inside = false;
          st.sinceFrame = -1;
          st.graceUntil = -1;
          st.dwellMs = 0;
          st.nextStayAt = 0;
          const ev = emit(zone, st, EVENT.EXIT, f, reasonExit(f, zone, fact, true));
          if (ev) produced.push(ev);
        }
        st.graceUntil = -1;
        return;
      }

      const wasInside = st.inside;
      const inGrace = st.graceUntil >= f.time;

      if (fact.insideNow) {
        if (!wasInside) {
          if (inGrace) {
            // 宽限内返回：不发进入，状态延续，保留已累计 dwell
            st.graceUntil = -1;
            st.inside = true;
            st.sinceFrame = f.index;
            if (st.dwellMs === 0) {
              st.dwellMs = 0;
              st.nextStayAt = f.time + zone.stayIntervalMs;
              st.sinceTime = f.time;
            } else {
              st.nextStayAt = f.time + zone.stayIntervalMs;
              st.sinceTime = f.time - st.dwellMs;
            }
          } else {
            st.inside = true;
            st.sinceFrame = f.index;
            st.sinceTime = f.time;
            st.dwellMs = 0;
            st.nextStayAt = f.time + zone.stayIntervalMs;
            const ev = emit(zone, st, EVENT.ENTER, f, reasonEnter(f, zone, fact));
            if (ev) produced.push(ev);
          }
        }
        st.graceUntil = -1;

        // 停留：按绝对时间阈值触发，帧步长不整除也不漏发
        if (zone.stayIntervalMs > 0 && st.inside) {
          st.dwellMs += dt;
          while (zone.stayIntervalMs > 0 && f.time >= st.nextStayAt && st.nextStayAt > 0) {
            const ev = emit(
              zone,
              st,
              EVENT.STAY,
              f,
              `区内累计停留 ${Math.round(st.dwellMs)}ms，达到 ${zone.stayIntervalMs}ms 间隔`,
              { dwellMs: Math.round(st.dwellMs) }
            );
            if (ev) produced.push(ev);
            st.nextStayAt += zone.stayIntervalMs;
          }
        }
      } else if (wasInside) {
        if (fact.exitIgnored) {
          // 规则忽略本次离开（如 teleportExit=false）：静默置外，不发退出、不走宽限
          st.inside = false;
          st.sinceFrame = -1;
          st.graceUntil = -1;
          st.dwellMs = 0;
          st.nextStayAt = 0;
          return;
        }
        // 离开：进入宽限窗。graceMs=0 时下一帧立刻到期。
        st.inside = false;
        st.sinceFrame = -1;
        st.graceUntil = f.time + zone.graceMs;
      }

      // 宽限到期且仍不在内 -> 正式退出，清空累计
      if (!st.inside && st.graceUntil >= 0 && f.time >= st.graceUntil) {
        st.graceUntil = -1;
        st.dwellMs = 0;
        st.nextStayAt = 0;
        const ev = emit(zone, st, EVENT.EXIT, f, reasonExit(f, zone, fact));
        if (ev) produced.push(ev);
      }
    });

    lastFrame = f;
    return produced;
  }

  // 显式启用/禁用；重新启用时按当前位置对账
  function setEnabled(id, enabled) {
    const zone = zoneById(id);
    if (!zone || zone.enabled === enabled) return [];
    zone.enabled = enabled;
    const st = ensureState(id);
    const produced = [];
    const f = { time: currentTime, action: ACTION.IDLE, pos, index: frameIndex };
    if (!enabled && st.inside) {
      st.inside = false;
      st.sinceFrame = -1;
      st.graceUntil = -1;
      st.dwellMs = 0;
      st.nextStayAt = 0;
      const ev = emit(zone, st, EVENT.EXIT, f, reasonExit(f, zone, {}, true));
      if (ev) produced.push(ev);
    }
    if (enabled && pos) {
      const geometricInside = pointInZone(pos, zone);
      if (geometricInside && zone.rules.walk) {
        st.graceUntil = -1;
        st.inside = true;
        st.sinceFrame = frameIndex;
        st.sinceTime = currentTime;
        st.dwellMs = st.dwellMs || 0;
        st.nextStayAt = currentTime + zone.stayIntervalMs;
        const ev = emit(
          zone,
          st,
          EVENT.ENTER,
          f,
          st.fired.enter
            ? '重新启用：角色当前位于区内，对账恢复在内状态（once 已触发，不再发进入）'
            : '重新启用：角色当前位于区内，对账补发进入'
        );
        if (ev) produced.push(ev);
      }
    }
    return produced;
  }

  // 重置单个区域的运行态（once 标记、计时、计数）
  function resetZone(id) {
    const zone = zoneById(id);
    if (!zone) return;
    state.set(id, freshZoneState());
    if (pos && zone.enabled && pointInZone(pos, zone) && zone.rules.walk) {
      const st = state.get(id);
      st.inside = true;
      st.sinceFrame = frameIndex;
      st.sinceTime = currentTime;
      st.nextStayAt = currentTime + zone.stayIntervalMs;
    }
  }

  function snapshot() {
    return {
      frameIndex,
      currentTime,
      pos: pos ? { ...pos } : null,
      zones: zones.map((z) => ({ ...z, rules: { ...z.rules } })),
      zoneState: zones.map((z) => [z.id, clone(ensureState(z.id))]),
      events: events.map((e) => ({ ...e })),
    };
  }

  function restore(snap) {
    zones.length = 0;
    state.clear();
    events.length = 0;
    for (const z of snap.zones) zones.push({ ...z, rules: { ...z.rules } });
    for (const [id, st] of snap.zoneState) state.set(id, st);
    events.push(...snap.events);
    frameIndex = snap.frameIndex;
    currentTime = snap.currentTime;
    pos = snap.pos ? { ...snap.pos } : null;
    lastFrame = null;
  }

  return {
    addZone(config) {
      const z = createZone(config);
      zones.push(z);
      ensureState(z.id);
      // 固定顺序：id 升序，保证同帧事件顺序确定
      zones.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return z;
    },
    removeZone(id) {
      const i = zones.findIndex((z) => z.id === id);
      if (i >= 0) {
        zones.splice(i, 1);
        state.delete(id);
      }
    },
    updateZone(id, patch) {
      const z = zoneById(id);
      if (!z) return;
      Object.assign(z, patch);
      if (patch.rules) z.rules = normalizeRules(patch.rules);
    },
    zones,
    getState: ensureState,
    pushFrame,
    setEnabled,
    resetZone,
    zoneById,
    snapshot,
    restore,
    resetCounters() {
      // 完整运行态重置：帧号、时间、位置、每区状态、事件与序号全部归零（区域配置保留）
      frameIndex = -1;
      currentTime = 0;
      pos = null;
      lastFrame = null;
      eventSeq = 0;
      for (const z of zones) state.set(z.id, freshZoneState());
      events.length = 0;
    },
    clearEvents() {
      events.length = 0;
    },
    get events() {
      return events;
    },
    get time() {
      return currentTime;
    },
    get frameIndex() {
      return frameIndex;
    },
    get position() {
      return pos;
    },
  };
}
