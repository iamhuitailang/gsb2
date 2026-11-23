// SFX Browser 前端：扫描、试听、循环点、标签、筛选、对比、项目保存
const $ = (id) => document.getElementById(id);

// ---------- 全局状态 ----------
const state = {
  root: null,
  assets: [],            // 每个元素: {path,name,format,duration,channels,sampleRate,sizeBytes,error,tags[],loopStart,loopEnd}
  tagGroups: [],         // [{id,name}]
  tags: [],              // [{name,groupId}]
  selected: new Set(),   // 勾选的素材 path
  current: null,         // 当前试听素材 path
  filter: { keyword: '', tags: new Set(), durMin: null, durMax: null },
  projectFile: '',
};

// ---------- 音频播放 ----------
let audioCtx = null;
const bufferCache = new Map(); // path -> AudioBuffer
const peaksCache = new Map();  // path -> {peaks: Float32Array, duration}
let playback = null;           // {source, startAt, offset, loop, raf}

function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

async function loadBuffer(asset) {
  if (bufferCache.has(asset.path)) return bufferCache.get(asset.path);
  const url = `/api/audio?root=${encodeURIComponent(state.root)}&path=${encodeURIComponent(asset.path)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`读取音频失败: ${resp.status}`);
  const buf = await ctx().decodeAudioData(await resp.arrayBuffer());
  bufferCache.set(asset.path, buf);
  return buf;
}

function computePeaks(buffer, buckets = 800) {
  const cached = peaksCache.get(buffer);
  if (cached) return cached;
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const peaks = new Float32Array(buckets);
  const per = Math.max(1, Math.floor(buffer.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const start = b * per, end = Math.min(buffer.length, start + per);
    for (const data of chans) {
      for (let i = start; i < end; i += 4) {
        const v = Math.abs(data[i]);
        if (v > max) max = v;
      }
    }
    peaks[b] = max;
  }
  const result = { peaks, duration: buffer.duration };
  peaksCache.set(buffer, result);
  return result;
}

function stopPlayback() {
  if (playback) {
    cancelAnimationFrame(playback.raf);
    try { playback.source.stop(); } catch {}
    playback = null;
  }
  $('btnPlay').textContent = '▶ 播放';
}

function playCurrent({ loop = false, trimOnly = false, from = null } = {}) {
  const asset = currentAsset();
  if (!asset) return;
  stopPlayback();
  loadBuffer(asset).then((buffer) => {
    const ac = ctx();
    const source = ac.createBufferSource();
    source.buffer = buffer;
    source.connect(ac.destination);
    const hasLoop = asset.loopStart != null && asset.loopEnd != null && asset.loopEnd > asset.loopStart;
    let offset = from ?? 0;
    let dur;
    if (trimOnly && hasLoop) {
      offset = asset.loopStart;
      dur = asset.loopEnd - asset.loopStart;
    } else if (loop && hasLoop) {
      source.loop = true;
      source.loopStart = asset.loopStart;
      source.loopEnd = asset.loopEnd;
      if (offset >= asset.loopEnd || offset < asset.loopStart) offset = asset.loopStart;
    }
    const startAt = ac.currentTime;
    source.start(0, offset, dur);
    source.onended = () => { if (playback && playback.source === source && !source.loop) stopPlayback(); };
    playback = { source, startAt, offset, buffer, raf: 0 };
    $('btnPlay').textContent = '❚❚ 播放中';
    tickPlayhead();
  }).catch((e) => alert(e.message));
}

function tickPlayhead() {
  if (!playback) return;
  const draw = () => {
    if (!playback) return;
    const ac = ctx();
    let pos = playback.offset + (ac.currentTime - playback.startAt);
    const asset = currentAsset();
    if (playback.source.loop && asset?.loopStart != null && asset?.loopEnd != null) {
      const len = asset.loopEnd - asset.loopStart;
      if (pos > asset.loopEnd) pos = asset.loopStart + ((pos - asset.loopStart) % len);
    } else if (pos > playback.buffer.duration) {
      stopPlayback(); drawWaveform(); return;
    }
    drawWaveform(pos);
    playback.raf = requestAnimationFrame(draw);
  };
  playback.raf = requestAnimationFrame(draw);
}

// ---------- 波形绘制 ----------
function drawWaveform(playheadPos = null, canvas = $('waveCanvas'), asset = currentAsset()) {
  if (!canvas || !asset) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
  if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  const entry = [...bufferCache.entries()].find(([p]) => p === asset.path);
  if (!entry) {
    g.fillStyle = asset.error ? '#ff6b6b' : '#8a919c';
    g.font = `${12 * dpr}px sans-serif`;
    g.fillText(asset.error ? `无法解码: ${asset.error}` : '加载中…', 10 * dpr, h / 2);
    return;
  }
  const { peaks, duration } = computePeaks(entry[1]);

  // 循环区域底色
  if (asset.loopStart != null && asset.loopEnd != null && duration > 0) {
    const x1 = (asset.loopStart / duration) * w, x2 = (asset.loopEnd / duration) * w;
    g.fillStyle = 'rgba(77,163,255,0.18)';
    g.fillRect(x1, 0, x2 - x1, h);
  }
  // 波形
  g.fillStyle = '#4da3ff';
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const p = peaks[Math.floor((x / w) * peaks.length)] || 0;
    const bh = Math.max(1, p * h * 0.92);
    g.fillRect(x, mid - bh / 2, 1, bh);
  }
  // 循环标记
  if (asset.loopStart != null && duration > 0) drawMarker(g, (asset.loopStart / duration) * w, h, '#ffb84d', dpr);
  if (asset.loopEnd != null && duration > 0) drawMarker(g, (asset.loopEnd / duration) * w, h, '#ff6b6b', dpr);
  // 播放头
  if (playheadPos != null && duration > 0) {
    const x = (playheadPos / duration) * w;
    g.fillStyle = '#ffffff';
    g.fillRect(x, 0, Math.max(1, dpr), h);
  }
}

function drawMarker(g, x, h, color, dpr) {
  g.fillStyle = color;
  g.fillRect(x - dpr, 0, 2 * dpr, h);
  g.beginPath();
  g.moveTo(x - 5 * dpr, 0); g.lineTo(x + 5 * dpr, 0); g.lineTo(x, 8 * dpr); g.closePath();
  g.fill();
}

// ---------- API ----------
async function api(path, opts = {}) {
  const resp = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `请求失败 ${resp.status}`);
  return data;
}

async function scan(dir) {
  const { root, assets } = await api('/api/scan', { method: 'POST', body: JSON.stringify({ dir }) });
  // 合并：保留已有素材的标签与循环点（按相对路径匹配）
  const old = new Map(state.assets.map((a) => [a.path, a]));
  state.root = root;
  state.assets = assets.map((a) => {
    const prev = old.get(a.path);
    return { ...a, tags: prev?.tags || [], loopStart: prev?.loopStart ?? null, loopEnd: prev?.loopEnd ?? null };
  });
  state.selected.clear();
  state.current = null;
  renderAll();
  const errs = state.assets.filter((a) => a.error).length;
  setStatus(`已索引 ${state.assets.length} 个文件` + (errs ? `，${errs} 个解析失败（已跳过，不影响其他文件）` : ''));
}

async function saveProject() {
  const project = { version: 1, root: state.root, assets: state.assets, tagGroups: state.tagGroups, tags: state.tags };
  const { projectFile } = await api('/api/project', { method: 'POST', body: JSON.stringify({ project }) });
  state.projectFile = projectFile;
  setStatus(`已保存 ✓`);
  renderProjectInfo();
}

async function exportManifest(format) {
  const project = { version: 1, root: state.root, assets: state.assets, tagGroups: state.tagGroups, tags: state.tags };
  const resp = await fetch(`/api/export?format=${format}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }),
  });
  if (!resp.ok) return alert('导出失败');
  const blob = await resp.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = format === 'csv' ? 'sfx-manifest.csv' : 'sfx-manifest.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- 标签 ----------
let groupSeq = 1;
function addGroup(name) {
  const id = 'g' + Date.now().toString(36) + (groupSeq++);
  state.tagGroups.push({ id, name });
  return id;
}
function addTag(name, groupId) {
  if (state.tags.some((t) => t.name === name)) return false;
  state.tags.push({ name, groupId });
  return true;
}
function renameTag(oldName, newName) {
  const tag = state.tags.find((t) => t.name === oldName);
  if (!tag || state.tags.some((t) => t.name === newName)) return false;
  tag.name = newName;
  // 同步更新所有素材上的引用
  for (const a of state.assets) {
    const i = a.tags.indexOf(oldName);
    if (i >= 0) a.tags[i] = newName;
  }
  if (state.filter.tags.delete(oldName)) state.filter.tags.add(newName);
  return true;
}
function deleteTag(name) {
  state.tags = state.tags.filter((t) => t.name !== name);
  for (const a of state.assets) a.tags = a.tags.filter((t) => t !== name);
  state.filter.tags.delete(name);
}
function tagGroupName(groupId) {
  return state.tagGroups.find((g) => g.id === groupId)?.name || '未分组';
}

// ---------- 筛选 ----------
function filteredAssets() {
  const { keyword, tags, durMin, durMax } = state.filter;
  const kw = keyword.trim().toLowerCase();
  return state.assets.filter((a) => {
    if (kw && !a.name.toLowerCase().includes(kw) && !a.tags.some((t) => t.toLowerCase().includes(kw))) return false;
    if (tags.size && ![...tags].every((t) => a.tags.includes(t))) return false;
    if (durMin != null && (a.duration == null || a.duration < durMin)) return false;
    if (durMax != null && (a.duration == null || a.duration > durMax)) return false;
    return true;
  });
}

// ---------- 渲染 ----------
function fmtDur(d) { return d == null ? '—' : d.toFixed(2) + 's'; }
function fmtLoop(a) {
  return a.loopStart != null && a.loopEnd != null ? `${a.loopStart.toFixed(2)}~${a.loopEnd.toFixed(2)}` : '';
}

function renderTable() {
  const rows = filteredAssets();
  const tbody = $('assetTbody');
  tbody.innerHTML = '';
  for (const a of rows) {
    const tr = document.createElement('tr');
    if (a.path === state.current) tr.classList.add('current');
    const tagsHtml = a.tags.map((t) => `<span class="tag-chip">${esc(t)}</span>`).join('');
    tr.innerHTML = `
      <td><input type="checkbox" data-path="${esc(a.path)}" ${state.selected.has(a.path) ? 'checked' : ''}></td>
      <td>${esc(a.name)}${a.error ? `<div class="err">${esc(a.error)}</div>` : ''}</td>
      <td>${esc(a.format || '—')}</td><td>${fmtDur(a.duration)}</td>
      <td>${a.channels ?? '—'}</td><td>${a.sampleRate ? a.sampleRate + ' Hz' : '—'}</td>
      <td class="tags-cell">${tagsHtml}</td>
      <td class="loop-badge">${fmtLoop(a)}</td>`;
    tr.addEventListener('click', (e) => {
      if (e.target.type === 'checkbox') return;
      selectAsset(a.path);
    });
    tr.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
      e.target.checked ? state.selected.add(a.path) : state.selected.delete(a.path);
      renderBatchBar();
    });
    tbody.appendChild(tr);
  }
  $('listSummary').textContent = `显示 ${rows.length} / ${state.assets.length} 个素材`;
}

function renderTagFilter() {
  const box = $('tagFilter');
  box.innerHTML = '';
  for (const group of groupView()) {
    const div = document.createElement('div');
    div.className = 'tag-group';
    div.innerHTML = `<div class="tag-group-name">${esc(group.name)}</div>`;
    for (const tag of group.tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip' + (state.filter.tags.has(tag.name) ? ' on' : '');
      chip.textContent = tag.name;
      chip.onclick = () => {
        state.filter.tags.has(tag.name) ? state.filter.tags.delete(tag.name) : state.filter.tags.add(tag.name);
        renderTagFilter(); renderTable();
      };
      div.appendChild(chip);
    }
    box.appendChild(div);
  }
}

function renderTagManager() {
  const box = $('tagManager');
  box.innerHTML = '';
  for (const group of groupView()) {
    const div = document.createElement('div');
    div.className = 'tag-group';
    const head = document.createElement('div');
    head.className = 'tag-group-name';
    head.innerHTML = `<span>${esc(group.name)}</span>`;
    const addBtn = document.createElement('button');
    addBtn.textContent = '＋标签';
    addBtn.onclick = () => {
      const name = prompt(`在「${group.name}」下新建标签:`);
      if (!name?.trim()) return;
      if (!addTag(name.trim(), group.id)) alert('标签已存在');
      renderAll();
    };
    head.appendChild(addBtn);
    div.appendChild(head);
    for (const tag of group.tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.innerHTML = `${esc(tag.name)} <span class="edit" title="重命名">✎</span> <span class="x" title="删除">×</span>`;
      chip.querySelector('.edit').onclick = () => {
        const name = prompt('重命名标签（所有引用该标签的素材会同步更新）:', tag.name);
        if (!name?.trim() || name.trim() === tag.name) return;
        if (!renameTag(tag.name, name.trim())) alert('重命名失败：名称已存在');
        renderAll();
      };
      chip.querySelector('.x').onclick = () => {
        if (confirm(`删除标签「${tag.name}」？所有素材上的该标签会被移除。`)) {
          deleteTag(tag.name); renderAll();
        }
      };
      div.appendChild(chip);
    }
    box.appendChild(div);
  }
}

function groupView() {
  const groups = state.tagGroups.map((g) => ({ ...g, tags: state.tags.filter((t) => t.groupId === g.id) }));
  const ungrouped = state.tags.filter((t) => !state.tagGroups.some((g) => g.id === t.groupId));
  if (ungrouped.length) groups.push({ id: null, name: '未分组', tags: ungrouped });
  return groups;
}

function renderBatchBar() {
  const n = state.selected.size;
  $('batchBar').classList.toggle('hidden', n === 0);
  $('batchCount').textContent = `已选 ${n} 个`;
  const sel = $('batchTag');
  sel.innerHTML = '';
  for (const group of groupView()) {
    const og = document.createElement('optgroup');
    og.label = group.name;
    for (const t of group.tags) {
      const opt = document.createElement('option');
      opt.value = t.name; opt.textContent = t.name;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
}

function renderDetail() {
  const a = currentAsset();
  $('detailTitle').textContent = a ? a.name : '未选择素材';
  $('detailMeta').textContent = a
    ? [a.format, fmtDur(a.duration), a.channels ? a.channels + ' 声道' : null, a.sampleRate ? a.sampleRate + ' Hz' : null, a.error].filter(Boolean).join(' · ')
    : '';
  $('loopStart').value = a?.loopStart ?? '';
  $('loopEnd').value = a?.loopEnd ?? '';
  $('btnLoop').classList.toggle('active', false);
  const box = $('assetTags');
  box.innerHTML = '';
  if (a) {
    for (const t of a.tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.innerHTML = `${esc(t)} <span class="x">×</span>`;
      chip.querySelector('.x').onclick = () => { a.tags = a.tags.filter((x) => x !== t); renderAll(); };
      box.appendChild(chip);
    }
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">＋ 添加标签…</option>' +
      state.tags.filter((t) => !a.tags.includes(t.name))
        .map((t) => `<option value="${esc(t.name)}">${esc(tagGroupName(t.groupId))} / ${esc(t.name)}</option>`).join('');
    sel.onchange = () => { if (sel.value) { a.tags.push(sel.value); renderAll(); } };
    box.appendChild(sel);
  }
  drawWaveform();
}

function renderProjectInfo() {
  $('projectInfo').textContent = state.projectFile ? `索引文件: ${state.projectFile}` : '';
}

function renderAll() {
  renderTable(); renderTagFilter(); renderTagManager(); renderBatchBar(); renderDetail(); renderProjectInfo();
}

function setStatus(msg) {
  $('saveStatus').textContent = msg;
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => { $('saveStatus').textContent = ''; }, 6000);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 选择与试听 ----------
function currentAsset() { return state.assets.find((a) => a.path === state.current) || null; }

async function selectAsset(path) {
  stopPlayback();
  state.current = path;
  renderTable(); renderDetail();
  const a = currentAsset();
  if (a && !a.error) {
    try { await loadBuffer(a); drawWaveform(); }
    catch (e) { a.error = e.message; renderTable(); renderDetail(); }
  }
}

// 波形交互：点击定位播放头，拖动循环标记
function setupWaveform() {
  const canvas = $('waveCanvas');
  let dragTarget = null; // 'start' | 'end'
  const posOf = (e) => {
    const rect = canvas.getBoundingClientRect();
    const a = currentAsset();
    const buf = a && bufferCache.get(a.path);
    if (!buf) return null;
    return Math.max(0, Math.min(buf.duration, ((e.clientX - rect.left) / rect.width) * buf.duration));
  };
  const hitMarker = (t) => {
    const a = currentAsset();
    const buf = a && bufferCache.get(a.path);
    if (!a || !buf) return null;
    const tol = buf.duration * 0.02;
    if (a.loopStart != null && Math.abs(t - a.loopStart) < tol) return 'start';
    if (a.loopEnd != null && Math.abs(t - a.loopEnd) < tol) return 'end';
    return null;
  };
  canvas.addEventListener('pointerdown', (e) => {
    const t = posOf(e);
    if (t == null) return;
    dragTarget = hitMarker(t);
    if (dragTarget) {
      canvas.setPointerCapture(e.pointerId);
    } else {
      // 点击定位并从该处播放
      playCurrent({ from: t, loop: $('btnLoop').classList.contains('active') });
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragTarget) return;
    const t = posOf(e);
    const a = currentAsset();
    if (t == null || !a) return;
    if (dragTarget === 'start') a.loopStart = Math.min(t, a.loopEnd ?? t);
    else a.loopEnd = Math.max(t, a.loopStart ?? 0);
    $('loopStart').value = a.loopStart?.toFixed(3) ?? '';
    $('loopEnd').value = a.loopEnd?.toFixed(3) ?? '';
    drawWaveform();
  });
  canvas.addEventListener('pointerup', () => { dragTarget = null; renderTable(); });
  // 双击设置循环点
  canvas.addEventListener('dblclick', (e) => {
    const t = posOf(e);
    const a = currentAsset();
    if (t == null || !a) return;
    if (a.loopStart == null || (a.loopEnd != null && t > a.loopEnd)) a.loopStart = t;
    else a.loopEnd = t;
    if (a.loopEnd != null && a.loopEnd < a.loopStart) [a.loopStart, a.loopEnd] = [a.loopEnd, a.loopStart];
    renderDetail(); renderTable();
  });
}

// ---------- 对比视图 ----------
async function openCompare() {
  const list = [...state.selected].map((p) => state.assets.find((a) => a.path === p)).filter((a) => a && !a.error);
  if (!list.length) return alert('请先在列表中勾选可解析的素材');
  $('compareOverlay').classList.remove('hidden');
  const box = $('compareList');
  box.innerHTML = '';
  for (const a of list) {
    const item = document.createElement('div');
    item.className = 'compare-item';
    item.innerHTML = `<div><strong>${esc(a.name)}</strong></div>
      <div class="meta">${esc(a.format || '')} · ${fmtDur(a.duration)} · ${a.sampleRate ?? '—'} Hz · 循环: ${fmtLoop(a) || '未设置'} · 标签: ${a.tags.join(', ') || '无'}</div>
      <canvas></canvas>`;
    box.appendChild(item);
    try {
      await loadBuffer(a);
      drawWaveform(null, item.querySelector('canvas'), a);
    } catch { /* 单个失败不影响其他对比项 */ }
  }
}

// ---------- 事件绑定 ----------
function bind() {
  $('btnScan').onclick = () => scan($('scanDir').value.trim()).catch((e) => alert(e.message));
  $('btnSamples').onclick = () => scan('@samples').catch((e) => alert(e.message));
  $('scanDir').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnScan').click(); });
  $('btnSave').onclick = () => saveProject().catch((e) => alert(e.message));
  $('btnExportJson').onclick = () => exportManifest('json');
  $('btnExportCsv').onclick = () => exportManifest('csv');

  $('filterKeyword').oninput = (e) => { state.filter.keyword = e.target.value; renderTable(); };
  $('durMin').oninput = (e) => { state.filter.durMin = e.target.value === '' ? null : +e.target.value; renderTable(); };
  $('durMax').oninput = (e) => { state.filter.durMax = e.target.value === '' ? null : +e.target.value; renderTable(); };
  $('btnClearFilter').onclick = () => {
    state.filter = { keyword: '', tags: new Set(), durMin: null, durMax: null };
    $('filterKeyword').value = ''; $('durMin').value = ''; $('durMax').value = '';
    renderTagFilter(); renderTable();
  };

  $('btnAddGroup').onclick = () => {
    const name = $('newGroupName').value.trim();
    if (!name) return;
    addGroup(name); $('newGroupName').value = '';
    renderAll();
  };

  $('checkAll').onchange = (e) => {
    state.selected.clear();
    if (e.target.checked) for (const a of filteredAssets()) state.selected.add(a.path);
    renderTable(); renderBatchBar();
  };
  $('btnClearSel').onclick = () => { state.selected.clear(); $('checkAll').checked = false; renderTable(); renderBatchBar(); };
  $('btnBatchAdd').onclick = () => {
    const tag = $('batchTag').value;
    if (!tag) return alert('请先选择标签');
    for (const p of state.selected) {
      const a = state.assets.find((x) => x.path === p);
      if (a && !a.tags.includes(tag)) a.tags.push(tag);
    }
    renderAll();
  };
  $('btnBatchRemove').onclick = () => {
    const tag = $('batchTag').value;
    if (!tag) return alert('请先选择标签');
    for (const p of state.selected) {
      const a = state.assets.find((x) => x.path === p);
      if (a) a.tags = a.tags.filter((t) => t !== tag);
    }
    renderAll();
  };
  $('btnCompare').onclick = openCompare;
  $('btnCloseCompare').onclick = () => $('compareOverlay').classList.add('hidden');

  $('btnPlay').onclick = () => playCurrent({ loop: $('btnLoop').classList.contains('active') });
  $('btnStop').onclick = () => { stopPlayback(); drawWaveform(); };
  $('btnLoop').onclick = (e) => {
    e.target.classList.toggle('active');
    if (playback) playCurrent({ loop: e.target.classList.contains('active') });
  };
  $('btnTrimPreview').onclick = () => playCurrent({ trimOnly: true });
  $('loopStart').onchange = (e) => {
    const a = currentAsset(); if (!a) return;
    a.loopStart = e.target.value === '' ? null : Math.max(0, +e.target.value);
    renderDetail(); renderTable();
  };
  $('loopEnd').onchange = (e) => {
    const a = currentAsset(); if (!a) return;
    a.loopEnd = e.target.value === '' ? null : Math.max(0, +e.target.value);
    renderDetail(); renderTable();
  };
  $('btnClearLoop').onclick = () => {
    const a = currentAsset(); if (!a) return;
    a.loopStart = a.loopEnd = null;
    renderDetail(); renderTable();
  };

  window.addEventListener('resize', () => drawWaveform());
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); playback ? (stopPlayback(), drawWaveform()) : $('btnPlay').click(); }
  });
}

// ---------- 启动 ----------
async function init() {
  bind();
  setupWaveform();
  try {
    const { project, projectFile } = await api('/api/project');
    state.projectFile = projectFile;
    if (project.root) {
      state.root = project.root;
      state.assets = (project.assets || []).map((a) => ({ tags: [], loopStart: null, loopEnd: null, ...a }));
      state.tagGroups = project.tagGroups || [];
      state.tags = project.tags || [];
      setStatus(`已载入项目（${state.assets.length} 个素材）`);
    }
  } catch { /* 首次启动没有项目文件 */ }
  renderAll();
}
init();
