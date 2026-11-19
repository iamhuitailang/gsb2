// app.js — 主控制器：界面事件、非破坏性处理链编排、回放、工程存取与 WAV 导出。
import {
  encodeWavPCM, decodeWav, arrayBufferToBase64, base64ToArrayBuffer,
} from './wav-codec.js';
import {
  OP_TYPES, createOp, applyOps, computeStats, planNormalize,
  activeCutIntervals, originalToCurrentTime, currentToOriginalTime,
  visibleMarkers, currentDuration, isInCut,
  formatTime, formatDb, timeToSample,
} from './audio-engine.js';
import { WaveformView } from './waveform-view.js';

const HISTORY_LIMIT = 100;

const state = {
  projectName: '未命名工程',
  source: null, // { channels: Float32Array[], sampleRate, fileName }
  ops: [],
  markers: [], // marker.time 为原始时间线坐标
  selection: null, // { start, end } 当前时间线（界面）坐标，秒
  undoStack: [],
  redoStack: [],
};
let rendered = { channels: [], stats: null };
let audioCtx = null;
let playback = null; // { node, startedAt, offset, useSource }
let markerSeq = 1;

const $ = (id) => document.getElementById(id);

/** 当前启用的剪切区间（原始时间线） */
function cuts() {
  return state.source ? activeCutIntervals(state.ops) : [];
}
/** 界面（当前时间线）时间 → 原始时间线时间 */
const toOrig = (currentT) => currentToOriginalTime(currentT, cuts());
/** 原始时间线时间 → 界面（当前时间线）时间 */
const toCurrent = (origT) => originalToCurrentTime(origT, cuts());

// ---------------- 初始化 ----------------

const view = new WaveformView($('waveContainer'), {
  onSelectionChanging: (sel) => updateSelectionBar(sel),
  onSelectionChange: (sel) => { state.selection = sel; updateSelectionBar(sel); },
  onSeek: (t) => seekTo(t),
  onMarkerAdd: (t) => addMarker(t),
  onMarkerSelect: (m) => seekTo(toCurrent(m.time)),
  onPpsChange: (pps) => { $('zoomSlider').value = pps; },
});

function init() {
  $('btnImport').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => {
    const f = e.target.files[0];
    if (f) importFile(f);
    e.target.value = '';
  };
  $('btnExport').onclick = openExportDialog;
  $('btnSaveProject').onclick = saveProject;
  $('btnOpenProject').onclick = () => $('projectInput').click();
  $('projectInput').onchange = (e) => {
    const f = e.target.files[0];
    if (f) openProject(f);
    e.target.value = '';
  };

  $('btnPlay').onclick = togglePlay;
  $('btnStop').onclick = stopPlayback;
  $('abToggle').onchange = () => { if (playback) { const t = currentPlayTime(); stopPlayback(); startPlayback(t); } };

  $('btnUndo').onclick = undo;
  $('btnRedo').onclick = redo;

  $('zoomSlider').oninput = (e) => view.setPps(Number(e.target.value));
  $('btnZoomIn').onclick = () => view.setPps(view.getPps() * 1.25);
  $('btnZoomOut').onclick = () => view.setPps(view.getPps() / 1.25);
  $('btnZoomFit').onclick = () => view.fitToWidth();
  $('btnZoom100').onclick = () => view.setPps(100);
  $('viewMode').onchange = (e) => view.setViewMode(e.target.value);

  $('btnMarkerMode').onclick = () => {
    const on = !view.markerMode;
    view.setMarkerMode(on);
    $('btnMarkerMode').classList.toggle('marker-mode-on', on);
  };
  $('btnAddMarker').onclick = () => addMarker(currentPlayTime());

  document.querySelectorAll('.op-btn').forEach((btn) => {
    btn.onclick = () => openOpDialog(btn.dataset.op);
  });

  $('modalClose').onclick = closeModal;
  $('modalBackdrop').addEventListener('click', (e) => {
    if (e.target === $('modalBackdrop')) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); }
  });

  // 样音演示页跳转：index.html?sample=samples/xxx.wav
  const params = new URLSearchParams(location.search);
  const sample = params.get('sample');
  if (sample) {
    const name = decodeURIComponent(sample.split('/').pop());
    fetch(sample)
      .then((r) => { if (!r.ok) throw new Error(`样音加载失败: ${r.status}`); return r.arrayBuffer(); })
      .then((buf) => importBuffer(buf, name))
      .catch((err) => toast(err.message, 'error'));
  }
}

// ---------------- 模态框 / Toast / 日志 ----------------

function openModal(title, bodyEl, footerButtons) {
  $('modalTitle').textContent = title;
  const body = $('modalBody');
  body.replaceChildren(bodyEl);
  const footer = $('modalFooter');
  footer.replaceChildren();
  for (const b of footerButtons || []) {
    const btn = document.createElement('button');
    btn.className = `btn ${b.cls || ''}`;
    btn.textContent = b.label;
    btn.onclick = () => b.onClick && b.onClick(closeModal);
    footer.appendChild(btn);
  }
  $('modalBackdrop').hidden = false;
}
function closeModal() { $('modalBackdrop').hidden = true; }

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c?.nodeType ? c : document.createTextNode(c ?? ''));
  return node;
}

let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function log(msg) {
  const li = el('li', { class: 'log-item' },
    el('span', { class: 'lt' }, new Date().toLocaleTimeString('zh-CN', { hour12: false })), `  ${msg}`);
  $('logList').prepend(li);
}

// ---------------- 导入 / 解码 ----------------

async function importFile(file) {
  try {
    const buf = await file.arrayBuffer();
    await importBuffer(buf, file.name);
  } catch (err) {
    toast(`导入失败: ${err.message}`, 'error');
  }
}

async function importBuffer(arrayBuffer, fileName) {
  stopPlayback();
  let channels, sampleRate, decoderUsed = '';
  // 优先走自带 PCM 解码器（不依赖 AudioContext，Node 可测），失败再回退浏览器解码
  try {
    const wav = decodeWav(arrayBuffer);
    channels = wav.channels;
    sampleRate = wav.sampleRate;
    decoderUsed = `PCM WAV ${wav.bitDepth}-bit / ${wav.numChannels}ch`;
  } catch (pcbErr) {
    const ctx = getAudioCtx();
    const audioBuf = await ctx.decodeAudioData(arrayBuffer.slice(0));
    channels = [];
    for (let c = 0; c < audioBuf.numberOfChannels; c++) {
      channels.push(audioBuf.getChannelData(c).slice());
    }
    sampleRate = audioBuf.sampleRate;
    decoderUsed = `浏览器解码（${fileName.split('.').pop().toUpperCase()} 等）`;
  }
  if (!channels.length || !channels[0].length) throw new Error('音频没有有效采样数据');

  state.source = { channels, sampleRate, fileName };
  state.ops = [];
  state.markers = [];
  state.selection = null;
  state.undoStack = [];
  state.redoStack = [];
  state.projectName = fileName.replace(/\.[^.]+$/, '') || '未命名工程';
  markerSeq = 1;
  playheadTime = 0;
  view.setPlayhead(null);
  $('projectName').textContent = state.projectName;
  $('emptyHint').style.display = 'none';
  setUiEnabled(true);

  reprocess();
  view.fitToWidth();
  $('zoomSlider').value = view.getPps();
  const st = rendered.stats;
  log(`导入「${fileName}」：${decoderUsed}，${sampleRate} Hz，${channels.length} 声道，${formatTime(st.duration)}，${st.numFrames} 采样`);
  if (st.isSilent) {
    toast('检测到该文件为全静音：仍可编辑，但增益/归一化不会产生声音', 'error');
    log('全静音文件：峰值为 0，归一化将被跳过并给出提示');
  }
  toast('导入完成', 'success');
}

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// ---------------- 处理链重算（唯一的渲染入口） ----------------

function reprocess() {
  if (!state.source) return;
  rendered.channels = applyOps(state.source.channels, state.source.sampleRate, state.ops);
  rendered.stats = computeStats(rendered.channels, state.source.sampleRate);
  view.setData(rendered.channels, state.source.sampleRate);
  // 标记存原始坐标，渲染时换算为当前时间线坐标并隐藏落在剪切区内的标记
  view.setMarkers(visibleMarkers(state.markers, cuts()).map((m) => ({ ...m, time: m.currentTime })));
  if (state.selection) {
    const d = rendered.stats.duration;
    state.selection = {
      start: Math.min(state.selection.start, d),
      end: Math.min(state.selection.end, d),
    };
    if (state.selection.end <= state.selection.start) state.selection = null;
  }
  view.setSelection(state.selection);
  updateSelectionBar(state.selection);
  renderOps();
  renderMarkers();
  renderStats();
  updateUndoButtons();
  $('totalDur').textContent = `${formatTime(rendered.stats.duration)}（${rendered.stats.numFrames} 采样）`;
}

// ---------------- 历史（撤销/重做） ----------------

function snapshot() {
  return JSON.stringify({
    ops: state.ops,
    markers: state.markers,
    selection: state.selection,
  });
}
function pushHistory() {
  state.undoStack.push(snapshot());
  if (state.undoStack.length > HISTORY_LIMIT) state.undoStack.shift();
  state.redoStack = [];
}
function restore(json) {
  const s = JSON.parse(json);
  state.ops = s.ops;
  state.markers = s.markers;
  state.selection = s.selection;
  reprocess();
}
function undo() {
  if (!state.undoStack.length) return;
  state.redoStack.push(snapshot());
  restore(state.undoStack.pop());
  log('撤销');
}
function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push(snapshot());
  restore(state.redoStack.pop());
  log('重做');
}
function updateUndoButtons() {
  $('btnUndo').disabled = !state.undoStack.length || !state.source;
  $('btnRedo').disabled = !state.redoStack.length || !state.source;
}

// ---------------- 选区 ----------------

function currentRange() {
  if (state.selection) return { ...state.selection };
  return { start: 0, end: rendered.stats.duration };
}

function updateSelectionBar(sel) {
  const sr = state.source?.sampleRate || 0;
  if (!sel) {
    $('selStart').textContent = '—';
    $('selEnd').textContent = '—';
    $('selDur').textContent = '—';
    $('selSamples').textContent = '—';
    return;
  }
  $('selStart').textContent = formatTime(sel.start);
  $('selEnd').textContent = formatTime(sel.end);
  $('selDur').textContent = formatTime(sel.end - sel.start);
  $('selSamples').textContent = sr
    ? `#${timeToSample(sel.start, sr)} – #${timeToSample(sel.end, sr)}`
    : '—';
}

// ---------------- 操作链 ----------------

function openOpDialog(type) {
  if (!state.source) return;
  const duration = rendered.stats.duration;
  const needSelection = type !== 'normalize';
  if (needSelection && !state.selection) {
    toast('请先在波形上拖选一个区域', 'error');
    return;
  }
  const range = currentRange();
  if (range.end <= range.start) { toast('选区长度为 0', 'error'); return; }

  const rangeInfo = el('div', { class: 'info-box' },
    el('div', { class: 'row' }, el('span', { class: 'k' }, '起点'), el('span', {}, formatTime(range.start))),
    el('div', { class: 'row' }, el('span', { class: 'k' }, '终点'), el('span', {}, formatTime(range.end))),
    el('div', { class: 'row' }, el('span', { class: 'k' }, '时长'), el('span', {}, formatTime(range.end - range.start))),
  );

  if (type === 'cut' || type === 'mute') {
    const body = el('div', {}, rangeInfo);
    if (type === 'cut') {
      const o = toOrig(range.start);
      const e = toOrig(range.end);
      const overlap = activeCutIntervals(state.ops).some((c) => o < c.end && e > c.start);
      body.append(el('p', { class: 'hint' },
        `删除后总时长将变为 ${formatTime(duration - (range.end - range.start))}；落在删除区间内的标记会随音频隐藏，其余标记位置自动随时间线更新。`));
      if (overlap) {
        body.append(el('div', { class: 'silent-banner' },
          '该区间与已有剪切重叠：重叠部分只删除一次，引擎会自动合并剪切区间。'));
      }
    } else {
      body.append(el('p', { class: 'hint' }, '静音仅把区间采样置 0，不改变时长。'));
    }
    openModal(OP_TYPES[type].label, body, [
      { label: '取消', onClick: closeModal },
      {
        label: '确定', cls: 'btn-primary',
        onClick: (close) => {
          const o = toOrig(range.start);
          const e = toOrig(range.end);
          addOp(createOp(type, o, e));
          close();
        },
      },
    ]);
    return;
  }

  if (type === 'gain') {
    const input = el('input', { type: 'number', step: '0.1', value: '6' });
    const body = el('div', {},
      rangeInfo,
      el('div', { class: 'field' }, el('label', {}, '增益量（dB，正数放大 / 负数衰减）'), input),
    );
    openModal('增益', body, [
      { label: '取消', onClick: closeModal },
      {
        label: '确定', cls: 'btn-primary',
        onClick: (close) => {
          addOp(createOp('gain', toOrig(range.start), toOrig(range.end), { gainDb: Number(input.value) || 0 }));
          close();
        },
      },
    ]);
    return;
  }

  if (type === 'fadeIn' || type === 'fadeOut') {
    const body = el('div', {}, rangeInfo);
    const curveWrap = el('div', { class: 'field' }, el('label', {}, '渐变曲线'));
    const radios = ['linear', 'equalPower'].map((curve) => {
      const r = el('input', { type: 'radio', name: 'curve', value: curve });
      if (curve === 'linear') r.checked = true;
      return el('label', { class: 'switch-label' }, r, curve === 'linear' ? '线性' : '等功率（余弦）');
    });
    const row = el('div', { class: 'radio-row' }, ...radios);
    curveWrap.appendChild(row);
    body.appendChild(curveWrap);
    openModal(OP_TYPES[type].label, body, [
      { label: '取消', onClick: closeModal },
      {
        label: '确定', cls: 'btn-primary',
        onClick: (close) => {
          const curve = body.querySelector('input[name="curve"]:checked').value;
          addOp(createOp(type, toOrig(range.start), toOrig(range.end), { curve }));
          close();
        },
      },
    ]);
    return;
  }

  if (type === 'normalize') {
    openNormalizeDialog(range);
  }
}

function openNormalizeDialog(range) {
  // 对话框展示当前时间线范围，实际计算使用原始坐标
  const origRange = { start: toOrig(range.start), end: toOrig(range.end) };
  const targetInput = el('input', { type: 'number', step: '0.1', value: '-1' });
  const resultBox = el('div', {});
  const body = el('div', {},
    el('p', { class: 'hint' }, state.selection ? '对当前选区做峰值归一化' : '未选择区域，默认对整段音频归一化'),
    rangeInfoOf(range),
    el('div', { class: 'field' }, el('label', {}, '目标峰值（dBFS，不允许超过 0 以防削波）'), targetInput),
    resultBox,
  );

  const renderPlan = () => {
    const target = Math.min(0, Number(targetInput.value) || 0);
    const plan = planNormalize(
      state.source.channels, state.source.sampleRate, state.ops,
      origRange.start, origRange.end, target,
    );
    resultBox.replaceChildren();
    if (plan.silent) {
      resultBox.append(el('div', { class: 'silent-banner' },
        '区间内实测峰值为 0（-∞ dBFS）：这是静音内容，没有可放大的信号，归一化不会执行任何改动。'));
      return;
    }
    resultBox.append(el('div', { class: 'info-box' },
      el('div', { class: 'row' }, el('span', { class: 'k' }, '处理前实测峰值'), el('span', {}, formatDb(plan.measuredPeakDb))),
      el('div', { class: 'row' }, el('span', { class: 'k' }, '将施加增益'), el('span', {}, formatDb(plan.gainDb))),
      el('div', { class: 'row' }, el('span', { class: 'k' }, '处理后预期峰值'), el('span', {}, formatDb(target))),
      el('div', { class: 'row' }, el('span', { class: 'k' }, '作用采样数（不含已剪切）'), el('span', {}, String(plan.frames))),
    ));
  };
  targetInput.addEventListener('input', renderPlan);
  renderPlan();

  const okBtn = {
    label: '添加归一化', cls: 'btn-primary',
    onClick: (close) => {
      const target = Math.min(0, Number(targetInput.value) || 0);
      const plan = planNormalize(
        state.source.channels, state.source.sampleRate, state.ops,
        origRange.start, origRange.end, target,
      );
      const op = createOp('normalize', origRange.start, origRange.end, { targetDb: target });
      op.measured = plan.silent
        ? { silent: true }
        : { measuredPeakDb: plan.measuredPeakDb, gainDb: plan.gainDb, afterPeakDb: target };
      addOp(op);
      close();
    },
  };
  openModal('音量归一化', body, [{ label: '关闭', onClick: closeModal }, okBtn]);
}

function rangeInfoOf(range) {
  return el('div', { class: 'info-box' },
    el('div', { class: 'row' }, el('span', { class: 'k' }, '起点'), el('span', {}, formatTime(range.start))),
    el('div', { class: 'row' }, el('span', { class: 'k' }, '终点'), el('span', {}, formatTime(range.end))),
    el('div', { class: 'row' }, el('span', { class: 'k' }, '时长'), el('span', {}, formatTime(range.end - range.start))),
  );
}

function addOp(op) {
  pushHistory();
  state.ops.push(op);
  if (op.type === 'cut') state.selection = null; // 剪切后原选区已无意义
  reprocess();
  log(`添加操作 #${state.ops.length}「${OP_TYPES[op.type].label}」 原始时间 ${formatTime(op.start)} → ${formatTime(op.end)}`);
}

function renderOps() {
  const list = $('opsList');
  list.replaceChildren();
  state.ops.forEach((op, idx) => {
    const li = el('li', { class: `op-item op-type-${op.type}${op.enabled ? '' : ' disabled-op'}` });
    const head = el('div', { class: 'op-head' },
      el('span', { class: 'op-index' }, `#${idx + 1}`),
      el('input', {
        type: 'checkbox', title: '旁路 / 启用',
        ...(op.enabled ? { checked: '' } : {}),
        onchange: () => toggleOp(op.id),
      }),
      el('span', { class: 'op-title' }, OP_TYPES[op.type].label),
      el('div', { class: 'op-actions' },
        iconBtn('↑', '上移', () => moveOp(op.id, -1), idx === 0),
        iconBtn('↓', '下移', () => moveOp(op.id, 1), idx === state.ops.length - 1),
        iconBtn('✎', '编辑参数', () => editOp(op)),
        iconBtn('✕', '删除', () => deleteOp(op), false, true),
      ),
    );
    li.append(head);
    // 坐标存原始时间线；剪切启用时额外显示它在当前界面时间线上的对应位置
    const meta = el('div', { class: 'op-meta' },
      el('span', {}, `原始 ${formatTime(op.start)} → ${formatTime(op.end)}`),
      el('span', {}, `时长 ${formatTime(op.end - op.start)}`),
      ...opParamBadges(op),
    );
    li.append(meta);
    if (cuts().length && !isInCut(op.start, cuts()) && op.type !== 'cut') {
      li.append(el('div', { class: 'op-note' },
        `界面位置 ${formatTime(toCurrent(op.start))} → ${formatTime(toCurrent(op.end))}`));
    }
    if (op.type === 'normalize' && op.measured) {
      li.append(el('div', { class: 'op-note' },
        op.measured.silent
          ? '添加时实测：区间全静音，已自动跳过'
          : `添加时实测：峰值 ${formatDb(op.measured.measuredPeakDb)} → ${formatDb(op.measured.afterPeakDb)}（增益 ${formatDb(op.measured.gainDb)}）`));
    }
    list.append(li);
  });
}

function opParamBadges(op) {
  if (op.type === 'gain') return [el('span', {}, `增益 ${formatDb(op.gainDb)}`)];
  if (op.type === 'fadeIn' || op.type === 'fadeOut') {
    return [el('span', {}, op.curve === 'equalPower' ? '等功率曲线' : '线性曲线')];
  }
  if (op.type === 'normalize') return [el('span', {}, `目标 ${formatDb(op.targetDb)}`)];
  return [];
}

function iconBtn(text, title, onClick, disabled = false, danger = false) {
  return el('button', {
    class: `icon-btn ${danger ? 'btn-danger' : ''}`,
    title, ...(disabled ? { disabled: '' } : {}), onclick: onClick,
  }, text);
}

function toggleOp(id) {
  const op = state.ops.find((o) => o.id === id);
  if (!op) return;
  pushHistory();
  op.enabled = !op.enabled;
  reprocess();
  log(`${op.enabled ? '启用' : '旁路'}操作「${OP_TYPES[op.type].label}」`);
}

function moveOp(id, dir) {
  const i = state.ops.findIndex((o) => o.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.ops.length) return;
  pushHistory();
  [state.ops[i], state.ops[j]] = [state.ops[j], state.ops[i]];
  reprocess();
  log('调整处理链顺序');
}

function deleteOp(op) {
  pushHistory();
  const idx = state.ops.findIndex((o) => o.id === op.id);
  state.ops.splice(idx, 1);
  // 所有 op/标记都存原始坐标，删除剪切只是让对应帧重新出现，无需移动任何坐标
  reprocess();
  log(`删除操作「${OP_TYPES[op.type].label}」`);
}

function editOp(op) {
  // 编辑的是原始时间线坐标，校验上界用原始音频时长
  const originalDuration = state.source.channels[0].length / state.source.sampleRate;
  const startInput = el('input', { type: 'number', step: '0.001', min: '0', value: op.start.toFixed(3) });
  const endInput = el('input', { type: 'number', step: '0.001', min: '0', value: op.end.toFixed(3) });
  const body = el('div', {},
    el('div', { class: 'field-row' },
      el('div', { class: 'field' }, el('label', {}, '起点（秒，原始时间线）'), startInput),
      el('div', { class: 'field' }, el('label', {}, '终点（秒，原始时间线）'), endInput),
    ),
    el('p', { class: 'hint' },
      `原始音频时长 ${formatTime(originalDuration)}；当前界面时长 ${formatTime(rendered.stats.duration)}`),
  );
  let extra = {};
  if (op.type === 'gain') {
    const g = el('input', { type: 'number', step: '0.1', value: String(op.gainDb) });
    body.append(el('div', { class: 'field' }, el('label', {}, '增益量（dB）'), g));
    extra.gainDb = () => Number(g.value) || 0;
  }
  if (op.type === 'fadeIn' || op.type === 'fadeOut') {
    const sel = el('select', {},
      el('option', { value: 'linear' }, '线性'),
      el('option', { value: 'equalPower' }, '等功率（余弦）'));
    sel.value = op.curve;
    body.append(el('div', { class: 'field' }, el('label', {}, '渐变曲线'), sel));
    extra.curve = () => sel.value;
  }
  if (op.type === 'normalize') {
    const t = el('input', { type: 'number', step: '0.1', max: '0', value: String(op.targetDb) });
    body.append(el('div', { class: 'field' }, el('label', {}, '目标峰值（dBFS）'), t));
    extra.targetDb = () => Math.min(0, Number(t.value) || 0);
  }
  openModal(`编辑：${OP_TYPES[op.type].label}`, body, [
    { label: '取消', onClick: closeModal },
    {
      label: '保存', cls: 'btn-primary',
      onClick: (close) => {
        const s = Number(startInput.value);
        const e = Number(endInput.value);
        if (!(s >= 0) || !(e > s) || e > originalDuration + 1e-6) {
          toast('时间范围无效（需在原始音频时长内且终点大于起点）', 'error'); return;
        }
        pushHistory();
        // 坐标始终是原始时间线，直接修改即可，不影响任何其他 op/标记
        op.start = s; op.end = e;
        if (extra.gainDb) op.gainDb = extra.gainDb();
        if (extra.curve) op.curve = extra.curve();
        if (extra.targetDb) op.targetDb = extra.targetDb();
        reprocess();
        log('修改操作参数');
        close();
      },
    },
  ]);
}

// ---------------- 标记 ----------------

function addMarker(currentTime) {
  if (!state.source) return;
  pushHistory();
  const origTime = toOrig(currentTime); // 标记存原始时间线坐标
  const name = `M${String(markerSeq++).padStart(2, '0')}`;
  state.markers.push({ id: `m-${Date.now().toString(36)}`, name, time: origTime });
  state.markers.sort((a, b) => a.time - b.time);
  reprocess();
  log(`添加标记 ${name} @ 原始 ${formatTime(origTime)}（界面 ${formatTime(toCurrent(origTime))}）`);
}

function renderMarkers() {
  const list = $('markerList');
  list.replaceChildren();
  const vis = visibleMarkers(state.markers, cuts());
  const hiddenCount = state.markers.length - vis.length;
  if (!state.markers.length) {
    list.append(el('li', { class: 'hint' }, '暂无标记：开启「标记模式」后点击波形，或用「播放头标记」'));
    return;
  }
  for (const m of vis) {
    list.append(el('li', { class: 'marker-item' },
      el('span', { class: 'marker-dot' }),
      el('span', {
        class: 'marker-name', title: '点击重命名',
        onclick: () => renameMarker(m),
      }, m.name),
      el('span', { class: 'marker-time', title: '点击定位' }, formatTime(m.currentTime)),
      iconBtn('⤳', '定位到此标记', () => seekTo(m.currentTime)),
      iconBtn('✕', '删除标记', () => {
        pushHistory();
        state.markers = state.markers.filter((x) => x.id !== m.id);
        reprocess();
        log(`删除标记 ${m.name}`);
      }),
    ));
  }
  if (hiddenCount > 0) {
    list.append(el('li', { class: 'hint' }, `另有 ${hiddenCount} 个标记落在剪切区间内，已随音频隐藏（恢复剪切后重新显示）`));
  }
}

function renameMarker(m) {
  const input = el('input', { type: 'text', value: m.name });
  openModal('重命名标记', el('div', { class: 'field' }, el('label', {}, '标记名称'), input), [
    { label: '取消', onClick: closeModal },
    {
      label: '保存', cls: 'btn-primary',
      onClick: (close) => {
        pushHistory();
        m.name = input.value.trim() || m.name;
        reprocess();
        close();
      },
    },
  ]);
  setTimeout(() => input.focus(), 0);
}

// ---------------- 回放 ----------------

function togglePlay() {
  if (!state.source) return;
  if (playback) stopPlayback();
  else startPlayback(currentPlayTime());
}

function startPlayback(offset = 0) {
  const ctx = getAudioCtx();
  const useSource = $('abToggle').checked;
  const data = useSource ? state.source.channels : rendered.channels;
  const sr = state.source.sampleRate;
  const buf = ctx.createBuffer(data.length, data[0].length, sr);
  data.forEach((ch, i) => buf.copyToChannel(ch, i));
  const node = ctx.createBufferSource();
  node.buffer = buf;
  node.connect(ctx.destination);
  const dur = data[0].length / sr;
  const startOffset = Math.min(offset, dur);
  node.start(0, startOffset);
  node.onended = () => { if (playback && playback.node === node) stopPlayback(); };
  // 记录当前播放缓冲自己的时长，避免 A（原始）比 B（处理后）长时播放头被提前钳住
  playback = { node, startedAt: ctx.currentTime, offset: startOffset, useSource, duration: dur };
  $('btnPlay').textContent = '⏸ 暂停';
  requestAnimationFrame(playheadLoop);
  log(useSource ? '回放原始音频（A）' : '回放处理结果（B）');
}

function stopPlayback() {
  if (!playback) return;
  try { playback.node.onended = null; playback.node.stop(); } catch { /* 已停止 */ }
  playback = null;
  $('btnPlay').textContent = '▶ 播放';
}

function currentPlayTime() {
  if (!playback) return playheadTime;
  return Math.min(
    playback.offset + (audioCtx.currentTime - playback.startedAt),
    playback.duration,
  );
}

let playheadTime = 0;
function playheadLoop() {
  if (!playback) return;
  playheadTime = currentPlayTime();
  view.setPlayhead(playheadTime);
  view.scrollToTime(playheadTime);
  $('playheadTime').textContent = formatTime(playheadTime);
  if (playback) requestAnimationFrame(playheadLoop);
}

function seekTo(t) {
  playheadTime = Math.max(0, Math.min(rendered.stats?.duration || 0, t));
  view.setPlayhead(playheadTime);
  $('playheadTime').textContent = formatTime(playheadTime);
  if (playback) {
    stopPlayback();
    startPlayback(playheadTime);
  }
}

// ---------------- 统计面板（A 原始 / B 处理后） ----------------

function renderStats() {
  if (!state.source) return;
  const box = $('statsBox');
  box.replaceChildren();
  const a = computeStats(state.source.channels, state.source.sampleRate);
  const b = rendered.stats;

  if (a.isSilent) {
    box.append(el('div', { class: 'silent-banner' },
      '原始音频为全静音（峰值 0 / -∞ dBFS）：静音/剪切仍可正常使用，增益与归一化不会产生信号。'));
  }
  if (a.hasInvalidSamples) {
    box.append(el('div', { class: 'silent-banner' },
      `检测到 ${a.invalidCount} 个非法采样（NaN/Infinity），已在统计与导出时按 0 处理，建议检查源文件。`));
  }
  const grid = el('div', { class: 'stats-grid' });
  grid.append(statsCol('A：原始音频', a, false));
  grid.append(statsCol('B：处理结果', b, true));
  box.append(grid);

  const delta = b.globalPeakDb - a.globalPeakDb;
  const deltaLabel = Math.abs(delta) < 0.005 ? '+0.00' : `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`;
  const deltaLine = a.isSilent
    ? '峰值变化：原始为静音，无可比较的电平'
    : `峰值变化：${formatDb(a.globalPeakDb)} → ${formatDb(b.globalPeakDb)}（${deltaLabel} dB）`;
  box.append(el('div', { class: 'stats-delta' },
    deltaLine,
    b.globalPeak >= 1 ? el('span', { class: 'badge badge-warn', style: 'margin-left:8px' }, '存在满幅/削波风险') : '',
  ));
}

function statsCol(title, st, isB) {
  const col = el('div', { class: `stats-col ${isB ? 'b' : 'a'}` }, el('h4', {}, title));
  st.perChannel.forEach((c, i) => {
    const chName = st.numChannels === 1 ? 'Mono' : (i === 0 ? 'L' : 'R');
    col.append(el('div', { class: 'metric' }, el('span', { class: 'mk' }, `${chName} 峰值`),
      el('span', { class: `mv ${c.peak >= 1 ? 'warn' : ''}` }, formatDb(c.peakDb))));
    col.append(el('div', { class: 'metric' }, el('span', { class: 'mk' }, `${chName} RMS`),
      el('span', { class: 'mv' }, formatDb(c.rmsDb))));
  });
  col.append(el('div', { class: 'metric' }, el('span', { class: 'mk' }, '时长'),
    el('span', { class: 'mv' }, formatTime(st.duration))));
  return col;
}

// ---------------- 工程保存 / 打开 ----------------

function saveProject() {
  if (!state.source) { toast('没有可保存的音频', 'error'); return; }
  // 原始浮点采样原样写入工程文件（不经过 PCM 量化），保证重新打开后逐采样一致
  const { channels, sampleRate, fileName } = state.source;
  const len = channels[0].length;
  const merged = new Float32Array(len * channels.length);
  channels.forEach((ch, c) => merged.set(ch, c * len));
  const project = {
    app: 'local-audio-waveform-editor',
    version: 1,
    savedAt: new Date().toISOString(),
    name: state.projectName,
    audio: {
      sampleRate,
      numChannels: channels.length,
      numFrames: len,
      float32Base64: arrayBufferToBase64(merged.buffer),
      originalFileName: fileName,
    },
    ops: state.ops,
    markers: state.markers,
    selection: state.selection,
  };
  const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
  downloadBlob(blob, `${state.projectName}.wae-project.json`);
  log('保存工程文件（原始浮点 PCM + 处理链 + 标记）');
  toast('工程已保存', 'success');
}

async function openProject(file) {
  try {
    const project = JSON.parse(await file.text());
    if (project.app !== 'local-audio-waveform-editor') throw new Error('不是本编辑器的工程文件');
    const a = project.audio;
    if (!a || !a.float32Base64) throw new Error('工程缺少音频数据');
    if (!(a.sampleRate > 0) || !Number.isInteger(a.sampleRate)) throw new Error('工程采样率无效');
    if (!(a.numChannels > 0) || !Number.isInteger(a.numChannels)) throw new Error('工程声道数无效');
    if (!(a.numFrames > 0) || !Number.isInteger(a.numFrames)) throw new Error('工程采样数无效');

    const buf = base64ToArrayBuffer(a.float32Base64);
    const expectedBytes = a.numFrames * a.numChannels * 4; // Float32
    if (buf.byteLength !== expectedBytes) {
      throw new Error(`音频数据长度不符：期望 ${expectedBytes} 字节，实际 ${buf.byteLength} 字节（文件可能已损坏或被截断）`);
    }
    const raw = new Float32Array(buf);
    const channels = [];
    for (let c = 0; c < a.numChannels; c++) {
      channels.push(raw.slice(c * a.numFrames, (c + 1) * a.numFrames));
    }
    stopPlayback();
    state.source = {
      channels, sampleRate: a.sampleRate,
      fileName: a.originalFileName || 'project.wav',
    };
    state.ops = Array.isArray(project.ops) ? project.ops : [];
    state.markers = Array.isArray(project.markers) ? project.markers : [];
    state.selection = project.selection || null;
    state.projectName = project.name || '未命名工程';
    state.undoStack = [];
    state.redoStack = [];
    markerSeq = state.markers.length + 1;
    playheadTime = 0;
    view.setPlayhead(null);
    $('projectName').textContent = state.projectName;
    $('emptyHint').style.display = 'none';
    setUiEnabled(true);
    reprocess();
    view.fitToWidth();
    log(`打开工程「${state.projectName}」：${state.ops.length} 个操作，${state.markers.length} 个标记`);
    toast('工程已打开', 'success');
  } catch (err) {
    toast(`工程打开失败: ${err.message}`, 'error');
  }
}

// ---------------- WAV 导出（带一致性校验） ----------------

function openExportDialog() {
  if (!state.source) return;
  const bitSelect = el('select', {},
    el('option', { value: '16' }, '16-bit PCM（通用）'),
    el('option', { value: '24' }, '24-bit PCM（更高精度）'));
  const st = rendered.stats;
  const body = el('div', {},
    el('div', { class: 'info-box' },
      el('div', { class: 'row' }, el('span', { class: 'k' }, '采样率'), el('span', {}, `${st.sampleRate} Hz（与源一致）`)),
      el('div', { class: 'row' }, el('span', { class: 'k' }, '声道数'), el('span', {}, String(st.numChannels))),
      el('div', { class: 'row' }, el('span', { class: 'k' }, '时长 / 采样'), el('span', {}, `${formatTime(st.duration)} / ${st.numFrames}`)),
      el('div', { class: 'row' }, el('span', { class: 'k' }, '已启用操作'), el('span', {}, `${state.ops.filter((o) => o.enabled).length} / ${state.ops.length}`)),
    ),
    el('div', { class: 'field' }, el('label', {}, '导出位深'), bitSelect),
    el('p', { class: 'hint' }, '导出内容为处理链的完整计算结果；导出后会自动回读校验采样率、声道与时长。'),
  );
  openModal('导出 WAV', body, [
    { label: '取消', onClick: closeModal },
    {
      label: '导出并校验', cls: 'btn-primary',
      onClick: (close) => { doExport(Number(bitSelect.value)); close(); },
    },
  ]);
}

function doExport(bitDepth) {
  const st = rendered.stats;
  const buffer = encodeWavPCM(rendered.channels, st.sampleRate, bitDepth);
  // 回读校验：导出文件的参数必须与界面显示完全一致
  const verify = decodeWav(buffer);
  const checks = [
    ['采样率', verify.sampleRate === st.sampleRate, `${verify.sampleRate} vs ${st.sampleRate}`],
    ['声道数', verify.numChannels === st.numChannels, `${verify.numChannels} vs ${st.numChannels}`],
    ['采样数', verify.numFrames === st.numFrames, `${verify.numFrames} vs ${st.numFrames}`],
    ['时长', Math.abs(verify.numFrames / verify.sampleRate - st.duration) < 1e-6,
      `${formatTime(verify.numFrames / verify.sampleRate)} vs ${formatTime(st.duration)}`],
  ];
  const allOk = checks.every(([, ok]) => ok);
  downloadBlob(new Blob([buffer], { type: 'audio/wav' }), `${state.projectName}-processed.wav`);
  log(`导出 WAV（${bitDepth}-bit，${st.sampleRate} Hz，${st.numChannels}ch，${formatTime(st.duration)}）校验${allOk ? '通过' : '失败'}`);

  const body = el('div', {},
    checks.map(([name, ok, detail]) => el('div', { class: 'row', style: 'padding:3px 0; font-family:var(--mono);font-size:12px' },
      el('span', {}, el('span', { class: `badge ${ok ? 'badge-ok' : 'badge-err'}` }, ok ? '通过' : '失败'), ` ${name}`),
      el('span', { class: 'hint' }, detail))),
    el('p', { class: 'hint' }, allOk ? '全部一致：导出文件与界面显示的采样率、声道、时长完全相同。' : '存在不一致，请检查后重试。'),
  );
  openModal('导出校验结果', body, [{ label: '知道了', cls: 'btn-primary', onClick: closeModal }]);
  toast(allOk ? 'WAV 已导出，校验通过' : '导出完成但校验失败', allOk ? 'success' : 'error');
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------- 杂项 ----------------

function setUiEnabled(on) {
  ['btnExport', 'btnPlay', 'btnStop', 'btnZoomOut', 'btnZoomIn', 'btnZoomFit', 'btnZoom100',
    'zoomSlider', 'viewMode', 'btnMarkerMode', 'btnAddMarker'].forEach((id) => { $(id).disabled = !on; });
  document.querySelectorAll('.op-btn').forEach((b) => { b.disabled = !on; });
}

// ---------------- 端到端测试钩子（tests/e2e-test.mjs 使用，不影响正常交互） ----------------

window.__e2e__ = {
  buildChain() {
    const sr = state.source.sampleRate;
    const before = state.source.channels[0].slice();
    state.selection = { start: 0.2, end: 0.5 };
    pushHistory();
    state.ops.push(createOp('mute', 0.2, 0.5));
    state.selection = { start: 0.0, end: 8.0 };
    pushHistory();
    state.ops.push(createOp('gain', 0, 8, { gainDb: 3 }));
    state.selection = { start: 1.0, end: 2.0 };
    pushHistory();
    state.ops.push(createOp('fadeIn', 1.0, 2.0, { curve: 'linear' }));
    state.selection = { start: 5.0, end: 6.0 };
    pushHistory();
    state.ops.push(createOp('fadeOut', 5.0, 6.0, { curve: 'linear' }));
    state.selection = null;
    reprocess();
    const out = rendered.channels;
    const i0 = Math.round(0.2 * sr);
    return {
      opsCount: state.ops.length,
      duration: out[0].length / sr,
      mutedZero: out[0].slice(i0, Math.round(0.5 * sr)).every((v) => v === 0),
      fadeStartZero: out[0][Math.round(1.0 * sr)] === 0,
      sourceIntact: state.source.channels[0].every((v, i) => v === before[i]),
    };
  },

  normalizeTest() {
    state.ops = [];
    state.markers = [];
    state.undoStack = [];
    state.redoStack = [];
    reprocess();
    const before = computeStats(state.source.channels, state.source.sampleRate);
    const plan = planNormalize(state.source.channels, state.source.sampleRate, [], 0, 8, -1);
    const op = createOp('normalize', 0, 8, { targetDb: -1 });
    op.measured = { measuredPeakDb: plan.measuredPeakDb, gainDb: plan.gainDb, afterPeakDb: -1 };
    pushHistory();
    state.ops.push(op);
    reprocess();
    const after = rendered.stats;
    return {
      beforePeak: before.globalPeak,
      gainDb: plan.gainDb,
      afterPeakDb: after.globalPeakDb,
    };
  },

  silentTest() {
    const st = computeStats(state.source.channels, state.source.sampleRate);
    const plan = planNormalize(state.source.channels, state.source.sampleRate, [], 0, 1.5, -1);
    const op = createOp('normalize', 0, 1.5, { targetDb: -1 });
    state.ops = [op];
    reprocess();
    const stillZero = rendered.channels[0].every((v) => v === 0);
    return {
      isSilent: st.isSilent,
      planSilent: plan.silent,
      stillZero,
      bannerShown: !!document.querySelector('.silent-banner'),
    };
  },

  cutWithMarkers() {
    state.markers = [
      { id: 't1', name: 'T1', time: 0.5 },
      { id: 't2', name: 'T2', time: 1.5 }, // 落在剪切 [1,2) 内 → 隐藏
      { id: 't3', name: 'T3', time: 3.0 }, // 剪切后 → 界面时间 2.0
    ];
    pushHistory();
    state.ops.push(createOp('cut', 1.0, 2.0));
    reprocess();
    const vis = visibleMarkers(state.markers, cuts());
    const durationAfter = rendered.stats.duration;
    const beforeMarkerKept = vis.some((m) => m.id === 't1' && m.currentTime === 0.5);
    const insideMarkerRemoved = !vis.some((m) => m.id === 't2');
    const afterMarker = vis.find((m) => m.id === 't3');
    const afterMarkerTime = afterMarker ? afterMarker.currentTime : -1;
    // 原始标记数据不被删除（旁路剪切后可恢复）
    const rawStillThere = state.markers.length === 3;

    undo();
    const undoDuration = rendered.stats.duration;
    const undoMarkers = visibleMarkers(state.markers, cuts()).length;
    return {
      durationAfter, beforeMarkerKept, insideMarkerRemoved, afterMarkerTime,
      rawStillThere, undoDuration, undoMarkers,
    };
  },

  // 视觉验证用：构造剪切 + 标记（含剪切区内）+ 增益 + 淡入的丰富场景
  visualScenario() {
    state.ops = [];
    state.markers = [
      { id: 'v1', name: '开头', time: 0.3 },
      { id: 'v2', name: '剪切区内', time: 1.5 },
      { id: 'v3', name: '后段', time: 5.0 },
    ];
    state.undoStack = [];
    state.redoStack = [];
    state.ops.push(createOp('cut', 1.0, 2.0));
    state.ops.push(createOp('gain', 4.5, 7.0, { gainDb: 4 }));
    state.ops.push(createOp('fadeIn', 2.0, 3.0, { curve: 'linear' }));
    reprocess();
    return 'ok';
  },

  // 审查缺陷 #1/#2 回归：剪切旁路/重排后，其他 op 仍命中同一段原始音频
  cutBypassTest() {    const sr = state.source.sampleRate;
    state.ops = [];
    state.markers = [];
    state.undoStack = [];
    state.redoStack = [];
    // 剪切原始 [1,2)，增益作用于原始 [4,5)（模拟界面选区经 currentToOriginalTime 换算）
    const cut = createOp('cut', 1, 2);
    const gain = createOp('gain', 4, 5, { gainDb: 6 });
    const factor = Math.pow(10, 6 / 20);
    // 在增益区 [4,5) 内找一个非零原始帧（避开正弦过零点）
    let probe = Math.round(4.5 * sr);
    while (Math.abs(state.source.channels[0][probe]) < 1e-4 && probe < Math.round(5 * sr) - 1) probe++;
    const srcVal = state.source.channels[0][probe];
    const probeTime = probe / sr;

    const active = applyOps(state.source.channels, sr, [cut, gain]);
    // 输出时间线 = 原始时间 - 1s（剪切 [1,2)）
    const activeVal = active[0][Math.round((probeTime - 1) * sr)];

    cut.enabled = false;
    const bypassed = applyOps(state.source.channels, sr, [cut, gain]);
    const bypassVal = bypassed[0][probe]; // 旁路后同一原始帧
    cut.enabled = true;

    const reordered = applyOps(state.source.channels, sr, [gain, cut]);

    return {
      activeHitsGain: Math.abs(activeVal / srcVal - factor) < 0.02,
      bypassHitsSameFrame: Math.abs(bypassVal / srcVal - factor) < 0.02,
      bypassRestoresLength: bypassed[0].length === state.source.channels[0].length,
      reorderIdentical: reordered[0].every((v, i) => v === active[0][i]),
    };
  },

  async projectRoundTrip() {
    // 构造一个已知状态
    state.ops = [
      createOp('mute', 0.5, 1.0),
      createOp('gain', 0, 4, { gainDb: -2 }),
    ];
    state.markers = [{ id: 'p1', name: 'P1', time: 2.25 }];
    state.selection = { start: 0.5, end: 1.0 };
    reprocess();
    const original = state.source.channels.map((c) => c.slice());

    const len = state.source.channels[0].length;
    const merged = new Float32Array(len * state.source.channels.length);
    state.source.channels.forEach((ch, c) => merged.set(ch, c * len));
    const project = {
      app: 'local-audio-waveform-editor', version: 1,
      name: 'e2e-roundtrip',
      audio: {
        sampleRate: state.source.sampleRate,
        numChannels: state.source.channels.length,
        numFrames: len,
        float32Base64: arrayBufferToBase64(merged.buffer),
        originalFileName: state.source.fileName,
      },
      ops: state.ops, markers: state.markers, selection: state.selection,
    };
    const json = JSON.stringify(project);

    // 模拟重新打开：走与 openProject 相同的恢复路径
    const parsed = JSON.parse(json);
    const a = parsed.audio;
    const raw = new Float32Array(base64ToArrayBuffer(a.float32Base64));
    const restored = [];
    for (let c = 0; c < a.numChannels; c++) {
      restored.push(raw.slice(c * a.numFrames, (c + 1) * a.numFrames));
    }
    const samplesIdentical = restored.every((ch, c) =>
      ch.length === original[c].length && ch.every((v, i) => v === original[c][i]));

    state.source = {
      channels: restored, sampleRate: a.sampleRate,
      fileName: a.originalFileName,
    };
    state.ops = parsed.ops;
    state.markers = parsed.markers;
    state.selection = parsed.selection;
    state.undoStack = [];
    state.redoStack = [];
    reprocess();
    return {
      hasAudio: !!parsed.audio.float32Base64,
      opsCount: state.ops.length,
      samplesIdentical,
      stateRestored: state.markers.length === 1 && state.markers[0].time === 2.25
        && state.selection.start === 0.5 && state.selection.end === 1.0,
    };
  },

  exportWav() {
    reprocess();
    const st = rendered.stats;
    const buf16 = encodeWavPCM(rendered.channels, st.sampleRate, 16);
    const v16 = decodeWav(buf16);
    const buf24 = encodeWavPCM(rendered.channels, st.sampleRate, 24);
    const v24 = decodeWav(buf24);
    const ok = (v) => v.sampleRate === st.sampleRate
      && v.numChannels === st.numChannels
      && v.numFrames === st.numFrames;
    return {
      ok16: ok(v16), ok24: ok(v24),
      detail16: `${v16.sampleRate}/${v16.numChannels}/${v16.numFrames} vs ${st.sampleRate}/${st.numChannels}/${st.numFrames}`,
      detail24: `${v24.sampleRate}/${v24.numChannels}/${v24.numFrames}`,
      exportDuration: v16.numFrames / v16.sampleRate,
      uiDuration: st.duration,
    };
  },

  historyTest() {
    state.ops = [];
    state.markers = [];
    state.undoStack = [];
    state.redoStack = [];
    reprocess();
    pushHistory();
    state.ops.push(createOp('mute', 0.1, 0.2));
    reprocess();
    const afterAdd = state.ops.length;
    undo();
    const afterUndo = state.ops.length;
    const redoAvailable = state.redoStack.length === 1;
    redo();
    const afterRedo = state.ops.length;
    return {
      ok: afterAdd === 1 && afterUndo === 0 && redoAvailable && afterRedo === 1,
    };
  },
};

init();
