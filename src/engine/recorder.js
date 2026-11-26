// 录制与回放：记录每一帧的输入，回放时用同一份帧序列驱动新引擎，
// 因此事件结果完全确定、可重复。跳到任意帧 = 用前 N 帧重建引擎状态。

import { ACTION } from './events.js';

export function createRecorder() {
  const frames = [];
  let recording = false;

  return {
    start() {
      frames.length = 0;
      recording = true;
    },
    stop() {
      recording = false;
    },
    get isRecording() {
      return recording;
    },
    record(frame) {
      if (!recording) return;
      frames.push(JSON.parse(JSON.stringify(frame)));
    },
    get frames() {
      return frames;
    },
    get length() {
      return frames.length;
    },
    load(newFrames) {
      frames.length = 0;
      frames.push(...JSON.parse(JSON.stringify(newFrames)));
    },
    exportJSON() {
      return JSON.stringify({ version: 1, frames }, null, 2);
    },
  };
}

// 用帧序列的前 upToFrame（含，-1 表示空场景）帧重放进引擎
export function replayInto(engine, frames, upToFrame = frames.length - 1) {
  engine.resetCounters();
  for (let i = 0; i <= upToFrame && i < frames.length; i++) {
    engine.pushFrame(frames[i]);
  }
}

// 把脚本路线（waypoints）展开成逐帧 frame 序列
// waypoint: { pos, action, durationMs? }
// - walk：从上一点匀速走到 pos，按 stepMs 拆帧
// - idle：停在 pos 若干帧
// - teleport：单帧跳变，from 取上一帧位置
// - dash：单帧高速线段，durationMs 表示该段耗时（采样依据）
export function buildFrames(waypoints, { stepMs = 100, dashMs = 60 } = {}) {
  const frames = [];
  let time = 0;
  let prev = waypoints[0]?.pos ? { ...waypoints[0].pos } : null;

  waypoints.forEach((wp, idx) => {
    const action = wp.action ?? ACTION.WALK;
    if (idx === 0) {
      frames.push({ time, pos: { ...wp.pos }, action: ACTION.IDLE });
      prev = { ...wp.pos };
      return;
    }
    if (action === ACTION.TELEPORT) {
      time += stepMs;
      frames.push({ time, pos: { ...wp.pos }, from: { ...prev }, action: ACTION.TELEPORT });
    } else if (action === ACTION.DASH) {
      time += wp.durationMs ?? dashMs;
      frames.push({
        time,
        pos: { ...wp.pos },
        from: { ...prev },
        durationMs: wp.durationMs ?? dashMs,
        action: ACTION.DASH,
      });
    } else if (action === ACTION.IDLE) {
      const hold = wp.durationMs ?? stepMs;
      const n = Math.max(1, Math.round(hold / stepMs));
      for (let i = 0; i < n; i++) {
        time += stepMs;
        frames.push({ time, pos: { ...wp.pos }, action: ACTION.IDLE });
      }
    } else {
      // walk：匀速拆帧
      const dist = Math.hypot(wp.pos.x - prev.x, wp.pos.y - prev.y);
      const speed = wp.speed ?? 2.2; // px/ms，约 220px/s
      const duration = Math.max(stepMs, Math.round(dist / speed));
      const n = Math.max(1, Math.round(duration / stepMs));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        time += Math.round(duration / n);
        frames.push({
          time,
          pos: {
            x: prev.x + (wp.pos.x - prev.x) * t,
            y: prev.y + (wp.pos.y - prev.y) * t,
          },
          action: ACTION.WALK,
        });
      }
    }
    prev = { ...wp.pos };
  });
  return frames;
}
