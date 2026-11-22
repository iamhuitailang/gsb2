/* global Sim */
/* app.js — 界面、编辑、运行控制、保存载入、示例场景 */
(function () {
  'use strict';
  const W = 12, H = 8;
  const { DIRS, COLORS, COLOR_NAMES, CONTENTION_NAMES } = Sim;

  // ---------- 全局状态 ----------
  let rules = Sim.defaultRules();
  let state = { grid: Sim.createGrid(W, H), blocks: [], tick: 0, nextId: 1 };
  let snapshot = takeSnapshot();
  let log = [];
  let timer = null;
  let tool = 'belt:E';
  let lastStatus = new Map(); // blockId -> moved|waiting|stuck|stopped（上一步结果，用于着色）

  function takeSnapshot() {
    return Sim.clone({ grid: state.grid, blocks: state.blocks, nextId: state.nextId });
  }
  function restoreSnapshot() {
    state.grid = Sim.clone(snapshot.grid);
    state.blocks = Sim.clone(snapshot.blocks);
    state.nextId = snapshot.nextId;
    state.tick = 0;
  }

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const gridEl = $('grid'), logEl = $('log'), bannerEl = $('banner');

  // ---------- 渲染 ----------
  function render() {
    $('tick').textContent = state.tick;
    $('blkCount').textContent = state.blocks.length;
    gridEl.style.gridTemplateColumns = `repeat(${W}, 46px)`;
    gridEl.innerHTML = '';
    const byPos = new Map(state.blocks.map((b) => [Sim.key(b.x, b.y), b]));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const cell = state.grid[y][x];
        const div = document.createElement('div');
        div.className = 'cell ' + cell.type;
        div.title = `(${x},${y})`;
        div.dataset.x = x; div.dataset.y = y;
        if (cell.type === 'belt') div.textContent = DIRS[cell.dir].arrow;
        else if (cell.type === 'splitter') {
          div.innerHTML =
            `<span class="sa">${DIRS[rules.splitter.matchDir].arrow}</span>` +
            `<span class="sb">${DIRS[rules.splitter.otherDir].arrow}</span>`;
          div.title += ` 分流：${COLOR_NAMES[rules.splitter.color]}→${DIRS[rules.splitter.matchDir].name}，其他→${DIRS[rules.splitter.otherDir].name}`;
        } else if (cell.type === 'stop') div.textContent = '■';
        const b = byPos.get(Sim.key(x, y));
        if (b) {
          const bd = document.createElement('div');
          const st = lastStatus.get(b.id);
          bd.className = 'blk ' + b.color + (st ? ' ' + st : '');
          bd.textContent = b.id;
          bd.title = `#${b.id} ${COLOR_NAMES[b.color]}` + (st ? ' · ' + statusName(st) : '');
          div.appendChild(bd);
        }
        gridEl.appendChild(div);
      }
    }
  }
  function statusName(s) {
    return { moved: '上一步移动成功', waiting: '等待（下步可恢复）', stuck: '卡死', stopped: '停止/无动力' }[s];
  }

  function setBanner(kind, text) {
    bannerEl.className = kind || '';
    bannerEl.textContent = text || '';
  }

  // ---------- 步骤记录 ----------
  function blkLabel(id) {
    const b = state.blocks.find((x) => x.id === id) || findInSnapshot(id);
    return `#${id}${b ? '·' + COLOR_NAMES[b.color] : ''}`;
  }
  function findInSnapshot(id) {
    return snapshot.blocks.find((x) => x.id === id);
  }

  function appendLogEntry(rec) {
    const d = document.createElement('details');
    d.open = true;
    const nW = rec.fails.filter((f) => f.cls === 'waiting').length;
    const nS = rec.fails.filter((f) => f.cls === 'stuck').length;
    const parts = [`移动 ${rec.moves.length}`];
    if (nW) parts.push(`等待 ${nW}`);
    if (nS) parts.push(`卡死 ${nS}`);
    if (rec.deadlock) parts.push('⚠ 死锁');
    const sum = document.createElement('summary');
    sum.innerHTML = `第 ${rec.tick} 步 · ${parts.join(' · ')}` +
      (rec.deadlock ? '<span class="tag bad">死锁</span>' : '');
    d.appendChild(sum);
    for (const m of rec.moves) {
      d.appendChild(line(`→ <b>${blkLabel(m.id)}</b> (${m.from}) → (${m.to}) 向${DIRS[m.dir].name}移动`, 'ok'));
    }
    for (const f of rec.fails) {
      const tag = f.cls === 'waiting' ? '等待' : '卡死';
      d.appendChild(line(`✕ <b>${blkLabel(f.id)}</b> ${f.reason} <span class="tag ${f.cls === 'waiting' ? 'wait' : 'bad'}">${tag}</span>`));
    }
    for (const s of rec.stays) {
      d.appendChild(line(`· <b>${blkLabel(s.id)}</b> ${s.reason}`));
    }
    logEl.appendChild(d);
    // 收起较早的条目，保持面板可读
    const items = logEl.querySelectorAll('details');
    if (items.length > 1) items[items.length - 2].open = false;
    while (logEl.children.length > 400) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function line(html) {
    const div = document.createElement('div');
    div.className = 'line';
    div.innerHTML = html;
    return div;
  }
  function sysLog(text) {
    const div = document.createElement('div');
    div.className = 'sys';
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------- 推进一步 ----------
  function step() {
    const rec = Sim.computeTick(state, rules);
    log.push(rec);
    lastStatus = new Map();
    for (const m of rec.moves) lastStatus.set(m.id, 'moved');
    for (const f of rec.fails) lastStatus.set(f.id, f.cls);
    for (const s of rec.stays) lastStatus.set(s.id, 'stopped');
    appendLogEntry(rec);
    render();
    if (rec.deadlock) {
      pause();
      setBanner('deadlock', `第 ${rec.tick} 步：所有移动提议都被阻挡 —— 死锁（见步骤记录）`);
    } else if (bannerEl.className === 'deadlock') {
      setBanner('', '');
    }
  }

  // ---------- 运行控制 ----------
  function run() {
    if (timer) return;
    $('btnRun').textContent = '⏸ 暂停';
    timer = setInterval(step, Number($('speed').value));
  }
  function pause() {
    clearInterval(timer);
    timer = null;
    $('btnRun').textContent = '▶ 运行';
  }
  $('btnRun').onclick = () => (timer ? pause() : run());
  $('btnStep').onclick = () => { pause(); step(); };
  $('btnRerun').onclick = () => {
    pause();
    restoreSnapshot();
    log = [];
    lastStatus = new Map();
    logEl.innerHTML = '';
    setBanner('info', '已从起点按当前规则重跑');
    sysLog(`↺ 从起点重跑（${ruleText()}）`);
    render();
  };
  $('btnSnapshot').onclick = () => {
    pause();
    snapshot = takeSnapshot();
    state.tick = 0;
    log = [];
    lastStatus = new Map();
    logEl.innerHTML = '';
    setBanner('info', '当前局面已设为起点');
    sysLog('⚑ 当前局面已设为起点');
    render();
  };
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
      e.preventDefault();
      timer ? pause() : run();
    }
  });

  // ---------- 规则面板 ----------
  function fillDirSelect(sel) {
    sel.innerHTML = '';
    for (const d of ['N', 'E', 'S', 'W']) {
      const o = document.createElement('option');
      o.value = d; o.textContent = DIRS[d].arrow + ' ' + DIRS[d].name;
      sel.appendChild(o);
    }
  }
  function fillColorSelect(sel) {
    sel.innerHTML = '';
    for (const c of COLORS) {
      const o = document.createElement('option');
      o.value = c; o.textContent = COLOR_NAMES[c];
      sel.appendChild(o);
    }
  }
  function ruleText() {
    return `争用：${CONTENTION_NAMES[rules.contention]}；分流：${COLOR_NAMES[rules.splitter.color]}→${DIRS[rules.splitter.matchDir].name}，其他→${DIRS[rules.splitter.otherDir].name}`;
  }
  function syncRuleUI() {
    $('ruleContention').value = rules.contention;
    $('splitColor').value = rules.splitter.color;
    $('splitMatch').value = rules.splitter.matchDir;
    $('splitOther').value = rules.splitter.otherDir;
    $('ruleText').textContent = ruleText();
  }
  fillColorSelect($('splitColor'));
  fillDirSelect($('splitMatch'));
  fillDirSelect($('splitOther'));
  $('ruleContention').onchange = (e) => { rules.contention = e.target.value; onRuleChange(); };
  $('splitColor').onchange = (e) => { rules.splitter.color = e.target.value; onRuleChange(); };
  $('splitMatch').onchange = (e) => { rules.splitter.matchDir = e.target.value; onRuleChange(); };
  $('splitOther').onchange = (e) => { rules.splitter.otherDir = e.target.value; onRuleChange(); };
  function onRuleChange() {
    syncRuleUI();
    render(); // 分流格箭头随规则更新
    setBanner('info', '规则已修改，点「重跑」从同一起点验证');
  }

  // ---------- 摆放工具 ----------
  const CELL_TOOLS = [
    ['belt:N', '↑'], ['belt:E', '→'], ['belt:S', '↓'], ['belt:W', '←'],
    ['splitter', '⑂ 分流'], ['stop', '■ 停止'], ['empty', '空地'],
  ];
  const palC = $('paletteCells');
  for (const [t, label] of CELL_TOOLS) {
    const b = document.createElement('button');
    b.className = 'tool-btn';
    b.textContent = label;
    b.dataset.tool = t;
    palC.appendChild(b);
  }
  const palB = $('paletteBlocks');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="swatch" style="background:${cssColor(c)}"></span>${COLOR_NAMES[c]}`;
    b.dataset.tool = 'block:' + c;
    palB.appendChild(b);
  }
  const delBtn = document.createElement('button');
  delBtn.textContent = '✕ 移除方块';
  delBtn.dataset.tool = 'delblock';
  palB.appendChild(delBtn);
  function cssColor(c) {
    return { red: '#d84a4a', blue: '#3f7fd9', green: '#3fae6a', yellow: '#d9a83f', purple: '#9a5fd0' }[c];
  }
  document.querySelectorAll('[data-tool]').forEach((b) => {
    b.onclick = () => {
      tool = b.dataset.tool;
      document.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('active', x === b));
    };
  });
  document.querySelector('[data-tool="belt:E"]').classList.add('active');

  function applyTool(x, y) {
    const cell = state.grid[y][x];
    const bi = state.blocks.findIndex((b) => b.x === x && b.y === y);
    if (tool.startsWith('belt:')) {
      cell.type = 'belt'; cell.dir = tool.slice(5);
    } else if (tool === 'splitter') {
      state.grid[y][x] = { type: 'splitter' };
    } else if (tool === 'stop') {
      state.grid[y][x] = { type: 'stop' };
    } else if (tool === 'empty') {
      state.grid[y][x] = { type: 'empty' };
      if (bi >= 0) state.blocks.splice(bi, 1); // 轨道拆了，方块一并移除
    } else if (tool.startsWith('block:')) {
      if (cell.type === 'empty') { setBanner('info', '方块只能放在轨道格上'); return; }
      if (bi >= 0) state.blocks.splice(bi, 1);
      state.blocks.push({ id: state.nextId++, color: tool.slice(6), x, y });
    } else if (tool === 'delblock') {
      if (bi >= 0) state.blocks.splice(bi, 1);
    }
  }
  function afterEdit() {
    pause();
    snapshot = takeSnapshot();
    state.tick = 0;
    log = [];
    lastStatus = new Map();
    logEl.innerHTML = '';
    sysLog('✎ 场景已编辑：回到起点（当前局面即新起点）');
    render();
  }
  let painting = false;
  gridEl.addEventListener('pointerdown', (e) => {
    const c = e.target.closest('.cell');
    if (!c) return;
    painting = true;
    applyTool(Number(c.dataset.x), Number(c.dataset.y));
    afterEdit();
  });
  gridEl.addEventListener('pointerover', (e) => {
    if (!painting || !tool.startsWith('belt:')) return; // 只有方向格支持拖动连画
    const c = e.target.closest('.cell');
    if (!c) return;
    applyTool(Number(c.dataset.x), Number(c.dataset.y));
    afterEdit();
  });
  window.addEventListener('pointerup', () => { painting = false; });

  // ---------- 示例场景 ----------
  function belt(g, x, y, d) { g[y][x] = { type: 'belt', dir: d }; }
  const EXAMPLES = {
    merge: () => {
      const g = Sim.createGrid(W, H);
      belt(g, 3, 0, 'S'); belt(g, 3, 1, 'S');
      belt(g, 3, 2, 'E'); belt(g, 4, 2, 'E'); belt(g, 5, 2, 'E'); belt(g, 6, 2, 'E');
      belt(g, 1, 2, 'E'); belt(g, 2, 2, 'E');
      return {
        grid: g,
        blocks: [{ id: 1, color: 'red', x: 3, y: 0 }, { id: 2, color: 'blue', x: 1, y: 2 }],
        nextId: 3,
        note: '第 2 步红蓝同时提议进入 (3,2)：切换争用规则再「重跑」，看谁先过。',
      };
    },
    split: () => {
      const g = Sim.createGrid(W, H);
      belt(g, 1, 2, 'E'); belt(g, 2, 2, 'E');
      g[2][3] = { type: 'splitter' };
      belt(g, 4, 2, 'E'); belt(g, 5, 2, 'E'); belt(g, 6, 2, 'E');
      belt(g, 3, 3, 'S'); belt(g, 3, 4, 'S'); belt(g, 3, 5, 'S');
      return {
        grid: g,
        blocks: [{ id: 1, color: 'red', x: 2, y: 2 }, { id: 2, color: 'blue', x: 1, y: 2 }],
        nextId: 3,
        rules: { contention: rules.contention, splitter: { color: 'red', matchDir: 'E', otherDir: 'S' } },
        note: '分流格：红块向右、其他颜色向下。改分流规则后「重跑」可验证不同走向。',
      };
    },
    loopGap: () => loopExample(false),
    loopFull: () => loopExample(true),
  };
  function loopExample(full) {
    const g = Sim.createGrid(W, H);
    const cells = [
      [2, 1, 'E'], [3, 1, 'E'], [4, 1, 'S'], [4, 2, 'S'],
      [4, 3, 'W'], [3, 3, 'W'], [2, 3, 'N'], [2, 2, 'N'],
    ];
    for (const [x, y, d] of cells) belt(g, x, y, d);
    const n = full ? 8 : 7; // 留 (2,2) 空位
    const blocks = [];
    for (let i = 0; i < n; i++) {
      blocks.push({ id: i + 1, color: COLORS[i % COLORS.length], x: cells[i][0], y: cells[i][1] });
    }
    return {
      grid: g, blocks, nextId: n + 1,
      note: full
        ? '循环带全满：提议构成闭环无空位，整环死锁（对比「环路（一空位）」）。'
        : '循环带留一个空位：空位沿环反向传递，整环方块每步同步前进一格；填满即死锁。',
    };
  }
  document.querySelectorAll('[data-ex]').forEach((b) => {
    b.onclick = () => {
      pause();
      const ex = EXAMPLES[b.dataset.ex]();
      state = { grid: ex.grid, blocks: ex.blocks, tick: 0, nextId: ex.nextId };
      if (ex.rules) { rules = Sim.clone(ex.rules); syncRuleUI(); }
      snapshot = takeSnapshot();
      log = [];
      lastStatus = new Map();
      logEl.innerHTML = '';
      $('exNote').textContent = ex.note;
      setBanner('info', '已载入示例：' + b.textContent);
      sysLog('▣ 载入示例「' + b.textContent + '」—— ' + ex.note);
      render();
    };
  });

  // ---------- 保存 / 载入 ----------
  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  $('btnExport').onclick = () => {
    download('conveyor-scene.json', {
      app: 'conveyor-rehearsal', version: 1,
      rules,
      snapshot,
      current: { grid: state.grid, blocks: state.blocks, tick: state.tick, nextId: state.nextId },
      log,
    });
    setBanner('info', '场景已导出（含地图、方块、步数、起点与规则）');
  };
  $('btnExportLog').onclick = () => {
    download('conveyor-steps.json', {
      app: 'conveyor-rehearsal', type: 'step-log',
      rules, snapshot, exportedAtTick: state.tick, log,
    });
    setBanner('info', `步骤记录已导出（对应场景第 0～${state.tick} 步）`);
  };
  $('btnImport').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.app !== 'conveyor-rehearsal') throw new Error('不是本工具的场景文件');
        pause();
        rules = data.rules || Sim.defaultRules();
        snapshot = data.snapshot;
        state = {
          grid: data.current.grid, blocks: data.current.blocks,
          tick: data.current.tick || 0, nextId: data.current.nextId || 1,
        };
        log = data.log || [];
        lastStatus = new Map();
        logEl.innerHTML = '';
        for (const rec of log) appendLogEntry(rec);
        syncRuleUI();
        setBanner('info', `已导入场景（第 ${state.tick} 步，记录 ${log.length} 条）`);
        sysLog(`⇪ 导入场景：从第 ${state.tick} 步继续`);
        render();
      } catch (err) {
        setBanner('deadlock', '导入失败：' + err.message);
      }
      e.target.value = '';
    };
    reader.readAsText(f);
  };

  // ---------- 启动 ----------
  syncRuleUI();
  EXAMPLES.merge && document.querySelector('[data-ex="merge"]').click();
})();
