// 主编排：画布交互、帧推进、播放/录制/回放、存档导入导出、各视图联动。

import { state, loadFrames } from './state.js';
import { render, toWorld, getCanvas } from './renderer.js';
import { renderTimeline } from './timeline.js';
import { renderEventLog, toCSV } from './eventlog.js';
import { renderZonePanel } from './zoneEditor.js';
import { openCompare, closeCompare } from './compare.js';
import { ACTION, EVENT } from '../engine/events.js';
import { createZone } from '../engine/engine.js';
import { buildPresetScenes, exportBundle } from '../engine/presets.js';
import { replayInto } from '../engine/recorder.js';
import { pointInZone } from '../engine/geometry.js';

const ZONE_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'];
let zoneCounter = 0;

const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function refresh() {
  render();
  renderZonePanel(refresh);
  renderTimeline(seekToFrame);
  renderEventLog(seekToFrame, state.playIndex);
  syncTransport();
}

function syncTransport() {
  const scrub = document.getElementById('scrub');
  scrub.max = String(Math.max(0, state.frames.length - 1));
  scrub.value = String(Math.max(0, state.playIndex));
  document.getElementById('clock').textContent =
    `t=${state.engine.time}ms · 帧 ${Math.max(0, state.playIndex)}`;
}

// ---------- 帧推进 ----------
function nextTime() {
  const last = state.frames.at(-1);
  return last ? last.time + 100 : 0;
}

function advance(frame) {
  state.frames.push(frame);
  state.playIndex = state.frames.length - 1;
  if (state.recorder.isRecording) state.recorder.record(frame);
  state.engine.pushFrame(frame);
  state.lastFrame = frame;
  refresh();
}

function makeMoveFrame(pos, action) {
  const time = nextTime();
  const from = state.engine.position ? { ...state.engine.position } : pos;
  if (action === ACTION.TELEPORT) {
    return { time, pos, from, action: ACTION.TELEPORT };
  }
  if (action === ACTION.DASH) {
    const dist = Math.hypot(pos.x - from.x, pos.y - from.y);
    return { time, pos, from, durationMs: Math.max(30, Math.round(dist / 6)), action: ACTION.DASH };
  }
  return { time, pos, action: state.engine.position ? ACTION.WALK : ACTION.IDLE };
}

// ---------- 画布交互 ----------
const canvas = getCanvas();

canvas.addEventListener('click', (evt) => {
  const p = toWorld(evt);
  const tool = state.tool;

  if (tool === 'addCircle') {
    addZone({
      shape: 'circle',
      center: p,
      radius: 55,
      name: `圆形 ${++zoneCounter}`,
    });
    state.tool = 'select';
    syncToolButtons();
    return;
  }
  if (tool === 'addRect') {
    addZone({
      shape: 'rect',
      rect: { x: p.x - 55, y: p.y - 40, w: 110, h: 80 },
      name: `矩形 ${++zoneCounter}`,
    });
    state.tool = 'select';
    syncToolButtons();
    return;
  }
  if (tool === 'addPolygon') {
    if (!state.polygonDraft) state.polygonDraft = [];
    state.polygonDraft.push(p);
    render();
    return;
  }

  // select：点击区域选中；否则按当前动作移动
  const hit = [...state.engine.zones].reverse().find((z) => pointInZone(p, z));
  if (hit) {
    state.selectedZoneId = hit.id;
    refresh();
    return;
  }
  advance(makeMoveFrame(p, state.action));
});

// 双击完成多边形；右键撤销一个顶点
canvas.addEventListener('dblclick', () => {
  if (state.tool === 'addPolygon' && state.polygonDraft && state.polygonDraft.length >= 3) {
    const pts = state.polygonDraft;
    state.polygonDraft = null;
    addZone({ shape: 'polygon', points: pts, name: `多边形 ${++zoneCounter}` });
    state.tool = 'select';
    syncToolButtons();
  }
});
canvas.addEventListener('contextmenu', (evt) => {
  if (state.polygonDraft && state.polygonDraft.length) {
    evt.preventDefault();
    state.polygonDraft.pop();
    render();
  }
});

// dash：按住拖拽起止点（mousedown 记起点，mouseup 出帧）
canvas.addEventListener('mousedown', (evt) => {
  if (state.tool === 'select' && state.action === ACTION.DASH) {
    state.dashDraft = { from: toWorld(evt), to: toWorld(evt) };
  }
});
canvas.addEventListener('mousemove', (evt) => {
  if (state.dashDraft) {
    state.dashDraft.to = toWorld(evt);
    render();
  }
});
canvas.addEventListener('mouseup', () => {
  if (state.dashDraft) {
    const { from, to } = state.dashDraft;
    state.dashDraft = null;
    if (Math.hypot(to.x - from.x, to.y - from.y) > 8) {
      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      advance({
        time: nextTime(),
        pos: to,
        from,
        durationMs: Math.max(30, Math.round(dist / 6)),
        action: ACTION.DASH,
      });
    } else {
      render();
    }
  }
});

function addZone(config) {
  const color = ZONE_COLORS[state.engine.zones.length % ZONE_COLORS.length];
  const z = state.engine.addZone({
    color,
    stayIntervalMs: 500,
    graceMs: 120,
    ...config,
  });
  state.selectedZoneId = z.id;
  refresh();
  toast(`已添加区域：${z.name}（双击画布可继续画多边形，右键撤销顶点）`);
}

// ---------- 工具/动作切换 ----------
function syncToolButtons() {
  document.querySelectorAll('#toolGroup .tool').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === state.tool);
  });
  document.querySelectorAll('#actionGroup .tool').forEach((b) => {
    b.classList.toggle('active', b.dataset.action === state.action);
  });
}
document.getElementById('toolGroup').addEventListener('click', (e) => {
  const b = e.target.closest('.tool');
  if (!b) return;
  state.tool = b.dataset.tool;
  state.polygonDraft = null;
  syncToolButtons();
  render();
});
document.getElementById('actionGroup').addEventListener('click', (e) => {
  const b = e.target.closest('.tool');
  if (!b) return;
  state.action = b.dataset.action;
  syncToolButtons();
  const hint = document.getElementById('canvasHint');
  hint.textContent =
    state.action === ACTION.DASH
      ? '高速模式：在画布上按住拖拽出高速线段（黄色线段+采样点）'
      : state.action === ACTION.TELEPORT
        ? '瞬移模式：点击目标点，角色不连续跳变（紫色弧线）'
        : '步行模式：点击落点，角色匀速走过去';
});

// ---------- 播放 / 单帧 / 拖动 ----------
function stopPlay() {
  state.playing = false;
  clearInterval(state.playTimer);
  state.playTimer = null;
}

function seekToFrame(index) {
  stopPlay();
  const target = Math.max(-1, Math.min(index, state.frames.length - 1));
  replayInto(state.engine, state.frames, target);
  state.playIndex = target;
  state.lastFrame = target >= 0 ? state.frames[target] : null;
  refresh();
}

document.getElementById('btnPlay').addEventListener('click', () => {
  if (!state.frames.length) return toast('还没有路线：先在画布上移动，或载入样例场景');
  if (state.playing) return;
  state.playing = true;
  if (state.playIndex >= state.frames.length - 1) seekToFrame(-1);
  state.playing = true;
  state.playTimer = setInterval(() => {
    const next = state.playIndex + 1;
    if (next >= state.frames.length) {
      stopPlay();
      return;
    }
    replayInto(state.engine, state.frames, next);
    state.playIndex = next;
    state.lastFrame = state.frames[next];
    refresh();
  }, 90 / state.speed);
});
document.getElementById('btnPause').addEventListener('click', stopPlay);
document.getElementById('btnStep').addEventListener('click', () => {
  if (state.playIndex < state.frames.length - 1) seekToFrame(state.playIndex + 1);
});
document.getElementById('scrub').addEventListener('input', (e) => seekToFrame(Number(e.target.value)));
document.getElementById('speedSel').addEventListener('change', (e) => {
  state.speed = Number(e.target.value);
  if (state.playing) {
    stopPlay();
    document.getElementById('btnPlay').click();
  }
});

// ---------- 录制 / 回放 / 重置 ----------
document.getElementById('btnRecord').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  if (!state.recorder.isRecording) {
    state.recorder.start();
    btn.classList.add('on');
    btn.textContent = '● 录制中…';
    // 后续手动移动的帧都会进入 recorder；同时清空旧路线重新积累
    state.frames.length = 0;
    state.playIndex = -1;
    state.engine.resetCounters();
    state.lastFrame = null;
    refresh();
    toast('开始录制：所有手动移动都会被记录，再点一次结束');
  } else {
    state.recorder.stop();
    btn.classList.remove('on');
    btn.textContent = '● 录制';
    loadFrames(state.recorder.frames);
    toast(`录制结束，共 ${state.recorder.length} 帧，可点“回放”重演`);
  }
});
document.getElementById('btnReplay').addEventListener('click', () => {
  const frames = state.recorder.length ? state.recorder.frames : state.frames;
  if (!frames.length) return toast('没有可回放的录制或路线');
  loadFrames(frames);
  seekToFrame(-1);
  document.getElementById('btnPlay').click();
});
document.getElementById('btnReset').addEventListener('click', () => {
  stopPlay();
  state.frames.length = 0;
  state.playIndex = -1;
  state.lastFrame = null;
  state.polygonDraft = null;
  state.engine.resetCounters();
  refresh();
  toast('已重置路线与全部运行态（区域配置保留）');
});

// ---------- 事件过滤 ----------
document.getElementById('eventFilters').addEventListener('change', () => {
  state.showTypes = new Set(
    [...document.querySelectorAll('#eventFilters input:checked')].map((i) => i.dataset.type)
  );
  renderEventLog(seekToFrame, state.playIndex);
});

// ---------- 导出 / 存档 ----------
function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('btnExportJson').addEventListener('click', () => {
  const bundle = exportBundle(state.engine, state.frames, { canvas: state.canvas });
  download('trigger-events.json', JSON.stringify(bundle, null, 2));
  toast(`已导出 ${state.engine.events.length} 条事件与 ${state.engine.zones.length} 个区域配置`);
});
document.getElementById('btnExportCsv').addEventListener('click', () => {
  download('trigger-events.csv', '﻿' + toCSV(), 'text/csv');
});
document.getElementById('btnSave').addEventListener('click', () => {
  const pack = {
    engine: state.engine.snapshot(),
    frames: state.frames,
    playIndex: state.playIndex,
  };
  localStorage.setItem(state.storageKey, JSON.stringify(pack));
  toast('已存入浏览器 localStorage');
});
document.getElementById('btnLoad').addEventListener('click', () => {
  const raw = localStorage.getItem(state.storageKey);
  if (!raw) return toast('没有找到存档');
  try {
    const pack = JSON.parse(raw);
    state.engine.restore(pack.engine);
    loadFrames(pack.frames);
    state.playIndex = pack.playIndex ?? -1;
    state.lastFrame = state.playIndex >= 0 ? state.frames[state.playIndex] : null;
    refresh();
    toast('读档成功：区域、运行态（含 once 标记与计时）与路线已恢复');
  } catch (err) {
    toast('读档失败：' + err.message);
  }
});

// ---------- 样例 / 对照 / 主题 ----------
document.getElementById('btnSample').addEventListener('click', loadSample);
document.getElementById('btnCompare').addEventListener('click', openCompare);
document.getElementById('btnCloseCompare').addEventListener('click', closeCompare);
document.getElementById('compareModal').addEventListener('click', (e) => {
  if (e.target.id === 'compareModal') closeCompare();
});
document.getElementById('btnTheme').addEventListener('click', () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  refresh();
});

function loadSample() {
  stopPlay();
  const preset = buildPresetScenes();
  state.canvas = preset.canvas;
  state.engine.resetCounters();
  // 清掉旧区域后按样例重建
  for (const z of [...state.engine.zones]) state.engine.removeZone(z.id);
  preset.scenes.lenient.zones.forEach((z) => state.engine.addZone(JSON.parse(JSON.stringify(z))));
  loadFrames(preset.frames);
  state.playIndex = -1;
  state.lastFrame = null;
  state.selectedZoneId = state.engine.zones[0]?.id ?? null;
  refresh();
  // 自动播放一遍，让事件流与泳道立即有内容
  setTimeout(() => document.getElementById('btnPlay').click(), 200);
  toast('样例已载入：含重叠圆、薄矩形、多边形，路线覆盖抖动/瞬移/高速，点“播放路线”可重演');
}

// 键盘：空格播放/暂停，方向键单帧
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    state.playing ? stopPlay() : document.getElementById('btnPlay').click();
  }
  if (e.code === 'ArrowRight') seekToFrame(state.playIndex + 1);
  if (e.code === 'ArrowLeft') seekToFrame(state.playIndex - 1);
});

loadSample();
refresh();
