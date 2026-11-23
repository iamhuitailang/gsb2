/* 界面层：所有规则判断都在 engine.js，这里只负责渲染与交互 */
(function () {
  'use strict';
  const G = window.GEngine;
  const LEVEL = G.LEVEL;
  const CELL = 40;
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');

  let game = G.createGame();
  let routeTimer = null;
  let activeRoute = null;       // 'A' | 'B' | null
  let routeIndex = 0;
  let eventFilters = new Set(['state', 'checkpoint', 'respawn', 'death', 'item', 'finish', 'respawn-blocked']);

  const COLORS = {
    wall: '#334155',
    floor: '#1e293b',
    floorAlt: '#223047',
    pit: '#020617',
    lava: '#dc2626',
    lavaGlow: '#f97316',
    spike: '#94a3b8',
    player: '#fde047',
    cp: '#38bdf8',
    cpActive: '#22d3ee',
    finish: '#4ade80',
  };

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 底图
    for (let y = 0; y < LEVEL.height; y++) {
      for (let x = 0; x < LEVEL.width; x++) {
        const t = G.tileAt(LEVEL, x, y);
        const px = x * CELL, py = y * CELL;
        if (t === G.TILE.WALL) fill(px, py, COLORS.wall);
        else {
          fill(px, py, (x + y) % 2 ? COLORS.floor : COLORS.floorAlt);
          if (t === G.TILE.PIT) drawPit(px, py);
          if (t === G.TILE.LAVA) drawLava(px, py);
          if (t === G.TILE.SPIKE) drawSpike(px, py);
        }
      }
    }
    // 演练封锁标记
    for (const k of game.overrideHazards) {
      const [x, y] = k.split(',').map(Number);
      ctx.fillStyle = 'rgba(249,113,166,0.35)';
      ctx.fillRect(x * CELL + 2, y * CELL + 2, CELL - 4, CELL - 4);
    }
    // 机关（门/桥）
    for (const m of LEVEL.mechanisms) drawMechanism(m);
    // 检查点
    for (const cp of LEVEL.checkpoints) drawCheckpoint(cp);
    // 终点
    drawFinish(LEVEL.finish);
    // 开关
    for (const sw of LEVEL.switches) drawSwitch(sw);
    // 道具
    for (const it of LEVEL.items) drawItem(it);
    // 起点标记
    drawStart(LEVEL.start);
    // 玩家
    drawPlayer(game.player);
  }

  function fill(px, py, color) {
    ctx.fillStyle = color;
    ctx.fillRect(px, py, CELL, CELL);
  }
  function drawPit(px, py) {
    ctx.fillStyle = COLORS.pit;
    ctx.fillRect(px + 3, py + 3, CELL - 6, CELL - 6);
    ctx.strokeStyle = '#475569';
    ctx.strokeRect(px + 3.5, py + 3.5, CELL - 7, CELL - 7);
  }
  function drawLava(px, py) {
    ctx.fillStyle = COLORS.lava;
    ctx.fillRect(px + 2, py + 2, CELL - 4, CELL - 4);
    ctx.fillStyle = COLORS.lavaGlow;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(px + 10 + i * 10, py + CELL - 9, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  function drawSpike(px, py) {
    ctx.fillStyle = COLORS.spike;
    for (let i = 0; i < 3; i++) {
      const bx = px + 6 + i * 11;
      ctx.beginPath();
      ctx.moveTo(bx, py + CELL - 6);
      ctx.lineTo(bx + 5, py + 8);
      ctx.lineTo(bx + 10, py + CELL - 6);
      ctx.closePath();
      ctx.fill();
    }
  }
  function drawMechanism(m) {
    const px = m.x * CELL, py = m.y * CELL;
    const closed = G.mechanismClosed(LEVEL, game, m);
    const sw = LEVEL.switches.find((s) => s.id === m.switchId);
    if (m.type === 'gate') {
      if (closed) {
        ctx.fillStyle = sw.color;
        ctx.fillRect(px + 4, py + 2, CELL - 8, CELL - 4);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        for (let i = 0; i < 3; i++) ctx.fillRect(px + 6, py + 8 + i * 9, CELL - 12, 2);
      } else {
        ctx.strokeStyle = sw.color;
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 5, py + 5, CELL - 10, CELL - 10);
        ctx.globalAlpha = 1;
      }
    } else if (m.type === 'bridge') {
      if (!closed) {
        ctx.fillStyle = '#0ea5e9';
        ctx.fillRect(px + 2, py + 10, CELL - 4, CELL - 20);
        ctx.strokeStyle = '#7dd3fc';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(px + 6 + i * 8, py + 10);
          ctx.lineTo(px + 6 + i * 8, py + CELL - 10);
          ctx.stroke();
        }
      }
    }
  }
  function drawCheckpoint(cp) {
    const px = cp.x * CELL, py = cp.y * CELL;
    const active = game.activeCheckpointId === cp.id;
    const reached = cpIndexOf(cp.id) <= game.activeCheckpointIndex;
    ctx.fillStyle = active ? COLORS.cpActive : reached ? '#0e7490' : 'rgba(56,189,248,0.35)';
    ctx.beginPath();
    ctx.arc(px + CELL / 2, py + CELL / 2, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#e0f2fe';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#082f49';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cpIndexOf(cp.id) + 1, px + CELL / 2, py + CELL / 2 + 0.5);
  }
  function drawFinish(f) {
    const px = f.x * CELL, py = f.y * CELL;
    ctx.fillStyle = COLORS.finish;
    ctx.fillRect(px + 8, py + 8, CELL - 16, CELL - 16);
    ctx.strokeStyle = '#052e16';
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 8.5, py + 8.5, CELL - 17, CELL - 17);
    ctx.fillStyle = '#052e16';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('终', px + CELL / 2, py + CELL / 2 + 0.5);
  }
  function drawSwitch(sw) {
    const px = sw.x * CELL, py = sw.y * CELL;
    const on = game.switches[sw.id];
    ctx.fillStyle = sw.color;
    ctx.globalAlpha = on ? 1 : 0.4;
    ctx.beginPath();
    ctx.roundRect(px + 7, py + 7, CELL - 14, CELL - 14, 5);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = on ? '#052e16' : '#1f2937';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(on ? 'ON' : 'OFF', px + CELL / 2, py + CELL / 2 + 0.5);
  }
  function drawItem(it) {
    const px = it.x * CELL, py = it.y * CELL;
    const n = game.items[it.id];
    if (n <= 0) {
      ctx.strokeStyle = 'rgba(148,163,184,0.3)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px + 12, py + 12, CELL - 24, CELL - 24);
      return;
    }
    ctx.fillStyle = '#a78bfa';
    ctx.beginPath();
    ctx.arc(px + CELL / 2, py + CELL / 2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2e1065';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(n, px + CELL / 2, py + CELL / 2 + 0.5);
  }
  function drawStart(s) {
    const px = s.x * CELL, py = s.y * CELL;
    ctx.strokeStyle = 'rgba(253,224,71,0.7)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(px + 4, py + 4, CELL - 8, CELL - 8);
    ctx.setLineDash([]);
  }
  function drawPlayer(p) {
    const px = p.x * CELL, py = p.y * CELL;
    ctx.fillStyle = COLORS.player;
    ctx.beginPath();
    ctx.roundRect(px + 8, py + 8, CELL - 16, CELL - 16, 4);
    ctx.fill();
    ctx.strokeStyle = '#a16207';
    ctx.lineWidth = 2;
    ctx.stroke();
    // 眼睛朝向简化为两点
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(px + 14, py + 15, 4, 4);
    ctx.fillRect(px + 22, py + 15, 4, 4);
  }
  function cpIndexOf(id) {
    return LEVEL.checkpoints.findIndex((c) => c.id === id);
  }

  /* ------------------------------------------------------------------ *
   * 侧栏：策略 / 状态 / 事件
   * ------------------------------------------------------------------ */
  function renderPolicyList() {
    const root = document.getElementById('policyList');
    root.innerHTML = '';
    const groups = [
      { title: '开关', list: LEVEL.switches },
      { title: '道具', list: LEVEL.items },
    ];
    for (const grp of groups) {
      const h = document.createElement('div');
      h.className = 'policy-group-title';
      h.textContent = grp.title;
      h.style.cssText = 'color:var(--muted);font-size:12px;margin:4px 0';
      root.appendChild(h);
      for (const obj of grp.list) {
        const row = document.createElement('div');
        row.className = 'policy-row';
        const color = obj.color || '#a78bfa';
        row.innerHTML =
          '<div class="pname"><span class="dot" style="background:' + color + '"></span>' + obj.name + '</div>' +
          '<select data-id="' + obj.id + '">' +
          ['keep', 'checkpoint', 'init'].map((p) =>
            '<option value="' + p + '"' + (game.policies[obj.id] === p ? ' selected' : '') + '>' +
            G.POLICY_LABEL[p] + '</option>').join('') +
          '</select>' +
          (obj.desc ? '<div class="pdesc">' + obj.desc + '</div>'
            : '<div class="pdesc">数量上限 ' + obj.max + '，拾取消耗</div>');
        root.appendChild(row);
      }
    }
    root.querySelectorAll('select').forEach((sel) => {
      sel.addEventListener('change', () => {
        G.setPolicy(game, sel.dataset.id, sel.value);
        refresh();
      });
    });
  }

  function renderStateGrid() {
    const grid = document.getElementById('stateGrid');
    const cells = [];
    for (const sw of LEVEL.switches) {
      cells.push({ k: sw.name, v: game.switches[sw.id] ? 'ON' : 'OFF', cls: game.switches[sw.id] ? 'on' : 'off' });
    }
    for (const it of LEVEL.items) {
      cells.push({ k: it.name + ' 余量', v: game.items[it.id] + ' / ' + it.max, cls: '' });
    }
    grid.innerHTML = cells.map((c) =>
      '<div class="state-cell ' + c.cls + '"><span class="k">' + c.k + '</span><span class="v">' + c.v + '</span></div>'
    ).join('');

    document.getElementById('stepLabel').textContent = '步数 ' + game.step;
    document.getElementById('deathLabel').textContent = '死亡 ' + game.deaths;
    const cpName = game.activeCheckpointIndex < 0
      ? '起点'
      : LEVEL.checkpoints[game.activeCheckpointIndex].name;
    document.getElementById('cpLabel').textContent = '有效检查点：' + cpName;
  }

  let showAllEvents = false;
  function renderEventLog() {
    const log = document.getElementById('eventLog');
    const rows = game.events.filter((e) => showAllEvents || eventFilters.has(e.type));
    log.innerHTML = rows.map((e) => {
      let extra = '';
      if (e.type === 'respawn' && e.data.sources) {
        extra = '<div class="source-line">' + e.data.sources.map((s) =>
          '<span class="tag ' + s.from + '">' + G.FROM_LABEL[s.from] + '</span>' +
          s.name + '：' + fmtVal(s.kind, s.before) + ' → ' + fmtVal(s.kind, s.after)
        ).join('<br>') + '</div>';
      }
      if (e.type === 'death' && e.data.candidates) {
        extra = '<div class="source-line">候选 ' + e.data.candidates.length +
          ' 个，首个安全：' + (e.data.candidates.find((c) => c.safe)?.label || '无') + '</div>';
      }
      return '<div class="event ' + e.type + '"><span class="meta">#' + e.seq + ' 步' + e.step +
        '</span>' + e.message + extra + '</div>';
    }).join('');
    log.scrollTop = log.scrollHeight;
  }
  function fmtVal(kind, v) { return kind === 'switch' ? (v ? 'ON' : 'OFF') : v; }

  /* ------------------------------------------------------------------ *
   * 死亡决策面板
   * ------------------------------------------------------------------ */
  function renderDeathOverlay() {
    const ov = document.getElementById('deathOverlay');
    if (!game.pendingRespawn) { ov.classList.add('hidden'); return; }
    ov.classList.remove('hidden');
    document.getElementById('deathReason').textContent =
      '死因：' + game.pendingRespawn.reason;
    const list = document.getElementById('candidateList');
    list.innerHTML = game.pendingRespawn.candidates.map((c) =>
      '<div class="candidate ' + (c.safe ? 'safe' : 'unsafe') + '">' +
      '<span>' + c.label + ' (' + c.x + ',' + c.y + ')</span>' +
      '<span class="reason">' + (c.safe ? '✓ 安全可用' : '✗ ' + c.reason) + '</span></div>'
    ).join('');
  }

  /* ------------------------------------------------------------------ *
   * 指令分发与自动路线
   * ------------------------------------------------------------------ */
  function issue(cmd) {
    G.doCommand(game, cmd);
    // 死亡由引擎进入 pending；若在自动路线中，停表等玩家在面板上选择，但保留路线断点
    if (game.pendingRespawn) pauseRouteTimer();
    refresh();
  }

  function respawn(mode) {
    G.doCommand(game, G.respawnCommand(mode));
    refresh();
    // 自动路线中处理完死亡后，从断点续跑剩余指令
    if (activeRoute && !game.pendingRespawn && !game.finished) {
      document.getElementById('btnPause').disabled = false;
      document.getElementById('btnPause').textContent = '暂停';
      routeTimer = setTimeout(tickRoute, 320);
    }
  }

  function startRoute(name) {
    stopRoute();
    restart(false);
    activeRoute = name;
    routeIndex = 0;
    document.getElementById('btnPause').disabled = false;
    tickRoute();
  }
  function pauseRouteTimer() {
    if (routeTimer) clearTimeout(routeTimer);
    routeTimer = null;
    document.getElementById('btnPause').disabled = !activeRoute;
    if (activeRoute) document.getElementById('btnPause').textContent = '继续';
  }
  function tickRoute() {
    if (!activeRoute) return;
    const cmds = G.ROUTES[activeRoute].commands;
    if (routeIndex >= cmds.length || game.finished) { stopRoute(true); return; }
    if (game.pendingRespawn) { pauseRouteTimer(); return; }
    issue(cmds[routeIndex++]);
    if (game.pendingRespawn || game.finished) { pauseRouteTimer(); return; }
    routeTimer = setTimeout(tickRoute, 240);
  }
  function stopRoute(finished) {
    if (routeTimer) clearTimeout(routeTimer);
    routeTimer = null;
    activeRoute = null;
    document.getElementById('btnPause').disabled = true;
    document.getElementById('btnPause').textContent = '暂停';
    if (finished) refresh();
  }

  function restart(stop = true) {
    if (stop) stopRoute();
    game = G.createGame();
    document.getElementById('verifyReport').textContent = '';
    document.getElementById('verifyReport').className = 'verify-report';
    refresh();
  }

  function refresh() {
    draw();
    renderPolicyList();
    renderStateGrid();
    renderEventLog();
    renderDeathOverlay();
  }

  /* ------------------------------------------------------------------ *
   * 存档 / 重放
   * ------------------------------------------------------------------ */
  function saveBundle() {
    const bundle = G.buildBundle(game, { savedFromUI: true });
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cp-respawn-' + Date.now() + '.json';
    a.click();
    URL.revokeObjectURL(url);
    // 同时写 localStorage，刷新页面可继续
    try { localStorage.setItem('cp-respawn-last', JSON.stringify(bundle)); } catch (_) {}
  }

  function verifyFromStart() {
    const bundle = G.buildBundle(game, { verify: true });
    const report = G.verifyBundle(bundle);
    const el = document.getElementById('verifyReport');
    const lines = [];
    lines.push((report.ok ? '✓ 重放一致' : '✗ 发现偏差') +
      '｜指令数 ' + report.commandCount + '｜死亡 ' + report.finalState.deaths +
      '｜最终位置 (' + report.finalState.player.x + ',' + report.finalState.player.y + ')');
    lines.push('最终检查点：' + (report.finalState.activeCheckpointId || '起点') +
      '｜通关：' + (report.finalState.finished ? '是' : '否'));
    if (report.mismatches.length) {
      lines.push('\n偏差明细（前 5 条）：');
      report.mismatches.slice(0, 5).forEach((m) =>
        lines.push('  指令#' + m.index + ' ' + JSON.stringify(m.cmd) + '\n    期望 ' + m.expected + '\n    实际 ' + m.actual));
    }
    lines.push('\n每次死亡前后值：');
    report.deathReports.forEach((d, i) => {
      lines.push('— 死亡 ' + (i + 1) + '（步' + d.step + '）重生在 ' + d.target.label);
      lines.push('  前：' + JSON.stringify({ sw: d.before.switches, it: d.before.items }));
      lines.push('  后：' + JSON.stringify({ sw: d.after.switches, it: d.after.items }));
    });
    el.textContent = lines.join('\n');
    el.className = 'verify-report ' + (report.ok ? 'ok' : 'bad');
  }

  function importBundle(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const bundle = JSON.parse(reader.result);
        const report = G.verifyBundle(bundle);
        // 重放成功则把重放出的状态接回界面
        if (report.ok) {
          const sim = G.createGame(bundle.policies);
          bundle.commands.forEach((c) => G.doCommand(sim, c));
          if (sim.pendingRespawn) G.doRespawn(sim);
          game = sim;
          refresh();
        }
        const el = document.getElementById('verifyReport');
        el.textContent = '导入存档重放：' + (report.ok ? '✓ 一致，已载入' : '✗ 不一致，未载入') +
          '\n' + JSON.stringify(report.mismatches.slice(0, 3), null, 2);
        el.className = 'verify-report ' + (report.ok ? 'ok' : 'bad');
      } catch (err) {
        alert('存档解析失败：' + err.message);
      }
    };
    reader.readAsText(file);
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */
  document.querySelectorAll('.dbtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = btn.dataset.dir;
      if (d === 'act') issue({ type: 'interact' });
      else issue({ type: 'move', dir: d });
    });
  });
  window.addEventListener('keydown', (e) => {
    const map = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right',
    };
    if (map[e.key]) { e.preventDefault(); issue({ type: 'move', dir: map[e.key] }); }
    else if (e.key === ' ') { e.preventDefault(); issue({ type: 'interact' }); }
  });
  document.getElementById('btnRouteA').addEventListener('click', () => startRoute('A'));
  document.getElementById('btnRouteB').addEventListener('click', () => startRoute('B'));
  document.getElementById('btnEmergency').addEventListener('click', () => issue({ type: 'emergency' }));
  document.getElementById('btnPause').addEventListener('click', () => {
    if (routeTimer) { clearTimeout(routeTimer); routeTimer = null; document.getElementById('btnPause').textContent = '继续'; }
    else if (activeRoute) { document.getElementById('btnPause').textContent = '暂停'; tickRoute(); }
  });
  document.getElementById('btnRestart').addEventListener('click', () => restart());
  document.getElementById('btnRespawn').addEventListener('click', () => respawn());
  document.getElementById('btnResetMech').addEventListener('click', () => respawn('reset-mech'));
  document.getElementById('btnResetInit').addEventListener('click', () => respawn('reset-init'));
  document.getElementById('btnSave').addEventListener('click', saveBundle);
  document.getElementById('btnVerify').addEventListener('click', verifyFromStart);
  document.getElementById('fileImport').addEventListener('change', (e) => {
    if (e.target.files[0]) importBundle(e.target.files[0]);
    e.target.value = '';
  });
  document.querySelectorAll('.filter-group input').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.dataset.filter === 'all') {
        showAllEvents = cb.checked;
      } else {
        document.querySelector('.filter-group input[data-filter="all"]').checked = false;
        showAllEvents = false;
        if (cb.checked) eventFilters.add(cb.dataset.filter);
        else eventFilters.delete(cb.dataset.filter);
      }
      renderEventLog();
    });
  });

  refresh();
})();
