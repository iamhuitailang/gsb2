/*
 * app.js — 应用主逻辑：状态、列表、搜索替换、撤销重做、持久化与事件装配
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'subtitle-qa-project-v1';

  // ---------------- 全局状态 ----------------
  const state = {
    cues: [],
    format: 'srt',
    fileName: '',
    selectedId: null,
    mode: 'ms',            // 'ms' | 'frame'
    fps: 25,
    durationSec: 0,
    videoName: '',
    ignoredOverlaps: new Set(),
    parseErrors: [],
    lastValidation: null,
  };
  let seqCounter = 0;
  const nextId = () => 'c' + (++seqCounter) + '_' + Date.now().toString(36);

  const textHistory = new History.HistoryStack('text');
  const timeHistory = new History.HistoryStack('time');
  textHistory.onChange = timeHistory.onChange = refreshHistoryButtons;

  let timeline = null;
  let searchRegex = null;
  let autosaveTimer = null;

  // ---------------- 通用工具 ----------------
  function getCue(id) { return state.cues.find((c) => c.id === id) || null; }
  function cueIndex(id) { return state.cues.findIndex((c) => c.id === id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveProject, 500);
  }

  // 历史恢复时统一应用变更（文字栈/时间栈共用）
  function applyHistoryChange(change, value) {
    if (change.prop === '__remove__') {
      state.cues.splice(change.index, 0, change.cue);
      return;
    }
    if (change.prop === '__add__') {
      const idx = state.cues.findIndex((c) => c.id === change.cueId);
      if (idx >= 0) state.cues.splice(idx, 1);
      return;
    }
    const cue = getCue(change.cueId);
    if (cue) cue[change.prop] = value;
  }

  // ---------------- 导入 ----------------
  function importText(text, filename) {
    const result = Parser.parse(text, filename);
    state.cues = result.cues;
    state.format = result.format;
    state.fileName = filename || ('subtitles.' + (result.format === 'vtt' ? 'vtt' : 'srt'));
    state.parseErrors = result.errors;
    state.ignoredOverlaps = new Set();
    state.selectedId = state.cues[0] ? state.cues[0].id : null;
    seqCounter = state.cues.length;
    textHistory.clear();
    timeHistory.clear();
    renderParseErrors();
    renderList();
    runValidation();
    updateStats();
    timeline.fit();
    scheduleAutosave();
  }

  function readFile(file) {
    const reader = new FileReader();
    reader.onload = () => importText(reader.result, file.name);
    reader.readAsText(file, 'utf-8');
  }

  function renderParseErrors() {
    const box = $('parse-errors');
    if (!state.parseErrors.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
    const errors = state.parseErrors.filter((e) => e.level === 'error');
    const warnings = state.parseErrors.filter((e) => e.level === 'warning');
    box.classList.remove('hidden');
    box.innerHTML =
      `<div class="pe-head">导入提示：${errors.length} 个错误，${warnings.length} 个警告（其余条目已正常导入，未影响字幕顺序与原文）</div>` +
      state.parseErrors.map((e) =>
        `<div class="pe-item pe-${e.level}"><b>第 ${e.line} 行</b> · ${esc(e.message)}</div>`).join('');
  }

  // ---------------- 文字/时间修改入口（负责写历史） ----------------
  function updateText(cue, newText) {
    if (cue.text === newText) return;
    // 连续输入合并：若栈顶是同一条目的文字修改，沿用它的 old（首次编辑前的值），
    // 否则撤销链会断成一串“空 -> 空”，无法一次撤销回原始文本
    const top = textHistory.undoStack[textHistory.undoStack.length - 1];
    if (top && top.changes.length === 1 && top.changes[0].cueId === cue.id &&
        top.changes[0].prop === 'text') {
      top.changes[0].new = newText;
      textHistory.redoStack = [];
      textHistory.onChange && textHistory.onChange(textHistory);
    } else {
      textHistory.push('文字修改', [{ cueId: cue.id, prop: 'text', old: cue.text, new: newText }]);
    }
    cue.text = newText;
    afterDataChanged();
  }

  function updateTime(cue, start, end, label) {
    const changes = [];
    if (cue.start !== start) changes.push({ cueId: cue.id, prop: 'start', old: cue.start, new: start });
    if (cue.end !== end) changes.push({ cueId: cue.id, prop: 'end', old: cue.end, new: end });
    if (!changes.length) return;
    timeHistory.push(label || '时间修改', changes);
    cue.start = start;
    cue.end = end;
    afterDataChanged();
  }

  // 时间轴拖拽过程中：直接改值不写历史，结束时由 commitDrag 一次性记录
  function dragTime(cue, start, end) {
    cue.start = start;
    cue.end = end;
    const row = $('list').querySelector(`[data-row="${cue.id}"]`);
    if (row) {
      row.querySelector('.t-start').value = Time.formatDisplay(start, state.mode, state.fps);
      row.querySelector('.t-end').value = Time.formatDisplay(end, state.mode, state.fps);
    }
    runValidation();
    timeline.draw();
    updateStats();
  }

  function commitDrag(cue, origStart, origEnd) {
    const changes = [];
    if (cue.start !== origStart) changes.push({ cueId: cue.id, prop: 'start', old: origStart, new: cue.start });
    if (cue.end !== origEnd) changes.push({ cueId: cue.id, prop: 'end', old: origEnd, new: cue.end });
    if (changes.length) {
      timeHistory.push('拖动时间轴', changes);
      refreshHistoryButtons();
      scheduleAutosave();
    }
  }

  function addCue(afterId) {
    const i = afterId ? cueIndex(afterId) : state.cues.length - 1;
    const ref = state.cues[i];
    const start = ref ? Math.min(ref.end + 100, Number.MAX_SAFE_INTEGER) : 0;
    const cue = {
      id: nextId(), start, end: start + 1000, text: '',
      settings: '', cueId: '', sourceLine: 0,
    };
    state.cues.splice(i + 1, 0, cue);
    textHistory.push('新增条目', [{ prop: '__add__', cueId: cue.id, index: i + 1 }]);
    state.selectedId = cue.id;
    afterDataChanged();
    renderList();
    scrollToRow(cue.id);
  }

  function deleteCue(id) {
    const i = cueIndex(id);
    if (i < 0) return;
    const cue = state.cues[i];
    textHistory.push('删除条目', [{ prop: '__remove__', cueId: id, index: i, cue }]);
    state.cues.splice(i, 1);
    if (state.selectedId === id) {
      state.selectedId = state.cues[Math.min(i, state.cues.length - 1)]?.id || null;
    }
    afterDataChanged();
    renderList();
  }

  function afterDataChanged() {
    runValidation();
    timeline.draw();
    updateStats();
    scheduleAutosave();
  }

  // ---------------- 撤销/重做 ----------------
  function doUndo(stack) {
    const entry = stack.undo(applyHistoryChange);
    if (!entry) return;
    state.selectedId = entry.changes[0].cueId || state.selectedId;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    afterDataChanged();
    renderList();
    scrollToRow(state.selectedId);
  }
  function doRedo(stack) {
    const entry = stack.redo(applyHistoryChange);
    if (!entry) return;
    state.selectedId = entry.changes[0].cueId || state.selectedId;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    afterDataChanged();
    renderList();
    scrollToRow(state.selectedId);
  }
  function refreshHistoryButtons() {
    $('undo-text').disabled = !textHistory.canUndo();
    $('redo-text').disabled = !textHistory.canRedo();
    $('undo-time').disabled = !timeHistory.canUndo();
    $('redo-time').disabled = !timeHistory.canRedo();
    $('undo-text').title = '撤销文字：' + (textHistory.nextUndoLabel() || '');
    $('undo-time').title = '撤销时间：' + (timeHistory.nextUndoLabel() || '');
  }

  // ---------------- 校验 ----------------
  function runValidation() {
    state.lastValidation = Validator.validate(
      state.cues, state.durationSec, state.ignoredOverlaps);
    renderIssueBadges();
    renderIssuePanel();
  }

  function renderIssueBadges() {
    const map = state.lastValidation ? state.lastValidation.byCue : new Map();
    document.querySelectorAll('#list .cue-row').forEach((row) => {
      const issues = map.get(row.dataset.row) || [];
      const badge = row.querySelector('.issue-badge');
      if (!issues.length) { badge.innerHTML = ''; badge.className = 'issue-badge'; return; }
      const hasErr = issues.some((i) => i.level === 'error');
      const hasWarn = issues.some((i) => i.level === 'warning');
      badge.className = 'issue-badge ' + (hasErr ? 'b-error' : hasWarn ? 'b-warn' : 'b-ignored');
      badge.textContent = issues.length;
      badge.title = issues.map((i) => '· ' + i.message).join('\n');
    });
  }

  function renderIssuePanel() {
    const panel = $('issue-panel');
    const v = state.lastValidation;
    if (!v || !v.issues.length) {
      panel.innerHTML = '<div class="issue-empty">未发现问题</div>';
      return;
    }
    panel.innerHTML =
      `<div class="issue-summary">错误 ${v.counts.error || 0} · 警告 ${v.counts.warning || 0} · 有意忽略 ${v.counts.ignored || 0}</div>` +
      v.issues.map((iss, n) => {
        const idxA = cueIndex(iss.cueId);
        if (idxA < 0) return ''; // 条目已删除（撤销栈中仍可能引用），不渲染
        const idxB = iss.otherCueId ? cueIndex(iss.otherCueId) : -1;
        const other = idxB >= 0 ? ` ↔ ${idxB + 1}` : '';
        const action = iss.type === 'overlap'
          ? `<button class="mini" data-issue-toggle="${esc(iss.key)}">${iss.ignored ? '取消忽略' : '标记有意重叠'}</button>`
          : '';
        return `<div class="issue-item is-${iss.level}">
          <span class="issue-no">#${idxA + 1}${other}</span>
          <span class="issue-msg">${esc(iss.message)}</span>${action}
          <button class="mini" data-issue-goto="${esc(iss.cueId)}">定位</button>
        </div>`;
      }).join('');
  }

  // ---------------- 列表渲染 ----------------
  function renderList() {
    const list = $('list');
    list.innerHTML = state.cues.map((cue, i) => {
      const issues = state.lastValidation ? (state.lastValidation.byCue.get(cue.id) || []) : [];
      const hasErr = issues.some((x) => x.level === 'error');
      const hasWarn = issues.some((x) => x.level === 'warning');
      const cls = cue.id === state.selectedId ? 'cue-row selected' : 'cue-row';
      const stateCls = hasErr ? ' row-error' : hasWarn ? 'row-warn' : '';
      return `<div class="${cls}${stateCls}" data-row="${cue.id}">
        <div class="row-head">
          <span class="seq">${i + 1}</span>
          <span class="issue-badge"></span>
          <span class="row-actions">
            <button class="mini" data-act="play">试听</button>
            <button class="mini" data-act="add">+ 新增</button>
            <button class="mini danger" data-act="del">删除</button>
          </span>
        </div>
        <div class="time-row">
          <input class="t-start" value="${esc(Time.formatDisplay(cue.start, state.mode, state.fps))}" spellcheck="false">
          <span class="arrow">→</span>
          <input class="t-end" value="${esc(Time.formatDisplay(cue.end, state.mode, state.fps))}" spellcheck="false">
          <span class="dur">${cue.end - cue.start} ms</span>
        </div>
        <textarea rows="2" spellcheck="false">${esc(cue.text)}</textarea>
      </div>`;
    }).join('');
    renderIssueBadges();
  }

  function refreshTimeInputs() {
    document.querySelectorAll('#list .cue-row').forEach((row) => {
      const cue = getCue(row.dataset.row);
      if (!cue) return;
      row.querySelector('.t-start').value = Time.formatDisplay(cue.start, state.mode, state.fps);
      row.querySelector('.t-end').value = Time.formatDisplay(cue.end, state.mode, state.fps);
      row.querySelector('.dur').textContent = (cue.end - cue.start) + ' ms';
    });
    $('mode-label').textContent = state.mode === 'frame' ? `帧模式（${state.fps} fps）` : '毫秒模式';
  }

  function scrollToRow(id) {
    const row = id && document.querySelector(`[data-row="${id}"]`);
    if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function selectCue(id, reveal) {
    state.selectedId = id;
    document.querySelectorAll('#list .cue-row').forEach((r) =>
      r.classList.toggle('selected', r.dataset.row === id));
    if (reveal) scrollToRow(id);
    timeline.draw();
  }

  // ---------------- 搜索替换 ----------------
  // 每次返回全新的正则实例，避免全局正则 lastIndex 在不同字幕间串状态
  function buildSearchRegex() {
    const q = $('search-input').value;
    if (!q) { searchRegex = null; return; }
    const flags = $('opt-case').checked ? 'g' : 'gi';
    try {
      const src = $('opt-regex').checked ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      searchRegex = new RegExp(src, flags);
      $('search-error').classList.add('hidden');
    } catch (err) {
      searchRegex = null;
      $('search-error').textContent = '正则表达式无效：' + err.message;
      $('search-error').classList.remove('hidden');
    }
  }

  function makeSearchRegex() {
    if (!searchRegex) return null;
    return new RegExp(searchRegex.source, searchRegex.flags);
  }

  // 统一的替换函数：正则模式支持 $1 等替换符号，字面模式按原文逐字替换
  function applyReplacement(text, replacement, isRegex) {
    const re = makeSearchRegex();
    if (!re) return text;
    return isRegex ? text.replace(re, replacement) : text.replace(re, () => replacement);
  }

  function previewSearch() {
    buildSearchRegex();
    const box = $('search-results');
    if (!searchRegex) { box.innerHTML = ''; $('search-count').textContent = ''; $('replace-all').disabled = true; return; }
    const repl = $('replace-input').value;
    const isRegex = $('opt-regex').checked;
    let total = 0;
    const rows = [];
    state.cues.forEach((cue, i) => {
      const matches = cue.text.match(makeSearchRegex());
      if (!matches) return;
      total += matches.length;
      const preview = cue.text.replace(makeSearchRegex(), (m) => `⟦${m}⟧`);
      const replaced = applyReplacement(cue.text, repl, isRegex);
      rows.push(`<div class="sr-item" data-cue="${cue.id}">
        <div class="sr-head">#${i + 1} · ${matches.length} 处
          <button class="mini" data-replace-one="${cue.id}">替换本条</button></div>
        <div class="sr-old">${esc(preview).replace(/⟦/g, '<mark>').replace(/⟧/g, '</mark>')}</div>
        <div class="sr-new">${esc(replaced)}</div>
      </div>`);
    });
    $('search-count').textContent = total ? `共 ${total} 处匹配，${rows.length} 条字幕` : '无匹配';
    box.innerHTML = rows.join('');
    $('replace-all').disabled = total === 0;
  }

  function replaceInCue(cue, pushHistory) {
    if (!searchRegex) return false;
    const next = applyReplacement(cue.text, $('replace-input').value, $('opt-regex').checked);
    if (next === cue.text) return false;
    if (pushHistory) updateText(cue, next);
    else cue.text = next;
    return true;
  }

  function replaceAll() {
    if (!searchRegex) return;
    const changes = [];
    const repl = $('replace-input').value;
    const isRegex = $('opt-regex').checked;
    state.cues.forEach((cue) => {
      const next = applyReplacement(cue.text, repl, isRegex);
      if (next !== cue.text) changes.push({ cueId: cue.id, prop: 'text', old: cue.text, new: next });
    });
    if (!changes.length) return;
    textHistory.push('全部替换（' + changes.length + ' 条）', changes);
    changes.forEach((c) => { getCue(c.cueId).text = c.new; });
    afterDataChanged();
    renderList();
    previewSearch();
  }

  // ---------------- 导出 ----------------
  function doExport(format) {
    if (!state.cues.length) { toast('没有可导出的字幕'); return; }
    const base = (state.fileName || 'subtitles').replace(/\.(srt|vtt)$/i, '');
    Serializer.download(state.cues, format, `${base}.${format === 'vtt' ? 'vtt' : 'srt'}`);
    toast('已导出 ' + format.toUpperCase() + '，可用本页面重新导入验证往返一致性');
  }

  // ---------------- 持久化 ----------------
  function saveProject() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        cues: state.cues, format: state.format, fileName: state.fileName,
        mode: state.mode, fps: state.fps, videoName: state.videoName,
        ignoredOverlaps: [...state.ignoredOverlaps],
        textUndo: textHistory.undoStack.length, timeUndo: timeHistory.undoStack.length,
      }));
    } catch (_) { /* 存储满或被禁用时静默 */ }
  }

  function restoreProject() {
    let raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (_) { return; }
    if (!raw) return;
    try {
      const p = JSON.parse(raw);
      if (!p || !Array.isArray(p.cues) || !p.cues.length) return;
      if (!confirm(`检测到上次未关闭的校对项目（${p.cues.length} 条字幕，文件：${p.fileName || '未知'}），是否恢复？`)) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      state.cues = p.cues;
      state.format = p.format || 'srt';
      state.fileName = p.fileName || '';
      state.mode = p.mode || 'ms';
      state.fps = p.fps || 25;
      state.videoName = p.videoName || '';
      state.ignoredOverlaps = new Set(p.ignoredOverlaps || []);
      seqCounter = state.cues.length;
      state.selectedId = state.cues[0].id;
      $('mode-select').value = state.mode;
      $('fps-input').value = state.fps;
      textHistory.clear();
      timeHistory.clear();
      renderParseErrors();
      renderList();
      runValidation();
      updateStats();
      timeline.fit();
    } catch (e) {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  // ---------------- 统计与提示 ----------------
  function updateStats() {
    $('stat-count').textContent = state.cues.length;
    const v = state.lastValidation;
    $('stat-issues').textContent = v ? (v.counts.error || 0) + ' 错误 / ' + (v.counts.warning || 0) + ' 警告' : '-';
    $('stat-file').textContent = state.fileName || '未导入';
    $('zoom-label').textContent = timeline.pixelsPerSecond.toFixed(0) + ' px/s（' +
      timeline.msPerPixel().toFixed(2) + ' ms/px）';
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ---------------- 事件装配 ----------------
  function bindEvents() {
    // 文件导入
    $('file-input').addEventListener('change', (e) => {
      if (e.target.files[0]) readFile(e.target.files[0]);
      e.target.value = '';
    });
    $('video-input').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      const video = $('video');
      video.src = url;
      state.videoName = f.name;
      scheduleAutosave();
      e.target.value = '';
    });

    // 拖放导入
    const drop = $('drop-overlay');
    document.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.remove('hidden'); });
    drop.addEventListener('dragleave', (e) => { if (e.target === drop) drop.classList.add('hidden'); });
    drop.addEventListener('dragover', (e) => e.preventDefault());
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.add('hidden');
      const files = [...e.dataTransfer.files];
      const sub = files.find((f) => /\.(srt|vtt)$/i.test(f.name));
      const vid = files.find((f) => /^video\//.test(f.type) || /\.(mp4|webm|mov|mkv|m4v)$/i.test(f.name));
      if (sub) readFile(sub);
      if (vid) {
        $('video').src = URL.createObjectURL(vid);
        state.videoName = vid.name;
      }
      if (!sub && !vid) toast('请拖入 .srt/.vtt 字幕或视频文件');
    });

    // 导出 / 新增 / 清空
    $('export-srt').addEventListener('click', () => doExport('srt'));
    $('export-vtt').addEventListener('click', () => doExport('vtt'));
    $('add-cue').addEventListener('click', () => addCue(state.selectedId));
    $('clear-all').addEventListener('click', () => {
      if (!state.cues.length || !confirm('确定清空当前全部字幕？此操作可通过文字栈撤销。')) return;
      const changes = state.cues.map((cue, i) => ({ prop: '__remove__', cueId: cue.id, index: i, cue })).reverse();
      textHistory.push('清空全部', changes);
      state.cues = [];
      state.selectedId = null;
      afterDataChanged();
      renderList();
    });

    // 显示模式 / 帧率（同时监听 input/change，兼容程序化赋值与用户操作）
    $('mode-select').addEventListener('change', (e) => {
      state.mode = e.target.value;
      refreshTimeInputs();
      timeline.draw();
      scheduleAutosave();
    });
    $('fps-input').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v) || v <= 0) { e.target.value = state.fps; return; }
      state.fps = v;
      refreshTimeInputs();
      timeline.draw();
      scheduleAutosave();
    });

    // 撤销重做
    $('undo-text').addEventListener('click', () => doUndo(textHistory));
    $('redo-text').addEventListener('click', () => doRedo(textHistory));
    $('undo-time').addEventListener('click', () => doUndo(timeHistory));
    $('redo-time').addEventListener('click', () => doRedo(timeHistory));

    // 搜索
    ['input', 'change'].forEach((ev) => {
      $('search-input').addEventListener(ev, previewSearch);
      $('replace-input').addEventListener(ev, previewSearch);
      $('opt-case').addEventListener(ev, previewSearch);
      $('opt-regex').addEventListener(ev, previewSearch);
    });
    $('replace-all').addEventListener('click', replaceAll);

    // 列表事件委托
    $('list').addEventListener('click', (e) => {
      const row = e.target.closest('.cue-row');
      if (!row) return;
      const id = row.dataset.row;
      const cue = getCue(id);
      const act = e.target.dataset.act;
      if (act === 'play') { audition(cue); return; }
      if (act === 'add') { addCue(id); return; }
      if (act === 'del') { deleteCue(id); return; }
      selectCue(id);
    });

    $('list').addEventListener('input', (e) => {
      const row = e.target.closest('.cue-row');
      if (!row) return;
      const cue = getCue(row.dataset.row);
      if (e.target.tagName === 'TEXTAREA') updateText(cue, e.target.value);
    });

    $('list').addEventListener('change', (e) => {
      const row = e.target.closest('.cue-row');
      if (!row) return;
      const cue = getCue(row.dataset.row);
      if (!e.target.classList.contains('t-start') && !e.target.classList.contains('t-end')) return;
      const ms = Time.parseInput(e.target.value, state.mode, state.fps);
      if (ms === null) {
        toast('时间格式无效，毫秒模式示例 00:00:01,500；帧模式示例 00:00:01:12');
        refreshTimeInputs();
        return;
      }
      if (e.target.classList.contains('t-start')) updateTime(cue, ms, cue.end, '修改开始时间');
      else updateTime(cue, cue.start, ms, '修改结束时间');
      refreshTimeInputs();
    });

    // 问题面板：忽略重叠 / 定位
    $('issue-panel').addEventListener('click', (e) => {
      const key = e.target.dataset.issueToggle;
      if (key) {
        if (state.ignoredOverlaps.has(key)) state.ignoredOverlaps.delete(key);
        else state.ignoredOverlaps.add(key);
        runValidation();
        renderList();
        scheduleAutosave();
        return;
      }
      const gotoId = e.target.dataset.issueGoto;
      if (gotoId) { selectCue(gotoId, true); audition(getCue(gotoId)); }
    });

    // 搜索结果：单条替换 / 点击定位
    $('search-results').addEventListener('click', (e) => {
      const id = e.target.dataset.replaceOne;
      if (id) {
        const cue = getCue(id);
        if (cue && replaceInCue(cue, true)) {
          afterDataChanged();
          renderList();
          previewSearch();
        }
        return;
      }
      const item = e.target.closest('.sr-item');
      if (item) { selectCue(item.dataset.cue, true); audition(getCue(item.dataset.cue)); }
    });

    // 时间轴缩放按钮
    $('zoom-in').addEventListener('click', () => timeline.zoomAt(1.4));
    $('zoom-out').addEventListener('click', () => timeline.zoomAt(1 / 1.4));
    $('zoom-fit').addEventListener('click', () => timeline.fit());

    // 视频事件
    const video = $('video');
    video.addEventListener('loadedmetadata', () => {
      state.durationSec = video.duration;
      runValidation();
      updateStats();
      timeline.fit();
    });
    video.addEventListener('timeupdate', () => timeline.draw());

    // 全局快捷键
    document.addEventListener('keydown', onKeyDown);

    // 窗口尺寸变化
    new ResizeObserver(() => timeline.resize()).observe($('timeline-wrap'));
  }

  // 播放到指定时间点自动暂停（用于条目试听）；重复调用时只保留最新一个监听
  function stopAt(video, stopSec) {
    if (stopAt._listener) video.removeEventListener('timeupdate', stopAt._listener);
    stopAt._listener = () => {
      if (video.currentTime >= stopSec) {
        video.pause();
        video.removeEventListener('timeupdate', stopAt._listener);
        stopAt._listener = null;
      }
    };
    video.addEventListener('timeupdate', stopAt._listener);
  }

  function audition(cue) {
    if (!cue) return;
    const video = $('video');
    video.currentTime = cue.start / 1000;
    stopAt(video, cue.end / 1000);
    video.play().catch(() => {});
  }

  function onKeyDown(e) {
    const tag = document.activeElement && document.activeElement.tagName;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      // Ctrl/⌘+Shift+Z 重做文字；按住 Alt 时操作时间栈
      if (e.shiftKey) doRedo(e.altKey ? timeHistory : textHistory);
      else doUndo(e.altKey ? timeHistory : textHistory);
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      doRedo(e.altKey ? timeHistory : textHistory);
      return;
    }
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search-input').focus();
      $('search-input').select();
      return;
    }
    if (typing) return;
    const cue = getCue(state.selectedId);
    if (e.key === ' ' && cue) {
      e.preventDefault();
      const v = $('video');
      if (v.paused) v.play().catch(() => {}); else v.pause();
    }
    if (!cue) return;
    const stepMs = state.mode === 'frame' ? Time.frameToMs(1, state.fps) : 10;
    const big = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const d = (e.key === 'ArrowRight' ? 1 : -1) * stepMs * big;
      if (e.altKey) updateTime(cue, Math.max(0, cue.start + d), Math.max(0, cue.end + d), '键盘平移');
      else updateTime(cue, Math.max(0, cue.start + d), cue.end, '键盘微调起点');
      refreshTimeInputs();
    }
    if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      const d = (e.key === ']' ? 1 : -1) * stepMs * big;
      updateTime(cue, cue.start, Math.max(0, cue.end + d), '键盘微调终点');
      refreshTimeInputs();
    }
  }

  // ---------------- 启动 ----------------
  function init() {
    timeline = new TimelineUI.Timeline($('timeline'), {
      getCues: () => state.cues,
      getSelectedId: () => state.selectedId,
      getDuration: () => state.durationSec,
      getMode: () => state.mode,
      getFps: () => state.fps,
      getIssueMap: () => (state.lastValidation ? state.lastValidation.byCue : new Map()),
      getCurrentTime: () => $('video').currentTime || 0,
      onSelect: (id) => selectCue(id, true),
      onSeek: (ms) => { $('video').currentTime = ms / 1000; },
      onTimeChange: (id, mode, start, end, fromDrag) => {
        const cue = getCue(id);
        if (cue && fromDrag) dragTime(cue, start, end);
      },
      onDragCommit: (cue, origStart, origEnd) => commitDrag(cue, origStart, origEnd),
      onAudition: (id, fromMs, toMs) => {
        const video = $('video');
        video.currentTime = fromMs / 1000;
        stopAt(video, toMs / 1000);
        video.play().catch(() => {});
      },
    });

    bindEvents();
    renderList();
    runValidation();
    updateStats();
    restoreProject();
  }

  document.addEventListener('DOMContentLoaded', init);

  // 仅用于自动化测试的只读诊断接口
  window.__subtitleQA = {
    getState: () => ({
      cues: state.cues,
      textUndoLen: textHistory.undoStack.length,
      timeUndoLen: timeHistory.undoStack.length,
      textTop: textHistory.undoStack[textHistory.undoStack.length - 1] || null,
    }),
  };
})();
