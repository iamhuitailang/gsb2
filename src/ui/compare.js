// 规则对照：用同一份区域与同一条帧序列，分别在严格/宽松规则下重放两个独立引擎，
// 并排展示迷你泳道、计数与逐帧差异。

import { createEngine } from '../engine/engine.js';
import { EVENT, EVENT_LABEL, RULES_LENIENT, RULES_STRICT } from '../engine/events.js';
import { buildPresetScenes } from '../engine/presets.js';

function runWith(rulesOverride) {
  const preset = buildPresetScenes();
  const eng = createEngine();
  const key = rulesOverride.id === 'strict' ? 'strict' : 'lenient';
  preset.scenes[key].zones.forEach((z) => eng.addZone({ ...z, rules: { ...rulesOverride } }));
  for (const f of preset.frames) eng.pushFrame(f);
  return { eng, frames: preset.frames, zones: eng.zones };
}

function evColor(type) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--ev-${type}`).trim();
}

function miniLanes(host, run) {
  host.innerHTML = '';
  const maxTime = Math.max(1, ...run.frames.map((f) => f.time));
  for (const zone of run.zones) {
    const row = document.createElement('div');
    row.className = 'mini-row';
    row.innerHTML = `<div class="lane-label" style="grid-template-columns:none">
      <span class="zone-swatch" style="background:${zone.color}"></span>${zone.id}</div>`;
    const track = document.createElement('div');
    track.className = 'lane-track';
    for (const e of run.eng.events.filter((ev) => ev.zoneId === zone.id)) {
      const mark = document.createElement('div');
      mark.className = 'lane-mark';
      mark.style.left = `${(e.time / maxTime) * 100}%`;
      mark.style.background = evColor(e.type);
      mark.style.width = '8px';
      mark.style.height = '14px';
      mark.title = `${e.time}ms ${EVENT_LABEL[e.type]} · ${e.reason}`;
      track.appendChild(mark);
    }
    row.appendChild(track);
    host.appendChild(row);
  }
}

function counts(host, run, label) {
  const c = { enter: 0, exit: 0, stay: 0 };
  for (const e of run.eng.events) c[e.type]++;
  host.innerHTML = `<span>${label} 共 <b>${run.eng.events.length}</b> 条</span>
    <span style="color:var(--ev-enter)">进入 <b>${c.enter}</b></span>
    <span style="color:var(--ev-exit)">退出 <b>${c.exit}</b></span>
    <span style="color:var(--ev-stay)">停留 <b>${c.stay}</b></span>`;
}

// 以“帧+区域”为键对比两边是否产生非退出事件
function buildDiff(strict, lenient) {
  const key = (e) => `${e.frame}|${e.zoneId}|${e.type}`;
  const sMap = new Map(strict.eng.events.filter((e) => e.type !== EVENT.EXIT).map((e) => [key(e), e]));
  const lMap = new Map(lenient.eng.events.filter((e) => e.type !== EVENT.EXIT).map((e) => [key(e), e]));
  const allKeys = [...new Set([...sMap.keys(), ...lMap.keys()])].sort((a, b) => {
    const [fa, , ta] = a.split('|');
    const [fb, , tb] = b.split('|');
    return Number(fa) - Number(fb) || ta.localeCompare(tb);
  });
  return allKeys.map((k) => {
    const s = sMap.get(k);
    const l = lMap.get(k);
    const ref = l ?? s;
    return {
      frame: ref.frame,
      time: ref.time,
      zone: ref.zoneName,
      type: EVENT_LABEL[ref.type],
      strict: !!s,
      lenient: !!l,
      reason: (l ?? s).reason,
    };
  });
}

export function openCompare() {
  const strict = runWith(RULES_STRICT);
  const lenient = runWith(RULES_LENIENT);

  document.getElementById('strictTitle').textContent = RULES_STRICT.name;
  document.getElementById('lenientTitle').textContent = RULES_LENIENT.name;
  miniLanes(document.getElementById('strictLane'), strict);
  miniLanes(document.getElementById('lenientLane'), lenient);
  counts(document.getElementById('strictCounts'), strict, '严格');
  counts(document.getElementById('lenientCounts'), lenient, '宽松');
  document.getElementById('compareSub').textContent =
    `同一条 ${lenient.frames.length} 帧路线、同样的 ${lenient.zones.length} 个区域，仅切换动作规则。` +
    `绿点=进入，红点=退出，蓝点=停留。`;

  const tbody = document.querySelector('#diffTable tbody');
  const diffs = buildDiff(strict, lenient);
  tbody.replaceChildren(
    ...diffs.map((d) => {
      const tr = document.createElement('tr');
      const tag =
        d.strict === d.lenient
          ? '<span class="diff-tag same">一致</span>'
          : d.lenient
            ? '<span class="diff-tag allowed">宽松放行</span>'
            : '<span class="diff-tag suppressed">严格抑制</span>';
      tr.innerHTML = `
        <td class="num">${d.frame}</td>
        <td class="num">${d.time}</td>
        <td>${d.zone}</td>
        <td>${d.strict ? d.type : '—'}</td>
        <td>${d.lenient ? d.type : '—'}</td>
        <td class="reason">${tag} ${d.reason}</td>`;
      return tr;
    })
  );

  document.getElementById('compareModal').classList.remove('hidden');
}

export function closeCompare() {
  document.getElementById('compareModal').classList.add('hidden');
}
