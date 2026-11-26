// 事件追踪表：按时间顺序列出全部事件，支持类型过滤、当前帧高亮、点击回跳场景位置。

import { state } from './state.js';
import { ACTION_LABEL, EVENT_LABEL } from '../engine/events.js';

const tbody = document.querySelector('#eventTable tbody');

export function renderEventLog(onSeek, currentFrame = -1) {
  const rows = state.engine.events
    .filter((e) => state.showTypes.has(e.type))
    .map((e) => {
      const tr = document.createElement('tr');
      if (e.frame === currentFrame) tr.classList.add('current');
      tr.innerHTML = `
        <td class="num">${e.seq}</td>
        <td class="num">${e.time}</td>
        <td class="num">${e.frame}</td>
        <td><span class="zone-swatch" style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${swatch(e.zoneId)};margin-right:5px"></span>${e.zoneName}</td>
        <td><span class="ev-pill ${e.type}">${EVENT_LABEL[e.type]}</span></td>
        <td><span class="act-tag">${ACTION_LABEL[e.action] ?? e.action}</span></td>
        <td class="reason">${e.reason}${e.dwellMs != null ? `（dwell=${e.dwellMs}ms）` : ''}</td>
      `;
      tr.addEventListener('click', () => onSeek(e.frame));
      return tr;
    });
  tbody.replaceChildren(...rows);
}

function swatch(zoneId) {
  return state.engine.zoneById(zoneId)?.color ?? '#888';
}

export function toCSV() {
  const header = ['seq', 'time', 'frame', 'zoneId', 'zoneName', 'type', 'action', 'reason'];
  const lines = [header.join(',')];
  for (const e of state.engine.events) {
    lines.push(
      header
        .map((k) => {
          const v = String(e[k] ?? '').replaceAll('"', '""');
          return /[",\n]/.test(v) ? `"${v}"` : v;
        })
        .join(',')
    );
  }
  return lines.join('\n');
}
