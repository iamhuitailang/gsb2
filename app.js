/*
 * 试验页交互层：编辑（锚/砖/连接 + 锚连通高亮）、破坏（单击或框选批量）、
 * 暂停单步、撤回、时间线、存档导入导出与重跑校验。
 * 规则全部委托 engine.js，本文件只负责状态、渲染与输入。
 */
(function () {
  'use strict';
  const E = window.DestructEngine;
  const SAMPLES = window.DestructSamples;

  // 砖配色（颜色只是标签，不参与规则）
  const COLORS = [
    { fill: '#60a5fa', name: '蓝' },
    { fill: '#f59e0b', name: '橙' },
    { fill: '#34d399', name: '绿' },
    { fill: '#f472b6', name: '粉' },
    { fill: '#a78bfa', name: '紫' },
    { fill: '#94a3b8', name: '灰' },
  ];
  const ANCHOR_FILL = '#1f2937';
  const UNSUPPORTED_TINT = 'rgba(220,38,38,0.16)';

  const DEFAULT_W = 11;
  const DEFAULT_H = 9;
  const CELL = 40;
  const STORAGE_KEY = 'destruct-grid/autosave/v1';

  // ---------- 应用状态 ----------
  const app = {
    mode: 'edit', // edit | play
    tool: 'brick', // anchor | brick | edge | erase | destroy
    color: 0,
    engine: null,
    viewSeq: -1, // 当前查看的事件序号（-1 = 初始布局）
    selection: new Set(), // 破坏模式下框选的 cellKey
    drag: null, // 编辑/框选拖拽状态
    pendingEdge: null, // 连接工具：第一次点击的格
    recordedOps: [], // 本次运行已执行的破坏操作（用于存档/重跑）
    autoTimer: null,
  };

  const $ = (sel) => document.querySelector(sel);

  function newEngine(w, h) {
    app.engine = new E.Engine(w, h);
    app.viewSeq = -1;
    app.recordedOps = [];
    app.selection = new Set();
    app.pendingEdge = null;
  }

  // ---------- 渲染 ----------

  function currentSnapshotEngine() {
    // 事件快照里的 cells/edges 即为当前查看时刻的地图
    const eng = app.engine;
    if (app.viewSeq === -1 || app.viewSeq === eng.events.length - 1) return eng;
    // 临时构造一个只用于读取的引擎视图
    const ev = eng.events[app.viewSeq];
    const view = new E.Engine(eng.width, eng.height);
    view._restore(ev.snapshot);
    return view;
  }

  function render() {
    const eng = app.engine;
    const view = currentSnapshotEngine();
    const W = eng.width;
    const H = eng.height;

    const svg = $('#board');
    svg.setAttribute('width', W * CELL);
    svg.setAttribute('height', H * CELL);
    svg.setAttribute('viewBox', `0 0 ${W * CELL} ${H * CELL}`);

    const parts = [];

    // 网格线 + 地板
    for (let x = 0; x <= W; x++) {
      parts.push(
        `<line x1="${x * CELL}" y1="0" x2="${x * CELL}" y2="${H * CELL}" stroke="#e6e9ef" stroke-width="1"/>`
      );
    }
    for (let y = 0; y <= H; y++) {
      parts.push(
        `<line x1="0" y1="${y * CELL}" x2="${W * CELL}" y2="${y * CELL}" stroke="#e6e9ef" stroke-width="1"/>`
      );
    }
    parts.push(
      `<rect x="0" y="${H * CELL - 4}" width="${W * CELL}" height="4" fill="#374151"/>`
    );

    // 锚连通分析（基于当前视图）
    const info = E.computeConnectivity(view.width, view.height, view.cells, view.edges);

    // 连接（边）
    for (const ek of view.edges.keys()) {
      const { a, b } = E.parseEdgeKey(ek);
      const pa = E.parseKey(a);
      const pb = E.parseKey(b);
      const supported = info.supportedKeys.has(a) && info.supportedKeys.has(b);
      const horizontal = pa.y === pb.y;
      const x = (Math.min(pa.x, pb.x) + 0.5) * CELL;
      const y = (Math.min(pa.y, pb.y) + 0.5) * CELL;
      if (horizontal) {
        parts.push(
          `<line x1="${x}" y1="${y}" x2="${x + CELL}" y2="${y}" stroke="${supported ? '#059669' : '#b45309'}" stroke-width="5" stroke-linecap="round" opacity="0.85"/>`
        );
      } else {
        parts.push(
          `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + CELL}" stroke="${supported ? '#059669' : '#b45309'}" stroke-width="5" stroke-linecap="round" opacity="0.85"/>`
        );
      }
    }

    // 单元
    for (const [k, cell] of view.cells.entries()) {
      const { x, y } = E.parseKey(k);
      const px = x * CELL;
      const py = y * CELL;
      const supported = info.supportedKeys.has(k);
      let fill;
      if (cell.type === E.ANCHOR) fill = ANCHOR_FILL;
      else fill = COLORS[cell.color % COLORS.length].fill;

      // 未连到锚的砖：红色斜纹底提示
      if (cell.type === E.BRICK && !supported) {
        parts.push(
          `<rect x="${px + 2}" y="${py + 2}" width="${CELL - 4}" height="${CELL - 4}" rx="6" fill="${UNSUPPORTED_TINT}"/>`
        );
      }
      parts.push(
        `<rect class="cell-rect" data-key="${k}" x="${px + 3}" y="${py + 3}" width="${CELL - 6}" height="${CELL - 6}" rx="7" fill="${fill}" stroke="${cell.type === E.ANCHOR ? '#111827' : '#ffffff'}" stroke-width="1.5"/>`
      );
      if (cell.type === E.ANCHOR) {
        parts.push(
          `<text x="${px + CELL / 2}" y="${py + CELL / 2 + 5}" text-anchor="middle" font-size="15" font-weight="700" fill="#fff">锚</text>`
        );
      } else {
        parts.push(
          `<text x="${px + CELL / 2}" y="${py + CELL / 2 + 4}" text-anchor="middle" font-size="10" fill="rgba(0,0,0,0.55)">${cell.id}</text>`
        );
      }
    }

    // 破坏模式的框选
    if (app.mode === 'play' && app.selection.size) {
      for (const k of app.selection) {
        const { x, y } = E.parseKey(k);
        parts.push(
          `<rect x="${x * CELL + 2}" y="${y * CELL + 2}" width="${CELL - 4}" height="${CELL - 4}" rx="6" fill="rgba(220,38,38,0.25)" stroke="#dc2626" stroke-width="2" stroke-dasharray="5 3"/>`
        );
      }
    }

    // 连接工具的首击提示
    if (app.tool === 'edge' && app.pendingEdge) {
      const { x, y } = app.pendingEdge;
      parts.push(
        `<rect x="${x * CELL + 2}" y="${y * CELL + 2}" width="${CELL - 4}" height="${CELL - 4}" rx="6" fill="none" stroke="#2563eb" stroke-width="2.5"/>`
      );
    }

    svg.innerHTML = parts.join('');

    renderStats(info);
    renderTimeline();
    renderEventLog();
    renderModeUI();
  }

  function renderStats(info) {
    const view = currentSnapshotEngine();
    let bricks = 0;
    let anchors = 0;
    for (const c of view.cells.values()) {
      if (c.type === E.BRICK) bricks++;
      else anchors++;
    }
    const unsupported = Array.from(view.cells.keys()).filter(
      (k) => !info.supportedKeys.has(k) && view.cells.get(k).type === E.BRICK
    ).length;
    $('#stats').innerHTML =
      `<span>砖 <b>${bricks}</b></span>` +
      `<span>锚 <b>${anchors}</b></span>` +
      `<span>连接 <b>${view.edges.size}</b></span>` +
      `<span>团 <b>${info.clusters.length}</b></span>` +
      `<span>未连锚砖 <b style="color:${unsupported ? '#dc2626' : 'inherit'}">${unsupported}</b></span>`;
  }

  function renderTimeline() {
    const n = app.engine.events.length;
    const slider = $('#timeline');
    slider.max = Math.max(0, n - 1);
    slider.min = -1;
    slider.value = app.viewSeq;
    $('#timeline-pos').textContent =
      app.viewSeq === -1 ? '初始布局' : `${app.viewSeq + 1} / ${n} 事件`;
  }

  function eventSummary(ev) {
    const d = ev.data;
    switch (ev.type) {
      case 'removal':
        return `移除 ${d.removedCells.length} 块、断 ${d.explicitEdges.length + d.autoEdges.length} 条连接${d.label ? '：' + d.label : ''}`;
      case 'support-lost':
        return `团 ${d.clusters.map((c) => c.id).join('、')} 失去支撑，开始下落`;
      case 'mutual-hold':
        return `团 ${d.clusters.join('、')} 相互托住，均不下落（${d.reason}）`;
      case 'fall':
        return `团 ${d.clusterId} 整体下移一格`;
      case 'collision':
        return d.blocker === 'ground'
          ? `团 ${d.clusterId} 撞地板，落定`
          : `团 ${d.clusterId} 抢位 (${d.contested.x},${d.contested.y}) 被 ${d.blocker} 挡住；取舍：${d.tieRule}`;
      case 'settle':
        return `本步落定：砖数 ${d.brickCount}，团数 ${d.clusterCount}，指纹 ${d.hash}`;
      default:
        return ev.type;
    }
  }

  function renderEventLog() {
    const log = $('#event-log');
    const evs = app.engine.events;
    if (!evs.length) {
      log.innerHTML = '<div class="event-row"><span class="muted">暂无事件。进入“破坏”模式点掉一块砖，或加载样例。</span></div>';
      return;
    }
    log.innerHTML = evs
      .map(
        (ev, i) =>
          `<div class="event-row ${i === app.viewSeq ? 'current' : ''}" data-seq="${i}">
            <div class="ev-head">
              <span class="ev-type ${ev.type}">${ev.type}</span>
              <span class="ev-tick">#${i} · tick ${ev.tick}</span>
            </div>
            <div class="ev-detail">${escapeHtml(eventSummary(ev))}</div>
          </div>`
      )
      .join('');
    log.querySelectorAll('.event-row[data-seq]').forEach((row) => {
      row.addEventListener('click', () => {
        app.viewSeq = Number(row.dataset.seq);
        stopAuto();
        render();
      });
    });
    const cur = log.querySelector('.event-row.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function renderModeUI() {
    const isEdit = app.mode === 'edit';
    $('#mode-badge').className = 'mode-badge ' + app.mode;
    $('#mode-badge').textContent = isEdit ? '编辑模式' : '破坏/运行模式';
    $('#mode-note').textContent = isEdit
      ? '放置锚、砖和连接；红底砖表示当前没有任何沿边到锚的路径。'
      : '单击移除一块，或按住拖出红框批量移除；一批目标会先全部移除再统一结算。';

    document.querySelectorAll('[data-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === app.tool);
      btn.disabled = !isEdit && ['anchor', 'brick', 'edge', 'erase'].includes(btn.dataset.tool);
    });
    $('#btn-destroy').disabled = !isEdit;
    $('#btn-edit').disabled = isEdit;
    $('#btn-apply-destroy').disabled = isEdit || app.selection.size === 0;
    $('#btn-step').disabled = isEdit;
    $('#btn-run').disabled = isEdit;
    $('#color-row').style.opacity = isEdit ? 1 : 0.4;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
    );
  }

  // ---------- 坐标拾取 ----------

  function cellFromEvent(evt) {
    const svg = $('#board');
    const rect = svg.getBoundingClientRect();
    const x = Math.floor(((evt.clientX - rect.left) / rect.width) * app.engine.width);
    const y = Math.floor(((evt.clientY - rect.top) / rect.height) * app.engine.height);
    if (x < 0 || y < 0 || x >= app.engine.width || y >= app.engine.height) return null;
    return { x, y, key: E.cellKey(x, y) };
  }

  // ---------- 编辑交互 ----------

  function handleEditClick(cell) {
    const eng = app.engine;
    if (app.tool === 'anchor' || app.tool === 'brick') {
      if (eng.cells.has(cell.key)) return;
      eng.addCell(cell.x, cell.y, app.tool === 'anchor' ? E.ANCHOR : E.BRICK, app.color);
    } else if (app.tool === 'erase') {
      eng.removeCellEdit(cell.x, cell.y);
      app.pendingEdge = null;
    } else if (app.tool === 'edge') {
      if (!eng.cells.has(cell.key)) {
        app.pendingEdge = null;
        return;
      }
      if (!app.pendingEdge) {
        app.pendingEdge = cell;
      } else {
        if (app.pendingEdge.key !== cell.key) {
          const ok = eng.toggleEdge(
            app.pendingEdge.x,
            app.pendingEdge.y,
            cell.x,
            cell.y
          );
          if (!ok && !eng.hasEdge(app.pendingEdge.x, app.pendingEdge.y, cell.x, cell.y)) {
            toast('连接只能建在正交相邻的两个单元之间');
          }
        }
        app.pendingEdge = null;
      }
    }
    render();
  }

  // ---------- 破坏交互 ----------

  function cellsInRect(a, b) {
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    const out = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) out.push(E.cellKey(x, y));
    return out;
  }

  function handleDestroyPointer(cell, isDrag) {
    // 只能选择“最新时刻”地图上仍存在的非锚单元，避免选到历史残影
    const live = app.engine.cells.get(cell.key);
    if (!live || live.type === E.ANCHOR) return;
    if (isDrag) {
      for (const k of cellsInRect(app.drag.start, cell)) {
        const c = app.engine.cells.get(k);
        if (c && c.type !== E.ANCHOR) app.selection.add(k);
      }
    } else {
      app.selection.add(cell.key);
    }
    render();
  }

  function applyDestroy() {
    if (!app.selection.size) return;
    const settleCount = app.engine.events.filter((e) => e.type === 'settle').length;
    // 若正停在历史时刻，先截断未来事件，并把操作记录截到同一长度
    if (app.viewSeq < app.engine.events.length - 1) {
      app.engine.rewind(app.viewSeq);
      app.recordedOps = app.recordedOps.slice(0, settleCountAt(app.viewSeq));
    }
    const op = {
      cells: Array.from(app.selection).sort(),
      edges: [],
      label: `手动移除 ${app.selection.size} 块`,
    };
    app.engine.applyRemoval(op);
    app.recordedOps.push(op);
    app.selection = new Set();
    app.viewSeq = app.engine.events.length - 1;
    saveAutosave();
    render();
  }

  // 第 seq 个事件之前（含）有多少次 settle，即对应多少条已执行操作
  function settleCountAt(seq) {
    let n = 0;
    for (let i = 0; i <= seq && i < app.engine.events.length; i++) {
      if (app.engine.events[i].type === 'settle') n++;
    }
    return n;
  }

  // ---------- 单步 / 自动 ----------

  function stepBack() {
    if (app.viewSeq > -1) {
      app.viewSeq--;
      app.selection = new Set();
      stopAuto();
      render();
    }
  }
  function stepForward() {
    if (app.viewSeq < app.engine.events.length - 1) {
      app.viewSeq++;
      app.selection = new Set();
      render();
    }
  }
  function jumpLatest() {
    app.viewSeq = app.engine.events.length - 1;
    app.selection = new Set();
    stopAuto();
    render();
  }
  function jumpInitial() {
    app.viewSeq = -1;
    app.selection = new Set();
    stopAuto();
    render();
  }

  function toggleAuto() {
    if (app.autoTimer) {
      stopAuto();
      return;
    }
    $('#btn-run').textContent = '暂停';
    app.autoTimer = setInterval(() => {
      if (app.viewSeq < app.engine.events.length - 1) {
        app.viewSeq++;
        render();
      } else {
        stopAuto();
      }
    }, 650);
  }
  function stopAuto() {
    if (app.autoTimer) clearInterval(app.autoTimer);
    app.autoTimer = null;
    const btn = $('#btn-run');
    if (btn) btn.textContent = '自动播放';
  }

  // ---------- 模式切换 ----------

  function enterPlay() {
    app.mode = 'play';
    app.tool = 'destroy';
    app.engine.commitLayout();
    app.viewSeq = -1;
    app.recordedOps = [];
    app.selection = new Set();
    saveAutosave();
    render();
  }

  function enterEdit() {
    stopAuto();
    app.mode = 'edit';
    app.tool = 'brick';
    // 回到初始布局继续编辑，事件清空
    app.engine.reset();
    app.viewSeq = -1;
    app.recordedOps = [];
    app.selection = new Set();
    render();
  }

  // ---------- 存档 / 读档 / 重跑校验 ----------

  function buildScenario() {
    const eng = app.engine;
    return {
      format: 'destruct-grid/1',
      title: '规则试验存档',
      savedAt: new Date().toISOString(),
      layout: eng.exportLayout(),
      operations: app.recordedOps,
    };
  }

  function saveAutosave() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildScenario()));
    } catch (_) {
      /* 隐私模式等情况下忽略 */
    }
  }

  function loadAutosave() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const scenario = JSON.parse(raw);
      loadScenario(scenario, true);
      return true;
    } catch (_) {
      return false;
    }
  }

  function loadScenario(scenario, replay) {
    if (!scenario || scenario.format !== 'destruct-grid/1' || !scenario.layout) {
      throw new Error('文件格式无法识别（需要 destruct-grid/1）');
    }
    const layout = scenario.layout;
    newEngine(layout.width, layout.height);
    app.engine.loadLayout(layout);
    app.engine.commitLayout();
    app.recordedOps = [];
    if (replay && Array.isArray(scenario.operations) && scenario.operations.length) {
      app.mode = 'play';
      app.tool = 'destroy';
      for (const op of scenario.operations) {
        app.engine.applyRemoval(op);
        app.recordedOps.push(op);
      }
      app.viewSeq = app.engine.events.length - 1;
    } else {
      app.mode = 'edit';
      app.tool = 'brick';
      app.viewSeq = -1;
    }
    saveAutosave();
    render();
  }

  function exportFile() {
    const scenario = buildScenario();
    const blob = new Blob([JSON.stringify(scenario, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'destruct-grid-scenario.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('已保存布局与破坏操作（JSON）');
  }

  function exportLog() {
    const lines = [];
    lines.push('# 二维可破坏结构 · 逐步记录');
    lines.push(`生成时间: ${new Date().toLocaleString()}`);
    lines.push(`地图: ${app.engine.width} x ${app.engine.height}`);
    lines.push('');
    app.engine.events.forEach((ev, i) => {
      lines.push(`## 事件 ${i}  tick=${ev.tick}  type=${ev.type}`);
      lines.push(eventSummary(ev));
      lines.push(`快照指纹: ${ev.hash}`);
      lines.push('');
    });
    const verify = E.verifyScenario(
      app.engine.exportLayout(),
      app.recordedOps
    );
    lines.push('## 重跑校验');
    lines.push(
      `结果: ${verify.ok ? '通过' : '失败'}；预期砖数 ${verify.expectedBricks}，实际砖数 ${verify.finalBricks}；最终指纹 ${verify.finalHash}`
    );
    verify.stepChecks.forEach((s) => {
      lines.push(
        `- 操作 ${s.operation + 1}: 砖数 ${s.brickCount}, 无重叠=${s.noOverlap}, 边有效=${s.edgesValid}, 指纹 ${s.hash}`
      );
    });
    const blob = new Blob([lines.join('\n'), { type: 'text/markdown' }]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'destruct-grid-log.md';
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出可读逐步记录（Markdown）');
  }

  function runVerification() {
    const box = $('#verify-box');
    const r = E.verifyScenario(app.engine.exportLayout(), app.recordedOps);
    box.className = 'verify-box ' + (r.ok ? 'ok' : 'bad');
    const perStep = r.stepChecks
      .map(
        (s) =>
          `操作${s.operation + 1}: 砖${s.brickCount} 指纹<code>${s.hash}</code>`
      )
      .join(' ｜ ');
    box.innerHTML =
      (r.ok ? '✅ 重跑校验通过' : '❌ 校验失败') +
      `：预期/实际砖数 <b>${r.expectedBricks}/${r.finalBricks}</b>，最终指纹 <code>${r.finalHash}</code><br><span class="muted">${perStep || '尚无破坏操作'}</span>`;
  }

  // ---------- Toast ----------

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  // ---------- 事件绑定 ----------

  function bind() {
    // 工具
    document.querySelectorAll('[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (app.mode !== 'edit') return;
        app.tool = btn.dataset.tool;
        app.pendingEdge = null;
        render();
      });
    });
    // 色板
    const row = $('#color-row');
    COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'swatch' + (i === app.color ? ' active' : '');
      b.style.background = c.fill;
      b.title = c.name;
      b.addEventListener('click', () => {
        app.color = i;
        row.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
        b.classList.add('active');
      });
      row.appendChild(b);
    });

    // SVG 指针
    const svg = $('#board');
    svg.addEventListener('pointerdown', (evt) => {
      const cell = cellFromEvent(evt);
      if (!cell) return;
      if (app.mode === 'edit') {
        handleEditClick(cell);
        app.drag = { tool: app.tool, start: cell, painted: new Set([cell.key]) };
      } else {
        app.drag = { tool: 'destroy', start: cell, painted: new Set() };
        handleDestroyPointer(cell, false);
      }
    });
    svg.addEventListener('pointermove', (evt) => {
      if (!app.drag) return;
      const cell = cellFromEvent(evt);
      if (!cell) return;
      if (app.mode === 'edit' && (app.drag.tool === 'anchor' || app.drag.tool === 'brick' || app.drag.tool === 'erase')) {
        if (app.drag.painted.has(cell.key)) return;
        app.drag.painted.add(cell.key);
        handleEditClick(cell);
      } else if (app.mode === 'play') {
        handleDestroyPointer(cell, true);
      }
    });
    window.addEventListener('pointerup', () => {
      app.drag = null;
    });

    // 模式
    $('#btn-destroy').addEventListener('click', enterPlay);
    $('#btn-edit').addEventListener('click', enterEdit);
    $('#btn-apply-destroy').addEventListener('click', applyDestroy);
    $('#btn-clear-selection').addEventListener('click', () => {
      app.selection = new Set();
      render();
    });

    // 运行控制
    $('#btn-start').addEventListener('click', jumpInitial);
    $('#btn-step-back').addEventListener('click', stepBack);
    $('#btn-step').addEventListener('click', stepForward);
    $('#btn-latest').addEventListener('click', jumpLatest);
    $('#btn-run').addEventListener('click', toggleAuto);
    $('#timeline').addEventListener('input', (evt) => {
      stopAuto();
      app.selection = new Set();
      app.viewSeq = Number(evt.target.value);
      render();
    });

    // 存档
    $('#btn-export').addEventListener('click', exportFile);
    $('#btn-export-log').addEventListener('click', exportLog);
    $('#btn-verify').addEventListener('click', runVerification);
    $('#file-input').addEventListener('change', (evt) => {
      const file = evt.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          loadScenario(JSON.parse(reader.result), true);
          toast('已打开存档并重跑全部破坏操作');
        } catch (err) {
          toast('读档失败：' + err.message);
        }
      };
      reader.readAsText(file);
      evt.target.value = '';
    });
    $('#btn-import').addEventListener('click', () => $('#file-input').click());

    // 样例
    document.querySelectorAll('[data-sample]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const factory = SAMPLES[btn.dataset.sample];
        const s = factory();
        stopAuto();
        loadScenario(
          { format: 'destruct-grid/1', layout: s.layout, operations: s.operations },
          true
        );
        $('#sample-title').textContent = s.title;
        $('#sample-desc').textContent = s.description + ' 预期：' + s.expect;
        runVerification();
        toast('已加载 ' + s.title);
      });
    });

    // 新地图
    $('#btn-new').addEventListener('click', () => {
      stopAuto();
      newEngine(DEFAULT_W, DEFAULT_H);
      app.mode = 'edit';
      app.tool = 'brick';
      $('#sample-title').textContent = '空白画布';
      $('#sample-desc').textContent = '在左侧选工具开始摆放；编辑时红底砖即未连到锚。';
      $('#verify-box').className = 'verify-box idle';
      $('#verify-box').textContent = '加载样例或执行破坏后可重跑校验。';
      render();
    });

    // 离开页面自动存档
    window.addEventListener('beforeunload', saveAutosave);
  }

  // ---------- 启动 ----------

  function init() {
    bind();
    const sampleId = new URLSearchParams(location.search).get('sample');
    const wantEdit = new URLSearchParams(location.search).get('mode') === 'edit';
    if (sampleId && SAMPLES[sampleId]) {
      const s = SAMPLES[sampleId]();
      stopAuto();
      loadScenario(
        { format: 'destruct-grid/1', layout: s.layout, operations: s.operations },
        !wantEdit
      );
      if (wantEdit) {
        // 仅看初始布局与锚连通，不重放破坏
        app.mode = 'edit';
        app.tool = 'brick';
      }
      $('#sample-title').textContent = s.title;
      $('#sample-desc').textContent = s.description + ' 预期：' + s.expect;
      if (!wantEdit) runVerification();
    } else if (!loadAutosave()) {
      newEngine(DEFAULT_W, DEFAULT_H);
      $('#sample-title').textContent = '空白画布';
      $('#sample-desc').textContent = '在左侧选工具开始摆放；编辑时红底砖即未连到锚。';
    } else {
      $('#sample-title').textContent = '上次自动存档';
      $('#sample-desc').textContent = '已从浏览器本地恢复布局与操作；可点左侧样例切换。';
    }
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
