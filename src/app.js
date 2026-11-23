/*
 * Voicebox page controller. Wires the pure scheduler to the timeline, the
 * transport, the comparison view, the editors and the export bundle.
 *
 * Rendering is split so typing never destroys an input: structural lists
 * (events, categories, tables) rebuild only when their shape changes, while
 * playback chrome (cursor, chips, scrub) updates on a rAF ticker.
 */

import {
  COLOR_SLOTS,
  DEFAULT_CONFIG,
  MAX_CATEGORIES,
  POLICIES,
  REASONS,
  STATUSES,
  TIMBRES,
  comparePlans,
  normalizeConfig,
  normalizeEvents,
  schedule,
  statusTone,
} from './scheduler.js';
import { getSample } from './examples.js';
import {
  PreviewTransport,
  SAMPLE_RATE,
  encodeWav,
  renderOneShot,
  renderPlan,
} from './audio.js';
import { buildExportBundleSync, downloadBlob, timestampSlug } from './exporter.js';

const SERIES_HEX = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];
const STORAGE_KEY = 'voicebox.session.v1';
const EPS = 0.25;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  config: normalizeConfig(DEFAULT_CONFIG),
  events: normalizeEvents(getSample('dense').events),
  sampleId: 'dense',
  view: 'channel',
  filterChanged: false,
  plan: null,
  baseline: null,
  compare: null,
  categoryIds: '',
  eventIds: '',
  activeSignature: '',
  audioState: 'idle',
  audioError: '',
  lastExport: null,
};

const transport = new PreviewTransport();
let audioGen = 0;
let renderQueued = false;
let tickRaf = 0;
let ganttScale = null;

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function categoryOf(id) {
  return state.config.categories.find((c) => c.id === id) || null;
}

function categoryColor(cat) {
  if (!cat) return 'var(--ink-4)';
  return `var(--series-${cat.colorSlot + 1})`;
}

function colorForSlot(slot) {
  return SERIES_HEX[slot] || SERIES_HEX[0];
}

function relativeLuminance(hex) {
  const c = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(l1, l2) {
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/* In-fill labels (the one place text sits on a data color) pick the ink with
 * the higher measured contrast, per the palette's "by the fill's luminance"
 * rule. On these mid-dark steps the dark ink usually wins for small text. */
function themeInkForSlot(slot) {
  const lum = relativeLuminance(colorForSlot(slot));
  return contrastRatio(lum, 0.004) >= contrastRatio(lum, 1) ? '#0b0b0b' : '#ffffff';
}

function msText(ms) {
  return ms == null ? '—' : `${Math.round(ms * 10) / 10}`;
}

function eventNote(id) {
  return state.events.find((e) => e.id === id)?.note || '';
}

function toast(message, kind = 'info') {
  const stack = $('#toast-stack');
  const node = el('div', 'toast', message);
  node.dataset.kind = kind;
  stack.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity 200ms ease';
    setTimeout(() => node.remove(), 220);
  }, 3400);
}

/* ---------------------------------------------------------------- */
/* plan lifecycle                                                    */
/* ---------------------------------------------------------------- */

function recompute(options = {}) {
  const { resetTransport = true, audio = true } = options;
  state.plan = schedule(state.config, state.events);
  const unmuted = {
    ...state.config,
    categories: state.config.categories.map((c) => ({ ...c, muted: false })),
  };
  state.baseline = schedule(unmuted, state.events);
  state.compare = comparePlans(state.baseline, state.plan);
  rebuildDecisionIndex();

  if (resetTransport) {
    transport.stop();
    state.activeSignature = '';
  }
  renderAll();
  if (audio) rebuildAudio();
  persist();
}

function updateEvent(id, patch) {
  state.events = normalizeEvents(
    state.events.map((e) => (e.id === id ? { ...e, ...patch } : e))
  );
  recompute();
}

function updateCategory(id, patch, options = {}) {
  state.config = normalizeConfig({
    ...state.config,
    categories: state.config.categories.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  });
  recompute({ resetTransport: options.resetTransport !== false });
}

/* ---------------------------------------------------------------- */
/* audio rendering                                                   */
/* ---------------------------------------------------------------- */

function audioKey(plan) {
  // category gain / timbre live in the config digest, so the rendered buffer
  // is refreshed whenever the mix would change.
  return `${plan.outcomeDigest}:${plan.configDigest}`;
}

async function rebuildAudio() {
  const gen = ++audioGen;
  state.audioState = 'rendering';
  state.audioError = '';
  reflectTransport();
  const plan = state.plan;
  try {
    const buffer = await renderPlan(plan, { sampleRate: SAMPLE_RATE });
    if (gen !== audioGen) return;
    state.audioState = 'ready';
    if (transport.bufferKey !== audioKey(plan) || !transport.buffer) {
      await transport.setBuffer(buffer, audioKey(plan));
    }
    state.lastExport = { buffer, key: audioKey(plan) };
  } catch (err) {
    if (gen !== audioGen) return;
    state.audioState = 'error';
    state.audioError = err?.message || String(err);
  }
  reflectTransport();
}

async function auditionCategory(cat) {
  if (cat.muted) {
    toast(`${cat.name} 已被静音，取消静音后才能试听。`, 'warn');
    return;
  }
  try {
    const buffer = await renderOneShot(cat, { sampleRate: SAMPLE_RATE });
    const ctx = transport.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = 0.9;
    src.connect(g).connect(ctx.destination);
    src.start();
  } catch (err) {
    toast(`试听失败：${err?.message || err}`, 'error');
  }
}

/* ---------------------------------------------------------------- */
/* render: high level                                               */
/* ---------------------------------------------------------------- */

function renderAll() {
  renderHeader();
  renderStats();
  renderMuteList();
  renderCompare();
  renderGantt();
  renderLegend();
  renderDecisionTable();
  renderEventTable();
  renderChannelPane();
  renderCategoryPane();
  renderNowStrip(true);
  reflectTransport();
}

function renderHeader() {
  $('#digest-value').textContent = state.plan.outcomeDigest;
  $('#policy-chip').textContent = POLICIES[state.plan.config.policy].name;
  const sub = $('#stage-sub');
  sub.textContent =
    state.view === 'channel'
      ? '按通道分行；实心 = 实际发声，斜纹 = 延后，右侧虚影 = 被顶掉前的时长，圆点 = 舍弃'
      : '按类别分行，堆叠表示同类并发；每条轨道右侧是同类上限';
  const muted = state.config.categories.filter((c) => c.muted);
  const note = $('#mute-note');
  if (muted.length) {
    note.hidden = false;
    note.textContent = `静音中：${muted.map((c) => c.name).join('、')}`;
  } else {
    note.hidden = true;
    note.textContent = '';
  }
  const addSelect = $('#add-category');
  const catKey = state.config.categories.map((c) => c.id).join('|');
  if (addSelect.dataset.key !== catKey) {
    addSelect.dataset.key = catKey;
    addSelect.replaceChildren(
      ...state.config.categories.map((c) => {
        const opt = el('option', null, c.name);
        opt.value = c.id;
        return opt;
      })
    );
  } else {
    state.config.categories.forEach((c, i) => {
      addSelect.options[i].textContent = c.name;
    });
  }
}

/* ---------------------------------------------------------------- */
/* stats & compare                                                  */
/* ---------------------------------------------------------------- */

function renderStats() {
  const s = state.plan.summary;
  $('#stat-kept').textContent = s.kept;
  $('#stat-delayed').textContent = s.delayed;
  $('#stat-preempted').textContent = s.preempted;
  $('#stat-dropped').textContent = s.dropped;
  $('#stat-kept-foot').textContent = `${s.fullLength} 个完整播完`;
  $('#stat-delayed-foot').textContent = s.delayed ? `平均 +${s.avgDelayMs}ms` : '没有延后';
  $('#stat-preempted-foot').textContent = s.preempted ? '播放中被截断' : '没有被截断';
  $('#stat-dropped-foot').textContent = s.dropped ? '完全不发声' : '没有舍弃';
  $('#kv-sounded').textContent = s.sounded;
  $('#kv-total').textContent = s.total;
  $('#kv-full').textContent = s.fullLength;
  $('#kv-peak').textContent = s.peakVoices;
  $('#kv-voices').textContent = state.plan.config.maxVoices;
  $('#kv-avg-delay').textContent = msText(s.avgDelayMs);
  $('#kv-max-delay').textContent = msText(s.maxDelayObservedMs);
  $('#kv-util').textContent = `${s.utilizationPct}%`;
  $('#util-meter').style.width = `${Math.min(100, s.utilizationPct)}%`;

  const dropReasons = new Map();
  for (const d of state.plan.decisions) {
    if (d.status !== 'dropped') continue;
    const key =
      d.reasonCode === 'drop-cooldown'
        ? '触发间隔'
        : d.reasonCode === 'drop-cap'
          ? '同类上限'
          : d.reasonCode === 'drop-policy'
            ? '策略舍弃'
            : '通道不足';
    dropReasons.set(key, (dropReasons.get(key) || 0) + 1);
  }
  const mutedCount = s.muted;
  const pieces = [];
  pieces.push(
    `共 <strong>${s.total}</strong> 个事件，<strong>${s.sounded}</strong> 个发声（${s.fullLength} 个完整播完）。`
  );
  if (dropReasons.size) {
    pieces.push(
      `舍弃原因：${[...dropReasons.entries()]
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ')}。`
    );
  }
  if (mutedCount) pieces.push(`${mutedCount} 个事件因类别静音未参与调度。`);
  if (!dropReasons.size && !mutedCount) pieces.push('所有事件都进入了播放。');
  const noteEl = $('#summary-note');
  noteEl.replaceChildren();
  // Build with a tiny safe formatter: only <strong> is interpreted.
  const html = pieces.join('');
  const parts = html.split(/(<strong>.*?<\/strong>)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('<strong>')) {
      noteEl.appendChild(el('strong', null, part.slice(8, -9)));
    } else {
      noteEl.appendChild(document.createTextNode(part));
    }
  }
}

function renderMuteList() {
  const list = $('#mute-list');
  list.replaceChildren();
  for (const cat of state.config.categories) {
    const row = el('div', `mute-row${cat.muted ? ' is-muted' : ''}`);
    row.style.setProperty('--c', categoryColor(cat));
    const sw = el('span', 'swatch');
    const name = el('span', 'mute-name', cat.name);
    const meta = el(
      'span',
      'mute-meta',
      `P${cat.priority} · ${cat.durationMs}ms · 上限${cat.cap}`
    );
    const toggle = el('button', `btn tiny ${cat.muted ? '' : 'ghost'}`, cat.muted ? '取消静音' : '静音');
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(cat.muted));
    toggle.setAttribute('aria-label', `${cat.muted ? '取消静音' : '静音'} ${cat.name}`);
    toggle.addEventListener('click', () => {
      updateCategory(cat.id, { muted: !cat.muted });
      toast(
        cat.muted
          ? `${cat.name} 已恢复发声，结果已按原时间表重算。`
          : `${cat.name} 已静音，下方对比显示对原时间表的影响。`,
        cat.muted ? 'info' : 'warn'
      );
    });
    row.append(sw, name, meta, toggle);
    list.appendChild(row);
  }
  $('#btn-compare-clear').hidden = !state.config.categories.some((c) => c.muted);
}

function renderCompare() {
  const cmp = state.compare;
  const box = $('#compare-box');
  const clearBtn = $('#btn-compare-clear');
  clearBtn.onclick = () => {
    state.config = normalizeConfig({
      ...state.config,
      categories: state.config.categories.map((c) => ({ ...c, muted: false })),
    });
    recompute();
    toast('已恢复全部类别。', 'info');
  };
  if (!cmp || !cmp.mutedCategoryIds.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const names = cmp.mutedCategoryIds
    .map((id) => categoryOf(id)?.name || id)
    .join('、');
  const head = $('#compare-head');
  head.replaceChildren();
  head.append(
    document.createTextNode('静音 '),
    el('strong', null, names),
    document.createTextNode(
      `：${cmp.affected.length} 个事件的时间表发生变化（状态 ${cmp.changedStatus} · 开始时间 ${cmp.changedStart}）。`
    )
  );

  const grid = $('#compare-grid');
  grid.replaceChildren();
  const cells = [
    ['发声事件', cmp.countsBefore.sounded, cmp.countsAfter.sounded],
    ['完整播完', cmp.countsBefore.fullLength, cmp.countsAfter.fullLength],
    ['延后', cmp.countsBefore.delayed, cmp.countsAfter.delayed],
    ['舍弃', cmp.countsBefore.dropped, cmp.countsAfter.dropped],
  ];
  for (const [label, before, after] of cells) {
    const cell = el('div', 'compare-cell', label);
    const b = el('b', null, `${before} → ${after}`);
    const delta = after - before;
    const d = el(
      'span',
      'delta',
      delta === 0 ? '不变' : `${delta > 0 ? '+' : ''}${delta}`
    );
    cell.append(b, document.createTextNode(' '), d);
    grid.appendChild(cell);
  }

  const list = $('#compare-list');
  list.replaceChildren();
  if (!cmp.affected.length) {
    list.appendChild(
      el('li', 'compare-empty', '静音没有改变任何其它事件的时间表。')
    );
    return;
  }
  for (const a of cmp.affected) {
    const li = el('li');
    const cat = categoryOf(a.categoryId);
    li.appendChild(el('span', 'cl-time', `${msText(a.plannedMs)}ms`));
    const main = el('span', 'cl-main', `${a.eventId} · ${cat?.name || a.categoryId}`);
    if (a.deltaStartMs != null && Math.abs(a.deltaStartMs) > 0.5) {
      main.appendChild(
        el('span', 'victim-tag', `${a.deltaStartMs > 0 ? '+' : ''}${msText(a.deltaStartMs)}ms`)
      );
    }
    li.appendChild(main);
    const status = el(
      'span',
      'cl-status status-pill',
      `${STATUSES[a.before.status]?.label || a.before.status} → ${STATUSES[a.after.status]?.label || a.after.status}`
    );
    status.dataset.tone = statusTone(a.after.status);
    li.appendChild(status);
    list.appendChild(li);
  }
}

/* ---------------------------------------------------------------- */
/* timeline / gantt                                                 */
/* ---------------------------------------------------------------- */

function buildLanes() {
  const plan = state.plan;
  const lanes = [];
  if (state.view === 'channel') {
    for (let ch = 1; ch <= plan.config.maxVoices; ch += 1) {
      const items = plan.playbacks
        .filter((p) => p.channel === ch)
        .map((p) => ({ decision: byEvent(p.eventId), playback: p, row: 0 }));
      lanes.push({
        id: `ch-${ch}`,
        label: `CH ${ch}`,
        kind: 'channel',
        height: 44,
        items,
      });
    }
  } else {
    for (const cat of state.config.categories) {
      const items = plan.playbacks.filter((p) => p.categoryId === cat.id);
      const rowEnds = [];
      const rows = new Map();
      for (const p of [...items].sort((a, b) => a.start - b.start || a.channel - b.channel)) {
        let row = rowEnds.findIndex((end) => end <= p.start + EPS);
        if (row === -1) {
          rowEnds.push(p.end);
          row = rowEnds.length - 1;
        } else {
          rowEnds[row] = p.end;
        }
        rows.set(p.eventId, row);
      }
      const rowCount = Math.max(1, rowEnds.length);
      lanes.push({
        id: `cat-${cat.id}`,
        label: cat.name,
        color: categoryColor(cat),
        cap: cat.cap,
        kind: 'category',
        height: Math.max(44, rowCount * 24 + 16),
        items: items.map((p) => ({
          decision: byEvent(p.eventId),
          playback: p,
          row: rows.get(p.eventId) || 0,
        })),
      });
    }
  }

  // Dropped / muted decisions share one lane; same-instant markers stack.
  const unplaced = plan.decisions
    .filter((d) => d.status === 'dropped' || d.status === 'muted')
    .sort((a, b) => a.plannedMs - b.plannedMs || a.sheetIndex - b.sheetIndex);
  const stackByTime = new Map();
  const unplacedItems = unplaced.map((d) => {
    const key = Math.round(d.plannedMs);
    const row = stackByTime.get(key) || 0;
    stackByTime.set(key, row + 1);
    return { decision: d, playback: null, row };
  });
  const maxRows = Math.max(1, ...[...stackByTime.values()]);
  lanes.push({
    id: 'unplaced',
    label: '未发声',
    kind: 'unplaced',
    height: Math.max(44, maxRows * 20 + 12),
    items: unplacedItems,
  });
  return lanes;
}

const byEventCache = new Map();
function byEvent(id) {
  if (!byEventCache.has(id)) return null;
  return byEventCache.get(id);
}

function rebuildDecisionIndex() {
  byEventCache.clear();
  for (const d of state.plan.decisions) byEventCache.set(d.eventId, d);
}

function renderGantt() {
  rebuildDecisionIndex();
  const lanes = buildLanes();
  const totalMs = state.plan.totalMs;
  const gutter = $('#gantt-gutter');
  const laneHost = $('#gantt-lanes');
  const plot = $('#gantt-plot');
  gutter.replaceChildren();
  laneHost.replaceChildren();

  const width = Math.max(320, plot.clientWidth || 640);
  const scale = width / totalMs;
  ganttScale = { width, totalMs, scale };

  gutter.style.height = 'auto';
  for (const lane of lanes) {
    const label = el('div', 'lane-label');
    label.style.height = `${lane.height}px`;
    if (lane.kind === 'channel') {
      label.appendChild(el('span', 'lane-label-text', lane.label));
      const count = lane.items.length;
      label.appendChild(el('span', 'lane-cap', `${count}`));
    } else if (lane.kind === 'unplaced') {
      label.appendChild(el('span', 'lane-label-text', lane.label));
      const count = lane.items.length;
      label.appendChild(el('span', 'lane-cap', `${count}`));
    } else {
      const sw = el('span', 'lane-swatch');
      sw.style.setProperty('--lane-color', lane.color);
      label.appendChild(sw);
      label.appendChild(el('span', 'lane-label-text', lane.label));
      label.appendChild(el('span', 'lane-cap', `≤${lane.cap}`));
    }
    label.title = lane.kind === 'unplaced' ? '舍弃与静音的事件' : lane.label;
    gutter.appendChild(label);

    const laneEl = el('div', 'lane');
    laneEl.style.height = `${lane.height}px`;
    laneEl.dataset.laneId = lane.id;
    laneEl.dataset.kind = lane.kind;
    renderLaneItems(laneEl, lane, scale, totalMs);
    laneEl.addEventListener('pointermove', (ev) => onLanePointerMove(ev, laneEl, lane, scale, totalMs));
    laneEl.addEventListener('pointerleave', clearHover);
    laneEl.addEventListener('click', (ev) => {
      if (ev.target.closest('.sound')) return;
      const rect = laneEl.getBoundingClientRect();
      const t = ((ev.clientX - rect.left) / rect.width) * totalMs;
      transport.seek(t);
    });
    laneHost.appendChild(laneEl);
  }

  renderGrid(totalMs, scale, lanes);
  renderAxis(totalMs, scale);
  positionCursor();
}

function renderLaneItems(laneEl, lane, scale, totalMs) {
  const pct = (v) => `${(v / totalMs) * 100}%`;
  const activeIds = activeEventIds(transport.positionMs());

  // Invisible layer under the marks: a click anywhere seeks.
  const hit = el('div', 'lane-hit');
  hit.setAttribute('aria-hidden', 'true');
  laneEl.appendChild(hit);

  const catFor = (id) => categoryOf(id);

  for (const item of lane.items) {
    const d = item.decision;
    const p = item.playback;
    const cat = catFor(d.categoryId);
    const color = categoryColor(cat);
    // Channel lanes center each mark on the lane; the by-category view stacks
    // concurrent intervals, so every decoration follows the same row offset.
    // `centerX` keeps the horizontal translate for point-like markers.
    const rowTop = (height, centerX = false) => {
      if (lane.kind === 'category') {
        return {
          top: `${8 + (item.row || 0) * 24 + (24 - height) / 2}px`,
          transform: centerX ? 'translateX(-50%)' : 'none',
        };
      }
      return centerX
        ? { transform: 'translate(-50%, -50%)' }
        : { transform: 'translateY(-50%)' };
    };

    // Baseline ghost: where this event sat before the mute comparison.
    const baselineDecision =
      state.compare?.mutedCategoryIds.length
        ? state.baseline.decisions.find((x) => x.eventId === d.eventId)
        : null;
    if (baselineDecision && baselineDecision.startMs != null) {
      const moved =
        d.startMs == null ||
        Math.abs(baselineDecision.startMs - d.startMs) > 0.5 ||
        baselineDecision.status !== d.status;
      if (moved) {
        const ghost = el('div', 'baseline-ghost');
        ghost.style.left = pct(baselineDecision.startMs);
        ghost.style.width = pct(
          Math.max(
            6,
            (baselineDecision.endMs ?? baselineDecision.startMs) - baselineDecision.startMs
          )
        );
        ghost.style.setProperty('--mark-color', color);
        Object.assign(ghost.style, rowTop(18));
        ghost.title = `静音前：${STATUSES[baselineDecision.status].label} @ ${msText(
          baselineDecision.startMs
        )}ms`;
        laneEl.appendChild(ghost);
      }
    }

    if (!p) {
      const marker = el(
        'button',
        `drop-marker${d.status === 'muted' ? ' is-muted' : ''}`,
        d.status === 'muted' ? '—' : '✕'
      );
      marker.type = 'button';
      marker.style.left = pct(d.plannedMs);
      if (lane.kind === 'unplaced') {
        marker.style.top = `${12 + (item.row || 0) * 20}px`;
      } else {
        marker.style.top = '50%';
        marker.style.transform = 'translate(-50%, -50%)';
      }
      marker.style.setProperty('--mark-color', color);
      marker.setAttribute(
        'aria-label',
        `${d.eventId} ${cat?.name || d.categoryId} ${STATUSES[d.status].label}：${REASONS[d.reasonCode] || ''}`
      );
      marker.addEventListener('click', (ev) => {
        ev.stopPropagation();
        transport.seek(d.plannedMs);
        showDecisionCard(d, ev.clientX, ev.clientY);
      });
      marker.addEventListener('focus', () => {
        const r = marker.getBoundingClientRect();
        showDecisionCard(d, r.right, r.top);
      });
      marker.addEventListener('blur', clearHover);
      laneEl.appendChild(marker);
      continue;
    }

    // Planned tick + delay hatch.
    if (p.start > p.plannedMs + EPS) {
      const tick = el('div', 'plan-tick');
      tick.style.left = pct(p.plannedMs);
      tick.style.setProperty('--mark-color', color);
      if (lane.kind === 'category') {
        // `.plan-tick` is anchored for the 44px channel lane; in the stacked
        // category view it follows its row instead.
        tick.style.top = `${8 + (item.row || 0) * 24 + 3}px`;
        tick.style.height = '18px';
      }
      laneEl.appendChild(tick);
      const ghost = el('div', 'delay-ghost');
      ghost.style.left = pct(p.plannedMs);
      ghost.style.width = pct(p.start - p.plannedMs);
      ghost.style.setProperty('--mark-color', color);
      Object.assign(ghost.style, rowTop(18));
      laneEl.appendChild(ghost);
    }

    // Natural tail for cut sounds.
    const cut = p.end < p.naturalEnd - EPS;
    if (cut) {
      const tail = el('div', 'natural-tail');
      tail.style.left = pct(p.end);
      tail.style.width = pct(p.naturalEnd - p.end);
      tail.style.setProperty('--mark-color', color);
      Object.assign(tail.style, rowTop(18));
      tail.title = `本应播放到 ${msText(p.naturalEnd)}ms`;
      laneEl.appendChild(tail);
    }

    const bar = el('button', 'sound');
    bar.type = 'button';
    bar.dataset.status = d.status;
    bar.dataset.muted = String(d.status === 'muted');
    bar.dataset.eventId = d.eventId;
    bar.style.left = pct(p.start);
    bar.style.width = pct(p.end - p.start);
    if (lane.kind === 'category') Object.assign(bar.style, rowTop(18));
    bar.style.setProperty('--mark-color', color);
    bar.style.color = themeInkForSlot(cat?.colorSlot ?? 0);
    if (activeIds.has(p.eventId)) bar.classList.add('is-active');
    // Only place a label inside the bar when it actually fits; the tooltip and
    // the decision table always carry the value.
    const barPx = (p.end - p.start) * scale;
    const nameTxt = cat?.name || d.categoryId;
    if (barPx >= nameTxt.length * 12 + 14) {
      bar.appendChild(el('span', 'bar-label', nameTxt));
    }
    const delayTxt = d.delayMs > 0.05 ? `+${msText(d.delayMs)}ms` : '准时';
    bar.title = `${d.eventId} · ${cat?.name || d.categoryId} · 计划 ${msText(
      p.plannedMs
    )}ms / 开始 ${msText(p.start)}ms（${delayTxt}）· CH ${p.channel}`;
    bar.setAttribute(
      'aria-label',
      `${d.eventId} ${cat?.name || d.categoryId}，计划 ${Math.round(
        p.plannedMs
      )} 毫秒，实际开始 ${Math.round(p.start)} 毫秒，通道 ${p.channel}，${STATUSES[d.status].label}`
    );
    bar.addEventListener('pointerenter', (ev) => showDecisionCard(d, ev.clientX, ev.clientY, p));
    bar.addEventListener('pointermove', (ev) => positionCard(ev.clientX, ev.clientY));
    bar.addEventListener('pointerleave', clearHover);
    bar.addEventListener('click', (ev) => {
      ev.stopPropagation();
      transport.seek(p.start);
      showDecisionCard(d, ev.clientX, ev.clientY, p);
    });
    bar.addEventListener('focus', () => {
      const r = bar.getBoundingClientRect();
      showDecisionCard(d, r.right + 6, r.top, p);
    });
    bar.addEventListener('blur', clearHover);
    laneEl.appendChild(bar);

    if (d.status === 'preempted') {
      const cutMark = el('span', 'cut-mark', '✂');
      cutMark.style.left = pct(p.end);
      Object.assign(cutMark.style, rowTop(12, true));
      cutMark.title = `在 ${msText(p.end)}ms 被 ${d.preemptedBy} 顶掉`;
      laneEl.appendChild(cutMark);
    }
  }
}

function renderGrid(totalMs, scale, lanes) {
  const grid = $('#gantt-grid');
  grid.replaceChildren();
  const { ticks } = chooseTicks(totalMs);
  for (const t of ticks) {
    const line = el('div', `grid-line${t === 0 ? ' major' : ''}`);
    line.style.left = `${(t / totalMs) * 100}%`;
    grid.appendChild(line);
  }
  const laneHeight = lanes.reduce((s, l) => s + l.height, 0);
  grid.style.height = `${laneHeight}px`;
}

function chooseTicks(totalMs) {
  const steps = [50, 100, 200, 250, 500, 1000, 2000, 5000];
  let step = steps[steps.length - 1];
  for (const s of steps) {
    if (totalMs / s <= 12) {
      step = s;
      break;
    }
  }
  const ticks = [];
  for (let t = 0; t <= totalMs; t += step) ticks.push(t);
  return { step, ticks };
}

function renderAxis(totalMs, scale) {
  const axis = $('#gantt-axis');
  axis.replaceChildren();
  const { ticks } = chooseTicks(totalMs);
  for (const t of ticks) {
    const tick = el('span', 'axis-tick', `${Math.round(t)}`);
    tick.style.left = `${(t / totalMs) * 100}%`;
    axis.appendChild(tick);
  }
  const unit = el('span', 'axis-unit', 'ms');
  axis.appendChild(unit);
  axis.style.height = '26px';
}

function onLanePointerMove(ev, laneEl, lane, scale, totalMs) {
  if (ev.pointerType === 'touch') return;
  const rect = laneEl.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const t = (x / rect.width) * totalMs;
  $('#gantt-now').style.left = `${(t / totalMs) * 100}%`;
  $('#gantt-now').hidden = false;

  const direct = lane.items.find((i) => i.playback && t >= i.playback.start && t < i.playback.end);
  if (direct) {
    showDecisionCard(direct.decision, ev.clientX, ev.clientY, direct.playback);
    return;
  }
  let best = null;
  let bestDist = Infinity;
  for (const item of lane.items) {
    const time = item.playback ? item.playback.start : item.decision.plannedMs;
    const px = Math.abs(time * scale - x);
    if (px < bestDist) {
      bestDist = px;
      best = item;
    }
  }
  if (best && bestDist <= 26) {
    showDecisionCard(best.decision, ev.clientX, ev.clientY, best.playback);
    return;
  }
  hideCard();
}

function positionCursor() {
  const plot = $('#gantt-plot');
  const totalMs = state.plan.totalMs;
  const pos = transport.positionMs();
  const pct = Math.min(1, Math.max(0, pos / totalMs));
  const cursor = $('#gantt-cursor');
  cursor.style.left = `${pct * 100}%`;
  const wrap = $('#gantt');
  if (wrap.offsetWidth) cursor.style.height = `${$('#gantt-lanes').offsetHeight}px`;
  const scrub = $('#scrub');
  if (document.activeElement !== scrub) scrub.value = String(Math.round(pct * 1000));
  scrub.style.setProperty('--scrub-progress', `${pct * 100}%`);
  $('#time-now').textContent = (pos / 1000).toFixed(3);
  $('#time-total').textContent = (totalMs / 1000).toFixed(3);
}

/* ---------------------------------------------------------------- */
/* now strip                                                         */
/* ---------------------------------------------------------------- */

function activePlaybacks(t) {
  return state.plan.playbacks.filter((p) => p.start <= t + EPS && t < p.end - EPS);
}

function activeEventIds(t) {
  return new Set(activePlaybacks(t).map((p) => p.eventId));
}

function renderNowStrip(force = false) {
  const t = transport.positionMs();
  const active = activePlaybacks(t);
  const sig = active.map((p) => `${p.eventId}:${p.channel}`).join('|') + `#${state.audioState}`;
  if (!force && sig === state.activeSignature) {
    updateNextPlan(t);
    return;
  }
  state.activeSignature = sig;
  const host = $('#now-strip');
  host.replaceChildren();
  if (!active.length) {
    host.appendChild(el('span', 'now-empty', '空闲 · 没有声音占用通道'));
  } else {
    for (const p of active) {
      const d = byEvent(p.eventId);
      const cat = categoryOf(p.categoryId);
      const chip = el('span', 'now-chip');
      chip.style.setProperty('--c', categoryColor(cat));
      chip.style.color = themeInkForSlot(cat?.colorSlot ?? 0);
      chip.appendChild(el('span', 'chip-ch', `CH${p.channel}`));
      chip.appendChild(el('span', null, `${cat?.name || p.categoryId} · ${p.eventId}`));
      if (d && d.status === 'preempted') chip.classList.add('is-cut');
      host.appendChild(chip);
    }
  }
  updateNextPlan(t);
  updateNowRowHighlights(t);
}

function updateNextPlan(t) {
  let next = null;
  for (const d of state.plan.decisions) {
    if (d.status === 'muted') continue;
    if (d.plannedMs > t + EPS) {
      if (!next || d.plannedMs < next.plannedMs) next = d;
    }
  }
  const node = $('#now-plan');
  if (!next) {
    node.textContent = '';
    return;
  }
  const cat = categoryOf(next.categoryId);
  node.textContent = `下一计划 ${msText(next.plannedMs)}ms · ${cat?.name || next.categoryId} +${msText(
    Math.max(0, next.plannedMs - t)
  )}ms`;
}

function updateNowRowHighlights(t) {
  const ids = activeEventIds(t);
  for (const row of $$('#decision-body tr')) {
    row.classList.toggle('is-now', ids.has(row.dataset.eventId));
  }
}

/* ---------------------------------------------------------------- */
/* hover card                                                       */
/* ---------------------------------------------------------------- */

function showDecisionCard(decision, clientX, clientY, playback) {
  if (!decision) return;
  const card = $('#hover-card');
  card.replaceChildren();
  card.hidden = false;

  const cat = categoryOf(decision.categoryId);
  const head = el('div', 'hc-head');
  const dot = el('span', 'hc-dot');
  dot.style.setProperty('--c', categoryColor(cat));
  head.appendChild(dot);
  head.appendChild(document.createTextNode(`${decision.eventId} · ${cat?.name || decision.categoryId}`));
  card.appendChild(head);

  const dl = el('dl');
  const add = (k, v) => {
    dl.appendChild(el('dt', null, k));
    dl.appendChild(el('dd', null, v));
  };
  add('计划', `${msText(decision.plannedMs)} ms`);
  if (decision.startMs != null) {
    add('实际开始', `${msText(decision.startMs)} ms`);
    add('结束', `${msText(decision.endMs)} ms${playback && playback.end < playback.naturalEnd - EPS ? '（被截断）' : ''}`);
    add('延迟', decision.delayMs > 0.05 ? `+${msText(decision.delayMs)} ms` : '准时');
    add('通道', `CH ${decision.channel}`);
  } else {
    add('实际开始', '未发声');
    add('通道', '—');
  }
  add('优先级', `P${decision.priority}`);
  if (playback && playback.cutBy) add('被顶于', `${msText(playback.end)} ms`);
  card.appendChild(dl);

  if (decision.victims.length) {
    const line = el('div', 'hc-reason', `顶掉：${decision.victims.join('、')}`);
    card.appendChild(line);
  }
  if (decision.status === 'preempted') {
    card.appendChild(
      el(
        'div',
        'hc-reason',
        `在 ${msText(decision.preemptedAtMs)} ms 被 ${decision.preemptedBy} 顶掉，提前结束。`
      )
    );
  }
  const reason = el('div', 'hc-reason');
  reason.textContent = `${STATUSES[decision.status].label} · ${REASONS[decision.reasonCode] || decision.reasonCode}`;
  if (decision.blockers && decision.blockers.length) {
    reason.textContent += `（占用者：${decision.blockers.join('、')}）`;
  }
  card.appendChild(reason);

  const base = state.compare?.mutedCategoryIds.length
    ? state.baseline.decisions.find((x) => x.eventId === decision.eventId)
    : null;
  if (base && (base.status !== decision.status || (base.startMs ?? -1) !== (decision.startMs ?? -1))) {
    card.appendChild(
      el(
        'div',
        'hc-reason',
        `静音前：${STATUSES[base.status].label}${
          base.startMs != null ? ` @ ${msText(base.startMs)} ms · CH ${base.channel}` : ''
        }`
      )
    );
  }

  positionCard(clientX, clientY);
}

function positionCard(x, y) {
  const card = $('#hover-card');
  if (card.hidden) return;
  card.style.left = '0px';
  card.style.top = '0px';
  const rect = card.getBoundingClientRect();
  const left = Math.min(window.innerWidth - rect.width - 12, x + 14);
  const top = Math.min(window.innerHeight - rect.height - 12, y + 14);
  card.style.left = `${Math.max(8, left)}px`;
  card.style.top = `${Math.max(8, top)}px`;
}

function hideCard() {
  $('#hover-card').hidden = true;
}

function clearHover() {
  hideCard();
  $('#gantt-now').hidden = true;
}

/* ---------------------------------------------------------------- */
/* legend                                                           */
/* ---------------------------------------------------------------- */

function renderLegend() {
  const host = $('#legend');
  host.replaceChildren();
  for (const cat of state.config.categories) {
    const item = el('span', 'legend-item');
    item.setAttribute('role', 'listitem');
    const sw = el('span', 'legend-swatch');
    sw.style.setProperty('--c', categoryColor(cat));
    item.appendChild(sw);
    item.appendChild(document.createTextNode(cat.name));
    if (cat.muted) item.appendChild(el('span', 'victim-tag', '静音'));
    host.appendChild(item);
  }
  for (const key of ['kept', 'delayed', 'preempted', 'dropped', 'muted']) {
    const s = STATUSES[key];
    const item = el('span', 'legend-status');
    const glyph = el('span', 'status-glyph', s.icon);
    glyph.dataset.tone = s.tone;
    item.appendChild(glyph);
    item.appendChild(document.createTextNode(s.label));
    host.appendChild(item);
  }
}

/* ---------------------------------------------------------------- */
/* decision table                                                   */
/* ---------------------------------------------------------------- */

function renderDecisionTable() {
  const body = $('#decision-body');
  body.replaceChildren();
  const changed = new Map(
    (state.compare?.mutedCategoryIds.length ? state.compare.affected : []).map((a) => [
      a.eventId,
      a,
    ])
  );
  const filter = $('#filter-changed');
  filter.disabled = !changed.size;
  if (!changed.size) {
    state.filterChanged = false;
    filter.checked = false;
  }

  for (const d of state.plan.decisions) {
    if (state.filterChanged && !changed.has(d.eventId)) continue;
    const cat = categoryOf(d.categoryId);
    const tr = el('tr');
    tr.dataset.eventId = d.eventId;
    if (changed.has(d.eventId)) tr.classList.add('is-affected');

    const addCell = (text, cls) => {
      const td = el('td', cls, text);
      tr.appendChild(td);
      return td;
    };

    addCell(String(d.sheetIndex + 1), 'num');
    addCell(d.eventId, 'mono');
    const catTd = el('td');
    const tag = el('span', 'cat-tag');
    const sw = el('span', 'swatch');
    sw.style.setProperty('--c', categoryColor(cat));
    tag.appendChild(sw);
    tag.appendChild(document.createTextNode(cat?.name || d.categoryId));
    catTd.appendChild(tag);
    tr.appendChild(catTd);
    addCell(msText(d.plannedMs), 'num');
    addCell(d.startMs == null ? '—' : msText(d.startMs), 'num');
    addCell(d.endMs == null ? '—' : msText(d.endMs), 'num');
    addCell(d.delayMs > 0.05 ? `+${msText(d.delayMs)}` : d.startMs == null ? '—' : '0', 'num');
    addCell(d.channel == null ? '—' : `CH${d.channel}`, 'num');

    const statusTd = el('td');
    const pill = el('span', 'status-pill', `${STATUSES[d.status].icon} ${STATUSES[d.status].label}`);
    pill.dataset.tone = statusTone(d.status);
    statusTd.appendChild(pill);
    if (d.victims.length) {
      statusTd.appendChild(el('span', 'victim-tag', `−${d.victims.join(' −')}`));
    }
    if (d.preemptedBy) {
      statusTd.appendChild(el('span', 'victim-tag', `被 ${d.preemptedBy}`));
    }
    tr.appendChild(statusTd);

    const reason = el('td', 'reason', REASONS[d.reasonCode] || d.reasonCode);
    const note = eventNote(d.eventId);
    if (note) reason.appendChild(el('span', 'victim-tag', note));
    tr.appendChild(reason);

    body.appendChild(tr);
  }
  if (!body.children.length) {
    const tr = el('tr');
    const td = el('td', null, '没有匹配的事件。');
    td.colSpan = 10;
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

/* ---------------------------------------------------------------- */
/* event table                                                      */
/* ---------------------------------------------------------------- */

function renderEventTable(forceRebuild = false) {
  const body = $('#event-body');
  const decisionByEvent = new Map(state.plan.decisions.map((d) => [d.eventId, d]));
  const sorted = [...state.events].sort((a, b) => a.sheetIndex - b.sheetIndex);
  const changedIds = new Set(
    (state.compare?.mutedCategoryIds.length ? state.compare.affected : []).map((a) => a.eventId)
  );
  // Rebuilding while a cell has focus would steal the caret. Rebuild only
  // when the sheet's shape changes (add / delete / sample switch); otherwise
  // patch values in place.
  const shape = sorted.map((e) => `${e.id}:${e.categoryId}`).join('|');
  const needRebuild = forceRebuild || shape !== state.eventIds || !body.children.length;
  if (!needRebuild) {
    for (const tr of $$('tr[data-event-id]', body)) {
      const ev = state.events.find((e) => e.id === tr.dataset.eventId);
      const d = decisionByEvent.get(tr.dataset.eventId);
      if (!ev) continue;
      const timeInput = $('.cell-time', tr);
      if (timeInput && document.activeElement !== timeInput) {
        timeInput.value = String(ev.timeMs);
      }
      const noteInput = $('.cell-note', tr);
      if (noteInput && document.activeElement !== noteInput) noteInput.value = ev.note;
      const statusHost = $('.cell-status', tr);
      if (statusHost && d) {
        statusHost.replaceChildren();
        const pill = el(
          'span',
          'status-pill',
          `${STATUSES[d.status].icon} ${STATUSES[d.status].label}`
        );
        pill.dataset.tone = statusTone(d.status);
        statusHost.appendChild(pill);
      }
      tr.classList.toggle('is-affected', changedIds.has(ev.id));
      const catCell = $('.cell-cat', tr);
      if (catCell) {
        catCell.replaceChildren();
        const tag = el('span', 'cat-tag');
        const sw = el('span', 'swatch');
        sw.style.setProperty('--c', categoryColor(categoryOf(ev.categoryId)));
        tag.appendChild(sw);
        tag.appendChild(document.createTextNode(categoryOf(ev.categoryId)?.name || ev.categoryId));
        catCell.appendChild(tag);
      }
    }
    return;
  }
  state.eventIds = shape;
  body.replaceChildren();
  for (const ev of sorted) {
    const d = decisionByEvent.get(ev.id);
    const cat = categoryOf(ev.categoryId);
    const tr = el('tr');
    tr.dataset.eventId = ev.id;
    if (changedIds.has(ev.id)) tr.classList.add('is-affected');

    tr.appendChild(el('td', 'num', String(ev.sheetIndex + 1)));
    tr.appendChild(el('td', 'mono', ev.id));

    const catTd = el('td', 'cell-cat');
    const tag = el('span', 'cat-tag');
    const sw = el('span', 'swatch');
    sw.style.setProperty('--c', categoryColor(cat));
    tag.appendChild(sw);
    tag.appendChild(document.createTextNode(cat?.name || ev.categoryId));
    catTd.appendChild(tag);
    tr.appendChild(catTd);

    const timeTd = el('td', 'num');
    const timeInput = el('input', 'cell-input cell-time');
    timeInput.type = 'number';
    timeInput.min = '0';
    timeInput.max = '120000';
    timeInput.step = '10';
    timeInput.value = String(ev.timeMs);
    timeInput.setAttribute('aria-label', `${ev.id} 计划时间（毫秒）`);
    timeInput.addEventListener('change', () => {
      const live = state.events.find((e) => e.id === ev.id);
      const next = Math.max(0, Math.round(Number(timeInput.value) || 0));
      timeInput.value = String(next);
      if (live && next !== live.timeMs) updateEvent(ev.id, { timeMs: next });
    });
    timeTd.appendChild(timeInput);
    tr.appendChild(timeTd);

    const noteTd = el('td');
    const noteInput = el('input', 'cell-input wide cell-note');
    noteInput.type = 'text';
    noteInput.maxLength = 80;
    noteInput.value = ev.note;
    noteInput.placeholder = '备注';
    noteInput.setAttribute('aria-label', `${ev.id} 备注`);
    noteInput.addEventListener('change', () => {
      const live = state.events.find((e) => e.id === ev.id);
      if (live && noteInput.value !== live.note) updateEvent(ev.id, { note: noteInput.value });
    });
    noteTd.appendChild(noteInput);
    tr.appendChild(noteTd);

    const statusTd = el('td', 'cell-status');
    if (d) {
      const pill = el(
        'span',
        'status-pill',
        `${STATUSES[d.status].icon} ${STATUSES[d.status].label}`
      );
      pill.dataset.tone = statusTone(d.status);
      statusTd.appendChild(pill);
    }
    tr.appendChild(statusTd);

    const actions = el('td');
    const wrap = el('div', 'row-actions');
    const seekBtn = el('button', 'icon-mini', '⌖');
    seekBtn.type = 'button';
    seekBtn.title = '定位到该事件';
    seekBtn.setAttribute('aria-label', `定位到 ${ev.id}`);
    seekBtn.addEventListener('click', () => {
      const live = state.events.find((e) => e.id === ev.id);
      const liveDecision = state.plan.decisions.find((x) => x.eventId === ev.id);
      transport.seek(liveDecision?.startMs ?? live?.timeMs ?? 0);
    });
    const delBtn = el('button', 'icon-mini danger', '✕');
    delBtn.type = 'button';
    delBtn.title = '删除事件';
    delBtn.setAttribute('aria-label', `删除 ${ev.id}`);
    delBtn.addEventListener('click', () => {
      state.events = normalizeEvents(state.events.filter((e) => e.id !== ev.id));
      recompute();
      renderEventTable(true);
      toast(`已删除 ${ev.id}。`, 'info');
    });
    wrap.append(seekBtn, delBtn);
    actions.appendChild(wrap);
    tr.appendChild(actions);

    body.appendChild(tr);
  }
  if (!sorted.length) {
    const tr = el('tr');
    const td = el('td', null, '事件表为空。使用上方表单添加事件，或载入示例。');
    td.colSpan = 7;
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

/* ---------------------------------------------------------------- */
/* channel pane                                                     */
/* ---------------------------------------------------------------- */

function renderChannelPane() {
  const host = $('#channel-strip');
  host.replaceChildren();
  const total = Math.max(state.plan.totalMs, 1);
  for (let ch = 1; ch <= state.plan.config.maxVoices; ch += 1) {
    const row = el('div', 'channel-row');
    row.appendChild(el('div', 'channel-name', `CH ${ch}`));
    const track = el('div', 'channel-track');
    const items = state.plan.playbacks.filter((p) => p.channel === ch);
    for (const p of items) {
      const cat = categoryOf(p.categoryId);
      const seg = el('div', 'channel-seg');
      seg.style.left = `${(p.start / total) * 100}%`;
      seg.style.width = `${Math.max(0.4, ((p.end - p.start) / total) * 100)}%`;
      seg.style.setProperty('--c', categoryColor(cat));
      seg.style.color = themeInkForSlot(cat?.colorSlot ?? 0);
      seg.textContent = p.eventId;
      seg.title = `${p.eventId} · ${cat?.name || p.categoryId} · ${msText(p.start)}→${msText(
        p.end
      )}ms${p.end < p.naturalEnd - EPS ? '（被截断）' : ''}`;
      track.appendChild(seg);
    }
    if (!items.length) track.appendChild(el('span', 'track-empty', '空闲'));
    row.appendChild(track);
    host.appendChild(row);
  }
}

/* ---------------------------------------------------------------- */
/* category editor                                                  */
/* ---------------------------------------------------------------- */

function renderCategoryPane(forceRebuild = false) {
  const host = $('#cat-grid');
  const ids = state.config.categories.map((c) => c.id).join('|');
  const needRebuild = forceRebuild || ids !== state.categoryIds || !host.children.length;
  if (!needRebuild) {
    // Keep focus/caret: update only the dynamic read-outs. Handlers resolve
    // the live category by id, so patching in place is safe.
    for (const card of $$('.cat-card', host)) {
      const cat = categoryOf(card.dataset.catId);
      if (!cat) continue;
      card.classList.toggle('is-muted', cat.muted);
      card.style.setProperty('--c', categoryColor(cat));
      const muteBtn = $('.cat-mute', card);
      if (muteBtn) {
        muteBtn.textContent = cat.muted ? '取消静音' : '静音';
        muteBtn.setAttribute('aria-checked', String(cat.muted));
        muteBtn.classList.toggle('ghost', !cat.muted);
      }
      const meta = $('.cat-meta', card);
      if (meta) meta.textContent = catMeta(cat);
      const peak = $('.cat-peak', card);
      if (peak) {
        peak.textContent = `${state.plan.summary.peakByCategory[cat.id] || 0} / 上限 ${cat.cap}`;
      }
      const nameInput = $('.cat-name-input', card);
      if (nameInput && document.activeElement !== nameInput && nameInput.value !== cat.name) {
        nameInput.value = cat.name;
      }
      const remove = $('.cat-remove', card);
      if (remove) remove.disabled = state.config.categories.length <= 1;
    }
    const add = $('.cat-add', host);
    if (add) add.disabled = state.config.categories.length >= MAX_CATEGORIES;
    return;
  }
  state.categoryIds = ids;
  host.replaceChildren();

  for (const cat of state.config.categories) {
    const card = el('div', `cat-card${cat.muted ? ' is-muted' : ''}`);
    card.dataset.catId = cat.id;
    card.style.setProperty('--c', categoryColor(cat));

    const head = el('div', 'cat-head');
    const swatch = el('button', 'cat-swatch');
    swatch.type = 'button';
    swatch.title = '切换颜色';
    swatch.setAttribute('aria-label', `${cat.name} 切换颜色`);
    swatch.addEventListener('click', () => {
      const live = categoryOf(cat.id);
      if (!live) return;
      const used = new Set(state.config.categories.map((c) => c.colorSlot));
      let next = (live.colorSlot + 1) % COLOR_SLOTS;
      let guard = 0;
      while (used.has(next) && guard++ < COLOR_SLOTS) next = (next + 1) % COLOR_SLOTS;
      updateCategory(cat.id, { colorSlot: next }, { resetTransport: false });
      renderCategoryPane(true);
    });
    const nameInput = el('input', 'cat-name-input');
    nameInput.value = cat.name;
    nameInput.maxLength = 24;
    nameInput.setAttribute('aria-label', `${cat.id} 名称`);
    nameInput.addEventListener('change', () => {
      const live = categoryOf(cat.id);
      const next = nameInput.value.trim() || live?.name || cat.name;
      nameInput.value = next;
      if (live && next !== live.name) {
        updateCategory(cat.id, { name: next }, { resetTransport: false });
      }
      renderHeader();
      renderLegend();
      renderMuteList();
    });
    const muteBtn = el('button', `btn tiny ${cat.muted ? '' : 'ghost'} cat-mute`, cat.muted ? '取消静音' : '静音');
    muteBtn.type = 'button';
    muteBtn.setAttribute('role', 'switch');
    muteBtn.setAttribute('aria-checked', String(cat.muted));
    muteBtn.addEventListener('click', () => {
      const live = categoryOf(cat.id);
      if (!live) return;
      updateCategory(cat.id, { muted: !live.muted });
      renderCategoryPane(true);
    });
    head.append(swatch, nameInput, muteBtn);
    card.appendChild(head);

    const fields = el('div', 'cat-fields');

    const timbreField = el('label', 'cat-field');
    timbreField.appendChild(el('span', null, '音色（样音由代码合成）'));
    const timbreSel = el('select');
    for (const t of TIMBRES) {
      const opt = el('option', null, t.name);
      opt.value = t.id;
      if (t.id === cat.timbre) opt.selected = true;
      timbreSel.appendChild(opt);
    }
    timbreSel.addEventListener('change', () => {
      updateCategory(cat.id, { timbre: timbreSel.value }, { resetTransport: false });
    });
    timbreField.appendChild(timbreSel);
    fields.appendChild(timbreField);

    fields.appendChild(
      numberField(
        '时长 ms',
        () => categoryOf(cat.id)?.durationMs ?? cat.durationMs,
        { min: 40, max: 1200, step: 10 },
        (v) => updateCategory(cat.id, { durationMs: v }, { resetTransport: false })
      )
    );
    fields.appendChild(
      numberField(
        '优先级 1–5',
        () => categoryOf(cat.id)?.priority ?? cat.priority,
        { min: 1, max: 5, step: 1 },
        (v) => updateCategory(cat.id, { priority: v }, { resetTransport: false })
      )
    );
    fields.appendChild(
      numberField(
        '触发间隔 ms',
        () => categoryOf(cat.id)?.cooldownMs ?? cat.cooldownMs,
        { min: 0, max: 2000, step: 10 },
        (v) => updateCategory(cat.id, { cooldownMs: v }, { resetTransport: false })
      )
    );
    fields.appendChild(
      numberField(
        '同类上限',
        () => categoryOf(cat.id)?.cap ?? cat.cap,
        { min: 1, max: 4, step: 1 },
        (v) => updateCategory(cat.id, { cap: v }, { resetTransport: false })
      )
    );

    const gainField = el('label', 'cat-field');
    gainField.appendChild(el('span', null, `音量 ${Math.round(cat.gain * 100)}%`));
    const gain = el('input');
    gain.type = 'range';
    gain.min = '0';
    gain.max = '1';
    gain.step = '0.05';
    gain.value = String(cat.gain);
    gain.setAttribute('aria-label', `${cat.name} 音量`);
    gain.addEventListener('input', () => {
      gainField.firstChild.textContent = `音量 ${Math.round(Number(gain.value) * 100)}%`;
    });
    gain.addEventListener('change', () => {
      updateCategory(cat.id, { gain: Number(gain.value) });
    });
    gainField.appendChild(gain);
    fields.appendChild(gainField);

    const peakField = el('label', 'cat-field');
    peakField.appendChild(el('span', null, '实际峰值占用'));
    const peakOut = el('div', 'cat-peak', '–');
    peakField.appendChild(peakOut);
    fields.appendChild(peakField);

    card.appendChild(fields);

    const actions = el('div', 'cat-actions');
    const audition = el('button', 'btn tiny ghost', '▶ 试听音色');
    audition.type = 'button';
    audition.addEventListener('click', () => {
      const live = categoryOf(cat.id);
      if (live) auditionCategory(live);
    });
    const remove = el('button', 'btn tiny ghost danger cat-remove', '删除类别');
    remove.type = 'button';
    remove.disabled = state.config.categories.length <= 1;
    remove.addEventListener('click', () => {
      const live = categoryOf(cat.id);
      if (!live) return;
      const used = state.events.filter((e) => e.categoryId === cat.id).length;
      const msg = used
        ? `删除「${live.name}」会同时移除 ${used} 个事件，确定？`
        : `删除「${live.name}」？`;
      if (!window.confirm(msg)) return;
      state.config = normalizeConfig({
        ...state.config,
        categories: state.config.categories.filter((c) => c.id !== cat.id),
      });
      state.events = normalizeEvents(state.events.filter((e) => e.categoryId !== cat.id));
      recompute();
      renderCategoryPane(true);
      toast(`已删除类别 ${live.name}。`, 'info');
    });
    actions.append(audition, remove);
    actions.appendChild(el('span', 'cat-meta', catMeta(cat)));
    card.appendChild(actions);

    host.appendChild(card);
  }

  const add = el('button', 'cat-add', '+ 新增音色类别');
  add.type = 'button';
  add.disabled = state.config.categories.length >= MAX_CATEGORIES;
  add.addEventListener('click', () => {
    const used = new Set(state.config.categories.map((c) => c.colorSlot));
    let slot = 0;
    while (used.has(slot) && slot < COLOR_SLOTS) slot += 1;
    const n = state.config.categories.length + 1;
    const id = `custom-${Date.now().toString(36)}`;
    state.config = normalizeConfig({
      ...state.config,
      categories: [
        ...state.config.categories,
        {
          id,
          name: `新音色 ${n}`,
          timbre: 'ui',
          durationMs: 120,
          priority: 2,
          cooldownMs: 100,
          cap: 1,
          gain: 0.4,
          muted: false,
          colorSlot: slot,
        },
      ],
    });
    recompute();
    renderCategoryPane(true);
    toast('已新增类别，可在事件表里为它添加事件。', 'info');
  });
  host.appendChild(add);
}

function numberField(label, getValue, attrs, onChange) {
  const field = el('label', 'cat-field');
  field.appendChild(el('span', null, label));
  const input = el('input');
  input.type = 'number';
  const { value, ...rest } = attrs;
  Object.assign(input, rest);
  const initial = typeof getValue === 'function' ? getValue() : getValue;
  input.value = String(initial);
  input.setAttribute('aria-label', label);
  input.addEventListener('change', () => {
    const current = typeof getValue === 'function' ? getValue() : getValue;
    const raw = Number(input.value);
    const min = Number(attrs.min);
    const max = Number(attrs.max);
    const next = Math.min(max, Math.max(min, Math.round(Number.isFinite(raw) ? raw : current)));
    input.value = String(next);
    if (next !== current) onChange(next);
  });
  field.appendChild(input);
  return field;
}

function catMeta(cat) {
  return `P${cat.priority} · ${cat.durationMs}ms · 间隔 ${cat.cooldownMs}ms · ≤${cat.cap}`;
}

/* ---------------------------------------------------------------- */
/* transport UI                                                     */
/* ---------------------------------------------------------------- */

function reflectTransport() {
  const playing = transport.state === 'playing';
  $('#btn-play .ico-play').hidden = playing;
  $('#btn-play .ico-pause').hidden = !playing;
  const badge = $('#play-state');
  if (state.audioState === 'rendering') {
    badge.textContent = '合成音频…';
    badge.dataset.state = 'rendering';
  } else if (state.audioState === 'error') {
    badge.textContent = '音频不可用';
    badge.dataset.state = 'error';
  } else if (playing) {
    badge.textContent = '播放中';
    badge.dataset.state = 'playing';
  } else if (transport.state === 'paused') {
    badge.textContent = '已暂停';
    badge.dataset.state = 'paused';
  } else if (transport.state === 'ended') {
    badge.textContent = '已播完';
    badge.dataset.state = 'ended';
  } else {
    badge.textContent = '就绪';
    badge.dataset.state = 'ready';
  }
  const ready = state.audioState === 'ready' && !!transport.buffer;
  $('#btn-play').disabled = !ready;
  $('#btn-restart').disabled = !ready;
  $('#btn-step-back').disabled = !ready;
  $('#btn-step-fwd').disabled = !ready;
  renderNowStrip(true);
  positionCursor();
}

function startTicker() {
  if (tickRaf) return;
  const loop = () => {
    tickRaf = 0;
    positionCursor();
    renderNowStrip();
    if (transport.state === 'playing') tickRaf = requestAnimationFrame(loop);
  };
  tickRaf = requestAnimationFrame(loop);
}

/* ---------------------------------------------------------------- */
/* persistence & presets                                            */
/* ---------------------------------------------------------------- */

function serializeSession() {
  return {
    schema: 'voicebox/session@1',
    savedAt: new Date().toISOString(),
    outcomeDigest: state.plan?.outcomeDigest ?? null,
    settings: {
      maxVoices: state.config.maxVoices,
      maxDelayMs: state.config.maxDelayMs,
      policy: state.config.policy,
      masterGain: state.config.masterGain,
      categories: state.config.categories.map((c) => ({ ...c })),
    },
    events: state.events.map((e) => ({
      id: e.id,
      categoryId: e.categoryId,
      timeMs: e.timeMs,
      note: e.note,
    })),
    sampleId: state.sampleId,
  };
}

let persistTimer = 0;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeSession()));
    } catch {
      /* storage may be full or blocked: non-fatal */
    }
  }, 300);
}

function applySession(obj, options = {}) {
  if (!obj || typeof obj !== 'object') throw new Error('文件格式无法识别');
  const settings = obj.settings || obj.config;
  if (!settings || !Array.isArray(obj.events)) throw new Error('缺少 settings 或 events');
  const config = normalizeConfig(settings);
  const ids = new Set(config.categories.map((c) => c.id));
  const rawEvents = obj.events.filter((e) => e && ids.has(e.categoryId));
  const dropped = obj.events.length - rawEvents.length;
  state.config = config;
  state.events = normalizeEvents(rawEvents);
  state.sampleId = typeof obj.sampleId === 'string' ? obj.sampleId : 'custom';
  recompute({ audio: true });
  renderCategoryPane(true);
  syncControls();

  // If the file carries a digest (export / saved session), verify the replay.
  const expected = obj.outcomeDigest;
  if (typeof expected === 'string' && expected) {
    const matches = expected === state.plan.outcomeDigest;
    if (options.silent !== true) {
      toast(
        matches
          ? `已载入，结果指纹核对一致：${expected}`
          : `已载入，但结果指纹不一致（文件 ${expected} / 当前 ${state.plan.outcomeDigest}），设置或事件表可能被改动过。`,
        matches ? 'info' : 'warn'
      );
    } else if (!matches) {
      toast('自动恢复的会话与保存时的指纹不一致，已按当前内容重算。', 'warn');
    }
    return;
  }
  if (dropped > 0) {
    toast(`已载入，忽略 ${dropped} 个引用未知类别的事件。`, 'warn');
  } else if (options.silent !== true) {
    toast('已载入设置与事件表。', 'info');
  }
}

function restoreSession() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return false;
  try {
    applySession(JSON.parse(raw), { silent: true });
    toast('已恢复上次会话（本地自动保存）。', 'info');
    return true;
  } catch {
    return false;
  }
}

function syncControls() {
  $('#ctl-voices').value = String(state.config.maxVoices);
  $('#ctl-voices-out').textContent = String(state.config.maxVoices);
  $('#ctl-delay').value = String(state.config.maxDelayMs);
  $('#ctl-delay-out').textContent = `${state.config.maxDelayMs}ms`;
  const policySelect = $('#ctl-policy');
  if (policySelect.options.length !== Object.keys(POLICIES).length) {
    policySelect.replaceChildren(
      ...Object.values(POLICIES).map((p) => {
        const opt = el('option', null, `${p.name} · ${p.short}`);
        opt.value = p.id;
        return opt;
      })
    );
  }
  policySelect.value = state.config.policy;
  $('#ctl-note').textContent = POLICIES[state.config.policy].detail;
  for (const btn of $$('[data-view]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.view === state.view));
  }
}

function applyPreset(id) {
  const base = {
    categories: state.config.categories.map((c) => ({ ...c, muted: false })),
  };
  const presets = {
    baseline: { maxVoices: 3, maxDelayMs: 420, policy: 'steal' },
    tight: { maxVoices: 2, maxDelayMs: 200, policy: 'steal' },
    queue: { maxVoices: 3, maxDelayMs: 420, policy: 'queue' },
    drop: { maxVoices: 3, maxDelayMs: 420, policy: 'drop' },
    wide: { maxVoices: 6, maxDelayMs: 420, policy: 'steal' },
  };
  const preset = presets[id];
  if (!preset) return;
  state.config = normalizeConfig({ ...state.config, ...base, ...preset });
  recompute();
  renderCategoryPane(true);
  syncControls();
  toast(`已应用预设：${POLICIES[state.config.policy].name} · ${preset.maxVoices} 通道 · 最大延迟 ${preset.maxDelayMs}ms`, 'info');
}

/* ---------------------------------------------------------------- */
/* export                                                           */
/* ---------------------------------------------------------------- */

async function doExport() {
  const btn = $('#btn-export');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '正在打包…';
  try {
    let buffer = state.lastExport?.buffer;
    if (!buffer || state.lastExport.key !== audioKey(state.plan)) {
      buffer = await renderPlan(state.plan, { sampleRate: SAMPLE_RATE });
      state.lastExport = { buffer, key: audioKey(state.plan) };
    }
    const wav = await encodeWav(buffer);
    const wavBytes = new Uint8Array(await wav.arrayBuffer());
    const extras = state.compare?.mutedCategoryIds.length
      ? { comparison: { ...state.compare, baselineSummary: undefined, currentSummary: undefined } }
      : {};
    const bytes = buildExportBundleSync(state.plan, state.events, state.compare, {
      wavBuffer: wavBytes,
      extras,
    });
    const name = `voicebox-${timestampSlug()}-${state.plan.outcomeDigest}.zip`;
    downloadBlob(new Blob([bytes], { type: 'application/zip' }), name);
    toast(`已导出 ${name}（含 mix.wav、decisions.csv、playbacks.csv、session.json）。`, 'info');
  } catch (err) {
    toast(`导出失败：${err?.message || err}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* ---------------------------------------------------------------- */
/* events wiring                                                    */
/* ---------------------------------------------------------------- */

function wire() {
  // transport
  $('#btn-play').addEventListener('click', () => transport.toggle());
  $('#btn-restart').addEventListener('click', () => transport.restart());
  $('#btn-step-back').addEventListener('click', () => transport.step(-50));
  $('#btn-step-fwd').addEventListener('click', () => transport.step(50));
  $('#scrub').addEventListener('input', () => {
    const pct = Number($('#scrub').value) / 1000;
    const t = pct * state.plan.totalMs;
    $('#time-now').textContent = (t / 1000).toFixed(3);
    $('#gantt-cursor').style.left = `${pct * 100}%`;
    $('#scrub').style.setProperty('--scrub-progress', `${pct * 100}%`);
  });
  $('#scrub').addEventListener('change', () => {
    const pct = Number($('#scrub').value) / 1000;
    transport.seek(pct * state.plan.totalMs);
  });

  transport.onChange((t) => {
    reflectTransport();
    if (t.state === 'playing') startTicker();
  });

  // global controls
  $('#ctl-voices').addEventListener('input', () => {
    const v = Number($('#ctl-voices').value);
    $('#ctl-voices-out').textContent = String(v);
  });
  $('#ctl-voices').addEventListener('change', () => {
    const v = Number($('#ctl-voices').value);
    state.config = normalizeConfig({ ...state.config, maxVoices: v });
    recompute();
    syncControls();
  });
  $('#ctl-delay').addEventListener('input', () => {
    $('#ctl-delay-out').textContent = `${$('#ctl-delay').value}ms`;
  });
  $('#ctl-delay').addEventListener('change', () => {
    const v = Number($('#ctl-delay').value);
    state.config = normalizeConfig({ ...state.config, maxDelayMs: v });
    recompute();
    syncControls();
  });
  $('#ctl-policy').addEventListener('change', () => {
    state.config = normalizeConfig({ ...state.config, policy: $('#ctl-policy').value });
    recompute();
    syncControls();
    toast(`冲突规则：${POLICIES[state.config.policy].name}`, 'info');
  });

  for (const btn of $$('[data-view]')) {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      for (const b of $$('[data-view]')) {
        b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
      }
      renderHeader();
      renderGantt();
      renderCategoryPane(true);
    });
  }

  // samples
  for (const btn of $$('[data-sample]')) {
    btn.addEventListener('click', () => {
      const sample = getSample(btn.dataset.sample);
      state.sampleId = sample.id;
      state.config = normalizeConfig(DEFAULT_CONFIG);
      state.events = normalizeEvents(sample.events);
      for (const b of $$('[data-sample]')) {
        b.setAttribute('aria-pressed', String(b.dataset.sample === sample.id));
      }
      recompute();
      renderCategoryPane(true);
      syncControls();
      toast(`已载入示例「${sample.name}」：${sample.description}`, 'info');
    });
  }
  // Reflect which sample the boot state came from (restored sessions may
  // carry a different sheet than the default).
  for (const b of $$('[data-sample]')) {
    b.setAttribute('aria-pressed', String(b.dataset.sample === state.sampleId));
  }

  // presets popover
  const presetBtn = $('#btn-presets');
  const presetMenu = $('#preset-menu');
  presetBtn.addEventListener('click', () => {
    const open = presetMenu.hidden;
    presetMenu.hidden = !open;
    presetBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (ev) => {
    if (presetMenu.hidden) return;
    if (presetMenu.contains(ev.target) || presetBtn.contains(ev.target)) return;
    presetMenu.hidden = true;
    presetBtn.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !presetMenu.hidden) {
      presetMenu.hidden = true;
      presetBtn.setAttribute('aria-expanded', 'false');
    }
  });
  for (const item of $$('[data-preset]')) {
    item.addEventListener('click', () => {
      applyPreset(item.dataset.preset);
      presetMenu.hidden = true;
      presetBtn.setAttribute('aria-expanded', 'false');
    });
  }

  // tabs
  const tabs = [
    ['tab-decisions', 'pane-decisions'],
    ['tab-events', 'pane-events'],
    ['tab-channels', 'pane-channels'],
    ['tab-categories', 'pane-categories'],
  ];
  for (const [tabId, paneId] of tabs) {
    $(`#${tabId}`).addEventListener('click', () => activateTab(tabId, paneId));
  }
  for (const [tabId, paneId] of tabs) {
    $(`#${tabId}`).addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      ev.preventDefault();
      const idx = tabs.findIndex(([t]) => t === tabId);
      const next = tabs[(idx + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      activateTab(next[0], next[1]);
      $(`#${next[0]}`).focus();
    });
  }

  $('#filter-changed').addEventListener('change', () => {
    state.filterChanged = $('#filter-changed').checked;
    renderDecisionTable();
  });

  // event add
  $('#event-add').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const categoryId = $('#add-category').value;
    const timeMs = Math.max(0, Math.round(Number($('#add-time').value) || 0));
    const note = $('#add-note').value.trim();
    const id = uniqueEventId();
    state.events = normalizeEvents([
      ...state.events,
      { id, categoryId, timeMs, note },
    ]);
    recompute();
    $('#add-note').value = '';
    toast(`已加入 ${id}：${categoryId} @ ${timeMs}ms`, 'info');
  });

  // save / load
  $('#btn-save').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(serializeSession(), null, 2)], {
      type: 'application/json',
    });
    downloadBlob(blob, `voicebox-session-${timestampSlug()}.json`);
    toast('设置与事件表已保存为 JSON。', 'info');
  });
  $('#btn-load').addEventListener('click', () => $('#file-load').click());
  $('#file-load').addEventListener('change', async () => {
    const file = $('#file-load').files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      applySession(JSON.parse(text));
    } catch (err) {
      toast(`载入失败：${err?.message || err}`, 'error');
    } finally {
      $('#file-load').value = '';
    }
  });

  $('#btn-export').addEventListener('click', doExport);

  // keyboard shortcuts
  document.addEventListener('keydown', (ev) => {
    const tag = ev.target?.tagName?.toLowerCase();
    if (
      tag === 'input' ||
      tag === 'select' ||
      tag === 'textarea' ||
      ev.target?.isContentEditable
    ) {
      return;
    }
    // A focused button already owns Space (its click fires on keyup); don't
    // also toggle the transport, or one press would act twice.
    if (ev.code === 'Space' && ev.target?.closest?.('button, a, [role="tab"]')) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.code === 'Space') {
      ev.preventDefault();
      transport.toggle();
    } else if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      transport.step(ev.shiftKey ? -200 : -50);
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      transport.step(ev.shiftKey ? 200 : 50);
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      transport.seek(0);
    }
  });

  // layout
  const ro = new ResizeObserver(() => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!state.plan) return;
      renderGantt();
      renderChannelPane();
      positionCursor();
    });
  });
  ro.observe($('#gantt-plot'));
  window.addEventListener('resize', () => {
    hideCard();
  });
}

function uniqueEventId() {
  let n = state.events.length + 1;
  let id = `e${n}`;
  const used = new Set(state.events.map((e) => e.id));
  while (used.has(id)) id = `e${++n}`;
  return id;
}

function activateTab(tabId, paneId) {
  for (const [t, p] of [
    ['tab-decisions', 'pane-decisions'],
    ['tab-events', 'pane-events'],
    ['tab-channels', 'pane-channels'],
    ['tab-categories', 'pane-categories'],
  ]) {
    $(`#${t}`).setAttribute('aria-selected', String(t === tabId));
    $(`#${p}`).hidden = p !== paneId;
  }
}

/* ---------------------------------------------------------------- */
/* boot                                                             */
/* ---------------------------------------------------------------- */

function boot() {
  wire();
  scheduleOptions();
  syncControls();
  const restored = restoreSession();
  if (!restored) {
    recompute();
  }
  if (state.audioState === 'idle') rebuildAudio();
  reflectTransport();
}

function scheduleOptions() {
  const select = $('#add-category');
  select.replaceChildren(
    ...state.config.categories.map((c) => {
      const opt = el('option', null, c.name);
      opt.value = c.id;
      return opt;
    })
  );
}

window.addEventListener('beforeunload', () => {
  transport.stop();
});

boot();
