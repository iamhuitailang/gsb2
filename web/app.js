// 主应用: 状态管理、分析/处理/试听/导出/工程
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  files: new Map(), // path -> { file, peaks, noise, params, processResult, status }
  currentPath: null,
  commonParams: {
    strength: 0.5,
    smoothing: 0.6,
    protect_transient: true,
    protect_voice: true,
  },
  specRegion: null,
  projectPath: null,
  busy: false,
};

const wave = new WaveformView($('wave'), {
  selectable: true,
  onSelect: (s, e) => {
    $('region-start').value = s.toFixed(2);
    $('region-end').value = e.toFixed(2);
  },
});
const diffView = new WaveformView($('wave-diff'), { selectable: false });
const spectrum = new SpectrumView($('spectrum'));
const player = new ABPlayer();

const debounce = (fn, ms) => {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

function banner(kind, text) {
  const el = $('banner');
  if (!text) {
    el.className = 'banner hidden';
    el.textContent = '';
    return;
  }
  el.className = `banner ${kind}`;
  el.innerHTML = text;
}

// 语义化别名: 成功提示复用 info 配色
const bannerOk = (text) => banner('info', text);

function current() {
  return state.files.get(state.currentPath);
}

function defaultParams() {
  return { ...state.commonParams };
}

// 每个文件独立存一份参数; 未单独调过时继承公共默认值
function effectiveParams(entry) {
  return entry.params ? { ...entry.params } : defaultParams();
}

function syncParamControls(params) {
  const p = params || state.commonParams;
  $('p-strength').value = p.strength;
  $('p-smoothing').value = p.smoothing;
  $('p-transient').checked = p.protect_transient;
  $('p-voice').checked = p.protect_voice;
  $('val-strength').textContent = Number(p.strength).toFixed(2);
  $('val-smoothing').textContent = Number(p.smoothing).toFixed(2);
}

// --------------------------------------------------------------------------- //
// 文件载入
// --------------------------------------------------------------------------- //
async function addFileFromServer(path, select = true) {
  const data = await Api.load(path);
  state.files.set(path, {
    file: data.file,
    peaks: data.peaks,
    noise: null,
    params: null,
    processResult: null,
    status: null,
  });
  renderFileList();
  if (select) await selectFile(path);
}

async function handleUpload(fileList) {
  for (const f of fileList) {
    try {
      const b64 = await fileToBase64(f);
      const data = await Api.upload(f.name, b64);
      state.files.set(data.file.path, {
        file: data.file,
        peaks: data.peaks,
        noise: null,
        params: null,
        processResult: null,
        status: null,
      });
    } catch (err) {
      banner('danger', `上传 ${f.name} 失败: ${escapeHtml(err.message)}`);
    }
  }
  renderFileList();
  if (!state.currentPath && state.files.size) {
    await selectFile([...state.files.keys()][0]);
  }
}

async function loadSamples() {
  const data = await Api.listSamples();
  if (!data.samples) {
    banner('warn', data.hint || '样音尚未生成');
    return;
  }
  for (const s of data.samples) {
    if (!state.files.has(s.path)) await addFileFromServer(s.path, false);
  }
  renderFileList();
  const first = data.samples[0];
  if (first) {
    await selectFile(first.path);
    // 预填建议样本区间
    const [s, e] = first.suggested_sample;
    $('region-start').value = s.toFixed(2);
    $('region-end').value = e.toFixed(2);
    wave.setSelection(s, e);
  }
  banner('info', `已载入 ${data.samples.length} 个演示样音，建议先点「分析样本」`);
}

async function openDirectory() {
  const dir = prompt('输入本机音频目录的绝对路径（需在服务允许的目录内，如演示样音目录 tmp/uploads）：');
  if (!dir) return;
  try {
    const data = await Api.listDir(dir);
    if (!data.items.length) {
      banner('warn', '该目录下没有支持的音频文件');
      return;
    }
    for (const item of data.items) {
      if (!state.files.has(item.path)) await addFileFromServer(item.path, false);
    }
    renderFileList();
    await selectFile(data.items[0].path);
  } catch (err) {
    banner('danger', `打开目录失败: ${escapeHtml(err.message)}`);
  }
}

function renderFileList() {
  const ul = $('file-list');
  ul.innerHTML = '';
  for (const [path, entry] of state.files) {
    const li = document.createElement('li');
    if (path === state.currentPath) li.classList.add('active');
    const badge =
      entry.status === 'ok'
        ? '<span class="badge badge-ok">已导出</span>'
        : entry.status === 'error'
          ? '<span class="badge badge-err">失败</span>'
          : '';
    li.innerHTML = `<span class="fname">${escapeHtml(entry.file.name)}${badge}</span>
      <span class="fmeta">${entry.file.sr} Hz · ${entry.file.channels} 声道 · ${entry.file.duration.toFixed(1)}s
      ${entry.noise ? '· 已取样' : ''}</span>`;
    li.addEventListener('click', () => selectFile(path));
    ul.appendChild(li);
  }
}

async function selectFile(path) {
  state.currentPath = path;
  player.stop();
  const entry = current();
  wave.setDuration(entry.file.duration);
  wave.setPeaks(entry.peaks);
  wave.setPlayhead(0);
  wave.selection = null;
  diffView.setDuration(entry.file.duration);
  diffView.setMultiTracks([
    { min: entry.peaks.min, max: entry.peaks.max, color: '--wave', label: '原声' },
  ]);
  spectrum.setData(null);
  $('play-time').textContent = `0.00 / ${entry.file.duration.toFixed(2)} s`;
  $('sample-stats').textContent = entry.noise
    ? `已分析样本: ${entry.noise.region.start.toFixed(2)}–${entry.noise.region.end.toFixed(2)}s`
    : '';
  syncParamControls(effectiveParams(entry));
  banner('');
  // 载入原声缓冲
  const res = await fetch(Api.audioUrl(path));
  await player.setOriginal(await res.arrayBuffer());
  if (entry.processResult) {
    await player.setProcessed(hexToWav(entry.processResult.wav_b64));
    applyProcessViews(entry);
  } else if (entry.noise) {
    // 应用到全部后该文件结果被置空, 切过来时自动按其参数重算
    await reprocess();
  }
  renderFileList();
}

// --------------------------------------------------------------------------- //
// 噪声样本分析
// --------------------------------------------------------------------------- //
async function analyzeSegment() {
  const entry = current();
  const start = parseFloat($('region-start').value);
  const end = parseFloat($('region-end').value);
  if (!(end > start)) return banner('danger', '样本区间无效: 结束时间必须大于开始时间');
  try {
    const noise = await Api.analyze(entry.file.path, start, end);
    entry.noise = noise;
    const warnClass = noise.speech_suspected ? 'danger' : 'good';
    $('sample-stats').innerHTML =
      `<span class="${warnClass}">` +
      (noise.speech_suspected ? '⚠ 疑似含语音/瞬态！' : '✓ 样本以稳态噪声为主') +
      `</span> 平坦度 ${noise.flatness} · 波峰因子 ${noise.crest} · 时长 ${noise.duration}s` +
      (noise.warnings.length ? `<br><span class="warn">${noise.warnings.map(escapeHtml).join('<br>')}</span>` : '');
    banner(
      noise.speech_suspected ? 'danger' : 'info',
      noise.speech_suspected
        ? '噪声样本里检测到疑似语音或敲击，用它估计噪声会削弱目标声音，建议重选纯底噪区间。'
        : '噪声轮廓已建立，调整强度即可实时预览。',
    );
    renderFileList();
    await reprocess();
  } catch (err) {
    banner('danger', `分析失败: ${escapeHtml(err.message)}`);
  }
}

// --------------------------------------------------------------------------- //
// 处理
// --------------------------------------------------------------------------- //
async function reprocess() {
  const entry = current();
  if (!entry || !entry.noise) return;
  const params = {
    ...effectiveParams(entry),
    n_fft: entry.noise.n_fft,
    region_start: entry.noise.region.start,
    region_end: entry.noise.region.end,
  };
  state.busy = true;
  try {
    const result = await Api.process(entry.file.path, entry.noise, params);
    entry.processResult = result;
    entry.lastParams = params;
    await player.setProcessed(hexToWav(result.wav_b64));
    applyProcessViews(entry);
  } catch (err) {
    banner('danger', `处理失败: ${escapeHtml(err.message)}`);
  } finally {
    state.busy = false;
  }
}

function applyProcessViews(entry) {
  const r = entry.processResult;
  diffView.setMultiTracks([
    { min: entry.peaks.min, max: entry.peaks.max, color: '--wave', label: '原声' },
    { min: r.peaks.min, max: r.peaks.max, color: '--accent-2', label: '处理后' },
    { min: r.diff_peaks.min, max: r.diff_peaks.max, color: '--wave-diff', label: '移除成分' },
  ]);
  $('diff-stats').innerHTML =
    `原声 RMS ${r.metrics.rms_before_db} dB → 处理后 ${r.metrics.rms_after_db} dB · ` +
    `移除成分 RMS ${r.diff_rms_db} dB`;
  refreshSpectrum();
}

const reprocessDebounced = debounce(() => reprocess(), 280);

function onParamChange() {
  const entry = current();
  if (!entry) return;
  // 滑块只改当前文件, 实现逐条微调; 「应用到全部」负责广播
  entry.params = {
    strength: parseFloat($('p-strength').value),
    smoothing: parseFloat($('p-smoothing').value),
    protect_transient: $('p-transient').checked,
    protect_voice: $('p-voice').checked,
  };
  $('val-strength').textContent = entry.params.strength.toFixed(2);
  $('val-smoothing').textContent = entry.params.smoothing.toFixed(2);
  reprocessDebounced();
}

// --------------------------------------------------------------------------- //
// 频谱
// --------------------------------------------------------------------------- //
async function refreshSpectrum() {
  const entry = current();
  if (!entry) return;
  let start = parseFloat($('spec-start').value);
  let end = parseFloat($('spec-end').value);
  if (!(end > start) || end > entry.file.duration) {
    start = 0;
    end = entry.file.duration;
    $('spec-start').value = '0';
    $('spec-end').value = end.toFixed(2);
  }
  state.specRegion = { start, end };
  try {
    const data = await Api.spectrum({
      path: entry.file.path,
      start,
      end,
      n_fft: entry.noise ? entry.noise.n_fft : null,
      noise: entry.noise || null,
      params: entry.lastParams || null,
    });
    spectrum.setData(data.freqs, data.before, data.after);
  } catch (err) {
    banner('danger', `频谱计算失败: ${escapeHtml(err.message)}`);
  }
}

// --------------------------------------------------------------------------- //
// 批量
// --------------------------------------------------------------------------- //
async function applyToAll() {
  const cur = current();
  if (!cur) return;
  const params = effectiveParams(cur);
  state.commonParams = { ...params };
  for (const [, entry] of state.files) {
    entry.params = { ...params }; // 广播同一份设置, 之后仍可逐条微调
  }
  banner('info', '当前参数已应用到全部文件；之后在单个文件上调整不会影响其他文件。');
  for (const [, entry] of state.files) {
    if (entry.noise) entry.processResult = null; // 强制下次重新计算
  }
  await reprocess();
}

async function batchExport() {
  const jobs = [];
  const skipped = [];
  for (const [, entry] of state.files) {
    if (!entry.noise) {
      skipped.push(entry.file.name);
      continue;
    }
    const params = {
      ...effectiveParams(entry),
      n_fft: entry.noise.n_fft,
      region_start: entry.noise.region.start,
      region_end: entry.noise.region.end,
    };
    jobs.push({ path: entry.file.path, noise: entry.noise, params });
  }
  if (!jobs.length) return banner('warn', '没有可导出的文件：请先为文件选取并分析噪声样本');
  const outDir = $('out-dir').value.trim() || null;
  try {
    const data = await Api.batch(jobs, outDir);
    for (const r of data.results) {
      for (const [, entry] of state.files) {
        if (entry.file.name === r.file) entry.status = r.status;
      }
    }
    renderFileList();
    const summary = $('batch-summary');
    summary.classList.remove('hidden');
    summary.innerHTML =
      `导出完成: 成功 ${data.ok} / 失败 ${data.failed}，目录 <code>${escapeHtml(data.out_dir)}</code>` +
      (skipped.length ? `<br>跳过(未取样): ${skipped.map(escapeHtml).join(', ')}` : '');
    logExports(data.results);
    if (data.failed > 0) {
      banner('danger', '部分文件失败，其余文件已正常导出（详见下方日志），原件均未改动。');
    } else {
      bannerOk('批量导出完成，原始录音未被修改。');
    }
  } catch (err) {
    banner('danger', `批量导出失败: ${escapeHtml(err.message)}`);
  }
}

async function exportOne() {
  const entry = current();
  if (!entry || !entry.noise) return banner('warn', '请先分析噪声样本');
  if (!entry.lastParams) return banner('warn', '处理结果尚未生成，请稍候或调整一次参数');
  const outDir = $('out-dir').value.trim() || null;
  try {
    const data = await Api.batch(
      [{ path: entry.file.path, noise: entry.noise, params: entry.lastParams }],
      outDir,
    );
    const r = data.results[0];
    entry.status = r.status;
    renderFileList();
    logExports(data.results);
    if (r.status === 'ok') {
      const link = $('download-link');
      link.href = Api.downloadUrl(r.outputs.wav);
      link.download = r.outputs.wav.split('/').pop();
      link.classList.remove('hidden');
      banner('info', `已导出: ${escapeHtml(r.outputs.wav)}，原件未修改。`);
    } else {
      banner('danger', `导出失败: ${escapeHtml(r.error)}`);
    }
  } catch (err) {
    banner('danger', `导出失败: ${escapeHtml(err.message)}`);
  }
}

function logExports(results) {
  const ul = $('export-log');
  for (const r of results) {
    const li = document.createElement('li');
    if (r.status === 'ok') {
      li.innerHTML = `<span class="ok">✓ ${escapeHtml(r.file)}</span>
        → <code>${escapeHtml(r.outputs.wav)}</code><br>
        参数记录: <code>${escapeHtml(r.outputs.record)}</code>`;
    } else {
      li.innerHTML = `<span class="err">✗ ${escapeHtml(r.file)}: ${escapeHtml(r.error)}</span>`;
    }
    ul.prepend(li);
  }
}

// --------------------------------------------------------------------------- //
// 工程
// --------------------------------------------------------------------------- //
function collectProject() {
  const files = [...state.files.values()].map((e) => e.file);
  const sampleRegions = {};
  const perFileParams = {};
  for (const [path, entry] of state.files) {
    if (entry.noise) sampleRegions[path] = entry.noise.region;
    if (entry.params) perFileParams[path] = entry.params;
  }
  return {
    commonParams: state.commonParams,
    files,
    sample_regions: sampleRegions,
    per_file_params: perFileParams,
  };
}
async function saveProject() {
  const defaultName = state.projectPath || `noisekit_project_${new Date().toISOString().slice(0, 10)}.nkproj`;
  const path = prompt('保存工程到（绝对路径，.nkproj；同名会自动加序号，不覆盖）：', defaultName);
  if (!path) return;
  try {
    const data = await Api.saveProject(path, buildProjectPayload());
    state.projectPath = data.path;
    banner('info', `工程已保存: ${escapeHtml(data.path)}`);
  } catch (err) {
    banner('danger', `保存工程失败: ${escapeHtml(err.message)}`);
  }
}

function buildProjectPayload() {
  const p = collectProject();
  return {
    format: 'noisekit-project',
    project_version: 1,
    app_version: '1.0.0',
    algo_version: 1,
    common_params: p.commonParams,
    files: p.files,
    sample_regions: p.sample_regions,
    per_file_params: p.per_file_params,
    exports: [],
  };
}

async function openProjectFile(file) {
  // 浏览器拿不到绝对路径, 先上传到 tmp 再让后端读
  const b64 = await fileToBase64(file);
  const up = await Api.upload(file.name, b64);
  const data = await Api.loadProject(up.file.path);
  const project = data.project;
  state.files.clear();
  for (const f of project.files) {
    try {
      await addFileFromServer(f.path, false);
      const entry = state.files.get(f.path);
      const region = project.sample_regions[f.path];
      if (region) {
        entry.noise = await Api.analyze(f.path, region.start, region.end);
      }
      if (project.per_file_params[f.path]) {
        entry.params = project.per_file_params[f.path];
      }
    } catch (err) {
      banner('danger', `工程中的文件无法载入: ${escapeHtml(f.name)} — ${escapeHtml(err.message)}`);
    }
  }
  Object.assign(state.commonParams, project.common_params || {});
  if (project.per_file_params) {
    for (const [path, params] of Object.entries(project.per_file_params)) {
      const entry = state.files.get(path);
      if (entry) entry.params = params;
    }
  }
  renderFileList();
  const firstOk = [...state.files.keys()][0];
  const firstEntry = state.files.get(firstOk);
  syncParamControls(firstEntry ? effectiveParams(firstEntry) : state.commonParams);
  if (firstOk) await selectFile(firstOk);
  const notes = [];
  if (data.missing.length) notes.push(`缺失: ${data.missing.join(', ')}`);
  if (data.changed.length) notes.push(`内容已变化(sha256 不符): ${data.changed.join(', ')}`);
  banner(notes.length ? 'warn' : 'info', notes.length ? notes.join('；') : '工程已恢复，样本区间已重新分析。');
}

// --------------------------------------------------------------------------- //
// 小工具
// --------------------------------------------------------------------------- //
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --------------------------------------------------------------------------- //
// 事件绑定
// --------------------------------------------------------------------------- //
function bind() {
  $('btn-samples').addEventListener('click', loadSamples);
  $('btn-upload').addEventListener('click', () => $('file-upload').click());
  $('file-upload').addEventListener('change', (e) => {
    handleUpload(e.target.files);
    e.target.value = '';
  });
  $('btn-open-dir').addEventListener('click', openDirectory);
  $('btn-analyze').addEventListener('click', analyzeSegment);
  $('btn-spec-refresh').addEventListener('click', refreshSpectrum);

  for (const id of ['p-strength', 'p-smoothing', 'p-transient', 'p-voice']) {
    $(id).addEventListener('input', onParamChange);
  }

  $('btn-play').addEventListener('click', () => {
    if (player.playing) {
      player.stop();
      $('btn-play').textContent = '播放';
    } else {
      player.play();
      $('btn-play').textContent = '暂停';
    }
  });
  $('btn-stop').addEventListener('click', () => {
    player.stop();
    player.seek(0);
    $('btn-play').textContent = '播放';
  });  player.onTime = (t) => {
    const entry = current();
    if (!entry) return;
    wave.setPlayhead(t);
    $('play-time').textContent = `${t.toFixed(2)} / ${entry.file.duration.toFixed(2)} s`;
  };
  player.onEnded = () => {
    $('btn-play').textContent = '播放';
    wave.setPlayhead(0);
  };

  // 按住 A / 松开回 B
  const ab = $('btn-ab');
  const setA = (on) => {
    player.switchTo(on ? 'A' : 'B');
    ab.classList.toggle('listening', on);
    ab.textContent = on ? '正在听原声 (A)，松开返回' : '按住试听原声 (A)';
    $('ab-mode').textContent = on ? '当前: 原声 (A)' : '当前: 处理后 (B)';
  };
  ab.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ab.setPointerCapture(e.pointerId);
    setA(true);
  });
  ab.addEventListener('pointerup', () => setA(false));
  ab.addEventListener('pointercancel', () => setA(false));

  // 键盘快捷键: 空格播放/暂停, A 键切换
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      $('btn-play').click();
    } else if (e.key.toLowerCase() === 'a') {
      setA(true);
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key.toLowerCase() === 'a') setA(false);
  });

  $('btn-apply-all').addEventListener('click', applyToAll);
  $('btn-batch-export').addEventListener('click', batchExport);
  $('btn-export-one').addEventListener('click', exportOne);
  $('btn-save-project').addEventListener('click', saveProject);
  $('btn-load-project').addEventListener('click', () => $('file-project').click());
  $('file-project').addEventListener('change', (e) => {
    if (e.target.files[0]) openProjectFile(e.target.files[0]);
    e.target.value = '';
  });

  // 区间数字输入同步到画布
  $('region-start').addEventListener('change', syncRegionInputs);
  $('region-end').addEventListener('change', syncRegionInputs);
  function syncRegionInputs() {
    const s = parseFloat($('region-start').value);
    const e = parseFloat($('region-end').value);
    if (e > s) wave.setSelection(s, e);
  }
}

bind();
banner('info', '请先「上传录音」或「载入演示样音」，然后在波形上拖选噪声样本区间。');
