'use strict';
/* ============================================================
 * 波次入场预演 —— 确定性模拟引擎
 * 固定步长（1 tick = 0.1s），种子化哈希随机，全状态可快照。
 * 相同配置 + 相同运行期关门记录 => 入场/离场顺序完全可复现。
 * ============================================================ */

const TICKS_PER_SEC = 10;

// ---------- 确定性工具 ----------
function hashStr(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 由任意若干部分生成 [0,1) 的确定性伪随机数（与调用顺序无关）
function rand01(...parts) {
  return mulberry32(hashStr(parts.join('|')))();
}

const fmtT = tick => (tick / TICKS_PER_SEC).toFixed(1) + 's';

class Sim {
  /**
   * config: {
   *   name, seed,
   *   nodes: [{id,x,y,type:'entrance'|'junction'|'field'|'exit',label,rx?,ry?}],
   *   edges: [{id,from,to,time(秒),cap(同时通行数),closures:[{start,end,label}]}],
   *   routes: [{id, enter:[[候选...]...], exit:[[候选...]...]}]
   *           候选: {edge, weight?}  —— 有 weight 按权重随机(确定性)，否则按顺序取第一条可用
   *   waves: [{id,name,color,priority?,batches:[{id?,count,entrance,route,dwell(秒,0=不离场),
   *            trigger:{type:'time',at}|{type:'afterBatch',batch,delay?}|
   *                     {type:'fieldBelow'|'fieldAbove',value}, notBefore?}]}]
   * }
   */
  constructor(config, opts = {}) {
    this.config = config;
    this.keepSnapshots = opts.snapshots !== false;
    this.reset();
  }

  reset() {
    const cfg = this.config;
    this.tick = 0;
    this.done = false;
    this.queueSeq = 0;
    this.events = [];
    this.sequence = [];            // 入场/离场顺序记录（用于复现校验哈希）
    this.metrics = [];             // 每 tick {t, waiting, onfield, departed}
    this.snapshots = [];
    this.runtimeClosures = [];     // 运行期手动关门 {edge,start,end}
    this.peak = { waiting: 0, tick: 0 };
    this.onfieldNow = 0;

    this.nodes = {};
    cfg.nodes.forEach(n => (this.nodes[n.id] = { ...n }));
    this.edgeList = cfg.edges.map(e => ({ ...e, cap: e.cap ?? Infinity, users: [], _open: undefined }));
    this.edges = {};
    this.edgeList.forEach(e => (this.edges[e.id] = e));
    this.routes = {};
    cfg.routes.forEach(r => (this.routes[r.id] = r));

    this.waves = cfg.waves.map((w, i) => ({ ...w, idx: i, priority: w.priority ?? i }));
    this.batches = [];
    this.chars = [];
    for (const w of this.waves) {
      w.batches.forEach((b, bi) => {
        const batch = {
          ...b,
          id: b.id || `${w.id}b${bi + 1}`,
          waveId: w.id, waveIdx: w.idx,
          state: 'pending', triggerTick: null, arrived: 0, doneTick: null,
        };
        this.batches.push(batch);
        for (let i = 0; i < b.count; i++) {
          this.chars.push({
            id: `${batch.id}c${i + 1}`, wave: w.id, color: w.color,
            batch: batch.id, route: b.route, dwell: b.dwell ?? 0,
            state: 'pending', node: null, edge: null,
            edgePos: 0, edgeTime: 1, leg: 0, phase: 'enter',
            queueSeq: 0, queuedTick: null, enterTick: null, exitTick: null,
            dwellUntil: Infinity,
          });
        }
      });
    }
    this.batchMap = {};
    this.batches.forEach(b => (this.batchMap[b.id] = b));
    this.charMap = {};
    this.chars.forEach(c => (this.charMap[c.id] = c));
    this.records = this.chars.map(c => ({
      id: c.id, wave: c.wave, batch: c.batch,
      queued: null, entered: null, exited: null, wait: null,
    }));
    this.recordMap = {};
    this.records.forEach(r => (this.recordMap[r.id] = r));

    this.log(0, 'init', `配置加载：${this.chars.length} 个角色 / ${this.batches.length} 个批次 / ${this.edgeList.length} 条通道`);
    if (this.keepSnapshots) this.snapshots.push(this.snapshot());
  }

  // ---------- 基础查询 ----------
  fieldNodeId() { return Object.values(this.nodes).find(n => n.type === 'field').id; }
  waveOf(c) { return this.waves[this.batchMap[c.batch].waveIdx]; }
  routeLegs(c) {
    const r = this.routes[c.route];
    return c.phase === 'enter' ? r.enter : r.exit;
  }
  edgeOpenAt(e, tSec) {
    for (const c of e.closures || []) if (tSec >= c.start && tSec < c.end) return false;
    for (const c of this.runtimeClosures) if (c.edge === e.id && tSec >= c.start && tSec < c.end) return false;
    return true;
  }
  // 候选边中，从当前节点出发且未关闭的；带权重则确定性加权随机，否则取顺序第一
  chooseEdge(c, cands, tSec) {
    const open = cands.filter(cd => {
      const e = this.edges[cd.edge];
      return e && e.from === c.node && this.edgeOpenAt(e, tSec);
    });
    if (!open.length) return null;
    if (open.some(cd => cd.weight != null)) {
      const total = open.reduce((s, cd) => s + (cd.weight ?? 1), 0);
      let r = rand01(this.config.seed, c.id, 'leg', c.leg, c.phase) * total;
      for (const cd of open) { r -= (cd.weight ?? 1); if (r < 0) return this.edges[cd.edge]; }
      return this.edges[open[open.length - 1].edge];
    }
    return this.edges[open[0].edge];
  }
  checkTrigger(tr, t) {
    if (tr.notBefore && t < tr.notBefore) return false;
    switch (tr.type) {
      case 'time': return t >= tr.at;
      case 'afterBatch': {
        const b = this.batchMap[tr.batch];
        return !!b && b.doneTick != null && t >= b.doneTick / TICKS_PER_SEC + (tr.delay ?? 0);
      }
      case 'fieldBelow': return this.onfieldNow <= tr.value;
      case 'fieldAbove': return this.onfieldNow >= tr.value;
      default: return false;
    }
  }

  // ---------- 主循环 ----------
  step() {
    if (this.done) return;
    const t = this.tick / TICKS_PER_SEC;

    // 1. 通道开/关状态变化事件
    for (const e of this.edgeList) {
      const open = this.edgeOpenAt(e, t);
      if (e._open === undefined) e._open = open;
      if (open !== e._open) {
        this.log(this.tick, open ? 'edge-open' : 'edge-close',
          `通道 ${e.id} ${open ? '恢复通行' : '临时关闭'}`);
        e._open = open;
      }
    }

    // 2. 批次触发（按 波次→批次 配置顺序，确定性）
    for (const b of this.batches) {
      if (b.state !== 'pending') continue;
      if (this.checkTrigger(b.trigger, t)) {
        b.state = 'triggered';
        b.triggerTick = this.tick;
        const w = this.waves[b.waveIdx];
        let n = 0;
        for (const c of this.chars) {
          if (c.batch === b.id && c.state === 'pending') {
            c.state = 'queued'; c.node = b.entrance; c.leg = 0; c.phase = 'enter';
            c.queueSeq = this.queueSeq++; c.queuedTick = this.tick;
            this.recordMap[c.id].queued = this.tick;
            n++;
          }
        }
        this.log(this.tick, 'trigger', `批次 ${b.id}（${w.name}）触发，${n} 人到 ${b.entrance} 排队`);
      }
    }

    // 3. 放行：每个节点按 (波次优先级, 排队序号) 顺序尝试上通道
    //    通道容量全波次共享 —— 同一时刻多个波次不会多占通道
    const byNode = {};
    for (const c of this.chars) if (c.state === 'queued') (byNode[c.node] ??= []).push(c);
    for (const nodeId of Object.keys(byNode)) {
      const q = byNode[nodeId].sort((a, b) =>
        (this.waveOf(a).priority - this.waveOf(b).priority) || (a.queueSeq - b.queueSeq));
      for (const c of q) {
        const legs = this.routeLegs(c);
        const cands = legs[c.leg];
        if (!cands) continue;                            // 路线已走完（配置异常），就地等待
        const edge = this.chooseEdge(c, cands, t);       // 放行时才选路：未出发者按最新开闭状态走
        if (!edge) continue;                             // 当前节点无可走通道，继续等
        if (edge.users.length >= edge.cap) continue;     // 通道满员，继续等
        c.state = 'moving'; c.edge = edge.id;
        c.edgeTime = Math.max(1, Math.round(edge.time * TICKS_PER_SEC));
        c.edgePos = c.edgeTime;
        edge.users.push(c.id);
        c.node = null;
      }
    }

    // 4. 通道上移动 & 到达
    for (const e of this.edgeList) {
      if (!e.users.length) continue;
      const remain = [];
      for (const cid of e.users) {
        const c = this.charMap[cid];
        c.edgePos--;
        if (c.edgePos > 0) { remain.push(cid); continue; }
        c.edge = null;
        this.arrive(c, e.to);
      }
      e.users = remain;
    }

    // 5. 场上驻留结束 → 去排离场通道
    for (const c of this.chars) {
      if (c.state === 'onfield' && this.tick >= c.dwellUntil) {
        c.state = 'queued'; c.node = this.fieldNodeId();
        c.leg = 0; c.phase = 'exit'; c.queueSeq = this.queueSeq++;
      }
    }

    // 6. 指标 & 峰值
    let waiting = 0, onfield = 0, departed = 0;
    for (const c of this.chars) {
      if (c.state === 'queued') waiting++;
      else if (c.state === 'onfield') onfield++;
      else if (c.state === 'departed') departed++;
    }
    this.onfieldNow = onfield;
    if (waiting > this.peak.waiting) this.peak = { waiting, tick: this.tick };
    this.metrics.push({ t: this.tick, waiting, onfield, departed });

    // 7. 结束判定：全部批次已触发，且所有角色已离场或永久驻留场上
    const allSettled = this.batches.every(b => b.state !== 'pending') &&
      this.chars.every(c => c.state === 'departed' || (c.state === 'onfield' && c.dwell === 0));
    if (allSettled) {
      this.done = true;
      this.log(this.tick, 'done',
        `全部完成：峰值等待 ${this.peak.waiting} 人 @ ${fmtT(this.peak.tick)}，哈希 ${this.hash()}`);
    }
    this.tick++;
    // 快照在 tick 自增之后：标签为 N 的快照 = 已完成 N 步的状态，恢复后不会重放第 N 步
    if (this.keepSnapshots && this.tick % 25 === 0) this.snapshots.push(this.snapshot());
  }

  arrive(c, nodeId) {
    const node = this.nodes[nodeId];
    if (node.type === 'field' && c.phase === 'enter') {
      c.state = 'onfield'; c.node = nodeId; c.enterTick = this.tick;
      c.dwellUntil = c.dwell > 0 ? this.tick + Math.round(c.dwell * TICKS_PER_SEC) : Infinity;
      const rec = this.recordMap[c.id];
      rec.entered = this.tick; rec.wait = this.tick - (rec.queued ?? this.tick);
      const b = this.batchMap[c.batch];
      b.arrived++;
      this.sequence.push(`${c.id}e${this.tick}`);
      if (b.arrived === b.count) {
        b.doneTick = this.tick; b.state = 'done';
        this.log(this.tick, 'batch-done', `批次 ${b.id} 全部入场（末人 ${fmtT(this.tick)}）`);
      }
    } else if (node.type === 'exit') {
      // 离场是终态：已离场角色永远不会回到等待队列
      c.state = 'departed'; c.node = nodeId; c.exitTick = this.tick;
      this.recordMap[c.id].exited = this.tick;
      this.sequence.push(`${c.id}x${this.tick}`);
    } else {
      c.state = 'queued'; c.node = nodeId; c.leg++; c.queueSeq = this.queueSeq++;
    }
  }

  runTo(targetTick, maxTicks = 60000) {
    while (this.tick < targetTick && !this.done && this.tick < maxTicks) this.step();
  }

  // ---------- 运行期手动关门（记录进状态，重跑可复现） ----------
  toggleEdge(edgeId) {
    const t = this.tick / TICKS_PER_SEC;
    const open = this.runtimeClosures.find(c => c.edge === edgeId && c.end === Infinity);
    if (open) {
      open.end = t;
      this.log(this.tick, 'edge-open', `通道 ${edgeId} 手动恢复（${fmtT(this.tick)}）`);
    } else {
      this.runtimeClosures.push({ edge: edgeId, start: t, end: Infinity });
      this.log(this.tick, 'edge-close', `通道 ${edgeId} 手动关闭（${fmtT(this.tick)}）`);
    }
    // 手动操作发生在当前 tick 边界：丢弃不晚于当前 tick 的旧快照，改记操作后的状态，
    // 否则回溯到本 tick 会丢失这次手动操作
    if (this.keepSnapshots) {
      this.snapshots = this.snapshots.filter(sn => sn.tick < this.tick);
      this.snapshots.push(this.snapshot());
    }
  }

  // ---------- 快照 / 回放 ----------
  snapshot() {
    return structuredClone({
      tick: this.tick, done: this.done, queueSeq: this.queueSeq,
      events: this.events, sequence: this.sequence, metrics: this.metrics,
      peak: this.peak, onfieldNow: this.onfieldNow,
      batches: this.batches, chars: this.chars, records: this.records,
      edgeUsers: this.edgeList.map(e => e.users.slice()),
      edgeOpen: this.edgeList.map(e => e._open),
      runtimeClosures: this.runtimeClosures,
    });
  }
  restore(s) {
    this.tick = s.tick; this.done = s.done; this.queueSeq = s.queueSeq;
    this.events = s.events; this.sequence = s.sequence; this.metrics = s.metrics;
    this.peak = s.peak; this.onfieldNow = s.onfieldNow;
    this.batches = s.batches; this.chars = s.chars; this.records = s.records;
    this.runtimeClosures = s.runtimeClosures;
    this.batchMap = {}; this.batches.forEach(b => (this.batchMap[b.id] = b));
    this.charMap = {}; this.chars.forEach(c => (this.charMap[c.id] = c));
    this.recordMap = {}; this.records.forEach(r => (this.recordMap[r.id] = r));
    this.edgeList.forEach((e, i) => { e.users = s.edgeUsers[i].slice(); e._open = s.edgeOpen[i]; });
    // 快照列表截断到当前时点之前
    this.snapshots = this.snapshots.filter(sn => sn.tick <= this.tick);
  }
  seek(targetTick) {
    if (targetTick < this.tick) {
      let best = null;
      for (const sn of this.snapshots) if (sn.tick <= targetTick) best = sn;
      if (best) this.restore(structuredClone(best));
      else if (this.tick > targetTick) { this.reset(); }
    }
    this.runTo(targetTick);
  }

  // ---------- 复现校验 ----------
  hash() {
    return hashStr(this.sequence.join(',')).toString(16).padStart(8, '0');
  }

  log(tick, type, text) { this.events.push({ tick, type, text }); }
}

// 触发器的人类可读描述
function triggerDesc(tr) {
  const nb = tr.notBefore ? `（${tr.notBefore}s 后评估）` : '';
  switch (tr.type) {
    case 'time': return `t=${tr.at}s 定时`;
    case 'afterBatch': return `批次 ${tr.batch} 全部入场后 ${tr.delay ?? 0}s`;
    case 'fieldBelow': return `场上 ≤ ${tr.value} 人${nb}`;
    case 'fieldAbove': return `场上 ≥ ${tr.value} 人${nb}`;
    default: return JSON.stringify(tr);
  }
}
