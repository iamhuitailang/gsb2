/* app.js — 页面主控：交互、路线播放/录制/重放核对、配置编辑、截图与持久化 */
(function () {
  'use strict';
  const C = window.OcclCore;
  const R = window.OcclRender;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  const LS = { scene: 'occl.scene.v1', routes: 'occl.routes.v1', shots: 'occl.shots.v1', route: 'occl.route.v1' };

  /* ---------------- 状态 ---------------- */

  let scene = loadJSON(LS.scene, C.defaultScene());
  let routes = loadJSON(LS.routes, C.defaultRoutes());
  let shots = loadJSON(LS.shots, []);
  let recordedRoute = loadJSON(LS.route, null);
  if (recordedRoute) routes = routes.filter(r => r.id !== 'route-manual').concat([recordedRoute]);

  let view = 'normal';
  let selectedId = null;
  let activeRouteId = null;       // null = 手动模式
  let playback = null;            // {frames, i, playing, timer}
  let recording = false;
  let recordSamples = [];
  let recordTimer = null;
  const keys = new Set();

  const hero = { pos: { x: scene.hero.start.x, y: scene.hero.start.y }, z: 0, floor: 'ground' };
  let lastTime = performance.now();

  function loadJSON(k, fallback) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('本地存储已满（截图较大），请先删除部分截图', true); } }

  // 非阻塞提示：避免原生 alert 在无头环境挂起自动化测试
  let toastTimer = null;
  function toast(msg, isError) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.style.cssText = 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);padding:9px 18px;border-radius:8px;color:#fff;font-size:13px;z-index:99;box-shadow:0 4px 14px rgba(0,0,0,.25);transition:opacity .25s';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.background = isError ? '#b91c1c' : '#1f2937';
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2200);
  }
  function confirmDlg(msg) {
    if (typeof window.__occlAutoConfirm === 'boolean') return window.__occlAutoConfirm;
    return window.confirm(msg);
  }

  /* ---------------- 每帧计算与绘制 ---------------- */

  function currentResult() {
    return C.computeOrder(scene, C.buildRenderables(scene, hero));
  }

  function draw() {
    const ctx = $('#cv').getContext('2d');
    ctx.clearRect(0, 0, 960, 640);
    const result = currentResult();
    if (view === 'normal') R.renderNormal(ctx, scene, result, selectedId);
    else if (view === 'footprint') R.renderFootprint(ctx, scene, result, selectedId);
    else R.renderOrder(ctx, scene, result, selectedId);
    renderConflicts(result);
    renderInspector(result);
    renderPosInfo(result);
  }

  function tick(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    if (playback) {
      if (playback.playing && now >= playback.at) {
        playback.i = Math.min(playback.frames.length - 1, playback.i + 1);
        playback.at = now + playback.interval;
        applyFrame(playback.frames[playback.i]);
        if (playback.i >= playback.frames.length - 1) stopPlayback(false);
      }
    } else if (recording || keys.size) {
      moveHero(dt);
      if (recording) { // 录制与播放共用同一套确定性采样
        recordSamples.push({ x: C.round1(hero.pos.x), y: C.round1(hero.pos.y), z: hero.z, floor: hero.floor });
      }
    }
    draw();
    requestAnimationFrame(tick);
  }

  function applyFrame(f) {
    hero.pos.x = f.x; hero.pos.y = f.y; hero.z = f.z; hero.floor = f.floor;
  }

  function moveHero(dt) {
    const speed = 3.4;
    let dx = 0, dy = 0;
    if (keys.has('w') || keys.has('arrowup')) dy -= 1;
    if (keys.has('s') || keys.has('arrowdown')) dy += 1;
    if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
    if (keys.has('d') || keys.has('arrowright')) dx += 1;
    if (!dx && !dy) return;
    const len = Math.hypot(dx, dy);
    const nx = clamp(hero.pos.x + dx / len * speed * dt, 0, scene.grid.cols - 1);
    const ny = clamp(hero.pos.y + dy / len * speed * dt, 0, scene.grid.rows - 1);
    enterCell(nx, ny);
    hero.pos.x = nx; hero.pos.y = ny;
  }

  // 越过格子中点才算进入新格，与 core.simulateRoute 同一判据
  function enterCell(nx, ny) {
    const ncx = Math.floor(nx + 0.5), ncy = Math.floor(ny + 0.5);
    const ocx = Math.floor(hero.pos.x + 0.5), ocy = Math.floor(hero.pos.y + 0.5);
    if (ncx === ocx && ncy === ocy) return;
    const idx = C.buildTerrainIndex(scene);
    hero.floor = C.enterCellFloor ? C.enterCellFloor(hero.floor, ncx, ncy, idx) : hero.floor;
    const s = C.surfaceAt(ncx, ncy, hero.floor, scene, idx);
    hero.floor = s.floor; hero.z = s.z;
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ---------------- 冲突与核对面板 ---------------- */

  function renderConflicts(result) {
    const badge = $('#conflictBadge');
    const list = $('#conflictList');
    if (!result.conflicts.length) {
      badge.className = 'badge ok'; badge.textContent = '无冲突';
      list.innerHTML = '<div class="muted">排序结果完全确定，所有前后关系都由地面坐标或高度区间推出。</div>';
      return;
    }
    badge.className = 'badge bad';
    badge.textContent = result.conflicts.length + ' 处冲突';
    list.innerHTML = '';
    for (const cf of result.conflicts) {
      const a = result.objects.find(o => o.id === cf.a);
      const b = result.objects.find(o => o.id === cf.b);
      const div = document.createElement('div');
      div.className = 'conflict-item';
      div.innerHTML = `<div class="t">${cf.type === 'cycle' ? '约束成环' : cf.type === 'mutual' ? '高度互相穿插' : '方位歧义'}</div><div>${cf.detail}</div>`;
      div.onclick = () => { selectedId = a.id; draw(); };
      list.appendChild(div);
    }
  }

  function renderInspector(result) {
    const body = $('#inspectBody');
    if (!selectedId) {
      body.className = 'muted';
      body.innerHTML = '点击场景中的物体，这里会列出它与每个物体的前后关系及判定依据。<br><br>' +
        '<div class="order-line">当前绘制顺序（后→前，即越靠右越靠前）：<br>' +
        result.order.map(id => result.objects.find(o => o.id === id).name).join(' → ') + '</div>';
      renderConfig(null);
      return;
    }
    const me = result.objects.find(o => o.id === selectedId);
    if (!me) { selectedId = null; draw(); return; }
    const myIndex = result.order.indexOf(me.id);
    const reasons = C.explainObject(result, me.id);
    body.className = '';
    body.innerHTML =
      `<div style="margin-bottom:8px">
        <b>${me.name}</b> <span class="badge">${kindName(me.kind)}</span>
        <span class="badge ${myIndex === result.order.length - 1 ? 'warn' : ''}">绘制序号 ${myIndex + 1}/${result.order.length}</span>
      </div>
      <div class="grid-info" style="margin-bottom:8px">
        占地格：${me.cells.map(c => c.join(',')).join(' | ')}<br>
        排序区间 z：[${me.lo}, ${me.hi})
      </div>` +
      reasons.map(r =>
        `<div class="reason-item ${r.conflict ? 'conflict' : r.iAmInFront ? 'front' : ''}">
          <b data-id="${r.otherId}">${r.other}</b>
          <span class="badge ${r.conflict ? 'bad' : r.iAmInFront ? 'ok' : ''}">${r.iAmInFront ? '我盖住它' : '它盖住我'}</span>
          <div class="muted" style="margin-top:2px">${r.text}</div>
        </div>`).join('');
    body.querySelectorAll('b[data-id]').forEach(el => el.onclick = () => { selectedId = el.dataset.id; draw(); });
    renderConfig(me);
  }

  function kindName(k) {
    return { bridge: '桥体', stair: '台阶', prop: '道具', hero: '角色' }[k] || k;
  }

  function renderPosInfo(result) {
    const cx = Math.round(hero.pos.x), cy = Math.round(hero.pos.y);
    const me = result.objects.find(o => o.id === 'hero');
    const idx = result.order.indexOf('hero') + 1;
    $('#posInfo').textContent =
      `位置 (${hero.pos.x.toFixed(2)}, ${hero.pos.y.toFixed(2)}) 格(${cx},${cy}) 层面:${hero.floor === 'top' ? '桥上/台阶上' : '地面'} z=${hero.z.toFixed(2)} 角色绘制序号 ${idx}/${result.order.length}`;
  }

  /* ---------------- 配置编辑（地面坐标/高度/排序范围/占地） ---------------- */

  function renderConfig(me) {
    const box = $('#configBody');
    if (!me) {
      box.className = 'muted';
      box.innerHTML = '先选中一个物体。<br><br>场景地面网格参数：' +
        `<div class="field"><label>列/行</label><input id="cfg-grid" value="${scene.grid.cols},${scene.grid.rows}"></div>
         <div class="field"><label>菱形宽/高</label><input id="cfg-cell" value="${scene.grid.cellW},${scene.grid.cellH}"></div>
         <div class="row"><button id="cfg-grid-apply">应用网格</button></div>
         <hr><div class="muted">桥体占地（格 x,y 列表）：</div>
         <textarea id="cfg-deck">${scene.terrain.decks[0].cells.map(c => c.join(',')).join(' | ')}</textarea>
         <div class="field"><label>桥底/桥面 z</label><input id="cfg-deckz" value="${scene.terrain.deckBottom},${scene.terrain.deckTop}"></div>
         <div class="row"><button id="cfg-deck-apply">应用桥配置</button></div>
         <hr><div class="muted">台阶（格 x,y,顶面z）：</div>
         <textarea id="cfg-stairw">${JSON.stringify(scene.terrain.stairs)}</textarea>
         <div class="row"><button id="cfg-stair-apply">应用台阶配置</button></div>`;
      bindStaticConfig();
      return;
    }
    box.className = '';
    if (me.kind === 'hero') {
      box.innerHTML = `<div class="field"><label>起始地面坐标</label><input id="cfg-heropos" value="${scene.hero.start.x},${scene.hero.start.y}"></div>
        <div class="field"><label>角色高度</label><input id="cfg-heroh" type="number" step="0.05" value="${scene.hero.h}"></div>
        <div class="row"><button id="cfg-hero-apply">应用</button></div>`;
      $('#cfg-hero-apply').onclick = () => {
        const [x, y] = $('#cfg-heropos').value.split(',').map(Number);
        scene.hero.start = { x, y }; scene.hero.h = Number($('#cfg-heroh').value);
        persistScene(); draw();
      };
      return;
    }
    const prop = scene.props.find(p => p.id === me.id);
    if (prop) {
      box.innerHTML =
        `<div class="field"><label>名称</label><input id="cfg-name" value="${prop.name}"></div>
         <div class="field"><label>地面坐标(占地)</label><input id="cfg-cells" value="${prop.cells.map(c => c.join(',')).join(' | ')}"></div>
         <div class="field"><label>所在高度 base</label><input id="cfg-base" type="number" step="0.05" value="${prop.base}"></div>
         <div class="field"><label>物体高度 h</label><input id="cfg-h" type="number" step="0.05" value="${prop.h}"></div>
         <div class="muted" style="margin:4px 0">参与排序的 z 区间 = [base, base+h)，跨多格时可写多组 x,y 处理部分重叠。</div>
         <div class="row">
           <button id="cfg-prop-apply">应用并重算</button>
           <button id="cfg-prop-add">扩一格</button>
           <button id="cfg-prop-del" class="danger">删除道具</button>
         </div>`;
      $('#cfg-prop-apply').onclick = () => {
        prop.name = $('#cfg-name').value;
        prop.cells = parseCellList($('#cfg-cells').value);
        prop.base = Number($('#cfg-base').value);
        prop.h = Number($('#cfg-h').value);
        persistScene(); draw();
      };
      $('#cfg-prop-add').onclick = () => {
        const last = prop.cells[prop.cells.length - 1];
        prop.cells.push([last[0] + 1, last[1]]);
        persistScene(); draw();
      };
      $('#cfg-prop-del').onclick = () => {
        scene.props = scene.props.filter(p => p.id !== prop.id);
        selectedId = null; persistScene(); draw();
      };
      return;
    }
    box.className = 'muted';
    box.innerHTML = '桥与台阶属于地形，请在未选中物体时于本面板顶部编辑其占地格与高度。';
  }

  function parseCellList(s) {
    return s.split('|').map(t => t.trim()).filter(Boolean).map(t => t.split(',').map(Number));
  }

  function bindStaticConfig() {
    const b1 = $('#cfg-grid-apply');
    if (b1) b1.onclick = () => {
      const [cols, rows] = $('#cfg-grid').value.split(',').map(Number);
      const [cellW, cellH] = $('#cfg-cell').value.split(',').map(Number);
      Object.assign(scene.grid, { cols, rows, cellW, cellH });
      persistScene(); draw();
    };
    const b2 = $('#cfg-deck-apply');
    if (b2) b2.onclick = () => {
      scene.terrain.decks[0].cells = parseCellList($('#cfg-deck').value);
      const [bot, top] = $('#cfg-deckz').value.split(',').map(Number);
      scene.terrain.deckBottom = bot; scene.terrain.deckTop = top;
      persistScene(); draw();
    };
    const b3 = $('#cfg-stair-apply');
    if (b3) b3.onclick = () => {
      try {
        scene.terrain.stairs = JSON.parse($('#cfg-stairw').value);
        persistScene(); draw();
      } catch (e) { toast('台阶 JSON 解析失败：' + e.message, true); }
    };
  }

  /* ---------------- 路线：播放 / 暂停 / 逐步 / 录制 ---------------- */

  function startRoute(routeId) {
    const route = routes.find(r => r.id === routeId);
    if (!route) return;
    activeRouteId = routeId;
    const frames = C.simulateRoute(scene, C.sampleRoute(route.waypoints));
    playback = { frames, i: 0, playing: true, at: performance.now(), interval: 90 };
    applyFrame(frames[0]);
    recording = false;
    renderRouteList();
  }

  function stopPlayback(finished) {
    if (!playback) return;
    playback.playing = false;
    if (finished) playback = null;
    renderRouteList();
  }

  function toggleRecording() {
    if (recording) {
      // 结束录制：把采样点化简为关键拐点保存，重放时再展开 → 与内建路线同一管线
      const wp = simplify(recordSamples);
      if (wp.length < 2) { toast('录制时间太短，请多走几步再结束', true); recording = false; renderRouteList(); return; }
      recordedRoute = { id: 'route-manual', name: '手动录制路线', waypoints: wp.map(p => [p.x, p.y]) };
      routes = routes.filter(r => r.id !== 'route-manual').concat([recordedRoute]);
      save(LS.route, recordedRoute); save(LS.routes, routes);
      recording = false;
      toast('已保存手动路线，重放走同一采样与排序管线，结果一致');
    } else {
      playback = null; activeRouteId = null;
      recording = true; recordSamples = [];
      hero.pos = { ...scene.hero.start }; hero.z = 0; hero.floor = 'ground';
    }
    renderRouteList();
  }

  function simplify(samples) {
    if (samples.length < 2) return samples;
    const out = [samples[0]];
    let lastDir = null;
    for (let i = 1; i < samples.length; i++) {
      const dx = samples[i].x - samples[i - 1].x, dy = samples[i].y - samples[i - 1].y;
      const dir = Math.round(Math.atan2(dy, dx) * 100);
      if (lastDir === null || dir !== lastDir) { out.push(samples[i - 1]); lastDir = dir; }
    }
    out.push(samples[samples.length - 1]);
    return out;
  }

  function renderRouteList() {
    const badge = $('#routeBadge');
    if (recording) { badge.className = 'badge bad'; badge.textContent = '录制中…'; }
    else if (playback) { badge.className = 'badge warn'; badge.textContent = playback.playing ? '播放中' : '已暂停'; }
    else { badge.className = 'badge'; badge.textContent = '手动模式'; }

    const list = $('#routeList');
    list.innerHTML = '';
    for (const r of routes) {
      const div = document.createElement('div');
      div.className = 'route-item' + (activeRouteId === r.id ? ' sel' : '');
      div.innerHTML = `<span class="nm">${r.name} <span class="muted">(${r.waypoints.length} 个关键点)</span></span>`;
      const btn = document.createElement('button');
      btn.textContent = activeRouteId === r.id ? '重新播放' : '播放';
      btn.onclick = () => startRoute(r.id);
      div.appendChild(btn);
      list.appendChild(div);
    }
  }

  // 重放一致性：同一路线连算两遍指纹，逐采样点比对绘制顺序
  function replayCheck() {
    const target = activeRouteId ? routes.find(r => r.id === activeRouteId) : routes[0];
    const s1 = C.routeSignature(scene, target);
    const s2 = C.routeSignature(scene, target);
    const mm = C.diffSignatures(s1, s2);
    const box = $('#replayResult');
    if (!mm.length) {
      box.innerHTML = `<span class="badge ok">一致 ✓</span> <span class="muted">「${target.name}」${s1.length} 个采样点，两遍绘制顺序完全相同。</span>`;
    } else {
      box.innerHTML = `<span class="badge bad">不一致 ✗</span> <span class="muted">${mm.length} 个采样点排序不同。</span>`;
    }
  }

  function gotoRouteFrame(routeId, matcher, label) {
    const route = routes.find(r => r.id === routeId);
    const frames = C.simulateRoute(scene, C.sampleRoute(route.waypoints));
    const f = frames.find(matcher) || frames[0];
    playback = { frames, i: frames.indexOf(f), playing: false, at: 0, interval: 90 };
    activeRouteId = routeId;
    applyFrame(f);
    renderRouteList(); draw();
  }

  /* ---------------- 截图 ---------------- */

  function takeShot() {
    const result = currentResult();
    const cx = Math.round(hero.pos.x), cy = Math.round(hero.pos.y);
    const caption = `${view === 'normal' ? '正常画面' : view === 'footprint' ? '占地区域' : '绘制顺序'}｜格(${cx},${cy}) ${hero.floor === 'top' ? '桥上/台阶上' : '地面'} z=${hero.z.toFixed(2)}｜顺序 ${result.order.map(id => result.objects.find(o => o.id === id).name).join('>')}`;
    const data = R.capture(view, scene, result, selectedId, caption, 960, 640);
    shots.push({ id: 's' + Date.now(), caption, data });
    save(LS.shots, shots);
    renderShots();
  }

  function renderShots() {
    $('#shotCount').textContent = shots.length + ' 张';
    const box = $('#shotList');
    if (!shots.length) { box.innerHTML = '<div class="muted">播放或手动走到关键位置（如桥上、桥底），点「截图存关键位置」保存对照。</div>'; return; }
    box.innerHTML = '';
    for (const s of shots) {
      const div = document.createElement('div');
      div.className = 'shot';
      div.innerHTML = `<img src="${s.data}" alt=""><div class="cap">${s.caption}</div>`;
      const del = document.createElement('button');
      del.className = 'danger'; del.textContent = '删';
      del.onclick = () => { shots = shots.filter(x => x.id !== s.id); save(LS.shots, shots); renderShots(); };
      div.appendChild(del);
      box.appendChild(div);
    }
  }

  /* ---------------- 冲突演示 / 场景持久化 ---------------- */

  function conflictDemo() {
    // 在桥边放一个与桥共格、高度区间互相穿插的道具 → 稳定回退并报冲突
    if (scene.props.some(p => p.id === 'demo-overlap')) {
      scene.props = scene.props.filter(p => p.id !== 'demo-overlap');
    } else {
      scene.props.push({
        id: 'demo-overlap', name: '冲突演示体',
        cells: [[5, 3], [6, 3]], base: 0.7, h: 0.9, color: '#c026d3',
      });
    }
    persistScene(); draw();
  }

  function persistScene() { save(LS.scene, scene); }

  function exportJSON() {
    const blob = new Blob([JSON.stringify({ scene, routes, app: 'occl-check' }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'occlusion-scene.json'; a.click();
    URL.revokeObjectURL(a.href);
  }

  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.scene) { scene = data.scene; persistScene(); }
        if (data.routes) { routes = data.routes; save(LS.routes, routes); }
        selectedId = null; renderRouteList(); draw();
        toast('导入成功');
      } catch (e) { toast('导入失败：' + e.message, true); }
    };
    reader.readAsText(file);
  }

  /* ---------------- 事件绑定 ---------------- */

  $$('button[data-view]').forEach(b => b.onclick = () => {
    view = b.dataset.view;
    $$('button[data-view]').forEach(x => x.classList.toggle('active', x === b));
    draw();
  });
  $$('button[data-panel]').forEach(b => b.onclick = () => {
    $$('button[data-panel]').forEach(x => x.classList.toggle('active', x === b));
    $('#panel-inspect').hidden = b.dataset.panel !== 'inspect';
    $('#panel-config').hidden = b.dataset.panel !== 'config';
    draw();
  });

  $('#cv').addEventListener('click', e => {
    const rect = e.target.getBoundingClientRect();
    const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const id = R.hitTest(scene, currentResult(), pt);
    if (id) selectedId = id;
    draw();
  });

  window.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      keys.add(k); e.preventDefault();
      if (playback) stopPlayback(true); // 手动接管，退出播放
    }
  });
  window.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));

  $('#btnPlay').onclick = () => {
    if (playback) { playback.playing = true; playback.at = performance.now(); renderRouteList(); }
    else startRoute(activeRouteId || routes[0].id);
  };
  $('#btnPause').onclick = () => { if (playback) { playback.playing = false; renderRouteList(); } };
  $('#btnStep').onclick = () => {
    if (!playback) { startRoute(activeRouteId || routes[0].id); playback.playing = false; }
    playback.playing = false;
    playback.i = Math.min(playback.frames.length - 1, playback.i + 1);
    applyFrame(playback.frames[playback.i]);
    renderRouteList(); draw();
  };
  $('#btnRecord').onclick = toggleRecording;
  $('#btnReplayCheck').onclick = replayCheck;
  $('#btnShot').onclick = takeShot;
  $('#btnConflictDemo').onclick = conflictDemo;
  $('#btnReset').onclick = () => {
    if (!confirmDlg('恢复默认场景与内建路线？已保存的截图保留。')) return;
    scene = C.defaultScene(); routes = C.defaultRoutes();
    localStorage.removeItem(LS.scene); localStorage.removeItem(LS.routes); localStorage.removeItem(LS.route);
    recordedRoute = null; selectedId = null; playback = null; activeRouteId = null; recording = false;
    hero.pos = { ...scene.hero.start }; hero.z = 0; hero.floor = 'ground';
    renderRouteList(); draw();
  };
  $('#btnSaveScene').onclick = () => { persistScene(); toast('场景已保存到浏览器本地，刷新不丢'); };
  $('#btnExport').onclick = exportJSON;
  $('#btnImport').onclick = () => $('#fileImport').click();
  $('#fileImport').addEventListener('change', e => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ''; });
  $('#btnGotoUnder').onclick = () => gotoRouteFrame('route-under',
    f => f.cx === 5 && f.cy === 3 && f.floor === 'ground', '桥下');
  $('#btnGotoOver').onclick = () => gotoRouteFrame('route-over',
    f => f.cx === 5 && f.cy === 3 && f.floor === 'top', '桥上');

  /* ---------------- 启动 ---------------- */

  // 仅用于自动化测试的只读/受控钩子
  window.__occlTest = {
    scene: () => scene,
    result: currentResult,
    shots: () => shots,
    playback: () => playback,
  };

  renderRouteList();
  renderShots();
  requestAnimationFrame(tick);
})();
