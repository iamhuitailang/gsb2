// 主应用：把状态、预览、时间线、检查器、音频与导出接起来。
import {
  $$, h, clear, debounce, fmt, toast, openModal, closeModal, apiJson, downloadUrl,
} from './lib/dom.js';
import { createStore, clipFromMedia, demoProject } from './lib/state.js';
import { PreviewEngine } from './lib/preview.js';
import { TimelineView } from './lib/timeline-view.js';
import { AuditionEngine } from './lib/audition.js';
import { filmstrip } from './lib/thumbs.js';
import {
  videoLayersAt, transitionFramesAt, projectFps,
} from '../src/timeline.js';
import { audioTransitionPlan } from '../src/audio.js';
import { clipLength, formatTimecode, clamp } from '../src/model.js';
import { validateProject, maxAllowedDuration } from '../src/project.js';

const app = {
  store: null,
  preview: null,
  timelineView: null,
  audition: new AuditionEngine(),
  samples: [],
  playhead: 0,
  playing: false,
  selectedClip: null,
  selectedTransition: 0,
  lastExport: null,
  exportMeta: null,
  rafId: null,
  filmstrips: {},
  loaded: new Map(), // 源 URL -> media 信息缓存
  pendingPlayStart: null,
  audioBusy: false,
  exportDirty: true,
  filmstripBusy: false,
};

const els = {};

function cacheEls() {
  const ids = [
    'topStats', 'sourceList', 'fileInput', 'btnAddFiles', 'btnAddSamples', 'stageCanvas',
    'stageEmpty', 'stageTc', 'stageLayers', 'viewerBadges', 'btnPlay', 'btnPrevFrame',
    'btnNextFrame', 'btnPrevCut', 'btnNextCut', 'timeNow', 'timeTotal', 'volume',
    'tlRuler', 'tlTracks', 'tlPlayhead', 'tlWrap', 'budget', 'inspectBody', 'audioBody',
    'btnAudition', 'btnStopAudio', 'exportBody', 'btnExport', 'btnReverify', 'btnGotoCut',
    'modalBackdrop', 'modalClose', 'toasts',
  ];
  for (const id of ids) els[id] = document.getElementById(id);
}

// ---------- 启动 ----------

async function boot() {
  cacheEls();
  app.store = createStore(null);
  app.preview = new PreviewEngine(els.stageCanvas);
  app.timelineView = new TimelineView({
    onSeek: (t) => seekTo(t, { fromTimeline: true }),
    onSelectClip: (i) => selectClip(i),
    onSelectTransition: (i) => selectTransition(i),
  });
  wireControls();
  app.store.subscribe(() => {
    refreshSampleFilmstrips();
    renderAll();
  });
  window.addEventListener('resize', debounce(() => renderTimeline(), 120));
  document.addEventListener('keydown', onKey);
  await loadSamples();
  renderAll();
  if (!app.store.project.clips.length) {
    // 首次进入：自动载入演示，直接看到硬切与叠化
    try { await loadDemo({ silent: true }); } catch { /* 用户可手动载入 */ }
  }
}

async function loadSamples() {
  try {
    const data = await apiJson('/api/samples');
    app.samples = data.items || [];
    if (app.samples.some((s) => !s.ready)) {
      toast('演示素材尚未生成，正在生成…', 'warn');
      try {
        await apiJson('/api/generate-samples', { method: 'POST' });
        const again = await apiJson('/api/samples');
        app.samples = again.items || [];
      } catch (err) {
        toast(`演示素材生成失败：${err.message}`, 'bad');
      }
    }
  } catch (err) {
    toast(`读取演示素材失败：${err.message}`, 'bad');
  }
}

// ---------- 渲染 ----------

function renderAll() {
  renderTopStats();
  withFocusRestore(() => {
    renderSources();
    renderTimeline();
    renderViewerBadges();
    renderInspector();
    renderAudioPanel();
  });
  // 导出面板只依赖导出结果，避免每次编辑都重建 <video> 导致播放中断
  if (app.exportDirty) {
    renderExport();
    app.exportDirty = false;
  }
  updateFrame();
}

// 重渲染会替换 DOM，正在编辑的控件会丢焦点。这里在渲染前后按 data-focus-key
// 记录与恢复焦点、光标位置，做到编辑时仍有即时反馈。
function withFocusRestore(fn) {
  const active = document.activeElement;
  const key = active?.dataset?.focusKey;
  let start = null;
  let end = null;
  let scroll = null;
  try {
    if (typeof active?.selectionStart === 'number') {
      start = active.selectionStart;
      end = active.selectionEnd;
    }
  } catch { /* range / number 等控件没有 selection */ }
  try { scroll = active?.scrollTop ?? null; } catch { /* noop */ }
  fn();
  if (!key) return;
  const next = document.querySelector(`[data-focus-key="${cssEscape(key)}"]`);
  if (!next) return;
  try { next.focus({ preventScroll: true }); } catch { next.focus?.(); }
  try {
    if (start != null && typeof next.setSelectionRange === 'function') {
      next.setSelectionRange(start, end);
    }
  } catch { /* 非文本控件 */ }
  if (scroll != null) {
    try { next.scrollTop = scroll; } catch { /* noop */ }
  }
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

function renderTopStats() {
  const tl = app.store.timeline;
  const b = app.store.budget;
  const stats = [
    { v: fmt(tl.duration, 2), l: '成片时长 / s' },
    { v: fmt(tl.hardCutTotal, 2), l: '全硬切 / s' },
    { v: fmt(b.saved, 2), l: '叠化省去 / s' },
    { v: `${b.percentOfHard.toFixed(1)}%`, l: '叠化占硬切' },
  ];
  clear(els.topStats);
  for (const s of stats) {
    els.topStats.append(h('div', { class: 'stat' }, h('b', {}, s.v), h('span', {}, s.l)));
  }
}

function renderSources() {
  const p = app.store.project;
  clear(els.sourceList);
  if (!p.clips.length) {
    els.sourceList.append(h('div', { class: 'empty-state' }, '还没有素材。添加本地短片，或载入演示三连。'));
    return;
  }
  p.clips.forEach((clip, i) => {
    const row = app.store.timeline.clips[i];
    const thumb = app.filmstrips[clip.id];
    const media = app.loaded.get(clip.src);
    const card = h('div', {
      class: `source-card${app.selectedClip === i ? ' selected' : ''}`,
      onclick: () => selectClip(i),
    },
    thumb ? h('img', { class: 'source-thumb', src: thumb }) : h('div', { class: 'source-thumb' }),
    h('div', { class: 'source-main' },
      h('div', { class: 'source-title' },
        h('span', { class: 'name', title: clip.name }, clip.name),
        clip.sample ? h('span', { class: 'badge sample' }, '演示') : null,
        clip.hasAudio ? h('span', { class: 'badge ok' }, '有声') : h('span', { class: 'badge warn' }, '无音轨'),
        clip.locked ? h('span', { class: 'badge' }, '已锁定') : null),
      h('div', { class: 'source-meta' },
        `${fmt(clip.duration, 2)}s 源 · ${(clip.fps || 30).toFixed(2)} fps · ` +
        `${row ? row.frameCount : 0} 帧在成片`),
      trimBar(clip),
      h('div', { class: 'mini-range' },
        numField('入点', clip.srcIn, (v) => app.store.setTrim(i, { srcIn: v }), i, 'in'),
        numField('出点', clip.srcOut, (v) => app.store.setTrim(i, { srcOut: v }), i, 'out')),
      h('div', { class: 'source-actions' },
        h('button', {
          class: 'ghost',
          onclick: (e) => { e.stopPropagation(); setInAtPlayhead(i); },
          title: '把入点设到当前播放头对应的源时间',
        }, '入点=播放头'),
        h('button', {
          class: 'ghost',
          onclick: (e) => { e.stopPropagation(); setOutAtPlayhead(i); },
          title: '把出点设到当前播放头对应的源时间',
        }, '出点=播放头'),
        h('button', {
          class: 'ghost',
          onclick: (e) => { e.stopPropagation(); app.store.setTrim(i, { srcIn: 0, srcOut: clip.duration }); },
        }, '整段'),
        h('button', {
          class: 'ghost',
          onclick: (e) => { e.stopPropagation(); app.store.removeClip(i); },
          disabled: clip.locked,
        }, '移除')),
      h('label', { class: 'lock-row', onclick: (e) => e.stopPropagation() },
        h('input', {
          type: 'checkbox',
          checked: clip.locked,
          onchange: (e) => app.store.setLocked(i, e.target.checked),
        }),
        '锁定该段取点（调整其它段时不变）')),
    ));
    els.sourceList.append(card);
  });
}

function trimBar(clip) {
  const total = Math.max(1e-6, clip.duration);
  const left = (clip.srcIn / total) * 100;
  const w = (clipLength(clip) / total) * 100;
  return h('div', { class: 'trim-bar', title: `整段 ${fmt(clip.duration, 2)} s` },
    h('div', { class: 'full' }),
    h('div', { class: 'sel', style: { left: `${left}%`, width: `${w}%` } }),
    h('div', { class: 'label' }, `${fmt(clip.srcIn, 2)} – ${fmt(clip.srcOut, 2)} s`));
}

function numField(label, value, onChange, index, field = '') {
  const input = h('input', {
    type: 'number', step: '0.01', min: '0', value: Number(value).toFixed(2),
    dataset: { focusKey: `clip-${index}-${field || label}` },
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => onChange(Number(e.target.value)),
  });
  return h('label', {}, `${label} `, input);
}

function renderViewerBadges() {
  const tl = app.store.timeline;
  clear(els.viewerBadges);
  els.viewerBadges.append(
    h('span', { class: 'badge' }, `${projectFps(app.store.project)} fps 输出`),
    h('span', { class: 'badge' }, `${tl.clips.length} 段`),
    h('span', {
      class: `badge ${tl.dissolveTotal > 0 ? 'ok' : ''}`,
    }, `叠化 ${tl.dissolveTotal.toFixed(2)}s`),
  );
  if (tl.issues.length) {
    els.viewerBadges.append(h('span', { class: 'badge warn' }, `${tl.issues.length} 条提示`));
  }
}

function renderTimeline() {
  const tl = app.store.timeline;
  app.timelineView.render(tl, {
    selectedClip: app.selectedClip,
    selectedTransition: app.selectedTransition,
    playhead: app.playhead,
    audioPlan: app.store.audioPlan,
    filmstrips: app.filmstrips,
  });
  renderBudget();
  els.stageEmpty.hidden = tl.clips.length > 0;
}

function renderBudget() {
  const tl = app.store.timeline;
  const b = app.store.budget;
  clear(els.budget);
  if (!tl.clips.length) return;
  const keptPct = tl.hardCutTotal > 0 ? (tl.duration / tl.hardCutTotal) * 100 : 100;
  const disPct = Math.max(0, 100 - keptPct);
  els.budget.append(
    h('div', { class: 'b-item highlight' }, '成片', h('b', {}, `${fmt(tl.duration, 3)} s`)),
    h('div', { class: 'b-item' }, '全硬切', h('b', {}, `${fmt(tl.hardCutTotal, 3)} s`)),
    h('div', { class: 'b-item' }, '叠化占用', h('b', {}, `${fmt(tl.dissolveTotal, 3)} s`)),
    h('div', { class: 'b-item' }, `占硬切 ${b.percentOfHard.toFixed(1)}% · 占成片 ${b.percentOfFinal.toFixed(1)}%`),
    h('div', { class: 'ratio-bar', title: '灰：保留的画面；紫：被叠化交叠掉的时长' },
      h('div', { class: 'seg kept', style: { width: `${keptPct}%` } }),
      h('div', { class: 'seg dis', style: { width: `${disPct}%` } })),
    tl.issues.length
      ? h('div', { class: 'b-item warn' }, h('b', {}, `${tl.issues.length}`), '条叠化提示')
      : null,
  );
}

// ---------- 预览与播放 ----------

function updateFrame() {
  const tl = app.store.timeline;
  if (!tl.clips.length) {
    app.preview.clear();
    els.stageTc.textContent = '00:00:00:00';
    clear(els.stageLayers);
    return [];
  }
  const t = clamp(app.playhead, 0, tl.duration);
  els.timeNow.textContent = t.toFixed(3);
  els.timeTotal.textContent = tl.duration.toFixed(3);
  els.stageTc.textContent = formatTimecode(t, tl.fps);
  app.timelineView.setPlayhead(t);

  const layers = videoLayersAt(tl, t);
  renderLayerChips(layers, tl);

  if (app.playing) {
    app.preview.paintAt(tl, t);
  } else {
    app.preview.drawAt(tl, t).catch(() => { /* 忽略单帧载入失败 */ });
  }
  syncInspectFrames(t);
  return layers;
}

const LAYER_COLORS = ['#6ea8fe', '#b39dff', '#7ee0c1'];

function renderLayerChips(layers, tl) {
  clear(els.stageLayers);
  for (const layer of layers) {
    const row = tl.clips[layer.clipIndex];
    els.stageLayers.append(h('span', { class: 'layer-chip' },
      h('i', { class: 'sw', style: { background: LAYER_COLORS[layer.clipIndex % LAYER_COLORS.length] } }),
      `${layer.clipIndex + 1}·${row.name.split(' ')[0]} · 源帧 ${layer.frame} · ${layer.fps} fps` +
      (layers.length > 1 ? ` · α${layer.weight.toFixed(2)}` : '')));
  }
}

// 播放中只更新图层文字，不再重建整块预览。
function syncLayersOnly(tl, t) {
  renderLayerChips(videoLayersAt(tl, t), tl);
}

function seekTo(t, { fromTimeline = false } = {}) {
  const tl = app.store.timeline;
  if (!tl.clips.length) return;
  if (app.playing) stopPlayback();
  app.playhead = clamp(t, 0, tl.duration);
  updateFrame();
  void fromTimeline;
}

function togglePlay() {
  if (app.playing) stopPlayback();
  else startPlayback();
}

async function startPlayback() {
  const tl = app.store.timeline;
  if (!tl.clips.length) return;
  await app.preview.prepareAll(tl.clips.map((r) => r.clip));
  app.playing = true;
  els.btnPlay.textContent = '⏸';
  els.btnPlay.classList.add('active');
  const startT = app.playhead >= tl.duration - 0.02 ? 0 : app.playhead;
  app.playhead = startT;
  const startPerf = performance.now();
  const baseT = startT;
  app.preview.playLayers(tl, startT);

  // 声音从同一时间点开始
  app.audition.setVolume(Number(els.volume.value));
  app.audition.play(tl, app.store.project, startT, tl.duration).catch(() => { /* 浏览器可能要求手势 */ });
  app.audition.onEnded = () => { /* 由画面时钟统一结束 */ };
  app.preview.playLayers(tl, startT);

  const loop = () => {
    if (!app.playing) return;
    let t = baseT + (performance.now() - startPerf) / 1000;
    const audioT = app.audition.currentTimelineTime();
    if (audioT != null && Math.abs(audioT - t) < 0.25) t = audioT;
    if (t >= tl.duration) {
      app.playhead = tl.duration;
      app.playing = false;
      updateFrame();
      stopPlayback();
      return;
    }
    app.playhead = t;
    els.timeNow.textContent = t.toFixed(3);
    els.stageTc.textContent = formatTimecode(t, tl.fps);
    app.timelineView.setPlayhead(t);
    app.preview.playLayers(tl, t);
    app.preview.paintAt(tl, t);
    syncLayersOnly(tl, t);
    app.rafId = requestAnimationFrame(loop);
  };
  app.rafId = requestAnimationFrame(loop);
}

function stopPlayback() {
  app.playing = false;
  els.btnPlay.textContent = '▶';
  els.btnPlay.classList.remove('active');
  if (app.rafId) cancelAnimationFrame(app.rafId);
  app.rafId = null;
  app.preview.pauseAll();
  app.audition.stop();
  updateFrame();
}

function stepFrame(dir) {  const tl = app.store.timeline;
  if (!tl.clips.length) return;
  if (app.playing) stopPlayback();
  const fps = tl.fps || 30;
  const frame = Math.round(app.playhead * fps) + dir;
  app.playhead = clamp(frame / fps, 0, tl.duration);
  updateFrame();
}

function gotoTransition(dir) {
  const tl = app.store.timeline;
  if (!tl.transitions.length) return;
  const cur = app.playhead;
  const points = tl.transitions.map((tr) => (tr.type === 'dissolve' ? (tr.start + tr.end) / 2 : tr.cutAt));
  let target = null;
  if (dir > 0) target = points.find((p) => p > cur + 0.02);
  else target = [...points].reverse().find((p) => p < cur - 0.02);
  if (target == null) target = dir > 0 ? points[0] : points[points.length - 1];
  seekTo(target);
  const idx = points.indexOf(target);
  if (idx >= 0) selectTransition(idx);
}

// ---------- 选择 ----------

function selectClip(i) {
  app.selectedClip = i;
  if (i >= 0 && i < app.store.timeline.transitions.length) app.selectedTransition = i;
  renderSources();
  renderTimeline();
  renderInspector();
}

function selectTransition(i) {
  app.selectedTransition = i;
  renderTimeline();
  renderInspector();
}

// ---------- 检查器 ----------

function renderInspector() {
  const tl = app.store.timeline;
  clear(els.inspectBody);
  if (!tl.transitions.length) {
    els.inspectBody.append(h('div', { class: 'inspect-empty' },
      tl.clips.length < 2 ? '至少需要两段素材才会出现转场。' : '当前没有转场。'));
    return;
  }
  for (const tr of tl.transitions) {
    els.inspectBody.append(transitionCard(tl, tr));
  }
}

function transitionCard(tl, tr) {
  const a = tl.clips[tr.a];
  const b = tl.clips[tr.b];
  const isSel = tr.index === app.selectedTransition;
  const maxD = maxAllowedDuration(app.store.project, tr.index);
  const audioPlan = audioTransitionPlan(tl, tr, app.store.project);
  const row = h('div', { class: `tr-card${isSel ? ' active' : ''}` });
  row.append(h('div', { class: 'tr-head' },
    h('div', { class: 'tr-name' },
      h('span', { class: 'badge' }, `#${tr.index + 1}`),
      `${a.name.split(' ')[0]} → ${b.name.split(' ')[0]}`,
      tr.type === 'dissolve'
        ? h('span', { class: 'badge ok' }, `叠化 ${tr.duration.toFixed(2)}s`)
        : h('span', { class: 'badge warn' }, '硬切')),
    h('button', {
      class: 'ghost',
      onclick: (e) => { e.stopPropagation(); gotoTransitionMid(tr); },
    }, '定位')));

  const body = h('div', { class: 'tr-body' });

  // 类型切换
  const typeToggle = h('div', { class: 'seg-control' },
    h('button', {
      class: tr.type === 'cut' ? 'on' : '',
      onclick: () => app.store.setTransition(tr.index, { type: 'cut', duration: 0 }),
    }, '硬切'),
    h('button', {
      class: tr.type === 'dissolve' ? 'on dissolve' : '',
      onclick: () => app.store.setTransition(tr.index, { type: 'dissolve', duration: tr.duration > 0 ? tr.duration : Math.min(0.8, maxD || 0.5) }),
    }, '叠化'));
  body.append(typeToggle);

  if (tr.requestedType === 'dissolve' || tr.type === 'dissolve') {
    const sliderMax = Math.max(0.001, maxD);
    const slider = h('input', {
      type: 'range', min: '0', max: String(sliderMax.toFixed(3)), step: String(1 / (tl.fps || 30)),
      value: String(Math.min(tr.duration, sliderMax)),
      dataset: { focusKey: `tr-${tr.index}-range` },
      oninput: (e) => { app.store.setTransition(tr.index, { type: 'dissolve', duration: Number(e.target.value) }); },
    });
    const num = h('input', {
      type: 'number', step: '0.01', min: '0', max: String(sliderMax.toFixed(3)),
      value: Number(tr.duration).toFixed(3),
      dataset: { focusKey: `tr-${tr.index}-num` },
      onchange: (e) => app.store.setTransition(tr.index, { type: 'dissolve', duration: Number(e.target.value) }),
    });
    body.append(h('div', { class: 'field-row' },
      h('span', {}, '叠化时长'),
      slider,
      num,
      h('span', { class: 'mono muted' }, `s / 可用上限 ${sliderMax.toFixed(2)} s`)));

    // 叠化提示 / 原因
    const issues = tr.issues || [];
    if (issues.length) {
      for (const iss of issues) {
        body.append(h('div', { class: 'tr-note bad' }, `⚠ ${iss.message}`));
      }
    } else if (tr.requested > tr.duration + 1e-6) {
      body.append(h('div', { class: 'tr-note bad' },
        `⚠ 请求 ${tr.requested.toFixed(2)} s，实际 ${tr.duration.toFixed(2)} s。`));
    } else {
      body.append(h('div', { class: 'tr-note' },
        `使用 ${a.name.split(' ')[0]} 的 ${fmt(a.srcOut - tr.duration, 2)}–${fmt(a.srcOut, 2)} s 与 ` +
        `${b.name.split(' ')[0]} 的 ${fmt(b.srcIn, 2)}–${fmt(b.srcIn + tr.duration, 2)} s，` +
        `在统一时间 ${fmt(tr.start, 2)}–${fmt(tr.end, 2)} s 交叠。`));
    }
  } else {
    body.append(h('div', { class: 'tr-note' },
      `在统一时间 ${fmt(tr.cutAt, 3)} s 硬切，无重叠帧。`));
  }

  // 转场帧检索：叠化时在窗口内取点；硬切时给出切点前后各 0.15 s，便于核对左右两侧帧。
  const frameBox = h('div', { class: 'frame-compare' });
  const isDissolve = tr.type === 'dissolve' && tr.duration > 0;
  const tProbe = isDissolve ? (tr.start + tr.end) / 2 : tr.cutAt;
  const probeMin = isDissolve ? tr.start : Math.max(0, tr.cutAt - 0.15);
  const probeMax = isDissolve ? tr.end : Math.min(tl.duration, tr.cutAt + 0.15);
  const leftImg = h('img', { alt: '左侧素材帧' });
  const rightImg = h('img', { alt: '右侧素材帧' });
  const leftFoot = h('div', { class: 'fc-foot' });
  const rightFoot = h('div', { class: 'fc-foot' });
  const probeLabel = h('div', { class: 'field-row' },
    h('span', {}, '检查时间'),
    h('input', {
      type: 'range',
      min: String(probeMin.toFixed(3)),
      max: String(Math.max(probeMin + 0.001, probeMax).toFixed(3)),
      step: String(1 / (tl.fps || 30)), value: String(tProbe),
      dataset: { focusKey: `tr-${tr.index}-probe` },
      oninput: (e) => updateCompare(tr, Number(e.target.value), collectRefs(row)),
    }),
    h('button', {
      class: 'ghost',
      onclick: () => { seekTo(tProbe); },
    }, '播放头到此'),
  );
  frameBox.append(
    h('div', { class: 'frame-cell' }, h('div', { class: 'fc-head' }, h('span', {}, `左 · ${a.name.split(' ')[0]}`), h('span', { class: 'mono' }, `${a.srcFps} fps`)), leftImg, leftFoot),
    h('div', { class: 'frame-cell' }, h('div', { class: 'fc-head' }, h('span', {}, `右 · ${b.name.split(' ')[0]}`), h('span', { class: 'mono' }, `${b.srcFps} fps`)), rightImg, rightFoot),
  );
  body.append(probeLabel, frameBox);
  row._tr = tr;
  row._probeT = tProbe;
  row.leftImg = leftImg; row.rightImg = rightImg;
  row.leftFoot = leftFoot; row.rightFoot = rightFoot;
  row.probeInput = probeLabel.querySelector('input[type=range]');

  // 音频
  body.append(audioControls(tr, audioPlan, tl));

  const foot = h('div', { class: 'tr-foot' });
  row.append(body);
  void foot;
  queueMicrotask(() => {
    updateCompare(tr, tProbe, collectRefs(row));
  });
  if (isSel) row.scrollIntoView({ block: 'nearest' });
  return row;
}

function collectRefs(row) {
  return {
    leftImg: row.leftImg, rightImg: row.rightImg,
    leftFoot: row.leftFoot, rightFoot: row.rightFoot,
  };
}

function audioControls(tr, plan, tl) {
  const wrap = h('div', { class: 'field-row' });
  const mode = tr.audio?.mode || 'follow';
  const sel = h('select', {
    onchange: (e) => app.store.setAudio(tr.index, { mode: e.target.value }),
  },
  h('option', { value: 'follow', selected: mode === 'follow' }, '声音跟随画面'),
  h('option', { value: 'switch', selected: mode === 'switch' }, '在指定点切换'),
  h('option', { value: 'mute', selected: mode === 'mute' }, '转场处静音'));
  wrap.append(h('span', {}, '音频'), sel);
  if (mode === 'switch') {
    const value = Number.isFinite(tr.audio?.switchTime) ? tr.audio.switchTime : tr.cutAt;
    wrap.append(h('span', { class: 'mono muted' }, '切换点'),
      h('input', {
        type: 'number', step: '0.01', value: value.toFixed(3),
        onchange: (e) => app.store.setAudio(tr.index, { switchTime: Number(e.target.value) }),
      }));
  }
  const info = h('div', { class: 'tr-note' });
  const lines = [...plan.details, ...plan.warnings];
  info.textContent = lines.join(' ');
  const box = h('div', {}, wrap, info);
  return box;
}

async function updateCompare(tr, t, refs = null) {
  const el = refs || findCompareRefs(tr.index);
  if (!el) return;
  const tl = app.store.timeline;
  const { left, right } = transitionFramesAt(tl, tr, t);
  const a = tl.clips[tr.a];
  const b = tl.clips[tr.b];
  el.leftFoot.replaceChildren(
    h('span', { class: 'hl' }, `统一时间 ${t.toFixed(3)} s → 源 ${left.srcTime.toFixed(3)} s`),
    h('span', {}, `源帧 ${left.frame} · ${left.fps} fps · 画面权重 ${left.weight.toFixed(2)}`),
  );
  el.rightFoot.replaceChildren(
    h('span', { class: 'hl' }, `统一时间 ${t.toFixed(3)} s → 源 ${right.srcTime.toFixed(3)} s`),
    h('span', {}, `源帧 ${right.frame} · ${right.fps} fps · 画面权重 ${right.weight.toFixed(2)}`),
  );
  try {
    const [lImg, rImg] = await Promise.all([
      frameUrl(a.clip, left.srcTime),
      frameUrl(b.clip, right.srcTime),
    ]);
    if (el.leftImg.src !== lImg) el.leftImg.src = lImg;
    if (el.rightImg.src !== rImg) el.rightImg.src = rImg;
  } catch {
    /* ignore */
  }
}

const frameCache = new Map(); // file@t@w@h -> blob URL

async function frameUrl(clip, srcTime) {
  const rel = clip.src.split('/').pop();
  const t = Math.round(srcTime * 1000) / 1000;
  const key = `${rel}@${t}@320x180`;
  if (frameCache.has(key)) return frameCache.get(key);
  const promise = (async () => {
    const res = await fetch(`/api/frame?file=${encodeURIComponent(rel)}&t=${t.toFixed(3)}&w=320&h=180`);
    if (!res.ok) throw new Error('取帧失败');
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  })();
  frameCache.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    frameCache.delete(key);
    throw err;
  }
}

function findCompareRefs(index) {
  const cards = $$('.tr-card', els.inspectBody);
  for (const card of cards) {
    if (card._tr && card._tr.index === index) return card;
  }
  return null;
}

function findProbeInput(index) {
  return findCompareRefs(index)?.probeInput || null;
}

function syncInspectFrames(t) {
  // 当播放头处在某个转场窗口时，同步该转场卡片的检查时间
  const tl = app.store.timeline;
  for (const tr of tl.transitions) {
    const lo = tr.type === 'dissolve' ? tr.start : Math.max(0, tr.cutAt - 0.15);
    const hi = tr.type === 'dissolve' ? tr.end : Math.min(tl.duration, tr.cutAt + 0.15);
    if (t < lo - 1e-6 || t > hi + 1e-6) continue;
    const refs = findCompareRefs(tr.index);
    if (refs?.probeInput) {
      refs.probeInput.value = String(clamp(t, Number(refs.probeInput.min), Number(refs.probeInput.max)));
    }
  }
}

function gotoTransitionMid(tr) {
  const tl = app.store.timeline;
  const t = tr.type === 'dissolve' ? (tr.start + tr.end) / 2 : tr.cutAt;
  seekTo(t);
  selectTransition(tr.index);
  void tl;
}

// ---------- 音频面板 ----------

function renderAudioPanel() {
  const tl = app.store.timeline;
  const plan = app.store.audioPlan;
  clear(els.audioBody);
  if (!tl.clips.length) {
    els.audioBody.append(h('div', { class: 'inspect-empty' }, '加入素材后在这里查看每段的音频编排。'));
    return;
  }
  for (let i = 0; i < tl.clips.length; i++) {
    const row = tl.clips[i];
    const span = plan[i];
    const cvs = h('canvas', { width: 900, height: 68 });
    const env = h('div', { class: 'envelope' }, cvs);
    els.audioBody.append(h('div', { class: 'audio-row' },
      h('div', { class: 'ar-name' }, `#${i + 1} ${row.name.split(' ')[0]}`),
      env));
    requestAnimationFrame(() => drawFullEnvelope(cvs, tl, span));
  }
  const notes = h('div', { class: 'audio-notes' });
  const seen = new Set();
  for (const span of plan) {
    if (span.silent) {
      notes.append(h('div', { class: 'audio-note missing' },
        h('i', { class: 'dot' }),
        `#${span.clipIndex + 1} ${span.reason}${span.clipIndex > 0 || span.clipIndex < tl.clips.length - 1 ? '，交界处按 0.3 s 平滑过渡到静音' : ''}`));
    } else if (span.note) {
      notes.append(h('div', { class: 'audio-note' }, h('i', { class: 'dot' }), `#${span.clipIndex + 1} ${span.note}`));
    }
    if (seen.has(span.clipIndex)) continue;
    seen.add(span.clipIndex);
  }
  els.audioBody.append(notes);
}

function drawFullEnvelope(canvas, tl, span) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const dur = Math.max(1e-6, tl.duration);
  // 背景网格
  ctx.strokeStyle = '#1c2430';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += W / 10) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  // 转场阴影
  for (const tr of tl.transitions) {
    if (tr.type !== 'dissolve') continue;
    const x0 = (tr.start / dur) * W;
    const x1 = (tr.end / dur) * W;
    ctx.fillStyle = 'rgba(138,110,240,0.16)';
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), H);
  }
  if (span.silent) {
    ctx.fillStyle = '#46536a';
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText('静音', 8, H / 2 + 4);
    return;
  }
  const pts = span.points || [];
  if (!pts.length) return;
  const xOf = (t) => (t / dur) * W;
  const yOf = (g) => H - 4 - g * (H - 12);
  ctx.beginPath();
  ctx.moveTo(xOf(span.start), H);
  for (const [t, g] of pts) ctx.lineTo(xOf(t), yOf(g));
  ctx.lineTo(xOf(span.end), H);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(126,224,193,0.6)');
  grad.addColorStop(1, 'rgba(126,224,193,0.06)');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  pts.forEach(([t, g], i) => { if (i === 0) ctx.moveTo(xOf(t), yOf(g)); else ctx.lineTo(xOf(t), yOf(g)); });
  ctx.strokeStyle = '#7ee0c1';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ---------- 导出 ----------

function renderExport() {
  clear(els.exportBody);
  const meta = app.exportMeta;
  if (!meta) {
    els.exportBody.append(h('div', { class: 'inspect-empty' }, '点右上角「导出成片并复检」生成成片，并逐项核对首尾、长度、转场与起始音频。'));
    return;
  }
  const rep = meta.report || {};
  const checks = rep.checks || [];
  const okCount = checks.filter((c) => c.ok).length;
  els.exportBody.append(
    h('div', { class: 'export-meta' },
      h('span', { class: `badge ${rep.ok ? 'ok' : 'bad'}` }, rep.ok ? '复检通过' : '复检有未通过项'),
      h('span', {}, '成片 ', h('b', {}, meta.file)),
      h('span', {}, '时长 ', h('b', {}, `${fmt(rep.probedDuration, 3)} s`)),
      h('span', {}, '期望 ', h('b', {}, `${fmt(rep.expectedDuration, 3)} s`)),
      h('span', {}, `检查 ${okCount}/${checks.length}`),
      h('button', { class: 'ghost', onclick: () => downloadUrl(meta.url, meta.file) }, '下载成片'),
    ),
    h('video', { class: 'export-video', src: meta.url, controls: true, preload: 'metadata' }),
  );
  const grid = h('div', { class: 'report-grid' });
  for (const c of checks) {
    grid.append(h('div', { class: `check-item ${c.ok ? 'ok' : 'no'}` },
      h('div', { class: 'mark' }, c.ok ? '✓' : '!'),
      h('div', {}, h('div', { class: 'ci-label' }, c.label), h('div', { class: 'ci-detail' }, c.detail))));
  }
  els.exportBody.append(grid);

  const audits = (rep.transitions || []).filter((t) => t.type === 'dissolve');
  if (audits.length) {
    const box = h('div', { class: 'dissolve-audit' });
    for (const a of audits) {
      box.append(h('div', { class: 'audit-card' },
        h('div', { class: 'ac-head' },
          h('span', {}, `叠化 ${a.index + 1} 复检`),
          h('span', { class: `badge ${a.ok ? 'ok' : 'bad'}` }, a.ok ? '起止可验证' : '需复查')),
        h('div', { class: 'ac-line' }, h('span', {}, '时间窗口'), h('b', {}, `${fmt(a.start, 2)} – ${fmt(a.end, 2)} s`)),
        h('div', { class: 'ac-line' }, h('span', {}, '颜色 α 起点/中点/终点'),
          h('b', {}, `${n3(a.alphaStart)} / ${n3(a.alphaMid)} / ${n3(a.alphaEnd)}`)),
        h('div', { class: 'ac-line' }, h('span', {}, '说明'), h('b', {}, a.detail || ''))));
    }
    els.exportBody.append(box);
  }
}

function n3(v) {
  return Number.isFinite(v) ? v.toFixed(2) : '—';
}

async function doExport() {
  const tl = app.store.timeline;
  if (!tl.clips.length) {
    toast('没有素材可导出', 'bad');
    return;
  }
  const validation = validateProject(app.store.project);
  const blocking = validation.checks.filter((c) => !c.ok && c.id !== 'dissolves-fit');
  if (blocking.length) {
    const proceed = await confirmDialog('导出前检查', blocking);
    if (!proceed) return;
  }
  els.btnExport.disabled = true;
  const original = els.btnExport.textContent;
  els.btnExport.textContent = '导出中…';
  clear(els.exportBody);
  const bar = h('div', { class: 'export-progress' }, h('div'));
  const label = h('div', { class: 'tr-note' }, '正在混音与拼接…');
  els.exportBody.append(h('div', { class: 'field-row' }, label), bar);
  const fake = setInterval(() => {
    const w = bar.firstElementChild;
    const cur = parseFloat(w.style.width || '0');
    w.style.width = `${Math.min(92, cur + 3)}%`;
  }, 260);
  try {
    const res = await apiJson('/api/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: app.store.project, force: true }),
    });
    clearInterval(fake);
    bar.firstElementChild.style.width = '100%';
    app.exportMeta = res;
    app.lastExport = res;
    renderExport();
    toast(res.report?.ok ? '导出完成，复检通过' : '导出完成，但有未通过项', res.report?.ok ? 'good' : 'warn');
    await refreshExportsList();
  } catch (err) {
    clearInterval(fake);
    toast(`导出失败：${err.message}`, 'bad');
    label.textContent = `导出失败：${err.message}`;
  } finally {
    els.btnExport.disabled = false;
    els.btnExport.textContent = original;
  }
}

function confirmDialog(title, failedChecks) {
  return new Promise((resolve) => {
    const body = h('div', {},
      h('p', { class: 'tr-note' }, '以下检查未通过。仍要导出吗？'),
      h('div', { class: 'report-grid' },
        ...failedChecks.map((c) => h('div', { class: 'check-item no' },
          h('div', { class: 'mark' }, '!'),
          h('div', {}, h('div', { class: 'ci-label' }, c.label), h('div', { class: 'ci-detail' }, c.detail))))),
      h('div', { class: 'field-row', style: { marginTop: '12px', justifyContent: 'flex-end' } },
        h('button', { class: 'ghost', onclick: () => { closeModal(); resolve(false); } }, '取消'),
        h('button', { class: 'primary', onclick: () => { closeModal(); resolve(true); } }, '仍然导出')));
    openModal(title, body);
  });
}

async function refreshExportsList() {
  try {
    const data = await apiJson('/api/exports');
    if (!data.items?.length) return;
    if (!app.exportMeta) {
      const first = data.items[0];
      const meta = await apiJson(`/api/exports/${first.id}`);
      app.exportMeta = { ...meta, url: `/exports/${meta.file}` };
      renderExport();
    }
  } catch { /* ignore */ }
}

async function reverify() {
  if (!app.exportMeta?.id) {
    toast('还没有可复检的导出', 'warn');
    return;
  }
  els.btnReverify.disabled = true;
  try {
    const res = await apiJson(`/api/exports/${app.exportMeta.id}/verify`, { method: 'POST' });
    app.exportMeta = { ...app.exportMeta, report: res.report };
    renderExport();
    toast(res.report.ok ? '重新复检通过' : '重新复检发现未通过项', res.report.ok ? 'good' : 'warn');
  } catch (err) {
    toast(`复检失败：${err.message}`, 'bad');
  } finally {
    els.btnReverify.disabled = false;
  }
}

// ---------- 素材添加 ----------

async function loadDemo({ silent = false } = {}) {
  const ready = app.samples.filter((s) => s.ready);
  if (ready.length < 3) throw new Error('演示素材未就绪');
  const p = demoProject(ready);
  app.store.replace(p, 'demo');
  // 预载视频与缩略图
  await Promise.all(p.clips.map((c) => app.preview.ensure(c).catch(() => null)));
  for (const clip of p.clips) {
    const info = (ready.find((s) => s.url === clip.src) || {}).media;
    if (info) app.loaded.set(clip.src, info);
    app.filmstrips[clip.id] = await filmstrip(clip.src, clip.srcIn, clip.srcOut, { frames: 5 }).catch(() => null);
  }
  app.selectedClip = 0;
  app.selectedTransition = 0;
  app.playhead = 0;
  renderAll();
  if (!silent) toast('已载入演示：A→B 叠化 0.8 s，B→C 硬切', 'good');
}

async function addFiles(files) {
  const list = [...files];
  if (!list.length) return;
  let added = 0;
  for (const file of list) {
    try {
      toast(`上传 ${file.name}…`);
      const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '上传失败');
      const clip = clipFromMedia({
        id: data.id,
        name: file.name.replace(/\.[^.]+$/, ''),
        url: data.url,
        media: data.media,
      });
      app.loaded.set(data.url, data.media);
      app.store.addClip(clip);
      await app.preview.ensure(clip).catch(() => null);
      app.filmstrips[clip.id] = await filmstrip(clip.src, clip.srcIn, clip.srcOut, { frames: 5 }).catch(() => null);
      added += 1;
    } catch (err) {
      toast(`${file.name} 添加失败：${err.message}`, 'bad');
    }
  }
  if (added) {
    toast(`已添加 ${added} 段素材`, 'good');
    renderAll();
  }
}

async function refreshSampleFilmstrips() {
  // 仅在缺缩略图时补齐；失败一次就记下，避免每次渲染都重试。
  if (app.filmstripBusy) return;
  app.filmstripBusy = true;
  try {
    const p = app.store.project;
    for (const clip of p.clips) {
      if (app.filmstrips[clip.id] || app.filmstripFailed?.has(clip.id)) continue;
      app.filmstripFailed = app.filmstripFailed || new Set();
      const url = await filmstrip(clip.src, clip.srcIn, clip.srcOut, { frames: 5 }).catch(() => null);
      if (url) {
        app.filmstrips[clip.id] = url;
        renderTimeline();
      } else {
        app.filmstripFailed.add(clip.id);
      }
    }
  } finally {
    app.filmstripBusy = false;
  }
}

// ---------- 播放头取点 ----------

function setInAtPlayhead(i) {
  const local = app.store.localTimeOf(i, app.playhead);
  if (local == null) {
    toast(`播放头不在片段 ${i + 1} 上，先把播放头移入该段再取点`, 'warn');
    return;
  }
  const trim = app.store.clampTrim(i, { srcIn: local, srcOut: null });
  app.store.setTrim(i, trim);
  toast(`片段 ${i + 1} 入点设为 ${local.toFixed(2)} s`);
}

function setOutAtPlayhead(i) {
  const local = app.store.localTimeOf(i, app.playhead);
  if (local == null) {
    toast(`播放头不在片段 ${i + 1} 上，先把播放头移入该段再取点`, 'warn');
    return;
  }
  const trim = app.store.clampTrim(i, { srcIn: null, srcOut: local });
  app.store.setTrim(i, trim);
  toast(`片段 ${i + 1} 出点设为 ${local.toFixed(2)} s`);
}

// ---------- 控件 ----------

function wireControls() {
  els.btnAddFiles?.addEventListener('click', () => els.fileInput.click());
  els.fileInput?.addEventListener('change', async (e) => {
    await addFiles(e.target.files);
    e.target.value = '';
  });
  els.btnAddSamples?.addEventListener('click', () => loadDemo().catch((err) => toast(err.message, 'bad')));
  els.btnPlay?.addEventListener('click', togglePlay);
  els.btnPrevFrame?.addEventListener('click', () => stepFrame(-1));
  els.btnNextFrame?.addEventListener('click', () => stepFrame(1));
  els.btnPrevCut?.addEventListener('click', () => gotoTransition(-1));
  els.btnNextCut?.addEventListener('click', () => gotoTransition(1));
  els.btnExport?.addEventListener('click', doExport);
  els.btnReverify?.addEventListener('click', reverify);
  els.btnGotoCut?.addEventListener('click', () => {
    const tr = app.store.timeline.transitions[app.selectedTransition];
    if (tr) gotoTransitionMid(tr);
    else toast('没有可定位的转场', 'warn');
  });
  els.volume?.addEventListener('input', (e) => app.audition.setVolume(Number(e.target.value)));
  els.btnAudition?.addEventListener('click', auditionFromPlayhead);
  els.btnStopAudio?.addEventListener('click', () => { app.audition.stop(); if (app.playing) stopPlayback(); });
  els.modalClose?.addEventListener('click', closeModal);
  els.modalBackdrop?.addEventListener('click', (e) => { if (e.target === els.modalBackdrop) closeModal(); });
  els.stageCanvas?.addEventListener('click', () => togglePlay());
}

async function auditionFromPlayhead() {
  const tl = app.store.timeline;
  if (!tl.clips.length) return;
  if (app.audioBusy) return;
  app.audioBusy = true;
  els.btnAudition.disabled = true;
  try {
    app.audition.setVolume(Number(els.volume.value));
    const from = app.playhead >= tl.duration - 0.02 ? 0 : app.playhead;
    const res = await app.audition.play(tl, app.store.project, from, tl.duration);
    if (res && res.anyScheduled === false) toast('当前编排没有可听的音频', 'warn');
    else toast(`从 ${from.toFixed(2)} s 试听（只播入点之后的音频）`, 'good');
    // 让画面跟随音频时钟
    if (!app.playing) {
      app.playing = true;
      els.btnPlay.textContent = '⏸';
      els.btnPlay.classList.add('active');
      await app.preview.prepareAll(tl.clips.map((r) => r.clip));
      app.preview.playLayers(tl, from);
      const loop = () => {
        if (!app.playing) return;
        const t = app.audition.currentTimelineTime();
        if (t == null) { stopPlayback(); return; }
        if (t >= tl.duration) { app.playhead = tl.duration; stopPlayback(); return; }
        app.playhead = t;
        els.timeNow.textContent = t.toFixed(3);
        els.stageTc.textContent = formatTimecode(t, tl.fps);
        app.timelineView.setPlayhead(t);
        app.preview.playLayers(tl, t);
        app.preview.paintAt(tl, t);
        syncLayersOnly(tl, t);
        app.rafId = requestAnimationFrame(loop);
      };
      app.rafId = requestAnimationFrame(loop);
    }
  } catch (err) {
    toast(`试听失败：${err.message}`, 'bad');
  } finally {
    app.audioBusy = false;
    els.btnAudition.disabled = false;
  }
}

function onKey(e) {
  if (e.target.matches('input, textarea, select')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); stepFrame(e.shiftKey ? -10 : -1); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); stepFrame(e.shiftKey ? 10 : 1); }
  else if (e.key === '[') { e.preventDefault(); gotoTransition(-1); }
  else if (e.key === ']') { e.preventDefault(); gotoTransition(1); }
  else if (e.key === 'Escape') closeModal();
}

boot();
