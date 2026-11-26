// 泳道时间线：每个区域一条轨道，进入/退出/停留事件按时间打点，
// 在内时段画半透明驻留带，当前帧位置画游标。点击标记/轨道可跳到对应帧。

import { state } from './state.js';
import { EVENT } from '../engine/events.js';

const laneHost = document.getElementById('swimlane');
const laneHint = document.getElementById('laneHint');

function evColor(type) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(`--ev-${type}`)
    .trim();
}

export function renderTimeline(onSeek) {
  const events = state.engine.events;
  const zones = state.engine.zones;
  laneHost.innerHTML = '';
  if (zones.length === 0) {
    laneHint.textContent = '尚无区域';
    return;
  }
  const maxTime = Math.max(
    1,
    ...events.map((e) => e.time),
    ...state.frames.map((f) => f.time),
    state.engine.time
  );
  laneHint.textContent = `时间轴 0–${maxTime}ms`;

  // 计算每区的驻留段（enter -> exit 配对）
  const dwellSegs = new Map();
  for (const z of zones) {
    const segs = [];
    let openStart = null;
    for (const e of events.filter((ev) => ev.zoneId === z.id)) {
      if (e.type === EVENT.ENTER) openStart = e.time;
      if (e.type === EVENT.EXIT && openStart != null) {
        segs.push([openStart, e.time]);
        openStart = null;
      }
    }
    const st = state.engine.getState(z.id);
    if (openStart != null && st?.inside) segs.push([openStart, maxTime]);
    dwellSegs.set(z.id, segs);
  }

  for (const zone of zones) {
    const row = document.createElement('div');
    row.className = 'lane';
    const label = document.createElement('div');
    label.className = 'lane-label';
    label.innerHTML = `<span class="zone-swatch" style="background:${zone.color}"></span><span>${zone.name}</span>`;
    const track = document.createElement('div');
    track.className = 'lane-track';
    track.title = `${zone.name}：点击轨道跳转`;

    const pct = (t) => `${(t / maxTime) * 100}%`;

    for (const [a, b] of dwellSegs.get(zone.id)) {
      const band = document.createElement('div');
      band.className = 'lane-dwell';
      band.style.left = pct(a);
      band.style.width = `calc(${pct(b)} - ${pct(a)})`;
      band.style.background = zone.color;
      track.appendChild(band);
    }

    for (const e of events.filter((ev) => ev.zoneId === zone.id)) {
      const mark = document.createElement('div');
      mark.className = 'lane-mark';
      mark.style.left = pct(e.time);
      mark.style.background = evColor(e.type);
      mark.title = `#${e.seq} ${e.time}ms ${e.type} · ${e.reason}`;
      mark.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onSeek(e.frame);
      });
      track.appendChild(mark);
    }

    const cursor = document.createElement('div');
    cursor.className = 'lane-cursor';
    cursor.style.left = pct(state.engine.time || 0);
    track.appendChild(cursor);
    track.addEventListener('click', () => onSeek(nearestFrameAt(state.engine.time)));

    row.append(label, track);
    laneHost.appendChild(row);
  }
}

function nearestFrameAt(time) {
  let best = 0;
  let bestDiff = Infinity;
  state.frames.forEach((f, i) => {
    const d = Math.abs(f.time - time);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  });
  return best;
}
