// 录制与确定性重放。
// 录制内容 = 关卡快照 + 起始状态 + 按键变化事件流（按逻辑帧打时间戳）。

import { TICK_RATE, createState, applyEvent, step, levelHash } from './sim.js';

export const FORMAT = 'gsb-replay';

export function makeRecording(cfg, startState, events, durationTicks, name) {
  return {
    format: FORMAT,
    version: 1,
    name: name || '未命名录制',
    tickRate: TICK_RATE,
    levelHash: levelHash(cfg),
    level: cfg,                          // 关卡快照：布局 / 移速 / 起点
    startState: { x: startState.x, y: startState.y },
    events,                              // [{t: 逻辑帧, k: 'up'|'down'|'left'|'right', d: 1|0}]
    durationTicks,
    createdAt: new Date().toISOString(),
  };
}

export function validateRecording(rec) {
  if (!rec || typeof rec !== 'object') return '不是有效的 JSON 对象';
  if (rec.format !== FORMAT) return `格式不符（期望 ${FORMAT}）`;
  if (rec.version !== 1) return `不支持的版本 ${rec.version}`;
  if (rec.tickRate !== TICK_RATE) return `逻辑帧率不符（录制 ${rec.tickRate}Hz，当前 ${TICK_RATE}Hz）`;
  if (!rec.level || !Array.isArray(rec.level.obstacles)) return '缺少关卡快照';
  if (!rec.startState || typeof rec.startState.x !== 'number') return '缺少起始状态';
  if (!Array.isArray(rec.events)) return '缺少输入事件流';
  if (typeof rec.durationTicks !== 'number' || rec.durationTicks < 0) return '时长非法';
  for (const e of rec.events) {
    if (typeof e.t !== 'number' || typeof e.k !== 'string' || (e.d !== 0 && e.d !== 1)) {
      return '事件流中存在非法条目';
    }
  }
  return null;
}

// 确定性重放器：从起始状态逐帧推进，可暂停、单步、任意跳转。
export class Replay {
  constructor(rec) {
    this.rec = rec;
    this.reset();
  }
  reset() {
    this.state = { x: this.rec.startState.x, y: this.rec.startState.y, keys: new Set() };
    this.tick = 0;
    this.ei = 0; // 下一条待应用事件的下标
  }
  // 推进一帧；到达末尾返回 false
  stepOne() {
    if (this.tick >= this.rec.durationTicks) return false;
    const evs = this.rec.events;
    const downsThisTick = new Set();
    while (this.ei < evs.length && evs[this.ei].t === this.tick) {
      const e = evs[this.ei];
      if (e.d) downsThisTick.add(e.k);
      applyEvent(this.state.keys, e);
      this.ei++;
    }
    // 快速点按：本帧内“按下过”的键，即使同帧已松开，也算本帧按住（与实时一致）
    if (downsThisTick.size) {
      const finalKeys = this.state.keys;
      this.state.keys = new Set([...finalKeys, ...downsThisTick]);
      step(this.state, this.rec.level);
      this.state.keys = finalKeys;
    } else {
      step(this.state, this.rec.level);
    }
    this.tick++;
    return true;
  }
  // 跳到指定帧：目标在过去则从头重放（确定性强保证一致）
  stepTo(n) {
    n = Math.max(0, Math.min(n, this.rec.durationTicks));
    if (n < this.tick) this.reset();
    while (this.tick < n && this.stepOne()) { /* 推进 */ }
  }
  get done() { return this.tick >= this.rec.durationTicks; }
}
