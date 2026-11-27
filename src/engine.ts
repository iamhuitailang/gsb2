// ============================================================
// 输入指令判定引擎（纯逻辑，不依赖 DOM）
// 设计要点：
//  - 一切判定按“游戏时间”(ms) 走，引擎只认事件时间戳与内部定时器，
//    与外部帧率无关：同一份事件记录在任何刷新率下重放结果一致。
//  - 指令 = 若干步骤的序列；步骤支持 短按(tap) / 长按(hold) / 同时按(chord)。
//  - 冲突规则（明确、确定）：
//      1) 一条指令凑齐时，若还有“以它为前缀”的更长候选存活，则挂起等待后续输入；
//      2) 挂起者在其所有更长候选都死亡后生效；
//      3) 多条指令同时可生效时：priority 高者优先 → 步数多者优先 → 凑齐时间早者优先；
//      4) 生效指令消费掉它用到的输入事件，其它引用这些事件的候选全部丢弃，
//         一次按键绝不被两个动作重复用掉。
//  - 当前动作不可打断时，成立的指令进入预存(buffer)，超 bufferMs 未生效则失效；
//    动作结束瞬间若预存仍有效，立即切换并说明由哪条指令触发。
// ============================================================

export interface TapStep { kind: 'tap'; key: string }
export interface HoldStep { kind: 'hold'; key: string; minMs: number }
export interface ChordStep { kind: 'chord'; keys: string[]; windowMs: number }
export type Step = TapStep | HoldStep | ChordStep;

export interface CommandDef {
  name: string;
  shape: 'circle' | 'triangle' | 'square' | 'diamond' | 'pentagon';
  color: string;
  steps: Step[];
  stepWindowMs: number;   // 相邻两步之间允许的最大间隔
  priority: number;       // 冲突时高者优先
  actionMs: number;       // 动作持续时间（游戏时间）
  interruptible: boolean; // 动作是否可被打断
}

export interface EngineConfig {
  tapMaxMs: number;   // 短按：按下到松开的最大时长
  bufferMs: number;   // 预存指令的有效期
  commands: CommandDef[];
}

export interface InputEvent { id: number; t: number; key: string; type: 'down' | 'up' }

export type LogKind =
  | 'event' | 'ignore' | 'candidate' | 'discard' | 'pending'
  | 'command' | 'action' | 'buffer';

export interface LogEntry { t: number; kind: LogKind; text: string }

interface PartialState {
  downId?: number; downT?: number;                 // tap / hold
  chordDowns?: Map<string, number>; chordFirstT?: number; // chord: key -> eventId
}

export interface Cand {
  id: number;
  cmd: CommandDef;
  stepIdx: number;          // 下一步要匹配的步骤下标
  used: number[];           // 已提交（完成步骤）的事件 id
  stepDoneTs: number[];     // 每一步完成的时间
  startT: number;
  lastT: number;            // 上一步完成时间（候选创建时为 startT）
  partial: PartialState | null; // 当前步骤进行中的状态
  state: 'active' | 'pending' | 'fired' | 'dead';
  completedT?: number;      // 指令凑齐时间（挂起前）
  fireT?: number;
  deadT?: number;
  deadReason?: string;
}

export interface ActionEpisode {
  name: string; shape: CommandDef['shape']; color: string;
  startT: number; endT: number; source: '即时' | '预存';
}

interface Timer { t: number; kind: string; cand?: Cand }

const TIMER_ORDER: Record<string, number> = {
  'hold-complete': 0, 'action-end': 1, 'buffer-expire': 2,
  'step-gap': 3, 'tap-expire': 4, 'chord-expire': 5,
};

export class Engine {
  cfg: EngineConfig;
  events: InputEvent[] = [];
  cursor = 0;
  now = 0;

  cands: Cand[] = [];
  private nextCandId = 1;
  consumed = new Set<number>();
  downKeys = new Map<string, number>(); // key -> down eventId
  log: LogEntry[] = [];

  action: { cmd: CommandDef; startT: number; endT: number } | null = null;
  buffered: { cmd: CommandDef; t: number; expireAt: number } | null = null;
  episodes: ActionEpisode[] = [];

  constructor(cfg: EngineConfig) { this.cfg = cfg; }

  load(events: InputEvent[]): void {
    // 稳定排序并重新编号，保证同一记录任何时刻重放都一致
    this.events = events
      .map((e, i) => ({ ...e, __i: i }))
      .sort((a, b) => a.t - b.t || (a as any).__i - (b as any).__i)
      .map((e, i) => ({ id: i + 1, t: e.t, key: e.key, type: e.type }));
    this.cursor = 0;
  }

  private say(t: number, kind: LogKind, text: string): void {
    this.log.push({ t, kind, text });
  }

  // ---------- 定时器 ----------
  private nextTimer(): Timer | null {
    let best: Timer | null = null;
    const consider = (t: number, kind: string, cand?: Cand) => {
      if (!isFinite(t)) return;
      if (!best || t < best.t || (t === best.t && TIMER_ORDER[kind] < TIMER_ORDER[best.kind])) {
        best = { t, kind, cand };
      }
    };
    for (const c of this.cands) {
      if (c.state !== 'active') continue;
      if (!c.partial) {
        consider(c.lastT + c.cmd.stepWindowMs, 'step-gap', c);
      } else {
        const step = c.cmd.steps[c.stepIdx];
        if (step.kind === 'tap') consider(c.partial.downT! + this.cfg.tapMaxMs, 'tap-expire', c);
        else if (step.kind === 'hold') consider(c.partial.downT! + step.minMs, 'hold-complete', c);
        else consider(c.partial.chordFirstT! + step.windowMs, 'chord-expire', c);
      }
    }
    if (this.action) consider(this.action.endT, 'action-end');
    if (this.buffered) consider(this.buffered.expireAt, 'buffer-expire');
    return best;
  }

  /** 推进到游戏时间 t（处理途中所有事件与定时器）。t=Infinity 表示跑到底。 */
  runTo(t: number): void {
    for (;;) {
      const evT = this.cursor < this.events.length ? this.events[this.cursor].t : Infinity;
      const tm = this.nextTimer();
      // 同一时刻：hold-complete 定时器先于事件（按住到点即算完成），其余定时器后于事件
      const timerFirst = tm !== null && (tm.t < evT || (tm.t === evT && tm.kind === 'hold-complete'));
      const nextT = timerFirst ? tm!.t : evT;
      if (nextT > t || nextT === Infinity) break;
      this.now = nextT;
      if (timerFirst) this.applyTimer(tm!); else this.handleEvent(this.events[this.cursor++]);
      this.resolvePendings();
    }
    if (t !== Infinity && t > this.now) this.now = t;
  }

  get finished(): boolean {
    return this.cursor >= this.events.length && this.nextTimer() === null;
  }

  /** 推进到下一个事件（含其之前的定时器），返回 false 表示没有更多事件 */
  stepToNextEvent(): boolean {
    if (this.cursor >= this.events.length) { this.runTo(Infinity); return false; }
    this.runTo(this.events[this.cursor].t);
    return true;
  }

  // ---------- 事件处理 ----------
  private handleEvent(e: InputEvent): void {
    this.say(e.t, 'event', `事件 #${e.id} ${e.key} ${e.type === 'down' ? '按下' : '松开'}`);
    if (this.consumed.has(e.id)) {
      this.say(e.t, 'ignore', `事件 #${e.id} 已被消费，跳过`);
      return;
    }
    if (e.type === 'down') {
      if (this.downKeys.has(e.key)) {
        this.say(e.t, 'ignore', `${e.key} 重复上报（已处于按下状态），忽略 — 不触发新候选`);
        return;
      }
      this.downKeys.set(e.key, e.id);
      // 先推进已有候选（chord 进行中的候选也要继续收键），再用它开启新候选
      for (const c of this.cands) {
        if (c.state !== 'active') continue;
        if (!c.partial || c.cmd.steps[c.stepIdx]?.kind === 'chord') this.tryStartStep(c, e);
      }
      for (const cmd of this.cfg.commands) {
        const c = this.newCand(cmd, e.t);
        this.tryStartStep(c, e);
      }
    } else {
      if (!this.downKeys.has(e.key)) {
        this.say(e.t, 'ignore', `${e.key} 松开时并未按下，忽略`);
        return;
      }
      this.downKeys.delete(e.key);
      for (const c of this.cands) {
        if (c.state !== 'active' || !c.partial) continue;
        const step = c.cmd.steps[c.stepIdx];
        if (step.kind === 'tap' && step.key === e.key) {
          const held = e.t - c.partial.downT!;
          if (held <= this.cfg.tapMaxMs) {
            this.completeStep(c, e.t, [c.partial.downId!, e.id]);
          } else {
            this.kill(c, `短按超时：按住 ${held}ms 超过上限 ${this.cfg.tapMaxMs}ms`);
          }
        } else if (step.kind === 'hold' && step.key === e.key) {
          const held = e.t - c.partial.downT!;
          this.kill(c, `长按不足：按住 ${held}ms 未达到 ${step.minMs}ms 就松开`);
        } else if (step.kind === 'chord' && c.partial.chordDowns?.has(e.key)) {
          this.kill(c, `同时按失败：${e.key} 在按齐前提前松开`);
        }
      }
    }
  }

  private newCand(cmd: CommandDef, t: number): Cand {
    const c: Cand = {
      id: this.nextCandId++, cmd, stepIdx: 0, used: [], stepDoneTs: [],
      startT: t, lastT: t, partial: null, state: 'active',
    };
    this.cands.push(c);
    return c;
  }

  private tryStartStep(c: Cand, e: InputEvent): void {
    const step = c.cmd.steps[c.stepIdx];
    if (!step) return;
    if ((step.kind === 'tap' || step.kind === 'hold') && step.key === e.key) {
      c.partial = { downId: e.id, downT: e.t };
      this.say(e.t, 'candidate', `候选 #${c.id}「${c.cmd.name}」第 ${c.stepIdx + 1} 步开始（${e.key} 按下）`);
    } else if (step.kind === 'chord' && step.keys.includes(e.key)) {
      if (!c.partial) c.partial = { chordDowns: new Map(), chordFirstT: e.t };
      c.partial.chordDowns!.set(e.key, e.id);
      const got = [...c.partial.chordDowns!.keys()].join('+');
      if (step.keys.every(k => c.partial!.chordDowns!.has(k))) {
        const ids = [...c.partial.chordDowns!.values()];
        this.completeStep(c, e.t, ids);
      } else {
        this.say(e.t, 'candidate', `候选 #${c.id}「${c.cmd.name}」同时按进行中（已按 ${got}，还差 ${step.keys.filter(k => !c.partial!.chordDowns!.has(k)).join('+')}）`);
      }
    }
  }

  private completeStep(c: Cand, t: number, evIds: number[]): void {
    c.used.push(...evIds);
    c.stepDoneTs.push(t);
    c.stepIdx++;
    c.lastT = t;
    c.partial = null;
    const total = c.cmd.steps.length;
    if (c.stepIdx < total) {
      this.say(t, 'candidate', `候选 #${c.id}「${c.cmd.name}」完成第 ${c.stepIdx}/${total} 步，等待下一步（${c.cmd.stepWindowMs}ms 内）`);
    } else {
      c.state = 'pending';
      c.completedT = t;
      const blockers = this.blockersOf(c);
      if (blockers.length > 0) {
        this.say(t, 'pending', `「${c.cmd.name}」已凑齐，但存在更长的存活候选（${blockers.map(b => `「${b.cmd.name}」#${b.id}`).join('、')}），挂起等待后续输入`);
      }
    }
  }

  /** 引用了某事件（已提交或进行中）的候选 */
  private refIds(c: Cand): number[] {
    const ids = [...c.used];
    if (c.partial) {
      if (c.partial.downId !== undefined) ids.push(c.partial.downId);
      if (c.partial.chordDowns) ids.push(...c.partial.chordDowns.values());
    }
    return ids;
  }

  private blockersOf(p: Cand): Cand[] {
    return this.cands.filter(d =>
      d.state === 'active' && d.id !== p.id &&
      p.used.every(id => d.used.includes(id)));
  }

  private kill(c: Cand, reason: string): void {
    if (c.state === 'dead' || c.state === 'fired') return;
    c.state = 'dead';
    c.deadT = this.now;
    c.deadReason = reason;
    this.say(this.now, 'discard', `候选丢弃 #${c.id}「${c.cmd.name}」：${reason}`);
  }

  // ---------- 冲突裁决 ----------
  private resolvePendings(): void {
    for (;;) {
      const pendings = this.cands.filter(c => c.state === 'pending');
      if (pendings.length === 0) return;
      const ready = pendings.filter(p => this.blockersOf(p).length === 0);
      if (ready.length === 0) return;
      // 明确规则：优先级高 → 步数多 → 凑齐早 → 候选编号小
      ready.sort((a, b) =>
        b.cmd.priority - a.cmd.priority ||
        b.cmd.steps.length - a.cmd.steps.length ||
        (a.completedT! - b.completedT!) ||
        a.id - b.id);
      let changed = false;
      for (const p of ready) {
        if (p.state !== 'pending') continue;
        if (p.used.some(id => this.consumed.has(id))) {
          this.kill(p, `指令冲突：事件已被更高优先级的指令消费`);
          changed = true;
          continue;
        }
        this.fire(p);
        changed = true;
      }
      if (!changed) return;
    }
  }

  private fire(c: Cand): void {
    c.state = 'fired';
    c.fireT = this.now;
    for (const id of c.used) this.consumed.add(id);
    this.say(this.now, 'command',
      `指令成立：「${c.cmd.name}」（消费事件 ${c.used.map(i => '#' + i).join(' ')}，凑齐于 ${c.completedT}ms）`);
    // 一次按键不能被两个动作用掉：引用这些事件的其它候选全部丢弃
    for (const d of this.cands) {
      if (d.state !== 'active' && d.state !== 'pending') continue;
      const hit = this.refIds(d).find(id => this.consumed.has(id));
      if (hit !== undefined) this.kill(d, `事件 #${hit} 已被「${c.cmd.name}」消费`);
    }
    // 动作层
    if (!this.action || this.action.cmd.interruptible) {
      if (this.action) {
        this.say(this.now, 'action', `动作切换：「${this.action.cmd.name}」被指令「${c.cmd.name}」打断`);
        this.endAction(this.now);
      }
      this.startAction(c.cmd, this.now, '即时');
    } else {
      if (this.buffered) {
        this.say(this.now, 'buffer', `预存覆盖：「${this.buffered.cmd.name}」被新指令「${c.cmd.name}」替换`);
      }
      this.buffered = { cmd: c.cmd, t: this.now, expireAt: this.now + this.cfg.bufferMs };
      this.say(this.now, 'buffer',
        `当前动作「${this.action.cmd.name}」不可打断，指令「${c.cmd.name}」已预存（${this.cfg.bufferMs}ms 内有效，至 ${this.buffered.expireAt}ms）`);
    }
  }

  private startAction(cmd: CommandDef, t: number, source: '即时' | '预存'): void {
    this.action = { cmd, startT: t, endT: t + cmd.actionMs };
    this.episodes.push({ name: cmd.name, shape: cmd.shape, color: cmd.color, startT: t, endT: t + cmd.actionMs, source });
    this.say(t, 'action',
      `动作开始：「${cmd.name}」（触发指令：「${cmd.name}」，来源：${source}，持续 ${cmd.actionMs}ms，${cmd.interruptible ? '可打断' : '不可打断'}）`);
  }

  private endAction(t: number): void {
    if (!this.action) return;
    const ep = this.episodes[this.episodes.length - 1];
    if (ep && ep.endT > t) ep.endT = t; // 被打断时截断
    this.action = null;
  }

  // ---------- 定时器触发 ----------
  private applyTimer(tm: Timer): void {
    const c = tm.cand;
    switch (tm.kind) {
      case 'step-gap':
        this.kill(c!, `步间窗口超时：上一步完成后 ${c!.cmd.stepWindowMs}ms 内没有后续输入`);
        break;
      case 'tap-expire':
        this.kill(c!, `短按超时：按住超过 ${this.cfg.tapMaxMs}ms 未松开，不算短按`);
        break;
      case 'chord-expire': {
        const step = c!.cmd.steps[c!.stepIdx] as ChordStep;
        const missing = step.keys.filter(k => !c!.partial?.chordDowns?.has(k)).join('+');
        this.kill(c!, `同时按窗口超时：${step.windowMs}ms 内未按齐（缺 ${missing}）`);
        break;
      }
      case 'hold-complete': {
        const step = c!.cmd.steps[c!.stepIdx] as HoldStep;
        const t = c!.partial!.downT! + step.minMs;
        this.say(t, 'candidate', `候选 #${c!.id}「${c!.cmd.name}」长按 ${step.minMs}ms 达成`);
        this.completeStep(c!, t, [c!.partial!.downId!]);
        break;
      }
      case 'action-end': {
        const name = this.action!.cmd.name;
        this.say(this.now, 'action', `动作结束：「${name}」`);
        this.action = null;
        if (this.buffered) {
          if (this.buffered.expireAt > this.now) {
            const b = this.buffered;
            this.buffered = null;
            this.say(this.now, 'buffer',
              `预存指令「${b.cmd.name}」生效（预存于 ${b.t}ms，距失效还有 ${b.expireAt - this.now}ms）→ 动作切换：「${name}」→「${b.cmd.name}」`);
            this.startAction(b.cmd, this.now, '预存');
          } else {
            this.say(this.now, 'buffer', `预存指令「${this.buffered.cmd.name}」已超时失效，动作「${name}」结束后无后续`);
            this.buffered = null;
          }
        }
        break;
      }
      case 'buffer-expire':
        if (this.buffered) {
          this.say(this.now, 'buffer',
            `预存指令「${this.buffered.cmd.name}」超时失效（${this.cfg.bufferMs}ms 内动作「${this.action?.cmd.name}」未结束）`);
          this.buffered = null;
        }
        break;
    }
  }
}

// ---------- 帧率无关性验证 ----------
export interface ReplayResult {
  actions: string[];   // "名称@开始ms(来源)"
  consumed: number[];  // 被消费的事件 id
  fires: string[];     // "名称@生效ms"
}

export function replayAtFps(cfg: EngineConfig, events: InputEvent[], fps: number): ReplayResult {
  const eng = new Engine(cfg);
  eng.load(events);
  const dur = events.reduce((m, e) => Math.max(m, e.t), 0) + 3000;
  const frame = 1000 / fps;
  for (let t = 0; t <= dur; t += frame) eng.runTo(t);
  eng.runTo(Infinity);
  return {
    actions: eng.episodes.map(e => `${e.name}@${e.startT}(${e.source})`),
    consumed: [...eng.consumed].sort((a, b) => a - b),
    fires: eng.log.filter(l => l.kind === 'command').map(l => l.text),
  };
}
