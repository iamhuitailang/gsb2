// 画布渲染：网格、区域（圆/矩形/多边形）、角色、动作轨迹、dash 采样点、多边形草稿。

import { pointInZone, sampleSegment } from '../engine/geometry.js';
import { ACTION } from '../engine/events.js';
import { state } from './state.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawGrid(w, h) {
  const grid = cssVar('--grid') || '#2c2c2a';
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= w; x += 40) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (let y = 0; y <= h; y += 40) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();
}

function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function zonePath(zone) {
  ctx.beginPath();
  if (zone.shape === 'circle') {
    ctx.arc(zone.center.x, zone.center.y, zone.radius, 0, Math.PI * 2);
  } else if (zone.shape === 'rect') {
    const { x, y, w, h } = zone.rect;
    ctx.rect(x, y, w, h);
  } else {
    const pts = zone.points;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }
}

function drawZone(zone) {
  const st = state.engine.getState(zone.id);
  const selected = zone.id === state.selectedZoneId;
  ctx.save();
  zonePath(zone);
  ctx.fillStyle = withAlpha(zone.color, zone.enabled ? (st?.inside ? 0.32 : 0.16) : 0.05);
  ctx.fill();
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.strokeStyle = zone.enabled ? zone.color : cssVar('--muted');
  if (!zone.enabled) ctx.setLineDash([6, 5]);
  ctx.stroke();
  ctx.setLineDash([]);

  // 标签
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = cssVar('--ink-2');
  const anchor = labelAnchor(zone);
  ctx.fillText(zone.name + (zone.enabled ? '' : '（已禁用）'), anchor.x, anchor.y);

  // 选中时画顶点手柄
  if (selected) drawHandles(zone);
  ctx.restore();
}

function labelAnchor(zone) {
  if (zone.shape === 'circle') return { x: zone.center.x - zone.radius, y: zone.center.y - zone.radius - 6 };
  if (zone.shape === 'rect') return { x: zone.rect.x, y: zone.rect.y - 6 };
  const xs = zone.points.map((p) => p.x);
  const ys = zone.points.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys) - 6 };
}

function drawHandles(zone) {
  let pts = [];
  if (zone.shape === 'circle') pts = [zone.center, { x: zone.center.x + zone.radius, y: zone.center.y }];
  else if (zone.shape === 'rect') {
    const { x, y, w, h } = zone.rect;
    pts = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  } else pts = zone.points;
  ctx.fillStyle = cssVar('--ink');
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTrail() {
  const frames = state.frames;
  if (frames.length < 2) return;
  ctx.save();
  ctx.strokeStyle = withAlpha(cssVar('--accent') || '#3987e5', 0.5);
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  frames.forEach((f, i) => {
    if (i === 0) ctx.moveTo(f.pos.x, f.pos.y);
    else ctx.lineTo(f.pos.x, f.pos.y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawDashSamples(frame) {
  if (!frame || frame.action !== ACTION.DASH) return;
  const from = frame.from;
  const to = frame.pos;
  ctx.save();
  ctx.strokeStyle = cssVar('--warning');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  // 对每个启用区域按其步长画采样点，命中点用绿色
  for (const zone of state.engine.zones) {
    if (!zone.enabled) continue;
    const samples = sampleSegment(from, to, zone.rules.dashSampleStep);
    samples.forEach((p, i) => {
      const hit = pointInZone(p, zone);
      ctx.beginPath();
      ctx.arc(p.x, p.y, hit ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = hit ? cssVar('--ev-enter') : withAlpha(zone.color, 0.8);
      ctx.fill();
    });
  }
  ctx.restore();
}

function drawTeleportArc(frame) {
  if (!frame || frame.action !== ACTION.TELEPORT) return;
  ctx.save();
  ctx.strokeStyle = cssVar('--series-5');
  ctx.lineWidth = 1.5;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(frame.from.x, frame.from.y);
  ctx.quadraticCurveTo(
    (frame.from.x + frame.pos.x) / 2,
    Math.min(frame.from.y, frame.pos.y) - 40,
    frame.pos.x,
    frame.pos.y
  );
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawPlayer(pos) {
  if (!pos) return;
  ctx.save();
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, 9, 0, Math.PI * 2);
  ctx.fillStyle = cssVar('--ink');
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = cssVar('--accent');
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = cssVar('--accent');
  ctx.fill();
  ctx.restore();
}

function drawPolygonDraft() {
  const draft = state.polygonDraft;
  if (!draft || draft.length === 0) return;
  ctx.save();
  ctx.strokeStyle = cssVar('--accent');
  ctx.fillStyle = withAlpha(cssVar('--accent'), 0.15);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  draft.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();
  draft.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = cssVar('--accent');
    ctx.fill();
  });
  ctx.restore();
}

function drawDashDraft() {
  const d = state.dashDraft;
  if (!d) return;
  ctx.save();
  ctx.strokeStyle = cssVar('--warning');
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(d.from.x, d.from.y);
  ctx.lineTo(d.to.x, d.to.y);
  ctx.stroke();
  ctx.restore();
}

export function render() {
  const { w, h } = state.canvas;
  ctx.clearRect(0, 0, w, h);
  drawGrid(w, h);
  drawTrail();
  for (const zone of state.engine.zones) drawZone(zone);
  drawPolygonDraft();
  drawDashDraft();
  if (state.lastFrame) {
    drawDashSamples(state.lastFrame);
    drawTeleportArc(state.lastFrame);
  }
  drawPlayer(state.engine.position);
}

// 屏幕坐标 -> 画布世界坐标（CSS 缩放适配）
export function toWorld(evt) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((evt.clientX - rect.left) / rect.width) * canvas.width,
    y: ((evt.clientY - rect.top) / rect.height) * canvas.height,
  };
}

export function getCanvas() {
  return canvas;
}
