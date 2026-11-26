// 应用全局状态：引擎、录制器、当前工具/动作、播放状态。

import { createEngine } from '../engine/engine.js';
import { createRecorder } from '../engine/recorder.js';
import { ACTION } from '../engine/events.js';

export const state = {
  engine: createEngine(),
  recorder: createRecorder(),
  tool: 'select',            // select | addCircle | addRect | addPolygon
  action: ACTION.WALK,       // walk | teleport | dash
  selectedZoneId: null,
  frames: [],                // 当前路线帧序列（样例/录制/手动累积）
  playIndex: -1,             // 播放到第几帧
  playing: false,
  playTimer: null,
  speed: 1,
  polygonDraft: null,        // 多边形绘制中的点
  dashDraft: null,           // dash 拖拽起点
  canvas: { w: 960, h: 600 },
  showTypes: new Set(['enter', 'exit', 'stay']),
  lastFrame: null,           // 最近一次推进的帧（供渲染采样点等）
  storageKey: 'trigger-rehearsal-v1',
};

export function loadFrames(frames) {
  state.frames = JSON.parse(JSON.stringify(frames));
  state.playIndex = -1;
}
