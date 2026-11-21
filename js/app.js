/* 应用主控：编辑 / 分析 / 试玩三态切换，参数面板、存档、连通性对比、逐步轨迹。 */
(function () {
  const JR = (window.JR = window.JR || {});

  const app = {
    canvas: null,
    ctx: null,
    level: JR.demo.demoLevel(),
    mode: 'edit', // edit | play
    tool: 'select',
    selectedId: null,
    paramsA: { ...JR.DEFAULT_PARAMS_A },
    paramsB: { ...JR.DEFAULT_PARAMS_B },
    activeSet: 'A',
    resultA: null,
    resultB: null,
    preview: null, // { frames, ghostFrames, run }
    stepIndex: 0,
    stepPlaying: false,
    player: null,
    playFrame: null,

    activeParams() {
      return this.activeSet === 'A' ? this.paramsA : this.paramsB;
    },
    activeResult() {
      return this.activeSet === 'A' ? this.resultA : this.resultB;
    },
    selectEntity(id) {
      this.selectedId = id;
      if (id) {
        const e = this.level.entities.find((x) => x.id === id);
        if (e && e.type === 'platform') this.level.targetId = id;
      }
      this.render();
      this.syncInspector();
    },
  };

  JR.app = app;

  function $(sel) {
    return document.querySelector(sel);
  }

  function render() {
    app.render();
  }

  function runAnalysis() {
    app.resultA = JR.analyzer.analyze(app.level, app.paramsA);
    app.resultB = JR.analyzer.analyze(app.level, app.paramsB);
    app.preview = null;
    app.stepPlaying = false;
    render();
    renderResults();
    renderCompare();
  }

  function renderResults() {
    const res = app.activeResult();
    const box = $('#landing-list');
    if (!res) {
      box.innerHTML = '<p class="hint">点击「计算可达性」后在此列出每个平台的落脚结果。</p>';
      return;
    }
    const lines = [];
    for (const agg of res.platforms) {
      const e = app.level.entities.find((x) => x.id === agg.entityId);
      const tag = agg.bonkBlocked
        ? '<span class="tag tag-bonk">撞头阻挡</span>'
        : agg.reachable
          ? '<span class="tag tag-ok">可落脚</span>'
          : '<span class="tag tag-no">不可达</span>';
      lines.push(
        `<div class="land-row ${app.level.targetId === agg.entityId ? 'is-target' : ''}" data-id="${agg.entityId}">
           <b>平台 ${agg.entityId}</b> ${tag}
           <span class="dim">(${Math.round(e.x)},${Math.round(e.y)}) ${e.w}×${e.h}${e.oneWay ? ' 薄' : ''}</span>
           ${agg.edgeSlips ? `<span class="tag tag-edge">滑落×${agg.edgeSlips}</span>` : ''}
         </div>`
      );
    }
    box.innerHTML = lines.join('');
    box.querySelectorAll('.land-row').forEach((row) => {
      row.addEventListener('click', () => showPlatformPreview(row.dataset.id));
    });

    // 目标判定
    const judge = JR.analyzer.judgeTarget(app.level, app.activeParams(), res);
    const tb = $('#target-verdict');
    if (judge.ok) {
      tb.className = 'verdict verdict-ok';
      tb.innerHTML = `✅ 可行跳法：<b>${escapeHtml(judge.text)}</b>
        <button id="btn-show-route" class="mini">载入轨迹逐步查看</button>`;
      $('#btn-show-route').onclick = () => loadRoute(judge.run, judge.frameIndex);
    } else if (judge.reason === 'no-target') {
      tb.className = 'verdict';
      tb.textContent = judge.text;
    } else {
      tb.className = 'verdict verdict-bad';
      tb.innerHTML = `❌ 跳不过：<b>${escapeHtml(judge.text)}</b>`;
    }
  }

  function showPlatformPreview(id) {
    const res = app.activeResult();
    const agg = res.platforms.find((p) => p.entityId === id);
    if (!agg || !agg.bestRun) {
      app.preview = null;
      render();
      return;
    }
    loadRoute(agg.bestRun.run, agg.bestRun.frameIndex);
  }

  function loadRoute(run, frameIndex) {
    app.preview = {
      frames: run.real.frames,
      ghostFrames: run.ghost.frames,
      run,
      landFrame: frameIndex,
    };
    app.stepIndex = 0;
    app.stepPlaying = false;
    render();
    drawStepFrame();
    $('#step-info').textContent = `策略：${JR.analyzer.strategyLabel(run.strategy)} · 共 ${app.preview.frames.length} 帧，第 ${frameIndex + 1} 帧站稳`;
  }

  function drawStepFrame() {
    if (!app.preview) return;
    const f = app.preview.frames[Math.min(app.stepIndex, app.preview.frames.length - 1)];
    app.playFrame = f;
    render();
    $('#step-frame-num').textContent = `帧 ${app.stepIndex + 1}/${app.preview.frames.length} · t=${(f.t).toFixed(2)}s · 速度(${f.vx.toFixed(0)},${f.vy.toFixed(0)})`;
  }

  function renderCompare() {
    const box = $('#compare-list');
    if (!app.resultA || !app.resultB) {
      box.innerHTML = '<p class="hint">计算后显示两套参数的连通性差异。</p>';
      return;
    }
    const diff = JR.analyzer.diffConnectivity(app.level, app.resultA, app.resultB);
    const parts = [];
    if (!diff.lost.length && !diff.gained.length && !diff.bonkChange.length) {
      parts.push('<p class="hint">两套参数的连通性完全相同。</p>');
    }
    for (const d of diff.lost) parts.push(`<div class="cmp cmp-lost">− ${escapeHtml(d.text)}</div>`);
    for (const d of diff.gained) parts.push(`<div class="cmp cmp-gained">+ ${escapeHtml(d.text)}</div>`);
    for (const d of diff.bonkChange) parts.push(`<div class="cmp cmp-bonk">⚠ ${escapeHtml(d.text)}</div>`);
    box.innerHTML = parts.join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 参数面板 ----------
  const PARAM_FIELDS = [
    ['jumpSpeed', '起跳速度 px/s', 50, 900, 1],
    ['gravity', '重力 px/s²', 200, 3000, 10],
    ['jumpCut', '松键截断系数', 0.1, 1, 0.01],
    ['maxHold', '跳跃最长按住 s', 0.02, 0.6, 0.01],
    ['moveSpeed', '最大横移 px/s', 20, 600, 5],
    ['groundAccel', '地面加速度', 200, 4000, 50],
    ['airAccel', '空中加速度', 100, 4000, 50],
    ['groundFriction', '地面摩擦', 0, 3000, 50],
    ['airFriction', '空中摩擦', 0, 1000, 10],
    ['width', '角色宽 px', 8, 64, 1],
    ['height', '角色高 px', 8, 80, 1],
  ];

  function buildParamPanel() {
    for (const set of ['A', 'B']) {
      const panel = $(`#params-${set.toLowerCase()}`);
      const fields = PARAM_FIELDS.map(([key, label, min, max, step]) => `
        <label class="param-row">
          <span>${label}</span>
          <input type="number" data-set="${set}" data-key="${key}" min="${min}" max="${max}" step="${step}">
        </label>`).join('');
      panel.insertAdjacentHTML('beforeend', fields);
      panel.querySelectorAll('input').forEach((inp) => {
        inp.addEventListener('input', () => {
          const target = set === 'A' ? app.paramsA : app.paramsB;
          target[inp.dataset.key] = parseFloat(inp.value);
          app.resultA = app.resultB = null;
          $('#compare-list').innerHTML = '<p class="hint">参数已修改，请重新计算可达性。</p>';
        });
      });
    }
    syncParams();
  }

  function syncParams() {
    for (const set of ['A', 'B']) {
      const p = set === 'A' ? app.paramsA : app.paramsB;
      document.querySelectorAll(`input[data-set="${set}"]`).forEach((inp) => {
        inp.value = p[inp.dataset.key];
      });
      $(`#name-${set.toLowerCase()}`).value = p.name;
    }
  }

  // ---------- 工具栏与模式 ----------
  function bindUI() {
    document.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        app.tool = btn.dataset.tool;
        document.querySelectorAll('.tool-btn').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });

    $('#btn-analyze').addEventListener('click', runAnalysis);
    $('#btn-play').addEventListener('click', () => enterPlay());
    $('#btn-stop-play-2').addEventListener('click', () => exitPlay());
    $('#btn-reset-play').addEventListener('click', () => app.player && app.player.reset());
    $('#btn-demo').addEventListener('click', () => {
      app.level = JR.demo.demoLevel();
      app.selectedId = app.level.targetId;
      app.resultA = app.resultB = null;
      app.preview = null;
      render();
      renderResults();
      renderCompare();
      syncInspector();
    });
    // 注：删除/薄平台/标记目标按钮在 #inspector 内动态生成，事件绑定在 syncInspector 里

    document.querySelectorAll('.param-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        app.activeSet = tab.dataset.set;
        document.querySelectorAll('.param-tab').forEach((t) => t.classList.toggle('active', t === tab));
        document.querySelectorAll('.param-panel').forEach((p) => p.classList.toggle('active', p.id === `params-${app.activeSet.toLowerCase()}`));
        renderResults();
        render();
      });
    });
    ['a', 'b'].forEach((s) => {
      $(`#name-${s}`).addEventListener('input', (ev) => {
        (s === 'a' ? app.paramsA : app.paramsB).name = ev.target.value;
      });
    });

    // 逐步轨迹控制
    $('#step-first').onclick = () => { app.stepIndex = 0; drawStepFrame(); };
    $('#step-prev').onclick = () => { app.stepIndex = Math.max(0, app.stepIndex - 1); drawStepFrame(); };
    $('#step-next').onclick = () => {
      if (app.preview) { app.stepIndex = Math.min(app.preview.frames.length - 1, app.stepIndex + 1); drawStepFrame(); }
    };
    $('#step-last').onclick = () => { if (app.preview) { app.stepIndex = app.preview.frames.length - 1; drawStepFrame(); } };
    $('#step-play').onclick = toggleStepPlay;

    // 存档
    $('#btn-save').onclick = saveCurrent;
    $('#btn-export').onclick = exportCurrent;
    $('#btn-import').onclick = () => $('#import-file').click();
    $('#import-file').onchange = importFile;
    refreshSaveList();

    // 画布点击空白处刷新检查器
    app.canvas.addEventListener('click', () => setTimeout(() => app.syncInspector && app.syncInspector(), 0));
  }

  function selectedEntity() {
    return app.level.entities.find((e) => e.id === app.selectedId);
  }

  function syncInspector() {
    const e = selectedEntity();
    const box = $('#inspector');
    if (!e) {
      box.innerHTML = '<p class="hint">选择或放置一个实体。左键拖拽移动，右下角手柄缩放，右键选中。</p>';
      return;
    }
    const isPlat = e.type === 'platform';
    box.innerHTML = `
      <div>类型：${JR.ENTITY_TYPES[e.type].label} ${e.id}</div>
      <div class="dim">位置 (${Math.round(e.x)}, ${Math.round(e.y)})　尺寸 ${e.w}×${e.h}</div>
      ${isPlat ? `<label class="chk"><input type="checkbox" id="chk-oneway-2" ${e.oneWay ? 'checked' : ''}> 薄平台（从下穿过、向下落接住）</label>` : ''}
      ${isPlat ? `<button class="mini" id="btn-mark-target-2">${app.level.targetId === e.id ? '★ 当前目标平台' : '标记为目标平台'}</button>` : ''}
      <button class="mini danger" id="btn-delete-2">删除该实体</button>`;
    if (isPlat) {
      $('#chk-oneway-2').onchange = (ev) => { e.oneWay = ev.target.checked; render(); };
      $('#btn-mark-target-2').onclick = () => { app.level.targetId = e.id; render(); syncInspector(); if (app.activeResult()) renderResults(); };
    }
    $('#btn-delete-2').onclick = deleteSelected;
  }
  app.syncInspector = syncInspector;

  function deleteSelected() {
    if (!app.selectedId) return;
    app.level.entities = app.level.entities.filter((e) => e.id !== app.selectedId);
    if (app.level.targetId === app.selectedId) app.level.targetId = null;
    app.selectedId = null;
    render();
    syncInspector();
  }

  // ---------- 试玩 ----------
  function enterPlay() {
    if (!app.level.entities.some((e) => e.type === 'start')) {
      alert('请先放置起跳区域');
      return;
    }
    app.mode = 'play';
    app.canvas.classList.add('playing');
    $('#play-bar').style.display = 'flex';
    app.player = JR.player.createPlayer(app.canvas, () => app, (frame) => {
      app.playFrame = frame;
      render();
    });
    app.player.start();
  }

  function exitPlay() {
    app.mode = 'edit';
    app.canvas.classList.remove('playing');
    $('#play-bar').style.display = 'none';
    if (app.player) app.player.stop();
    app.player = null;
    app.playFrame = null;
    render();
  }

  // ---------- 存档 ----------
  function saveCurrent() {
    const name = prompt('存档名称：', `关卡-${new Date().toLocaleString('zh-CN', { hour12: false })}`);
    if (!name) return;
    JR.storage.saveLevel(name, app.level, app.paramsA, app.paramsB);
    refreshSaveList();
  }

  function refreshSaveList() {
    const box = $('#save-list');
    const saves = JR.storage.listSaves();
    if (!saves.length) {
      box.innerHTML = '<p class="hint">暂无存档。</p>';
      return;
    }
    box.innerHTML = saves.map((s) => `
      <div class="save-row">
        <b>${escapeHtml(s.name)}</b> <span class="dim">${new Date(s.at).toLocaleString('zh-CN', { hour12: false })}</span>
        <button class="mini" data-load="${escapeHtml(s.name)}">载入</button>
        <button class="mini danger" data-del="${escapeHtml(s.name)}">删</button>
      </div>`).join('');
    box.querySelectorAll('[data-load]').forEach((b) => (b.onclick = () => loadSave(b.dataset.load)));
    box.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { JR.storage.deleteSave(b.dataset.del); refreshSaveList(); }));
  }

  function applyRecord(rec) {
    app.level = rec.level;
    app.paramsA = { ...JR.DEFAULT_PARAMS_A, ...rec.paramsA };
    app.paramsB = { ...JR.DEFAULT_PARAMS_B, ...rec.paramsB };
    app.resultA = app.resultB = null;
    app.preview = null;
    app.selectedId = null;
    syncParams();
    render();
    renderResults();
    renderCompare();
    syncInspector();
  }

  function loadSave(name) {
    const rec = JR.storage.listSaves().find((s) => s.name === name);
    if (rec) applyRecord(rec);
  }

  function exportCurrent() {
    const rec = JR.storage.saveLevel('__export_tmp__', app.level, app.paramsA, app.paramsB);
    JR.storage.deleteSave('__export_tmp__');
    const blob = new Blob([JR.storage.exportJSON(rec)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'jump-level.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importFile(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        applyRecord(JR.storage.importJSON(reader.result));
      } catch (e) {
        alert('导入失败：' + e.message);
      }
    };
    reader.readAsText(file);
    ev.target.value = '';
  }

  let stepTimer = null;
  function toggleStepPlay() {
    app.stepPlaying = !app.stepPlaying;
    $('#step-play').textContent = app.stepPlaying ? '暂停自动' : '自动播放';
    if (stepTimer) { clearInterval(stepTimer); stepTimer = null; }
    if (app.stepPlaying) {
      stepTimer = setInterval(() => {
        if (!app.preview) { toggleStepPlay(); return; }
        if (app.stepIndex >= app.preview.frames.length - 1) { toggleStepPlay(); return; }
        app.stepIndex++;
        drawStepFrame();
      }, 1000 / 24);
    }
  }

  // ---------- 启动 ----------
  app.render = function () {
    JR.render.drawAll(app.ctx, {
      w: app.canvas.width,
      h: app.canvas.height,
      level: app.level,
      selectedId: app.selectedId,
      result: app.mode === 'edit' ? app.activeResult() : null,
      preview: app.mode === 'edit' ? app.preview : null,
      playFrame: app.mode === 'play' ? app.playFrame : null,
      mode: app.mode,
    });
  };

  window.addEventListener('DOMContentLoaded', () => {
    app.canvas = $('#stage');
    app.ctx = app.canvas.getContext('2d');
    JR.editor.createEditor(app.canvas, () => app, () => { app.render(); });
    buildParamPanel();
    bindUI();
    syncInspector();
    app.render();
  });
})();
