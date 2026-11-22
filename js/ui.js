/* UI 绑定与各面板渲染 */
(function () {
  'use strict';

  const E = window.TileEngine;
  const R = window.TileRender;
  const App = window.TileApp;
  const $ = (id) => document.getElementById(id);

  const canvas = $('map-canvas');
  const ctx = canvas.getContext('2d');

  /* ---------------- 小工具 ---------------- */

  let toastTimer = null;
  function toast(msg, kind) {
    const el = $('toast');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'persist' ? null : 4200);
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function dialog(title, bodyHtml) {
    closeDialog();
    const back = document.createElement('div');
    back.className = 'dialog-backdrop';
    back.innerHTML = `<div class="dialog"><h3>${title}</h3><div class="dialog-body">${bodyHtml}</div>
      <div class="dlg-actions"><button id="dlg-close">关闭</button></div></div>`;
    document.body.appendChild(back);
    back.addEventListener('click', (ev) => { if (ev.target === back || ev.target.id === 'dlg-close') closeDialog(); });
    return back;
  }
  function closeDialog() {
    document.querySelectorAll('.dialog-backdrop').forEach((d) => d.remove());
  }

  /* Bresenham 插值，拖动时把途经格都画上 */
  function lineCells(x0, y0, x1, y1) {
    const out = [];
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    while (true) {
      out.push([x, y]);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
    return out;
  }

  function terrainById(id) {
    return App.rules.terrains.find((t) => t.id === id);
  }

  /* ---------------- 主渲染 ---------------- */

  function render() {
    R.renderMap(canvas, {
      grid: App.grid,
      rules: App.rules,
      seed: App.seed,
      selection: App.selection,
      cellSize: App.cellSize,
      evalCache: App.evalCache,
    });
    $('rule-version').textContent = App.rules._version;
    updateProblemBadge();
    updateStatus();
    if ($('tab-inspector').classList.contains('active') && App.selection) renderInspector();
  }

  function updateStatus() {
    const filled = App.grid.cells.filter(Boolean).length;
    $('map-status').textContent =
      `${App.grid.w}×${App.grid.h}，已铺 ${filled} 格 ｜ 工具：${toolLabel(App.tool)} ｜ 笔刷：${App.brushTerrain ? terrainById(App.brushTerrain).name : '—'} ｜ 种子：${App.seed}`;
  }
  function toolLabel(t) {
    return { draw: '绘制', erase: '擦除', fill: '填充', inspect: '检查' }[t];
  }

  let lastProblemCount = -1;
  function updateProblemBadge() {
    const p = App.scanProblems();
    const n = p.missing.length + p.conflicts.length;
    if (n !== lastProblemCount) {
      lastProblemCount = n;
      $('problem-count').textContent = n;
      $('problem-count').style.color = n ? 'var(--warn)' : '';
    }
  }

  /* ---------------- 画布交互 ---------------- */

  let painting = false;
  let lastCell = null;

  function eventCell(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - rect.left) / App.cellSize);
    const y = Math.floor((ev.clientY - rect.top) / App.cellSize);
    return { x, y };
  }

  canvas.addEventListener('pointerdown', (ev) => {
    const { x, y } = eventCell(ev);
    if (!App.grid.inBounds(x, y)) return;
    canvas.setPointerCapture(ev.pointerId);

    if (App.tool === 'inspect') {
      showInspector(x, y);
      render();
      return;
    }
    if (App.tool === 'fill') {
      App.applyFill(x, y, App.brushTerrain);
      render();
      return;
    }
    painting = true;
    lastCell = [x, y];
    const value = App.tool === 'erase' ? null : App.brushTerrain;
    App.pushHistory(value == null ? '擦除' : '绘制');
    App.applyStrokeDirect([[x, y]], value);
    render();
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (!painting) return;
    const { x, y } = eventCell(ev);
    if (!App.grid.inBounds(x, y)) return;
    if (lastCell && lastCell[0] === x && lastCell[1] === y) return;
    const value = App.tool === 'erase' ? null : App.brushTerrain;
    const pts = lastCell ? lineCells(lastCell[0], lastCell[1], x, y) : [[x, y]];
    lastCell = [x, y];
    App.applyStrokeDirect(pts, value);
    render();
  });

  window.addEventListener('pointerup', () => { painting = false; lastCell = null; });

  /* ---------------- 地表列表 ---------------- */

  function renderTerrainList() {
    const el = $('terrain-list');
    el.innerHTML = '';
    for (const t of App.rules.terrains) {
      const div = document.createElement('div');
      div.className = 'terrain-item' + (t.id === App.brushTerrain ? ' selected' : '');
      div.innerHTML = `
        <input type="color" class="color-input" value="${t.color}" data-act="color">
        <span class="t-name" title="ID: ${t.id}">${t.name}</span>
        <button data-act="rename" title="重命名">✎</button>
        <button data-act="del" class="danger" title="删除">✕</button>`;
      div.querySelector('[data-act="color"]').addEventListener('change', (ev) => {
        t.color = ev.target.value;
        App.rulesMutated();
        renderAll();
      });
      div.querySelector('[data-act="rename"]').addEventListener('click', () => {
        const name = prompt('地表名称', t.name);
        if (name) { t.name = name.trim() || t.name; App.rulesMutated(); renderAll(); }
      });
      div.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (!confirm(`删除地表「${t.name}」？地图中该地表的格会变成空。`)) return;
        App.rules.terrains = App.rules.terrains.filter((q) => q.id !== t);
        delete App.rules.tiles[t.id];
        for (let i = 0; i < App.grid.cells.length; i++) {
          if (App.grid.cells[i] === t.id) App.grid.cells[i] = null;
        }
        if (App.brushTerrain === t.id) App.brushTerrain = App.rules.terrains[0] && App.rules.terrains[0].id;
        App.rulesMutated();
        renderAll();
      });
      div.addEventListener('click', (ev) => {
        if (ev.target.tagName === 'BUTTON' || ev.target.tagName === 'INPUT') return;
        App.brushTerrain = t.id;
        renderTerrainList();
        updateStatus();
      });
      el.appendChild(div);
    }
  }

  $('btn-add-terrain').addEventListener('click', () => {
    const name = $('new-terrain-name').value.trim();
    if (!name) return toast('请输入地表名称', 'error');
    const id = 't' + Date.now().toString(36);
    const colors = ['#c98c5b', '#7fb069', '#6d8ea0', '#b56576', '#8d77b8', '#d4a373'];
    App.rules.terrains.push({ id, name, color: colors[App.rules.terrains.length % colors.length] });
    E.ensureTerrainSlots(App.rules, id);
    $('new-terrain-name').value = '';
    App.brushTerrain = id;
    App.rulesMutated();
    renderAll();
  });

  /* ---------------- 规则编辑器 ---------------- */

  function renderRuleTerrainSelect() {
    const sel = $('rule-terrain-select');
    const cur = sel.value;
    sel.innerHTML = App.rules.terrains.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
    if (cur && App.rules.terrains.some((t) => t.id === cur)) sel.value = cur;
  }

  function maskSummary(mask) {
    return E.DIR_NAMES.map((d, i) => (mask & (1 << i)) ? d : '·').join(' ');
  }

  function renderRuleEditor() {
    const tid = $('rule-terrain-select').value;
    const root = $('rule-editor');
    root.innerHTML = '';
    if (!tid) { root.innerHTML = '<p class="muted">请先添加地表。</p>'; return; }
    const terrain = terrainById(tid);
    E.ensureTerrainSlots(App.rules, tid);

    for (const cat of E.CAT_ORDER) {
      const shapes = E.registry.shapes[cat];
      const wrap = document.createElement('div');
      wrap.className = 'rule-cat';
      const missingCount = shapes.filter((s, i) => App.rules.tiles[tid][cat][i].tileId == null).length;
      wrap.innerHTML = `<div class="rule-cat-title"><span>${E.CAT_INFO[cat].label}</span>
        <span class="muted">${shapes.length} 种形态${missingCount ? `，<span style="color:var(--warn)">缺项 ${missingCount}</span>` : ''}</span></div>`;
      const grid = document.createElement('div');
      grid.className = 'rule-tiles';

      shapes.forEach((shape, si) => {
        const slot = App.rules.tiles[tid][cat][si];
        const missing = slot.tileId == null;
        const card = document.createElement('div');
        card.className = 'rule-tile' + (missing ? ' missing' : '');
        card.innerHTML = `
          <canvas width="72" height="72"></canvas>
          <div class="rt-meta">形态 #${si} ｜ 旋转×${shape.orientationCount}</div>
          <div class="rot-line"></div>
          <input type="number" placeholder="图块编号" value="${slot.tileId == null ? '' : slot.tileId}" data-f="tileId">
          <input type="text" placeholder="变体ID(逗号分隔)" value="${(slot.variantIds || []).join(',')}" data-f="variants">`;
        const cv = card.querySelector('canvas');
        R.renderPreview(cv, shape.canonMask, 0, terrain.color, 72, null, missing);

        const rotLine = card.querySelector('.rot-line');
        for (let r = 0; r < shape.orientationCount; r++) {
          const rc = document.createElement('canvas');
          rc.width = 22; rc.height = 22;
          R.renderPreview(rc, shape.canonMask, r, terrain.color, 22, null, missing);
          rc.title = `顺时针旋转 ${r * 90}°`;
          rotLine.appendChild(rc);
        }

        card.querySelector('[data-f="tileId"]').addEventListener('change', (ev) => {
          const v = ev.target.value.trim();
          slot.tileId = v === '' ? null : Number(v);
          App.rulesMutated();
          renderRuleEditor();
          render();
        });
        card.querySelector('[data-f="variants"]').addEventListener('change', (ev) => {
          slot.variantIds = ev.target.value.split(',').map((s) => s.trim()).filter(Boolean);
          App.rulesMutated();
          render();
        });
        grid.appendChild(card);
      });
      wrap.appendChild(grid);
      root.appendChild(wrap);
    }
  }

  $('rule-terrain-select').addEventListener('change', renderRuleEditor);

  /* ---------------- 格检查器 ---------------- */

  function showInspector(x, y) {
    const ev = App.inspect(x, y);
    document.querySelector('.tab-btn[data-tab="inspector"]').click();
    renderInspector(ev);
  }

  function dirLabel(d) { return `${E.DIR_NAMES_CN[d]} ${E.DIR_NAMES[d]}`; }

  function renderInspector(evArg) {
    const ev = evArg || (App.selection && App.evalCache.get(App.grid.idx(App.selection.x, App.selection.y)));
    const empty = $('inspector-empty');
    const body = $('inspector-body');
    if (!ev || ev.empty) {
      empty.hidden = false; empty.textContent = '该格为空（无地表）。';
      body.hidden = true;
      return;
    }
    empty.hidden = true;
    body.hidden = false;
    const terrain = terrainById(ev.terrain);

    // 3x3 邻接表（NW N NE / W 中心 E / SW S SE）
    const layout = [7, 0, 4, 3, -1, 1, 6, 2, 5];
    const cells = layout.map((d) => {
      if (d === -1) {
        return `<div class="insp-cell center">
          <canvas width="72" height="72"></canvas>
          <div class="dir">本格</div></div>`;
      }
      const n = ev.neighbors[d];
      const same = n === ev.terrain;
      const name = n ? (terrainById(n) || { name: n }).name : '空';
      return `<div class="insp-cell ${n ? (same ? 'same' : 'diff') : ''}">
        <span class="dir">${dirLabel(d)}</span>
        <span>${name}</span>
        <span style="font-family:ui-monospace,Menlo,monospace;font-size:10px">${same ? '同类●' : '异类○'}</span>
      </div>`;
    }).join('');

    const hitHtml = ev.hit.kind === 'custom'
      ? `<span class="pill info">自定义规则 ${ev.hit.ruleId}（优先级 ${ev.hit.priority}）</span>`
      : `<span class="pill ok">自动形态：${E.CAT_INFO[ev.cat].label} #${ev.shape}</span>`;

    body.innerHTML = `
      <div class="insp-head">
        <strong>(${ev.x}, ${ev.y}) ｜ ${terrain.name}</strong>
        ${ev.missing ? '<span class="pill warn">缺项：无可用图块</span>' : '<span class="pill ok">已配置</span>'}
      </div>
      <div class="insp-grid">${cells}</div>
      <canvas id="insp-preview" width="120" height="120" style="float:right;border-radius:8px;margin-left:10px">
      </canvas>
      <div class="kv">
        <span class="k">邻接掩码</span><span class="v">0b${ev.mask.toString(2).padStart(8, '0')}（${maskSummary(ev.mask)}）</span>
        <span class="k">规范掩码</span><span class="v">0b${ev.canonMask.toString(2).padStart(8, '0')}</span>
        <span class="k">命中规则</span><span class="v">${hitHtml}</span>
        <span class="k">图块编号</span><span class="v">${ev.tileId == null ? '—' : ev.tileId}</span>
        <span class="k">旋转方向</span><span class="v">顺时针 ${ev.rotDeg}°（${ev.rot}/4 次）</span>
        <span class="k">外观变体</span><span class="v">${ev.variantId || '无（单外观）'}</span>
      </div>
      <div id="insp-conflict"></div>
      <div style="clear:both"></div>
      <p class="hint">右侧预览与地图上该格完全一致（同规范掩码 + 同旋转）。变体由固定种子按格坐标确定性选取。</p>`;

    R.renderPreview($('insp-preview'), ev.canonMask, ev.rot, terrain.color, 120, ev.variantId, ev.missing);

    const cf = $('insp-conflict');
    if (ev.conflictRuleIds.length) {
      cf.innerHTML = `<div style="margin:8px 0">
        <span class="pill danger">同优先级冲突</span>
        <p class="hint">以下规则同时命中且优先级相同，当前按 ID 顺序取第一条；可在「自定义规则」里调整优先级：</p>
        <div>${ev.conflictRuleIds.map((id) => `<span class="pill danger" style="margin-right:6px">${id}</span>`).join('')}</div>
      </div>`;
    }
  }

  /* ---------------- 自定义规则 ---------------- */

  function renderCustomList() {
    const root = $('custom-list');
    root.innerHTML = '';
    App.rules.customRules.forEach((rule) => {
      const div = document.createElement('div');
      div.className = 'custom-rule';
      const opts = (v) => [
        `<option value="-1" ${v === -1 ? 'selected' : ''}>通配</option>`,
        `<option value="1" ${v === 1 ? 'selected' : ''}>同类</option>`,
        `<option value="0" ${v === 0 ? 'selected' : ''}>非同类</option>`,
      ].join('');
      const maskSelects = E.DIR_NAMES.map((dn, i) => `
        <div class="mask-cell">${dn}<select data-d="${i}">${opts(rule.match[i] == null ? -1 : rule.match[i])}</select></div>`).join('');
      const terrainOpts = App.rules.terrains.map((t) =>
        `<option value="${t.id}" ${rule.terrain === t.id ? 'selected' : ''}>${t.name}</option>`).join('');
      div.innerHTML = `
        <div class="cr-head">
          <strong>${rule.id}</strong>
          <input type="text" value="${rule.name.replace(/"/g, '&quot;')}" data-f="name">
          <button data-act="del" class="danger">删除</button>
        </div>
        <div class="cr-grid">
          <label>地表 <select data-f="terrain">${terrainOpts}</select></label>
          <label>优先级 <input type="number" value="${rule.priority}" data-f="priority"></label>
          <label>图块编号 <input type="number" value="${rule.tileId == null ? '' : rule.tileId}" data-f="tileId"></label>
          <label>旋转(0-3) <input type="number" min="0" max="3" value="${rule.rot}" data-f="rot"></label>
        </div>
        <div class="mask-grid">${maskSelects}</div>
        <input type="text" value="${(rule.variantIds || []).join(',')}" data-f="variants" placeholder="变体ID(逗号分隔，可空)">`;

      div.querySelector('[data-act="del"]').addEventListener('click', () => {
        App.rules.customRules = App.rules.customRules.filter((r) => r.id !== rule.id);
        App.rulesMutated(); renderCustomList(); render();
      });
      div.querySelectorAll('input,select').forEach((inp) => {
        inp.addEventListener('change', () => {
          const f = inp.dataset.f;
          if (f === 'name') rule.name = inp.value;
          else if (f === 'terrain') rule.terrain = inp.value;
          else if (f === 'priority') rule.priority = Number(inp.value);
          else if (f === 'tileId') rule.tileId = inp.value === '' ? null : Number(inp.value);
          else if (f === 'rot') rule.rot = Math.max(0, Math.min(3, Number(inp.value) || 0));
          else if (f === 'variants') rule.variantIds = inp.value.split(',').map((s) => s.trim()).filter(Boolean);
          App.rulesMutated(); render();
        });
      });
      div.querySelectorAll('.mask-cell select').forEach((sel) => {
        sel.addEventListener('change', () => {
          rule.match[Number(sel.dataset.d)] = Number(sel.value);
          App.rulesMutated(); render();
        });
      });
      root.appendChild(div);
    });
  }

  $('btn-add-custom').addEventListener('click', () => {
    if (!App.rules.terrains.length) return toast('请先添加地表', 'error');
    const id = 'r' + App.rules.nextCustomRuleId++;
    App.rules.customRules.push({
      id,
      name: '新规则 ' + id,
      terrain: App.rules.terrains[0].id,
      priority: 5,
      match: [-1, -1, -1, -1, -1, -1, -1, -1],
      tileId: 8000 + App.rules.customRules.length,
      rot: 0,
      variantIds: [],
    });
    App.rulesMutated();
    renderCustomList();
  });

  /* ---------------- 问题扫描 ---------------- */

  $('btn-problems').addEventListener('click', () => {
    const { missing, conflicts } = App.scanProblems();
    const rows = (list, kind) => list.map((ev) => `
      <tr>
        <td><span class="loc-link" data-x="${ev.x}" data-y="${ev.y}">(${ev.x}, ${ev.y})</span></td>
        <td>${terrainById(ev.terrain).name}</td>
        <td>${kind === 'missing'
          ? `${E.CAT_INFO[ev.cat].label} #${ev.shape} 未配置图块`
          : `规则 ${ev.conflictRuleIds.join(' / ')} 同优先级冲突`}</td>
      </tr>`).join('');
    const html = `
      <p>缺项 <strong style="color:var(--warn)">${missing.length}</strong> 处，
      同优先级冲突 <strong style="color:var(--danger)">${conflicts.length}</strong> 处。</p>
      <table>
        <thead><tr><th>位置</th><th>地表</th><th>问题</th></tr></thead>
        <tbody>${rows(missing, 'missing')}${rows(conflicts, 'conflict')}</tbody>
      </table>
      <p class="hint">点击位置可跳转到该格并打开检查器。</p>`;
    const dlg = dialog('问题扫描', html);
    dlg.querySelectorAll('.loc-link').forEach((a) => {
      a.addEventListener('click', () => {
        const x = Number(a.dataset.x), y = Number(a.dataset.y);
        closeDialog();
        showInspector(x, y);
        render();
      });
    });
  });

  /* ---------------- 工具栏 ---------------- */

  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      App.tool = btn.dataset.tool;
      document.querySelectorAll('.tool-btn').forEach((b) => b.classList.toggle('active', b === btn));
      updateStatus();
    });
  });

  $('cell-size').addEventListener('input', (ev) => {
    App.cellSize = Number(ev.target.value);
    render();
  });

  $('seed-input').addEventListener('change', (ev) => {
    App.setSeed(Number(ev.target.value) || 0);
    render();
  });

  $('btn-undo').addEventListener('click', () => { App.undo(); render(); });
  $('btn-redo').addEventListener('click', () => { App.redo(); render(); });

  $('btn-clear-map').addEventListener('click', () => {
    if (!confirm('清空整张地图？')) return;
    App.pushHistory('清空地图');
    const changed = [];
    App.grid.cells.forEach((c, i) => { if (c) changed.push([i % App.grid.w, Math.floor(i / App.grid.w)]); });
    App.grid.cells.fill(null);
    App.reevaluateCells(changed);
    App.selection = null;
    render();
  });

  $('btn-demo-map').addEventListener('click', () => {
    if (!confirm('重置为演示地图？当前地图会被覆盖（可撤销）。')) return;
    App.pushHistory('重置演示地图');
    App.grid = window.TileDemo.makeDemoGrid();
    App.reevaluateAll();
    App.selection = null;
    render();
  });

  /* ---------------- 保存 / 载入 / 导出 ---------------- */

  $('btn-save-rules').addEventListener('click', () => {
    download('tile-rules.json', App.serializeRules());
    toast('规则已保存（含版本号）');
  });

  $('btn-save-map').addEventListener('click', () => {
    download('tile-map.json', App.serializeMap());
    toast('地图已保存（含规则版本与图块快照）');
  });

  $('btn-export-csv').addEventListener('click', () => {
    download('tile-export.csv', App.exportTileTable());
    toast('已导出 CSV：每格的图块编号、旋转角度与变体');
  });

  let pendingLoad = null;
  $('btn-load-rules').addEventListener('click', () => { pendingLoad = 'rules'; $('file-input').click(); });
  $('btn-load-map').addEventListener('click', () => { pendingLoad = 'map'; $('file-input').click(); });

  $('file-input').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    const text = await file.text();
    try {
      if (pendingLoad === 'rules') {
        const r = App.loadRules(text);
        toast(`规则已载入。版本 ${r.oldVersion} → ${r.newVersion}，已按新规则重算全图`);
        renderAll();
      } else {
        const r = App.loadMap(text);
        if (r.sameVersion) {
          toast('地图已载入，规则版本一致，外观不变');
        } else {
          showVersionWarning(r);
        }
        renderAll();
      }
    } catch (err) {
      toast('载入失败：' + err.message, 'error');
    }
  });

  function showVersionWarning(r) {
    const rows = r.warnings.slice(0, 200).map((w) => `
      <tr>
        <td><span class="loc-link" data-x="${w.x}" data-y="${w.y}">(${w.x}, ${w.y})</span></td>
        <td>${terrainById(w.terrain).name}</td>
        <td>${w.before.tileId ?? '缺项'} / ${w.before.rot * 90}°${w.before.variantId ? ' / ' + w.before.variantId : ''}</td>
        <td>${w.after.tileId ?? '缺项'} / ${w.after.rot * 90}°${w.after.variantId ? ' / ' + w.after.variantId : ''}</td>
      </tr>`).join('');
    const more = r.warnings.length > 200 ? `<p class="hint">仅显示前 200 处，共 ${r.warnings.length} 处。</p>` : '';
    const dlg = dialog('规则版本不同 — 可能变化的位置', `
      <p>地图保存于规则版本 <code>${r.oldRuleVersion}</code>，当前为 <code>${r.currentRuleVersion}</code>。
      以下 <strong style="color:var(--warn)">${r.warnings.length}</strong> 格的图块/旋转/变体发生了变化：</p>
      <table><thead><tr><th>位置</th><th>地表</th><th>旧：编号/旋转/变体</th><th>新：编号/旋转/变体</th></tr></thead>
      <tbody>${rows}</tbody></table>${more}
      <p class="hint">点击位置可在检查器中查看该格当前的命中规则。</p>`);
    dlg.querySelectorAll('.loc-link').forEach((a) => {
      a.addEventListener('click', () => {
        closeDialog();
        showInspector(Number(a.dataset.x), Number(a.dataset.y));
        render();
      });
    });
    toast(`载入完成：${r.warnings.length} 格可能变化，详见弹窗`, 'warn');
  }

  /* ---------------- Tabs / 快捷键 ---------------- */

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-pane').forEach((p) =>
        p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
      if (btn.dataset.tab === 'rules') renderRuleEditor();
      if (btn.dataset.tab === 'inspector') renderInspector();
      if (btn.dataset.tab === 'custom') renderCustomList();
    });
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT' || ev.target.tagName === 'TEXTAREA') return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'z') { ev.preventDefault(); App.undo(); render(); }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'y' || (ev.shiftKey && ev.key === 'Z'))) { ev.preventDefault(); App.redo(); render(); }
    const toolKey = { b: 'draw', e: 'erase', g: 'fill', i: 'inspect' };
    if (toolKey[ev.key]) {
      App.tool = toolKey[ev.key];
      document.querySelectorAll('.tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === App.tool));
      updateStatus();
    }
  });

  /* ---------------- 启动 ---------------- */

  function renderAll() {
    renderTerrainList();
    renderRuleTerrainSelect();
    renderRuleEditor();
    renderCustomList();
    render();
  }

  App.init(window.TileDemo.makeDefaultRules(), window.TileDemo.makeDemoGrid(), 20261123);
  renderAll();
  toast('演示地图已载入：含内洞、1 格宽狭窄连接和贯通水渠；岩石的端头形态、水域的连接形态故意留了缺项，另含两条同优先级冲突规则');
})();
