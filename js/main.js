// 应用入口：把场景状态、求解器、三维视图、俯视图和面板连起来。

import {
  CARDINALS,
  SIDES_LABEL,
  applyDemo,
  cellIndex,
  cellOfPoint,
  clampProbeToCell,
  makeProbe,
  makeState,
  nextProbeId,
  normalizeLoadedState,
  probeWorldPos,
  serializeScene,
} from './model.js';
import {
  MODE_LABEL,
  auditCoverage,
  pathEvents,
  sampleLighting,
  samplePath,
  stepFlags,
} from './solver.js';
import { Camera, drawScene } from './render3d.js';
import { Chart } from './chart.js';
import { MapView } from './map2d.js';
import { COLORS, DEMOS, DIVIDER, GRID, MOVER, SAMPLE } from './config.js';
import {
  clamp,
  formatNumber,
  formatPct,
  hexToRgb,
  nearestOnPolyline,
  rgbToCss,
  rgbToHex,
} from './util.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ui = {
  demoId: 'open',
  mode: 'restricted',
  showRays: true,
  showFloor: true,
  showProbes: true,
  playing: false,
  playTimer: null,
  selectedProbeId: null,
  selectedCellIndex: null,
  importedFrames: null,
  importSummary: null,
};

let state = makeState();
let samples = [];
let events = [];
let playhead = 0;

const camera = new Camera();
const view3d = $('#view3d');
const ctx3d = view3d.getContext('2d');
const chart = new Chart($('#chart'), $('#chart-tooltip'));
const map = new MapView($('#map'));

/* -------------------------------------------------------------- derive */

function activeDoorOpen() {
  return clamp(state.door?.hasOpening === false ? 0 : state.door?.open ?? 1, 0, 1);
}

function sampleAt(point, mode = ui.mode) {
  return sampleLighting(state, point, { mode, doorOpen: activeDoorOpen() });
}

function recompute({ keepPlayhead = true, keepInspector = false, keepAnalysis = false } = {}) {
  samples = samplePath(state, { step: state.step, doorOpen: activeDoorOpen() });
  events = pathEvents(samples);
  if (!keepPlayhead) playhead = 0;
  playhead = Math.min(playhead, Math.max(0, samples.length - 1));
  // 以物体位置为准对齐当前帧：读回保存文件时物体位置是权威数据。
  alignPlayheadToMover();
  if (state.followPath && samples[playhead]) {
    state.mover = { x: samples[playhead].x, z: samples[playhead].z };
  }
  chart.setData(samples, events, playhead);
  refreshAll({ keepInspector, keepAnalysis });
}

function currentSample() {
  return sampleAt(state.mover);
}

function currentPathSample() {
  return samples[clamp(playhead, 0, samples.length - 1)] ?? null;
}

function usedMapForMode() {
  const m = new Map();
  const s = currentSample();
  if (!s) return m;
  for (const c of s.contributions) m.set(c.probeId, c.fraction);
  return m;
}

/* -------------------------------------------------------------- render */

function resizeAll() {
  const vp = $('#viewport');
  const rect = vp.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  view3d.width = Math.round(rect.width * dpr);
  view3d.height = Math.round(rect.height * dpr);
  ctx3d.setTransform(dpr, 0, 0, dpr, 0, 0);
  camera.resize(rect.width, rect.height);
  chart.resize();
  map.resize();
}

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render3d();
  });
}

function render3d() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ctx3d.setTransform(dpr, 0, 0, dpr, 0, 0);
  const mode = ui.mode;
  const floorSampler = (x, z, m) => sampleLighting(state, { x, z }, { mode: m, doorOpen: activeDoorOpen() });
  const used = usedMapForMode();
  drawScene(ctx3d, camera, state, currentSample(), {
    mode,
    floor: ui.showFloor,
    showProbes: ui.showProbes,
    showRays: ui.showRays,
    showMoverLabel: true,
    selectedProbeId: ui.selectedProbeId,
    selectedCell: ui.selectedCellIndex === null ? null : state.cells[ui.selectedCellIndex],
    usedProbeIds: used,
    sampleAt: floorSampler,
  });
  map.draw(state, floorSampler, mode, {
    selectedCell: ui.selectedCellIndex === null ? null : state.cells[ui.selectedCellIndex],
    selectedProbeId: ui.selectedProbeId,
    usedList: currentSample()?.contributions ?? [],
  });
}

function refreshAll({ keepInspector = false, keepAnalysis = false } = {}) {
  renderDemos();
  document.body.dataset.mode = ui.mode;
  $('#now-mode-pill').textContent = MODE_LABEL[ui.mode];
  $$('#mix-mode button').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === ui.mode));
  $$('.demo-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.demo === ui.demoId));
  renderNow();
  renderProbePanel();
  if (!keepAnalysis) {
    renderAudit();
    renderLeakPanel();
  }
  if (!keepInspector) renderInspector();
  renderFrameReadout();
  renderFrameTable();
  renderStatus();
  updateHud();
  requestRender();
}

function renderDemos() {
  const meta = DEMOS[ui.demoId] ?? {
    title: '自定义场景',
    note: '当前场景来自保存文件；两条曲线分别是受区域限制与无区域限制的混色结果。',
  };
  $('#chart-sub').textContent = meta.note;
}

/* ------------------------------------------------------------- panels */

function swatchRow(label, rgb, detail) {
  const el = document.createElement('div');
  el.className = 'swatch-row';
  const chip = document.createElement('i');
  chip.className = 'chip';
  chip.style.background = rgbToCss(rgb);
  const text = document.createElement('div');
  text.className = 'swatch-text';
  const l = document.createElement('span');
  l.className = 'swatch-label';
  l.textContent = label;
  const d = document.createElement('span');
  d.className = 'swatch-detail';
  d.textContent = detail;
  text.append(l, d);
  el.append(chip, text);
  return el;
}

function meter(label, value, tone = 'neutral') {
  const wrap = document.createElement('div');
  wrap.className = 'meter';
  const head = document.createElement('div');
  head.className = 'meter-head';
  const l = document.createElement('span');
  l.textContent = label;
  const v = document.createElement('strong');
  v.textContent = formatPct(value, 0);
  head.append(l, v);
  const track = document.createElement('div');
  track.className = 'meter-track';
  const fill = document.createElement('div');
  fill.className = `meter-fill tone-${tone}`;
  fill.style.width = `${clamp(value, 0, 1) * 100}%`;
  track.append(fill);
  wrap.append(head, track);
  return wrap;
}

function renderNow() {
  const s = currentSample();
  const body = $('#now-body');
  body.replaceChildren();
  if (!s) return;

  const pos = document.createElement('div');
  pos.className = 'kv';
  const addKv = (k, v) => {
    const row = document.createElement('div');
    row.className = 'kv-row';
    const kk = document.createElement('span');
    kk.className = 'kv-key';
    kk.textContent = k;
    const vv = document.createElement('span');
    vv.className = 'kv-val';
    vv.textContent = v;
    row.append(kk, vv);
    pos.append(row);
  };
  addKv('位置', `x ${state.mover.x.toFixed(2)} · z ${state.mover.z.toFixed(2)}`);
  addKv('区域', s.zone ? (s.zone === 'interior' ? '室内' : '室外') : s.outside ? '网格外' : '未分配');
  addKv('格子', s.col === null ? '—' : `${s.col},${s.row}`);
  addKv('参与探针', `${s.usedProbeCount} 个 · 权重和 ${formatNumber(s.totalWeight, 2)}`);
  body.append(pos);

  body.append(meter('实测支撑度', s.support, s.support >= 0.999 ? 'good' : s.support <= 0.001 ? 'critical' : 'warning'));
  body.append(meter('补缺值占比', s.fallbackFraction, s.fallbackFraction > 0.001 ? 'warning' : 'good'));

  const actual = document.createElement('div');
  actual.className = 'swatch-grid';
  actual.append(
    swatchRow('实际采样 · 朝上', s.computed.up, s.usedProbeCount ? '仅探针混合，不含补缺' : '没有可用探针'),
    swatchRow('实际采样 · 朝侧', avgSides(s.computed.sides), '四个方向平均'),
    swatchRow('补缺值 · 朝上', SAMPLE.fallback.up, '无实测数据时的中性值'),
  );
  if (s.usedFallback) {
    actual.append(
      swatchRow('最终混入后 · 朝上', s.colors.up, `实测 ${formatPct(1 - s.fallbackFraction, 0)} + 补缺 ${formatPct(s.fallbackFraction, 0)}`),
    );
  }
  body.append(actual);

  if (s.contributions.some((c) => c.crossSide)) {
    const note = document.createElement('p');
    note.className = 'note note-warn';
    const cross = s.contributions.filter((c) => c.crossSide).length;
    note.textContent = ui.mode === 'restricted'
      ? `${cross} 个跨区域探针参与混色；它们在门洞内的权重已按开口宽度和门扇位置折算。`
      : `${cross} 个跨区域探针直接参与混色，未检查墙和门——这就是无区域限制下的漏光来源。`;
    body.append(note);
  }
  if (s.usedFallback) {
    const note = document.createElement('p');
    note.className = 'note note-warn';
    note.textContent = `此位置实测支撑只有 ${formatPct(s.support, 0)}，最终颜色包含补缺值，不能当作真实采样结果。`;
    body.append(note);
  }
}

function avgSides(sides) {
  if (!sides) return [0, 0, 0];
  const out = [0, 0, 0];
  for (const d of CARDINALS) {
    out[0] += sides[d][0] / 4;
    out[1] += sides[d][1] / 4;
    out[2] += sides[d][2] / 4;
  }
  return out;
}

function renderProbePanel() {
  const s = currentSample();
  const body = $('#probe-body');
  body.replaceChildren();
  const hint = $('#probe-count-hint');
  if (!s) return;
  hint.textContent = `${s.usedProbeCount} 个参与`;

  if (!s.contributions.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = '当前点没有任何探针参与：数据只能靠补缺值。请确认所在格/区域是否有可用探针，或门是否把跨侧权重挡住了。';
    body.append(p);
    return;
  }

  for (const c of s.contributions) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'probe-row';
    if (ui.selectedProbeId === c.probeId) row.classList.add('is-selected');
    row.addEventListener('click', () => {
      ui.selectedProbeId = c.probeId;
      ui.selectedCellIndex = cellIndex(c.col, c.row);
      refreshAll();
    });

    const dot = document.createElement('i');
    dot.className = 'probe-dot';
    dot.style.background = rgbToCss(c.up);

    const main = document.createElement('div');
    main.className = 'probe-main';
    const title = document.createElement('div');
    title.className = 'probe-title';
    const name = document.createElement('span');
    name.textContent = c.probeId;
    const zone = document.createElement('span');
    zone.className = 'tag';
    zone.textContent = c.zone === 'interior' ? '室内' : '室外';
    title.append(name, zone);
    if (c.crossSide) {
      const tag = document.createElement('span');
      tag.className = 'tag tag-warn';
      tag.textContent = `跨区 · 门洞 ${formatPct(c.viaPortal, 0)}`;
      title.append(tag);
    }
    const bar = document.createElement('div');
    bar.className = 'share-track';
    const fill = document.createElement('div');
    fill.className = 'share-fill';
    fill.style.width = `${Math.max(1.5, c.fraction * 100)}%`;
    bar.append(fill);
    main.append(title, bar);

    const pct = document.createElement('span');
    pct.className = 'probe-pct';
    pct.textContent = formatPct(c.fraction, 0);

    row.append(dot, main, pct);
    body.append(row);
  }

  const foot = document.createElement('p');
  foot.className = 'note';
  const cross = s.contributions.filter((c) => c.crossSide).length;
  const footText = ui.mode === 'restricted'
    ? `比例按权重归一化；距离 ${SAMPLE.radius.toFixed(1)} m 外不参与。${cross ? `${cross} 个跨区域点受门洞可见性约束。` : '全部来自同一区域。'}`
    : `比例按权重归一化；距离 ${SAMPLE.radius.toFixed(1)} m 外不参与。${cross ? `${cross} 个跨区域点直接参与（漏光）。` : '全部来自同一区域。'}`;
  foot.textContent = footText;
  body.append(foot);
}

function renderAudit() {
  const audit = auditCoverage(state, { doorOpen: activeDoorOpen(), step: 0.25 });
  const status = $('#audit-status');
  status.className = 'pill';
  if (audit.complete) {
    status.classList.add('pill-good');
    status.textContent = '✔ 完整覆盖';
  } else if (audit.coverageRatio > 0.55) {
    status.classList.add('pill-warn');
    status.textContent = '△ 部分补缺';
  } else {
    status.classList.add('pill-bad');
    status.textContent = '✕ 补缺为主';
  }

  const body = $('#audit-body');
  body.replaceChildren();

  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = audit.summary;
  body.append(p);

  body.append(meter('路径覆盖率', audit.coverageRatio, audit.complete ? 'good' : 'warning'));

  const stats = document.createElement('div');
  stats.className = 'stat-row';
  const mk = (label, value, tone = '') => {
    const d = document.createElement('div');
    d.className = `stat ${tone}`;
    const v = document.createElement('strong');
    v.textContent = value;
    const l = document.createElement('span');
    l.textContent = label;
    d.append(v, l);
    return d;
  };
  stats.append(
    mk('可用格', `${audit.usableCells}/${audit.totalCells}`),
    mk('覆盖点', `${audit.covered}/${audit.samples}`),
    mk('补缺段', String(audit.fallbackSegments.length), audit.fallbackSegments.length ? 'stat-warn' : 'stat-good'),
  );
  body.append(stats);

  if (audit.fallbackSegments.length) {
    const list = document.createElement('ul');
    list.className = 'seg-list';
    for (const seg of audit.fallbackSegments.slice(0, 5)) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = `${seg.from.toFixed(1)}–${seg.to.toFixed(1)} m`;
      const reason = document.createElement('em');
      reason.textContent = seg.reason;
      li.append(span, reason);
      list.append(li);
    }
    body.append(list);
  }

  if (audit.emptyCells.length) {
    const p2 = document.createElement('p');
    p2.className = 'note note-warn';
    p2.textContent = `${audit.emptyCells.length} 个可用格内没有探针：${audit.emptyCells.map((c) => `${c.col},${c.row}`).join('；')}。这些格子附近会退回补缺值。`;
    body.append(p2);
  }

  if (ui.importSummary) {
    const p3 = document.createElement('p');
    p3.className = `note ${ui.importSummary.ok ? 'note-good' : 'note-warn'}`;
    p3.textContent = ui.importSummary.message;
    body.append(p3);
  }

  body.append(auditLegend());
}

function auditLegend() {
  const wrap = document.createElement('div');
  wrap.className = 'mini-legend';
  wrap.append(
    legendChip('good', '实测'),
    legendChip('warning', '实测 + 补缺'),
    legendChip('critical', '纯补缺'),
  );
  return wrap;
}

function legendChip(tone, label) {
  const s = document.createElement('span');
  const i = document.createElement('i');
  i.className = `mini-dot tone-${tone}`;
  s.append(i, document.createTextNode(label));
  return s;
}

function renderLeakPanel() {
  const body = $('#leak-body');
  body.replaceChildren();
  const pill = $('#leak-pill');
  const open = activeDoorOpen();

  // 门内侧一排采样点：对比两种策略，差值即“漏光”
  // 只取门洞宽度内（|z| ≤ 1.0），门全开时应只剩很小的差值，门关时明显变大。
  let maxLeak = 0;
  let sumLeak = 0;
  let n = 0;
  const probes = [];
  for (let i = 0; i < 9; i += 1) {
    const z = -1.0 + i * 0.25;
    const p = { x: DIVIDER.x - 0.35, z };
    const r = sampleLighting(state, p, { mode: 'restricted', doorOpen: open });
    const u = sampleLighting(state, p, { mode: 'unrestricted', doorOpen: open });
    const leak = Math.max(0, u.lum - r.lum);
    probes.push({ z, r, u, leak });
    maxLeak = Math.max(maxLeak, leak);
    sumLeak += leak;
    n += 1;
  }
  const avgLeak = n ? sumLeak / n : 0;
  pill.className = 'pill';
  if (maxLeak < 0.02) {
    pill.classList.add('pill-good');
    pill.textContent = '✔ 无明显漏光';
  } else if (maxLeak < 0.08) {
    pill.classList.add('pill-warn');
    pill.textContent = `△ 漏光 ${formatNumber(maxLeak, 3)}`;
  } else {
    pill.classList.add('pill-bad');
    pill.textContent = `✕ 漏光 ${formatNumber(maxLeak, 3)}`;
  }

  const stats = document.createElement('div');
  stats.className = 'stat-row';
  const mk = (label, value, tone = '') => {
    const d = document.createElement('div');
    d.className = `stat ${tone}`;
    const v = document.createElement('strong');
    v.textContent = value;
    const l = document.createElement('span');
    l.textContent = label;
    d.append(v, l);
    return d;
  };
  stats.append(
    mk('开启', `${Math.round(open * 100)}%`),
    mk('平均漏光', formatNumber(avgLeak, 3), avgLeak > 0.02 ? 'stat-warn' : 'stat-good'),
    mk('峰值漏光', formatNumber(maxLeak, 3), maxLeak > 0.05 ? 'stat-warn' : 'stat-good'),
  );
  body.append(stats);

  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = '门内侧 0.35 m、门洞宽度内 9 个采样点：无区域限制比受区域限制多出的亮度即漏光。门全开时只剩门框边缘的轻微差值，门关或半开时差值会明显变大。';
  body.append(p);

  // 每个采样点的小条，避免只用数字
  const strip = document.createElement('div');
  strip.className = 'leak-strip';
  for (const pt of probes) {
    const cell = document.createElement('i');
    cell.className = 'leak-cell';
    cell.style.background = `rgba(217,89,38,${clamp(pt.leak * 6, 0, 0.92)})`;
    cell.title = `z ${pt.z.toFixed(2)} · 漏光 ${formatNumber(pt.leak, 3)}`;
    strip.append(cell);
  }
  body.append(strip);
}

function renderInspector() {
  const body = $('#inspector-body');
  body.replaceChildren();

  const probe = state.probes.find((p) => p.id === ui.selectedProbeId) ?? null;
  const cell = ui.selectedCellIndex === null ? null : state.cells[ui.selectedCellIndex];

  if (!probe && !cell) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = '在俯视图里点一个格子或探针，或在三维视图里点探针。';
    body.append(p);
    return;
  }

  if (cell) body.append(cellEditor(cell));
  if (probe) body.append(probeEditor(probe));
}

function cellEditor(cell) {
  const wrap = document.createElement('div');
  wrap.className = 'editor-block';

  const head = document.createElement('div');
  head.className = 'editor-head';
  head.textContent = `格 ${cell.col},${cell.row}`;
  wrap.append(head);

  const zones = document.createElement('div');
  zones.className = 'segmented segmented-small';
  const opts = [
    { value: 'interior', label: '室内区' },
    { value: 'exterior', label: '室外区' },
    { value: null, label: '不可用' },
  ];
  for (const opt of opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opt.label;
    const active = opt.value === null
      ? cell.blocked || cell.zone === null
      : !cell.blocked && cell.zone === opt.value;
    if (active) b.classList.add('is-active');
    b.addEventListener('click', () => {
      if (opt.value === null) {
        cell.zone = null;
        cell.blocked = true;
        state.probes = state.probes.filter((p) => !(p.col === cell.col && p.row === cell.row));
        if (ui.selectedProbeId && !state.probes.some((p) => p.id === ui.selectedProbeId)) ui.selectedProbeId = null;
      } else {
        cell.zone = opt.value;
        cell.blocked = false;
      }
      recompute();
    });
    zones.append(b);
  }
  wrap.append(zones);

  const count = state.probes.filter((p) => p.col === cell.col && p.row === cell.row).length;
  const info = document.createElement('p');
  info.className = 'note';
  info.textContent = cell.blocked
    ? '该格被标为不可用：已移除其中探针，路径经过这里时只能用补缺值。'
    : count
      ? `该格有 ${count} 个探针。`
      : '该格还没有探针，附近位置会缺实测数据。';
  wrap.append(info);

  const actions = document.createElement('div');
  actions.className = 'editor-actions';

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-small';
  add.textContent = '在此格添加探针';
  add.disabled = cell.blocked || count >= 4;
  add.addEventListener('click', () => {
    const idx = state.probes.filter((p) => p.col === cell.col && p.row === cell.row).length;
    const override = { id: nextProbeId(state) };
    if (idx > 0) {
      override.ox = idx === 1 ? 0.4 : idx === 2 ? -0.4 : 0;
      override.oz = idx === 2 ? 0.4 : idx === 3 ? -0.4 : 0;
    }
    const probe = makeProbe(cell.col, cell.row, override);
    state.probes.push(probe);
    ui.selectedProbeId = probe.id;
    recompute();
  });
  actions.append(add);

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn btn-small btn-quiet';
  reset.textContent = '按区域重置本格';
  reset.disabled = cell.blocked;
  reset.addEventListener('click', () => {
    state.probes = state.probes.filter((p) => !(p.col === cell.col && p.row === cell.row));
    const probe = makeProbe(cell.col, cell.row, { id: nextProbeId(state) });
    state.probes.push(probe);
    ui.selectedProbeId = probe.id;
    recompute();
  });
  actions.append(reset);
  wrap.append(actions);

  return wrap;
}

function probeEditor(probe) {
  const wrap = document.createElement('div');
  wrap.className = 'editor-block';

  const head = document.createElement('div');
  head.className = 'editor-head';
  const title = document.createElement('span');
  title.textContent = `探针 ${probe.id}`;
  const sub = document.createElement('span');
  const pos = probeWorldPos(probe);
  sub.className = 'editor-sub';
  sub.textContent = `x ${pos.x.toFixed(2)} · z ${pos.z.toFixed(2)}`;
  head.append(title, sub);
  wrap.append(head);

  const row = document.createElement('div');
  row.className = 'editor-actions';
  const enabled = document.createElement('label');
  enabled.className = 'check';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = probe.enabled !== false;
  cb.addEventListener('change', () => { probe.enabled = cb.checked; recompute(); });
  enabled.append(cb, document.createTextNode('启用'));
  row.append(enabled);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn btn-small btn-danger';
  del.textContent = '删除探针';
  del.addEventListener('click', () => {
    state.probes = state.probes.filter((p) => p.id !== probe.id);
    ui.selectedProbeId = null;
    recompute();
  });
  row.append(del);
  wrap.append(row);

  const sliders = document.createElement('div');
  sliders.className = 'slider-grid';
  sliders.append(
    slider('权重', probe.weight, 0.1, 2, 0.05, (v) => { probe.weight = v; recompute({ keepInspector: true }); }),
    slider('半径 m', probe.radius, 0.8, 5, 0.1, (v) => { probe.radius = v; recompute({ keepInspector: true }); }),
    slider('格内偏移 X', probe.ox, -0.85, 0.85, 0.02, (v) => { probe.ox = v; recompute({ keepInspector: true }); }),
    slider('格内偏移 Z', probe.oz, -0.85, 0.85, 0.02, (v) => { probe.oz = v; recompute({ keepInspector: true }); }),
  );
  wrap.append(sliders);

  const colorsWrap = document.createElement('div');
  colorsWrap.className = 'color-grid';
  colorsWrap.append(colorField('朝上', probe.up, (rgb) => { probe.up = rgb; recompute({ keepInspector: true }); }));
  for (const dir of CARDINALS) {
    colorsWrap.append(colorField(`朝${SIDES_LABEL[dir]}`, probe.sides[dir], (rgb) => {
      probe.sides[dir] = rgb;
      recompute({ keepInspector: true });
    }));
  }
  wrap.append(colorsWrap);

  return wrap;
}

function slider(label, value, min, max, step, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'slider';
  const head = document.createElement('span');
  head.className = 'slider-head';
  const l = document.createElement('span');
  l.textContent = label;
  const v = document.createElement('span');
  v.textContent = Number(value).toFixed(2);
  head.append(l, v);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    const n = Number(input.value);
    v.textContent = n.toFixed(2);
    onChange(n);
  });
  wrap.append(head, input);
  return wrap;
}

function colorField(label, rgb, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'color-field';
  const text = document.createElement('span');
  text.textContent = label;
  const input = document.createElement('input');
  input.type = 'color';
  input.value = rgbToHex(rgb);
  input.addEventListener('input', () => onChange(hexToRgb(input.value)));
  wrap.append(input, text);
  return wrap;
}

/* ------------------------------------------------------------- frame UI */

function renderFrameReadout() {
  const s = currentPathSample();
  const el = $('#frame-readout');
  el.replaceChildren();
  if (!s) return;

  const flags = playhead > 0 ? stepFlags(samples[playhead - 1].restricted, s.restricted) : [];
  const frameIndex = playhead;

  const head = document.createElement('div');
  head.className = 'frame-head';
  const t = document.createElement('strong');
  t.textContent = `帧 ${frameIndex} / ${samples.length - 1}`;
  const d = document.createElement('span');
  d.textContent = `${s.dist.toFixed(2)} m · 格 ${s.restricted.col ?? '—'},${s.restricted.row ?? '—'} · ${s.restricted.zone === 'interior' ? '室内' : s.restricted.zone === 'exterior' ? '室外' : '未分配'}`;
  head.append(t, d);
  el.append(head);

  const row = document.createElement('div');
  row.className = 'frame-values';
  const prev = playhead > 0 ? samples[playhead - 1].restricted : null;
  const delta = prev ? s.restricted.lum - prev.lum : null;
  row.append(
    valuePill('受区域限制', s.restricted.lum, COLORS.seriesRestricted),
    valuePill('无区域限制', s.unrestricted.lum, COLORS.seriesUnrestricted),
    valuePill('补缺', s.restricted.fallbackFraction, COLORS.fallback, 'pct'),
  );
  if (delta !== null) {
    const d = document.createElement('span');
    d.className = `value-pill ${Math.abs(delta) > 0.05 ? 'value-pill-alert' : ''}`;
    d.title = '与上一帧相比的亮度变化';
    const l = document.createElement('span');
    l.textContent = 'Δ 本步';
    const v = document.createElement('strong');
    v.textContent = `${delta >= 0 ? '+' : ''}${formatNumber(delta, 3)}`;
    d.append(l, v);
    row.append(d);
  }
  el.append(row);

  const flagWrap = document.createElement('div');
  flagWrap.className = 'flag-row';
  if (!flags.length) {
    const span = document.createElement('span');
    span.className = 'flag flag-quiet';
    span.textContent = '本步无事件';
    flagWrap.append(span);
  } else {
    for (const f of flags) {
      const span = document.createElement('span');
      span.className = `flag flag-${f.type}`;
      span.textContent = `${f.label}：${f.detail}`;
      flagWrap.append(span);
    }
  }
  el.append(flagWrap);

  if (events.length) {
    const chips = document.createElement('div');
    chips.className = 'event-chips';
    const label = document.createElement('span');
    label.className = 'event-chips-label';
    label.textContent = '事件';
    chips.append(label);
    const near = nearestEventWindow(playhead);
    for (const ev of near) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'event-chip';
      if (ev.index === playhead) chip.classList.add('is-current');
      chip.title = `${ev.label} ${ev.detail}`;
      chip.textContent = `${ev.dist.toFixed(1)} m · ${ev.label}`;
      chip.addEventListener('click', () => goToFrame(ev.index));
      chips.append(chip);
    }
    el.append(chips);
  }

  if (ui.importedFrames) {
    const f = ui.importedFrames[frameIndex];
    if (f?.restricted) {
      const note = document.createElement('p');
      note.className = 'note note-good';
      note.textContent = `读回帧 ${frameIndex}：导出亮度 ${formatNumber(f.restricted.lum, 4)}，当前重算 ${formatNumber(s.restricted.lum, 4)}。`;
      el.append(note);
    } else {
      const note = document.createElement('p');
      note.className = 'note note-warn';
      note.textContent = '该帧不在读回的报告中（报告帧数较少）。';
      el.append(note);
    }
  }
}

function valuePill(label, value, color, kind = 'lum') {
  const wrap = document.createElement('span');
  wrap.className = 'value-pill';
  const key = document.createElement('i');
  key.className = 'line-key';
  key.style.background = color;
  const l = document.createElement('span');
  l.textContent = label;
  const v = document.createElement('strong');
  v.textContent = kind === 'pct' ? formatPct(value, 0) : formatNumber(value, 3);
  wrap.append(key, l, v);
  return wrap;
}

/** 取当前帧附近最多 8 个事件，用于快速跳转。 */
function nearestEventWindow(index) {
  if (!events.length) return [];
  const sorted = [...events].sort((a, b) => Math.abs(a.index - index) - Math.abs(b.index - index));
  return sorted.slice(0, 8).sort((a, b) => a.index - b.index);
}

/** 帧表可能在同一帧内被多次请求重画，合并为一次，避免拖动时反复建表。 */
let tableRaf = 0;
function renderFrameTable() {
  if (tableRaf) return;
  tableRaf = requestAnimationFrame(() => {
    tableRaf = 0;
    buildFrameTable();
  });
}

function buildFrameTable() {
  const table = $('#frame-table');
  table.replaceChildren();
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of ['帧', '距离', '区域', '格', '受区域限制', '无区域限制', '补缺', '主要探针']) {
    const th = document.createElement('th');
    th.textContent = h;
    hr.append(th);
  }
  thead.append(hr);
  const tbody = document.createElement('tbody');
  const stride = Math.max(1, Math.ceil(samples.length / 200));
  samples.forEach((s, i) => {
    if (i % stride !== 0 && i !== samples.length - 1) return;
    const tr = document.createElement('tr');
    tr.dataset.index = String(i);
    if (i === playhead) tr.className = 'is-current';
    const cells = [
      String(i),
      s.dist.toFixed(2),
      s.restricted.zone === 'interior' ? '室内' : s.restricted.zone === 'exterior' ? '室外' : '未分配',
      `${s.restricted.col},${s.restricted.row}`,
      s.restricted.lum.toFixed(4),
      s.unrestricted.lum.toFixed(4),
      formatPct(s.restricted.fallbackFraction, 0),
      s.restricted.contributions.slice(0, 3).map((c) => `${c.probeId} ${formatPct(c.fraction, 0)}`).join(' · ') || '—',
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    }
    tr.addEventListener('click', () => goToFrame(i));
    tbody.append(tr);
  });
  table.append(thead, tbody);
}

/** 帧表内容不变时，只移动当前行高亮，避免整表重建。 */
function updateFrameTableCurrent() {
  const rows = [...$('#frame-table').querySelectorAll('tbody tr')];
  if (!rows.length) return;
  rows.forEach((tr) => tr.classList.toggle('is-current', Number(tr.dataset.index) === playhead));
  const cur = rows.find((tr) => Number(tr.dataset.index) === playhead);
  const scroller = cur?.closest('.table-scroll');
  if (!cur || !scroller) return;
  const rowRect = cur.getBoundingClientRect();
  const boxRect = scroller.getBoundingClientRect();
  if (rowRect.top < boxRect.top) {
    scroller.scrollTop -= boxRect.top - rowRect.top + 8;
  } else if (rowRect.bottom > boxRect.bottom) {
    scroller.scrollTop += rowRect.bottom - boxRect.bottom + 8;
  }
}

function renderStatus() {
  const s = currentSample();
  const metrics = $('#status-metrics');
  metrics.textContent = s
    ? `探针 ${state.probes.length} · 支撑 ${formatPct(s.support, 0)} · 补缺 ${formatPct(s.fallbackFraction, 0)} · 帧 ${playhead}/${Math.max(0, samples.length - 1)}`
    : '';
}

function updateHud() {
  const s = currentSample();
  const hud = $('#hud-sample');
  if (!s) {
    hud.textContent = '';
    return;
  }
  hud.replaceChildren();
  const mk = (label, value, color) => {
    const span = document.createElement('span');
    const i = document.createElement('i');
    i.className = 'hud-dot';
    i.style.background = color;
    const b = document.createElement('b');
    b.textContent = value;
    span.append(i, b, document.createTextNode(label));
    return span;
  };
  hud.append(
    mk(MODE_LABEL[ui.mode], formatNumber(s.lum, 3), ui.mode === 'restricted' ? COLORS.seriesRestricted : COLORS.seriesUnrestricted),
    mk('补缺', formatPct(s.fallbackFraction, 0), COLORS.fallback),
  );
}

/* -------------------------------------------------------------- actions */

function goToFrame(index) {
  if (!samples.length) return;
  playhead = clamp(index, 0, samples.length - 1);
  const s = samples[playhead];
  state.mover = { x: s.x, z: s.z };
  state.followPath = true;
  $('#toggle-follow').checked = true;
  chart.setCurrent(playhead);
  renderNow();
  renderProbePanel();
  renderFrameReadout();
  updateFrameTableCurrent();
  renderStatus();
  updateHud();
  requestRender();
}

function nextEvent(dir = 1) {
  if (!events.length) return;
  const list = dir > 0 ? events : [...events].reverse();
  const found = list.find((e) => (dir > 0 ? e.index > playhead : e.index < playhead));
  if (found) goToFrame(found.index);
  else goToFrame(dir > 0 ? samples.length - 1 : 0);
}

function togglePlay() {
  ui.playing = !ui.playing;
  $('#btn-play').textContent = ui.playing ? '暂停' : '播放';
  if (ui.playTimer) {
    clearInterval(ui.playTimer);
    ui.playTimer = null;
  }
  if (!ui.playing) return;
  ui.playTimer = setInterval(() => {
    if (playhead >= samples.length - 1) {
      goToFrame(0);
    } else {
      goToFrame(playhead + 1);
    }
  }, 90);
}

function loadDemo(id) {
  ui.demoId = id;
  const keepView = { ...state.view };
  state = applyDemo(id);
  state.view = keepView;
  state.followPath = false;
  ui.importedFrames = null;
  ui.importSummary = null;
  ui.selectedProbeId = null;
  ui.selectedCellIndex = null;
  $('#toggle-follow').checked = false;
  playhead = 0;
  state.mover = { x: state.path[0].x, z: state.path[0].z };
  recompute({ keepPlayhead: false });
  setDoorUI();
  toast(`${DEMOS[id].title}：${DEMOS[id].note}`);
}

function syncViewToState() {
  state.view.floorMode = ui.showFloor ? ui.mode : 'off';
  state.view.showRays = ui.showRays;
  state.view.showProbes = ui.showProbes;
  state.view.selectedProbeId = ui.selectedProbeId;
  state.view.selectedCellIndex = ui.selectedCellIndex;
  state.followPath = $('#toggle-follow').checked;
}

function saveScene() {
  syncViewToState();
  const payload = serializeScene(state);
  download(`probe-scene-${ui.demoId}-${timestamp()}.json`, JSON.stringify(payload, null, 2));
  toast('已保存场景（探针分布、区域标记、门状态、路径）');
}

function exportCsv() {
  const rows = [['frame', 'dist_m', 'x', 'z', 'zone', 'support', 'fallback_pct', 'lum_restricted', 'lum_unrestricted', 'probes']];
  samples.forEach((s, i) => {
    rows.push([
      i,
      s.dist.toFixed(3),
      s.x.toFixed(3),
      s.z.toFixed(3),
      s.restricted.zone ?? 'unassigned',
      s.restricted.support.toFixed(3),
      (s.restricted.fallbackFraction * 100).toFixed(1),
      s.restricted.lum.toFixed(5),
      s.unrestricted.lum.toFixed(5),
      s.restricted.contributions.map((c) => `${c.probeId}:${c.fraction.toFixed(3)}${c.crossSide ? '@portal' + c.viaPortal.toFixed(2) : ''}`).join('|'),
    ]);
  });
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  download(`probe-path-${ui.demoId}-${timestamp()}.csv`, csv, 'text/csv');
  toast(`已导出 ${samples.length} 帧的亮度与采样点`);
}

function exportReport() {
  syncViewToState();
  const frameRows = samples.map((s, i) => ({
    index: i,
    dist: round(s.dist, 6),
    x: round(s.x, 6),
    z: round(s.z, 6),
    restricted: packSample(s.restricted),
    unrestricted: packSample(s.unrestricted),
  }));
  const payload = {
    format: 'light-probe-frame-report',
    version: 1,
    exportedAt: new Date().toISOString(),
    demo: ui.demoId,
    mode: ui.mode,
    doorOpen: activeDoorOpen(),
    scene: serializeScene(state),
    events,
    frames: frameRows,
  };
  download(`probe-report-${ui.demoId}-${timestamp()}.json`, JSON.stringify(payload, null, 2));
  toast('已导出帧报告（含场景快照，可读回复现）');
}

function packSample(s) {
  return {
    lum: round(s.lum, 6),
    support: round(s.support, 6),
    fallbackFraction: round(s.fallbackFraction, 6),
    zone: s.zone,
    blocked: s.blocked,
    col: s.col,
    row: s.row,
    usedProbeCount: s.usedProbeCount,
    contributors: s.contributions.map((c) => ({
      probeId: c.probeId,
      fraction: round(c.fraction, 6),
      weight: round(c.weight, 6),
      crossSide: c.crossSide,
      viaPortal: round(c.viaPortal, 4),
    })),
    colors: {
      up: s.colors.up.map((v) => round(v, 6)),
      sides: Object.fromEntries(CARDINALS.map((d) => [d, s.colors.sides[d].map((v) => round(v, 6))])),
    },
  };
}

const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

function applyLoadedView() {
  const v = state.view ?? {};
  ui.showRays = v.showRays !== false;
  ui.showProbes = v.showProbes !== false;
  ui.showFloor = v.floorMode !== 'off';
  if (v.floorMode === 'restricted' || v.floorMode === 'unrestricted') ui.mode = v.floorMode;
  $('#toggle-rays').checked = ui.showRays;
  $('#toggle-probes').checked = ui.showProbes;
  $('#toggle-floor').checked = ui.showFloor;
  $('#toggle-follow').checked = Boolean(state.followPath);
}

async function readSceneFile(file) {
  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    if (raw?.format === 'light-probe-frame-report' && raw.scene) {
      applyImportedReport(raw);
      return;
    }
    state = normalizeLoadedState(raw);
    ui.demoId = 'custom';
    ui.importedFrames = null;
    ui.importSummary = null;
    ui.selectedProbeId = null;
    ui.selectedCellIndex = null;
    applyLoadedView();
    recompute();
    setDoorUI();
    toast('已读回场景');
  } catch (err) {
    toast(`读取失败：${err.message}`, 'error');
  }
}

function applyImportedReport(raw) {
  const scene = normalizeLoadedState(raw.scene);
  state = scene;
  ui.demoId = raw.demo ?? 'custom';
  ui.importedFrames = Array.isArray(raw.frames) ? raw.frames : [];
  ui.importSummary = null;
  ui.selectedProbeId = null;
  ui.selectedCellIndex = null;
  applyLoadedView();
  recompute();

  let maxDiff = 0;
  let compared = 0;
  for (const frame of ui.importedFrames) {
    const ours = samples[frame.index];
    if (!ours || !frame.restricted) continue;
    maxDiff = Math.max(maxDiff, Math.abs(ours.restricted.lum - frame.restricted.lum));
    compared += 1;
  }
  ui.importSummary = {
    ok: compared > 0 && maxDiff < 1e-3,
    message: compared
      ? `读回报告：对比 ${compared} 帧，最大亮度差 ${maxDiff.toExponential(1)}。${maxDiff < 1e-3 ? '当前场景与报告一致，可复现对应帧。' : '结果与报告不一致：场景可能被修改或版本不同。'}`
      : '报告里没有可用的帧。',
  };
  renderAudit();
  setDoorUI();
  renderFrameReadout();
  renderFrameTable();
  updateHud();
  requestRender();
  toast(ui.importSummary.message, ui.importSummary.ok ? 'ok' : 'error');
}

function setDoorUI() {
  const el = $('#door-open');
  if (el) el.value = String(Math.round(activeDoorOpen() * 100));
  const label = $('#door-open-label');
  if (label) label.textContent = `${Math.round(activeDoorOpen() * 100)}%`;
  const toggle = $('#door-has-opening');
  if (toggle) toggle.checked = state.door.hasOpening !== false;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function download(name, content, type = 'application/json') {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let toastTimer = null;
function toast(message, tone = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.tone = tone;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5200);
}

/* ------------------------------------------------------- 3D interaction */

let drag = null;

function canvasPoint(evt) {
  const rect = view3d.getBoundingClientRect();
  return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
}

function pickMoverScreen(p) {
  const s = camera.project({ x: state.mover.x, y: MOVER.centerY, z: state.mover.z });
  if (!s) return Infinity;
  return Math.hypot(s.x - p.x, s.y - p.y);
}

function pickProbeScreen(p) {
  let best = null;
  let bestD = 16;
  for (const probe of state.probes) {
    const pos = probeWorldPos(probe);
    const s = camera.project(pos);
    if (!s) continue;
    const d = Math.hypot(s.x - p.x, s.y - p.y);
    if (d < bestD) { bestD = d; best = probe; }
  }
  return best;
}

view3d.addEventListener('pointerdown', (evt) => {
  view3d.setPointerCapture(evt.pointerId);
  const p = canvasPoint(evt);
  const probe = pickProbeScreen(p);
  if (probe) {
    ui.selectedProbeId = probe.id;
    ui.selectedCellIndex = cellIndex(probe.col, probe.row);
    drag = { kind: 'probe', probe, pointer: p };
    refreshAll();
    return;
  }
  if (pickMoverScreen(p) < 18) {
    drag = { kind: 'mover', pointer: p };
    return;
  }
  drag = { kind: 'orbit', start: p, yaw: camera.yaw, pitch: camera.pitch };
});

view3d.addEventListener('pointermove', (evt) => {
  if (!drag) return;
  const p = canvasPoint(evt);
  if (drag.kind === 'orbit') {
    camera.yaw = drag.yaw - (p.x - drag.start.x) * 0.006;
    camera.pitch = clamp(drag.pitch + (p.y - drag.start.y) * 0.004, 0.12, 1.35);
    requestRender();
    return;
  }
  const ground = camera.intersectPlane(p.x, p.y, drag.kind === 'probe' ? GRID.probeY : 0);
  if (!ground) return;
  if (drag.kind === 'mover') {
    state.mover = { x: clamp(ground.x, -5.8, 7.8), z: clamp(ground.z, -4.8, 4.8) };
    state.followPath = false;
    $('#toggle-follow').checked = false;
    syncLiveMover();
  } else if (drag.kind === 'probe') {
    const probe = drag.probe;
    const off = clampProbeToCell(probe, ground.x, ground.z);
    probe.ox = off.ox;
    probe.oz = off.oz;
    recompute({ keepInspector: true, keepAnalysis: true });
  }
});

function matchPathIndex(dist) {
  let best = 0;
  let bestD = Infinity;
  samples.forEach((s, i) => {
    const d = Math.abs(s.dist - dist);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

/** 把当前帧对齐到物体最近的路径位置（读回场景后保持物体不动）。 */
function alignPlayheadToMover() {
  if (!samples.length) return;
  const near = nearestOnPolyline(samples.map((s) => ({ x: s.x, z: s.z })), state.mover);
  playhead = matchPathIndex(near.dist);
}

/** 拖动方块时，同步当前帧读数与高亮，但不重算整条路径采样。 */
function syncLiveMover() {
  const near = nearestOnPolyline(samples.map((s) => ({ x: s.x, z: s.z })), state.mover);
  playhead = matchPathIndex(near.dist);
  chart.setCurrent(playhead);
  renderNow();
  renderProbePanel();
  renderFrameReadout();
  updateFrameTableCurrent();
  renderStatus();
  updateHud();
  requestRender();
}

view3d.addEventListener('pointerup', (evt) => { drag = null; });
view3d.addEventListener('pointercancel', () => { drag = null; });

view3d.addEventListener('wheel', (evt) => {
  evt.preventDefault();
  camera.dist = clamp(camera.dist * (1 + Math.sign(evt.deltaY) * 0.09), 6, 34);
  requestRender();
}, { passive: false });

view3d.addEventListener('dblclick', (evt) => {
  const p = canvasPoint(evt);
  const ground = camera.intersectPlane(p.x, p.y, 0);
  if (!ground) return;
  const c = cellOfPoint(ground.x, ground.z);
  if (!c) return;
  ui.selectedCellIndex = c.index;
  ui.selectedProbeId = null;
  refreshAll();
});

/* --------------------------------------------------- 2D map interaction */

$('#map').addEventListener('pointerdown', (evt) => {
  const rect = evt.target.getBoundingClientRect();
  const p = { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  const hit = map.hitTest(p.x, p.y);
  if (!hit) return;

  if (hit.kind === 'probe') {
    ui.selectedProbeId = hit.probeId;
    const probe = state.probes.find((pr) => pr.id === hit.probeId);
    if (probe) ui.selectedCellIndex = cellIndex(probe.col, probe.row);
    map.drag = { kind: 'probe', probeId: hit.probeId };
    evt.target.setPointerCapture(evt.pointerId);
  } else if (hit.kind === 'mover') {
    map.drag = { kind: 'mover' };
    evt.target.setPointerCapture(evt.pointerId);
  } else if (hit.kind === 'pathpoint') {
    map.drag = { kind: 'pathpoint', point: hit.point };
    evt.target.setPointerCapture(evt.pointerId);
  } else if (hit.kind === 'cell') {
    ui.selectedCellIndex = cellIndex(hit.col, hit.row);
    const probe = state.probes.find((pr) => pr.col === hit.col && pr.row === hit.row);
    ui.selectedProbeId = probe ? probe.id : null;
  }
  refreshAll();
});

$('#map').addEventListener('pointermove', (evt) => {
  const rect = evt.target.getBoundingClientRect();
  const p = { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  const world = map.toWorld(p.x, p.y);
  const hover = map.cellAtWorld(world.x, world.z);
  const hoverChanged = (hover?.col ?? null) !== (map.hoverCell?.col ?? null)
    || (hover?.row ?? null) !== (map.hoverCell?.row ?? null);
  map.hoverCell = hover;
  if (!map.drag) {
    if (hoverChanged) map.draw(state, activeSampler(), ui.mode, mapOptions());
    return;
  }
  if (map.drag.kind === 'probe') {
    const probe = state.probes.find((pr) => pr.id === map.drag.probeId);
    if (!probe) return;
    const off = clampProbeToCell(probe, world.x, world.z);
    probe.ox = off.ox;
    probe.oz = off.oz;
    recompute({ keepInspector: true, keepAnalysis: true });
  } else if (map.drag.kind === 'mover') {
    state.mover = {
      x: clamp(world.x, GRID.originX + 0.2, GRID.originX + GRID.cols * GRID.cell - 0.2),
      z: clamp(world.z, GRID.originZ + 0.2, GRID.originZ + GRID.rows * GRID.cell - 0.2),
    };
    state.followPath = false;
    $('#toggle-follow').checked = false;
    syncLiveMover();
  } else if (map.drag.kind === 'pathpoint') {
    map.drag.point.x = clamp(world.x, GRID.originX, GRID.originX + GRID.cols * GRID.cell);
    map.drag.point.z = clamp(world.z, GRID.originZ, GRID.originZ + GRID.rows * GRID.cell);
    recompute();
  }
});

$('#map').addEventListener('pointerup', () => { map.drag = null; });
$('#map').addEventListener('pointerleave', () => {
  map.drag = null;
  map.hoverCell = null;
  requestRender();
});

function activeSampler() {
  return (x, z, m) => sampleLighting(state, { x, z }, { mode: m, doorOpen: activeDoorOpen() });
}

function mapOptions() {
  return {
    selectedCell: ui.selectedCellIndex === null ? null : state.cells[ui.selectedCellIndex],
    selectedProbeId: ui.selectedProbeId,
    usedList: currentSample()?.contributions ?? [],
  };
}

/* ---------------------------------------------------------- controls UI */

$$('.demo-tab').forEach((btn) => {
  btn.addEventListener('click', () => loadDemo(btn.dataset.demo));
});

$$('#mix-mode button').forEach((btn) => {
  btn.addEventListener('click', () => {
    ui.mode = btn.dataset.mode;
    refreshAll();
  });
});

$('#toggle-floor').addEventListener('change', (e) => { ui.showFloor = e.target.checked; requestRender(); });

$('#door-open').addEventListener('input', (e) => {
  state.door.open = Number(e.target.value) / 100;
  state.door.hasOpening = true;
  $('#door-has-opening').checked = true;
  $('#door-open-label').textContent = `${e.target.value}%`;
  recompute();
});

$('#door-has-opening').addEventListener('change', (e) => {
  state.door.hasOpening = e.target.checked;
  recompute();
});
$('#toggle-rays').addEventListener('change', (e) => { ui.showRays = e.target.checked; requestRender(); });
$('#toggle-probes').addEventListener('change', (e) => { ui.showProbes = e.target.checked; requestRender(); });
$('#btn-reset-view').addEventListener('click', () => {
  camera.yaw = 0.42;
  camera.pitch = 0.74;
  camera.dist = 15.2;
  requestRender();
});

$('#btn-prev').addEventListener('click', () => goToFrame(playhead - 1));
$('#btn-next').addEventListener('click', () => goToFrame(playhead + 1));
$('#btn-prev-event').addEventListener('click', () => nextEvent(-1));
$('#btn-next-event').addEventListener('click', () => nextEvent(1));
$('#btn-play').addEventListener('click', togglePlay);
$('#toggle-follow').addEventListener('change', (e) => {
  state.followPath = e.target.checked;
  if (state.followPath) goToFrame(playhead);
});

$('#btn-save').addEventListener('click', saveScene);
$('#btn-load').addEventListener('click', () => $('#file-scene').click());
$('#file-scene').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) readSceneFile(file);
  e.target.value = '';
});
$('#btn-export').addEventListener('click', exportCsv);
$('#btn-report').addEventListener('click', exportReport);
$('#btn-import-report').addEventListener('click', () => $('#file-report').click());
$('#file-report').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) readSceneFile(file);
  e.target.value = '';
});

chart.onSeek = (index) => goToFrame(index);

document.addEventListener('keydown', (evt) => {
  const tag = evt.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT') return;
  if (evt.key === 'ArrowLeft') { evt.preventDefault(); goToFrame(playhead - 1); }
  else if (evt.key === 'ArrowRight') { evt.preventDefault(); goToFrame(playhead + 1); }
  else if (evt.key === ' ') { evt.preventDefault(); togglePlay(); }
});

const chartCanvas = $('#chart');
chartCanvas.addEventListener('pointermove', (e) => chart.handleMove(e));
chartCanvas.addEventListener('pointerleave', () => chart.handleLeave());
chartCanvas.addEventListener('pointerdown', (e) => chart.handleClick(e));

let resizeFrame = null;
const scheduleResize = () => {
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    resizeAll();
    requestRender();
  });
};

new ResizeObserver(scheduleResize).observe($('#viewport'));
new ResizeObserver(scheduleResize).observe($('.chart-card'));
new ResizeObserver(scheduleResize).observe($('.map-wrap'));

/* ---------------------------------------------------------------- boot */

function boot() {
  resizeAll();
  loadDemo('open');
  requestRender();
}

boot();

// 供自动化检查使用
window.__probeApp = {
  get state() { return state; },
  get samples() { return samples; },
  get events() { return events; },
  get playhead() { return playhead; },
  goToFrame,
  setMode: (m) => { ui.mode = m; refreshAll(); },
  sampleAt: (x, z, mode = 'restricted') => sampleLighting(state, { x, z }, { mode, doorOpen: activeDoorOpen() }),
  audit: () => auditCoverage(state, { doorOpen: activeDoorOpen() }),
};
