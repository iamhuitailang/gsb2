/*
 * 主控制器：录入 → 解析 → 排版 → 渲染/播放 → 预设/导出。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('measureCanvas');

  const state = {
    parsed: null,
    layout: null,
    view: null,          // renderer 返回值
    player: null,
    tab: 'play',
    config: Object.assign({}, TT.layout.DEFAULTS),
    playback: { charIntervalMs: 55, defaultWaitMs: 400 },
    rebuildTimer: null,
    revealed: 0,
    compareScales: []
  };

  // ---------- 小工具 ----------
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  function debounce(fn, ms) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function readConfig() {
    state.config.fontSize = +$('cfgFontSize').value;
    state.config.lineWidth = +$('cfgLineWidth').value;
    state.config.letterSpacing = +$('cfgLetterSpacing').value;
    state.config.lineHeight = +$('cfgLineHeight').value;
    state.config.fontFamily = $('cfgFontFamily').value;
    state.playback.charIntervalMs = +$('cfgSpeed').value;
    state.playback.defaultWaitMs = +$('cfgDefaultWait').value;
  }

  function syncConfigLabels() {
    $('vFontSize').textContent = $('cfgFontSize').value;
    $('vLineWidth').textContent = $('cfgLineWidth').value;
    $('vLetterSpacing').textContent = $('cfgLetterSpacing').value;
    $('vLineHeight').textContent = (+$('cfgLineHeight').value).toFixed(1);
    $('vSpeed').textContent = $('cfgSpeed').value;
    $('vDefaultWait').textContent = $('cfgDefaultWait').value;
  }

  // ---------- 核心重建流程 ----------
  function rebuild() {
    readConfig();
    syncConfigLabels();
    const text = $('editor').value;

    state.parsed = TT.parser.parse(text);
    state.layout = TT.layout.layout(state.parsed, state.config, canvas);

    renderStage();
    renderIssues();
    updateReadouts();
    rebuildPlayer();
    refreshJsonPreview();
    TT.storage.saveDraft(text, state.config, state.playback);
  }

  const rebuildDebounced = debounce(rebuild, 160);

  function renderStage() {
    const host = $('stageHost');
    host.innerHTML = '';
    state.view = TT.renderer.render(state.layout, state.parsed, {
      showMarkers: $('cfgShowMarkers').checked
    });
    host.appendChild(state.view.stage);

    // 字形点击 → 跳到该字
    state.view.spanByChar.forEach((node, idx) => {
      node.addEventListener('click', () => {
        if (state.player) state.player.seekTo(idx + 1);
      });
      node.style.cursor = 'pointer';
    });

    if (state.tab === 'final') {
      state.view.reveal(state.parsed.charCount);
    } else if (state.tab === 'compare') {
      renderCompare();
      return;
    } else {
      state.view.reveal(state.revealed);
    }
  }

  function rebuildPlayer() {
    const wasState = state.player ? state.player.getState() : null;
    const keepRevealed = wasState ? wasState.revealed : 0;
    // 正在播放/等待中触发的重排版（如拖动尺寸）：重建后自动续播，其余状态保持暂停
    const resumePlayback = !!wasState && (wasState.state === 'playing' || wasState.state === 'waiting');

    state.player = TT.player.create(state.parsed, {
      charIntervalMs: state.playback.charIntervalMs,
      defaultWaitMs: state.playback.defaultWaitMs,
      onTick: (revealed, ctx) => {
        state.revealed = revealed;
        if (state.view && state.tab === 'play') state.view.reveal(revealed);
        $('seek').value = revealed;
        $('seek').max = state.parsed.charCount;
        $('seekReadout').textContent = revealed + ' / ' + state.parsed.charCount;
        updateStateBadge(ctx.state);
      },
      onStateChange: () => {}
    });

    // 重建后恢复进度（关键：播放途中改尺寸，进度与已显示文字保持对应）
    // 切换样本后字形总数可能变化，进度需先夹紧到新范围
    const safeRevealed = Math.min(keepRevealed, state.parsed.charCount);
    state.revealed = safeRevealed;
    state.player.seekTo(safeRevealed);
    if (resumePlayback) state.player.play();
    if (state.view) {
      if (state.tab === 'final') state.view.reveal(state.parsed.charCount);
      else state.view.reveal(safeRevealed);
    }
    $('seek').max = state.parsed.charCount;
    $('seek').value = safeRevealed;
    $('seekReadout').textContent = safeRevealed + ' / ' + state.parsed.charCount;
    if (!resumePlayback) updateStateBadge(safeRevealed >= state.parsed.charCount ? 'done' : 'paused');
  }

  function updateStateBadge(s) {
    const badge = $('stateBadge');
    const map = {
      idle: '空闲', playing: '播放中', waiting: '停顿中…', paused: '已暂停', done: '已完成'
    };
    badge.textContent = map[s] || s;
    badge.className = 'state ' + (s === 'waiting' ? 'waiting' : s === 'done' ? 'done' : '');
  }

  // ---------- 问题面板 ----------
  function renderIssues() {
    const box = $('errorList');
    box.innerHTML = '';
    const errs = state.parsed.errors;
    const ofs = state.layout.overflows;
    const warns = state.layout.warnings;

    $('issueCount').textContent = `错误 ${errs.length} · 溢出 ${ofs.length} · 警告 ${warns.length}`;

    if (errs.length + ofs.length + warns.length === 0) {
      box.innerHTML = '<div class="empty-hint">✅ 没有解析错误，没有溢出，版面正常。</div>';
      return;
    }

    errs.forEach((e) => box.appendChild(issueNode('error',
      `第 ${e.line} 行 第 ${e.col} 列`, e.message, e.lineText, e.colInLine, () => selectInEditor(e.pos, e.end))));

    ofs.forEach((o) => box.appendChild(issueNode(o.reason.includes('kinsoku') ? 'warn' : 'error',
      `第 ${o.page + 1} 页 第 ${o.line + 1} 行 · ${o.reason}`,
      `字形「${o.text}」需要 ${Math.round(o.width)}px，行宽仅 ${o.lineWidth}px（字序号 ${o.charIndex}）`,
      null, -1, () => locateChar(o.charIndex))));

    warns.forEach((w) => box.appendChild(issueNode('warn',
      `第 ${Math.round(w.width)}px / 行宽 ${w.lineWidth}px`, w.message,
      null, -1, () => {
        const p = state.layout.placements.find((z) => z.srcStart >= w.srcStart && z.srcEnd <= w.srcEnd);
        if (p) locateChar(p.charIndex);
      })));
  }

  function issueNode(kind, loc, msg, lineText, colInLine, onClick) {
    const node = document.createElement('div');
    node.className = 'issue ' + kind;
    const locEl = document.createElement('div');
    locEl.className = 'loc';
    locEl.textContent = loc;
    const msgEl = document.createElement('div');
    msgEl.className = 'msg';
    msgEl.textContent = msg;
    node.appendChild(locEl);
    node.appendChild(msgEl);
    if (lineText !== null) {
      const srcEl = document.createElement('div');
      srcEl.className = 'src';
      const before = lineText.slice(0, colInLine);
      const rest = lineText.slice(colInLine);
      srcEl.textContent = '';
      srcEl.appendChild(document.createTextNode(before));
      const caret = document.createElement('span');
      caret.className = 'caret';
      caret.textContent = '▸';
      srcEl.appendChild(caret);
      srcEl.appendChild(document.createTextNode(rest));
      node.appendChild(srcEl);
    }
    node.addEventListener('click', onClick);
    return node;
  }

  function selectInEditor(start, end) {
    const ed = $('editor');
    ed.focus();
    ed.setSelectionRange(start, end);
    // 滚动到对应行
    const upto = ed.value.slice(0, start);
    const lines = upto.split('\n').length;
    const approx = (lines - 1) * 18;
    ed.scrollTop = Math.max(0, approx - ed.clientHeight / 2);
  }

  function locateChar(charIndex) {
    if (state.tab !== 'play') switchTab('play');
    state.player.seekTo(charIndex + 1);
    const node = state.view.flashChar(charIndex);
    if (node) {
      const scroll = $('stageScroll');
      const top = node.offsetTop - scroll.clientHeight / 2 + 40;
      scroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }

  // ---------- 读数 ----------
  function updateReadouts() {
    $('charCountReadout').textContent =
      `可见字形 ${state.parsed.charCount} · 单元 ${state.parsed.units.length} · 页 ${state.layout.pages.length} · 行 ${state.layout.pages.reduce((n, p) => n + p.lines.length, 0)}`;
    $('layoutReadout').textContent =
      `总高 ${Math.round(state.layout.totalHeight)}px · 溢出 ${state.layout.overflows.length} · 警告 ${state.layout.warnings.length}`;
  }

  // ---------- 多配置对照 ----------
  const COMPARE_VARIANTS = [
    { name: '小字号·窄行', patch: { fontSize: 13, lineWidth: 240, letterSpacing: 0 } },
    { name: '当前配置', patch: {} },
    { name: '大字号·宽行·宽间距', patch: { fontSize: 26, lineWidth: 620, letterSpacing: 4, lineHeight: 1.8 } }
  ];

  function renderCompare() {
    const host = $('stageHost');
    host.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'compare-grid';
    grid.style.width = '100%';

    COMPARE_VARIANTS.forEach((v) => {
      const cfg = Object.assign({}, state.config, v.patch);
      const lay = TT.layout.layout(state.parsed, cfg, canvas);
      const view = TT.renderer.render(lay, state.parsed, { showMarkers: false });
      view.reveal(state.parsed.charCount);

      const card = document.createElement('div');
      card.className = 'compare-card';
      const h = document.createElement('h4');
      h.textContent = v.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${cfg.fontSize}px / 行宽${cfg.lineWidth} / 间距${cfg.letterSpacing} / 行高${cfg.lineHeight}`;

      const badge = document.createElement('div');
      if (lay.overflows.length) {
        badge.innerHTML = `<span class="badge bad">溢出 ${lay.overflows.length}</span> <span class="badge warn">警告 ${lay.warnings.length}</span>`;
      } else if (lay.warnings.length) {
        badge.innerHTML = `<span class="badge ok">无溢出</span> <span class="badge warn">警告 ${lay.warnings.length}</span>`;
      } else {
        badge.innerHTML = '<span class="badge ok">版面正常</span>';
      }
      badge.addEventListener('click', () => {
        const first = lay.overflows[0];
        if (first) {
          switchTab('play');
          locateChar(first.charIndex);
        }
      });

      const miniScroll = document.createElement('div');
      miniScroll.className = 'mini-scroll';
      const miniHost = document.createElement('div');
      miniHost.className = 'mini-host';
      const scale = Math.min(1, (cfg.lineWidth > 300 ? 0.55 : 0.9));
      miniHost.appendChild(view.stage);
      miniHost.style.width = view.totalWidth * scale + 'px';
      miniHost.style.height = view.totalHeight * scale + 'px';
      view.stage.style.transformOrigin = 'top left';
      view.stage.style.transform = `scale(${scale})`;
      miniScroll.appendChild(miniHost);

      card.appendChild(h);
      card.appendChild(meta);
      card.appendChild(badge);
      card.appendChild(miniScroll);
      grid.appendChild(card);
    });

    host.appendChild(grid);
  }

  // ---------- Tab 切换 ----------
  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $('playerBar').style.display = tab === 'play' ? 'flex' : 'none';
    if (tab === 'compare') {
      renderCompare();
    } else {
      renderStage();
      if (tab === 'final') {
        state.view.reveal(state.parsed.charCount);
      } else {
        state.view.reveal(state.revealed);
      }
    }
  }

  // ---------- 预设 ----------
  function refreshPresets() {
    const box = $('presetList');
    box.innerHTML = '';
    const presets = TT.storage.listPresets();
    if (!presets.length) {
      box.innerHTML = '<span class="muted" style="font-size:12px;">暂无预设</span>';
      return;
    }
    presets.forEach((p) => {
      const chip = document.createElement('span');
      chip.className = 'preset-chip';
      chip.innerHTML = '';
      const name = document.createElement('span');
      name.textContent = p.name;
      name.title = `字号${p.data.layout.fontSize} / 行宽${p.data.layout.lineWidth} / 间距${p.data.layout.letterSpacing} · ${new Date(p.data.savedAt).toLocaleString()}`;
      chip.appendChild(name);
      chip.addEventListener('click', () => applyPreset(p.data));
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = '✕';
      del.title = '删除';
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (confirm('删除预设「' + p.name + '」？')) {
          TT.storage.deletePreset(p.name);
          refreshPresets();
          toast('已删除预设');
        }
      });
      chip.appendChild(del);
      box.appendChild(chip);
    });
  }

  function applyPreset(data) {
    const l = data.layout || {};
    const pb = data.playback || {};
    if (l.fontSize) $('cfgFontSize').value = l.fontSize;
    if (l.lineWidth) $('cfgLineWidth').value = l.lineWidth;
    if (l.letterSpacing) $('cfgLetterSpacing').value = l.letterSpacing;
    if (l.lineHeight) $('cfgLineHeight').value = l.lineHeight;
    if (l.fontFamily) $('cfgFontFamily').value = l.fontFamily;
    if (pb.charIntervalMs) $('cfgSpeed').value = pb.charIntervalMs;
    if (pb.defaultWaitMs) $('cfgDefaultWait').value = pb.defaultWaitMs;
    rebuild();
    toast('已套用预设');
  }

  // ---------- 导出 ----------
  function currentExport() {
    return TT.exporter.buildExport(state.parsed, state.layout);
  }
  function refreshJsonPreview() {
    try {
      const data = currentExport();
      // 预览可能很长：保留全部顶层结构与 markers，仅对 pages 内逐字坐标做摘要
      const preview = JSON.parse(JSON.stringify(data));
      const MAX_CHARS = 24;
      preview.pages = preview.pages.map((pg) => ({
        page: pg.page,
        height: pg.height,
        text: pg.text,
        lineCount: pg.lines.length,
        lines: pg.lines.slice(0, 2).map((ln) => ({
          index: ln.index,
          top: ln.top,
          width: ln.width,
          charCount: ln.chars.length,
          charsPreview: ln.chars.slice(0, MAX_CHARS).map((c) => ({
            charIndex: c.charIndex, text: c.text, x: c.x, y: c.y, width: c.width
          })).concat(ln.chars.length > MAX_CHARS ? [{ note: '…其余 ' + (ln.chars.length - MAX_CHARS) + ' 字见下载文件' }] : [])
        })).concat(pg.lines.length > 2 ? [{ note: '…其余 ' + (pg.lines.length - 2) + ' 行见下载文件' }] : [])
      }));
      $('jsonPreview').textContent = JSON.stringify(preview, null, 2);
    } catch (e) {
      $('jsonPreview').textContent = '导出失败: ' + e.message;
    }
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    $('editor').addEventListener('input', rebuildDebounced);

    ['cfgFontSize', 'cfgLineWidth', 'cfgLetterSpacing', 'cfgLineHeight', 'cfgFontFamily',
      'cfgSpeed', 'cfgDefaultWait', 'cfgShowMarkers']
      .forEach((id) => $(id).addEventListener('input', rebuildDebounced));

    document.querySelectorAll('.tab').forEach((t) =>
      t.addEventListener('click', () => switchTab(t.dataset.tab)));

    $('btnPlay').addEventListener('click', () => state.player.play());
    $('btnPause').addEventListener('click', () => state.player.pause());
    $('btnShowAll').addEventListener('click', () => {
      state.player.showAll();
      if (state.view) state.view.reveal(state.parsed.charCount);
    });
    $('btnReset').addEventListener('click', () => {
      state.player.reset();
      state.revealed = 0;
      if (state.view) state.view.reveal(0);
      $('seek').value = 0;
      $('seekReadout').textContent = '0 / ' + state.parsed.charCount;
      updateStateBadge('idle');
    });

    $('seek').addEventListener('input', (e) => {
      const n = +e.target.value;
      state.player.seekTo(n);
      state.revealed = n;
      if (state.view && state.tab === 'play') state.view.reveal(n);
    });

    $('btnSavePreset').addEventListener('click', () => {
      const name = $('presetName').value.trim();
      if (!name) { toast('请先输入预设名称'); return; }
      try {
        TT.storage.savePreset(name, { layout: state.config, playback: state.playback });
        refreshPresets();
        toast('预设「' + name + '」已保存');
      } catch (err) {
        toast(err.message);
      }
    });
    $('btnRefreshPresets').addEventListener('click', refreshPresets);

    $('btnCopyJson').addEventListener('click', async () => {
      const text = JSON.stringify(currentExport(), null, 2);
      try {
        await navigator.clipboard.writeText(text);
        toast('JSON 已复制到剪贴板');
      } catch (e) {
        download('dialogue-layout.json', text);
        toast('剪贴板不可用，已改为下载文件');
      }
    });
    $('btnDownloadJson').addEventListener('click', () => {
      download('dialogue-layout.json', JSON.stringify(currentExport(), null, 2));
      toast('已下载 dialogue-layout.json');
    });

    $('btnHelp').addEventListener('click', () => $('helpMask').classList.add('show'));
    $('btnCloseHelp').addEventListener('click', () => $('helpMask').classList.remove('show'));
    $('helpMask').addEventListener('click', (e) => {
      if (e.target === $('helpMask')) $('helpMask').classList.remove('show');
    });

    // 空格快捷键：播放/暂停
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        state.player.toggle();
      }
    });
  }

  // ---------- 示例 ----------
  function initSamples() {
    const box = $('samplePills');
    TT.samples.forEach((s) => {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = s.name;
      pill.addEventListener('click', () => {
        $('editor').value = s.text;
        rebuild();
        toast('已载入示例：' + s.name);
      });
      box.appendChild(pill);
    });
  }

  // ---------- 启动 ----------
  function init() {
    initSamples();
    bindEvents();
    const draft = TT.storage.loadDraft();
    if (draft && typeof draft.text === 'string' && draft.text.length) {
      $('editor').value = draft.text;
      if (draft.layout) {
        const l = draft.layout;
        if (l.fontSize) $('cfgFontSize').value = l.fontSize;
        if (l.lineWidth) $('cfgLineWidth').value = l.lineWidth;
        if (l.letterSpacing) $('cfgLetterSpacing').value = l.letterSpacing;
        if (l.lineHeight) $('cfgLineHeight').value = l.lineHeight;
        if (l.fontFamily) $('cfgFontFamily').value = l.fontFamily;
      }
      if (draft.playback) {
        if (draft.playback.charIntervalMs) $('cfgSpeed').value = draft.playback.charIntervalMs;
        if (draft.playback.defaultWaitMs) $('cfgDefaultWait').value = draft.playback.defaultWaitMs;
      }
      toast('已恢复上次草稿');
    } else {
      $('editor').value = TT.samples[0].text;
    }
    refreshPresets();
    rebuild();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
