/*
 * 编辑器主控制器（浏览器端，零依赖）
 * 职责：规则编辑、生成、校验与问题定位、锁定重生成、工程保存/打开、版本对比。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const R = window.DungeonRules;
  const G = window.DungeonGenerator;
  const V = window.DungeonValidator;
  const P = window.DungeonProject;

  const state = {
    rules: null,
    project: null,
    currentMap: null,       // 当前展示的地图（成功或 partialMap）
    lastResult: null,       // 最近一次 generate 返回
    validation: null,
    selectedRoomId: null,
    highlight: new Set(),
    lockedIds: new Set(),
    compareIds: [],         // 参与对比的两个版本 id
  };

  // ---------- 初始化 ----------
  function boot() {
    fetch('examples/rules/small-dungeon.json')
      .then((r) => r.json())
      .then((rules) => {
        state.rules = rules;
        state.project = P.createProject(JSON.parse(JSON.stringify(rules)));
        renderRulesForm();
        renderAdjacencyEditor();
        bindEvents();
        runGenerate();
      })
      .catch((err) => {
        state.rules = R.createDefaultRules();
        state.project = P.createProject(state.rules);
        bindEvents();
        toast('示例规则加载失败：' + err.message, 'error');
      });
  }

  function bindEvents() {
    $('btn-generate').addEventListener('click', runGenerate);
    $('btn-check-rules').addEventListener('click', runCheckRules);
    $('btn-save-project').addEventListener('click', saveProject);
    $('btn-open-project').addEventListener('click', () => $('file-project').click());
    $('file-project').addEventListener('change', openProject);
    $('btn-export-map').addEventListener('click', exportMap);
    $('btn-import-map').addEventListener('click', () => $('file-map').click());
    $('file-map').addEventListener('change', importMap);
    $('btn-save-version').addEventListener('click', saveVersion);
    $('btn-compare').addEventListener('click', runCompare);
    $('btn-relock-regen').addEventListener('click', regenerateWithLocks);
    $('btn-clear-locks').addEventListener('click', clearLocks);
    $('input-zoom').addEventListener('change', renderMap);
    $('btn-new-type').addEventListener('click', addRoomType);
    $('btn-add-adjacency').addEventListener('click', addAdjacencyRow);
    $('btn-apply-meta').addEventListener('click', applyMeta);
    $('issue-list').addEventListener('click', onIssueClick);
    $('version-list').addEventListener('click', onVersionClick);
  }

  // ---------- 规则表单 ----------
  function renderRulesForm() {
    const r = state.rules;
    $('meta-name').value = r.name || '';
    $('meta-grid-w').value = r.grid.width;
    $('meta-grid-h').value = r.grid.height;
    $('meta-max-rooms').value = r.maxRooms;
    $('meta-default-adj').value = r.defaultAdjacency;

    const host = $('type-list');
    host.innerHTML = '';
    r.roomTypes.forEach((t, idx) => host.appendChild(typeCard(t, idx)));
  }

  function typeCard(t, idx) {
    const card = document.createElement('div');
    card.className = 'type-card';
    card.innerHTML = `
      <div class="type-head">
        <input class="t-id" value="${escapeHtml(t.id)}" placeholder="id" ${t.start || t.end ? 'disabled' : ''}>
        <input class="t-name" value="${escapeHtml(t.name || '')}" placeholder="显示名">
        <input class="t-color" type="color" value="${t.color || '#888888'}">
        <label class="chk"><input type="checkbox" class="t-start" ${t.start ? 'checked' : ''}> 起点</label>
        <label class="chk"><input type="checkbox" class="t-end" ${t.end ? 'checked' : ''}> 终点</label>
        <label class="chk"><input type="checkbox" class="t-required" ${t.required ? 'checked' : ''}> 必需</label>
        <button class="btn-small btn-danger t-del">删除</button>
      </div>
      <div class="type-row">
        <label>min <input class="t-min" type="number" min="0" value="${t.min || 0}" style="width:60px"></label>
        <label>max <input class="t-max" type="number" min="0" value="${t.max || 0}" style="width:60px"></label>
        <label>尺寸（宽x高，逗号分隔多个）
          <input class="t-sizes" value="${(t.sizes || []).map((s) => s.join('x')).join(', ')}" style="width:160px">
        </label>
      </div>
      <div class="type-row port-editor" data-idx="${idx}">
        ${R.DIRS.map((d) => `
          <label>${d.toUpperCase()} 端口偏移
            <input class="t-port" data-dir="${d}" value="${((t.ports && t.ports[d]) || []).join(',')}" style="width:70px">
          </label>`).join('')}
      </div>`;
    card.querySelector('.t-del').addEventListener('click', () => {
      state.rules.roomTypes.splice(idx, 1);
      renderRulesForm();
    });
    return card;
  }

  /** 从表单收集规则（带基本解析与提示） */
  function collectRulesFromForm() {
    const r = state.rules;
    r.roomTypes = [...document.querySelectorAll('#type-list .type-card')].map((card) => {
      const portInputs = card.querySelectorAll('.t-port');
      const ports = {};
      portInputs.forEach((inp) => {
        const arr = inp.value.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n));
        ports[inp.dataset.dir] = arr;
      });
      const sizes = card.querySelector('.t-sizes').value.split(',').map((s) => {
        const m = s.toLowerCase().split('x').map((n) => parseInt(n.trim(), 10));
        return m.length === 2 ? m : null;
      }).filter(Boolean);
      return {
        id: card.querySelector('.t-id').value.trim(),
        name: card.querySelector('.t-name').value.trim(),
        color: card.querySelector('.t-color').value,
        start: card.querySelector('.t-start').checked,
        end: card.querySelector('.t-end').checked,
        required: card.querySelector('.t-required').checked,
        min: parseInt(card.querySelector('.t-min').value, 10) || 0,
        max: parseInt(card.querySelector('.t-max').value, 10) || 0,
        sizes,
        ports,
      };
    });
    r.adjacency = [...document.querySelectorAll('#adjacency-list .adj-row')].map((row) => ({
      a: row.querySelector('.adj-a').value.trim(),
      b: row.querySelector('.adj-b').value.trim(),
      allow: row.querySelector('.adj-allow').value === 'allow',
    })).filter((x) => x.a && x.b);
    return r;
  }

  function applyMeta() {
    const r = state.rules;
    r.name = $('meta-name').value;
    r.grid.width = parseInt($('meta-grid-w').value, 10) || r.grid.width;
    r.grid.height = parseInt($('meta-grid-h').value, 10) || r.grid.height;
    r.maxRooms = parseInt($('meta-max-rooms').value, 10) || r.maxRooms;
    r.defaultAdjacency = $('meta-default-adj').value;
    toast('元信息已应用', 'ok');
  }

  function addRoomType() {
    collectRulesFromForm();
    const id = 'type' + (state.rules.roomTypes.length + 1);
    state.rules.roomTypes.push({
      id, name: '新类型', color: '#888888', sizes: [[3, 3]], min: 0, max: 3,
      ports: { n: [1], s: [1], e: [1], w: [1] },
    });
    renderRulesForm();
  }

  // ---------- 相邻规则编辑 ----------
  function renderAdjacencyEditor() {
    const host = $('adjacency-list');
    host.innerHTML = '';
    (state.rules.adjacency || []).forEach((rule, idx) => host.appendChild(adjRow(rule, idx)));
  }

  function adjRow(rule, idx) {
    const ids = state.rules.roomTypes.map((t) => t.id);
    const row = document.createElement('div');
    row.className = 'adj-row';
    row.innerHTML = `
      <select class="adj-a">${['*', ...ids].map((id) => `<option ${id === rule.a ? 'selected' : ''}>${id}</option>`).join('')}</select>
      <select class="adj-b">${['*', ...ids].map((id) => `<option ${id === rule.b ? 'selected' : ''}>${id}</option>`).join('')}</select>
      <select class="adj-allow">
        <option value="allow" ${rule.allow !== false ? 'selected' : ''}>允许相邻</option>
        <option value="deny" ${rule.allow === false ? 'selected' : ''}>禁止相邻</option>
      </select>
      <button class="btn-small btn-danger adj-del">删除</button>`;
    row.querySelector('.adj-del').addEventListener('click', () => {
      state.rules.adjacency.splice(idx, 1);
      renderAdjacencyEditor();
    });
    return row;
  }

  function addAdjacencyRow() {
    collectRulesFromForm();
    const first = state.rules.roomTypes[0]?.id || '*';
    state.rules.adjacency.push({ a: first, b: first, allow: true });
    renderAdjacencyEditor();
  }

  // ---------- 生成 ----------
  function currentSeed() {
    const v = $('input-seed').value.trim();
    return v === '' ? 'default' : v;
  }

  function runGenerate() {
    collectRulesFromForm();
    state.project.rules = JSON.parse(JSON.stringify(state.rules));
    const seed = currentSeed();
    const result = G.generate(state.rules, seed);
    state.lastResult = result;
    state.currentMap = result.ok ? result.map : result.partialMap;
    state.validation = state.currentMap ? V.validate(state.currentMap, state.rules) : null;
    state.selectedRoomId = null;
    state.highlight = new Set();
    renderMap();
    renderIssues();
    renderStatus(result);
    if (!result.ok) renderConflicts(result.conflicts);
    else $('conflict-panel').innerHTML = '';
  }

  function runCheckRules() {
    collectRulesFromForm();
    const issues = R.validateRules(state.rules);
    const host = $('conflict-panel');
    if (!issues.length) {
      host.innerHTML = '<div class="ok-box">规则静态检查通过，无问题。</div>';
      return;
    }
    host.innerHTML = issues.map((i) =>
      `<div class="conflict ${i.severity === 'warning' ? 'warn' : 'err'}">
        <b>[${i.severity === 'warning' ? '警告' : '错误'}][${i.code}]</b> ${escapeHtml(i.message)}</div>`).join('');
  }

  function renderStatus(result) {
    const box = $('gen-status');
    if (result.ok) {
      const v = state.validation;
      box.innerHTML = `<span class="badge badge-ok">生成成功</span>
        种子 <code>${escapeHtml(result.map.seed)}</code> ·
        房间 ${result.map.rooms.length} · 连接 ${result.map.edges.length} ·
        回溯节点 ${result.map.nodeVisits} ·
        校验 ${v.ok ? '<b class="ok-text">通过</b>' : `<b class="err-text">${v.errors.length} 错误 / ${v.warnings.length} 警告</b>`}`;
    } else {
      box.innerHTML = `<span class="badge badge-err">生成失败</span> 已在下方列出冲突条件，并渲染回溯终止时的局部地图。`;
    }
  }

  function renderConflicts(conflicts) {
    const host = $('conflict-panel');
    host.innerHTML = `<div class="conflict-title">冲突条件（按拦截次数排序，前 15 条）</div>` +
      conflicts.slice(0, 15).map((c) =>
        `<div class="conflict err">
          <b>[${c.code}]</b> ×${c.count}<br>${escapeHtml(c.message)}
          ${c.detail ? `<pre class="detail">${escapeHtml(JSON.stringify(c.detail))}</pre>` : ''}
        </div>`).join('');
  }

  // ---------- 校验问题 ----------
  function renderIssues() {
    const host = $('issue-list');
    if (!state.validation) {
      host.innerHTML = '<div class="muted">无地图</div>';
      return;
    }
    if (!state.validation.issues.length) {
      host.innerHTML = '<div class="ok-box">✔ 全部检查通过：起终点连通、必需房间可达、无孤立门口/房间。</div>';
      return;
    }
    host.innerHTML = state.validation.issues.map((iss, i) =>
      `<div class="issue ${iss.severity}" data-i="${i}">
        <span class="badge badge-${iss.severity === 'error' ? 'err' : 'warn'}">${iss.severity === 'error' ? '错误' : '警告'}</span>
        <code>${iss.code}</code> ${escapeHtml(iss.message)}
      </div>`).join('');
  }

  function onIssueClick(e) {
    const item = e.target.closest('.issue');
    if (!item || !state.validation) return;
    const iss = state.validation.issues[parseInt(item.dataset.i, 10)];
    state.highlight = new Set();
    for (const a of iss.anchors) state.highlight.add(a.type + ':' + a.id);
    // 选中关联房间
    const roomAnchor = iss.anchors.find((a) => a.type === 'room');
    if (roomAnchor) state.selectedRoomId = roomAnchor.id;
    renderMap();
  }

  // ---------- 地图渲染 ----------
  function renderMap() {
    const svg = $('map-svg');
    if (!state.currentMap) {
      G && window.DungeonRender.render(svg, null, state.rules, {});
      return;
    }
    window.DungeonRender.render(svg, state.currentMap, state.rules, {
      validation: state.validation,
      selectedId: state.selectedRoomId,
      highlight: state.highlight,
      lockedIds: state.lockedIds,
      onSelect: (id) => {
        state.selectedRoomId = id;
        renderMap();
        renderRoomDetail();
      },
      zoom: parseFloat($('input-zoom').value) || 1,
    });
    renderRoomDetail();
  }

  function renderRoomDetail() {
    const host = $('room-detail');
    const room = state.currentMap?.rooms.find((r) => r.id === state.selectedRoomId);
    if (!room) {
      host.innerHTML = '<span class="muted">点击地图上的房间查看详情 / 锁定</span>';
      return;
    }
    const t = R.getType(state.rules, room.type);
    const isLocked = state.lockedIds.has(room.id);
    host.innerHTML = `
      <div><b>${room.id}</b> · ${escapeHtml(t?.name || room.type)} ${isLocked ? '🔒 已锁定' : ''}</div>
      <div class="muted">位置 (${room.x}, ${room.y})，尺寸 ${room.w}×${room.h}</div>
      <div class="muted">端口 ${room.ports.length} 个，已连接 ${room.ports.filter((p) => p.connects).length} 个</div>
      <button class="btn-small ${isLocked ? 'btn-danger' : 'btn-primary'}" id="btn-toggle-lock">
        ${isLocked ? '解锁该房间' : '锁定该房间'}
      </button>`;
    $('btn-toggle-lock').addEventListener('click', () => {
      if (state.lockedIds.has(room.id)) state.lockedIds.delete(room.id);
      else state.lockedIds.add(room.id);
      renderMap();
      renderRoomDetail();
    });
  }

  // ---------- 锁定重生成 ----------
  function regenerateWithLocks() {
    if (!state.currentMap) return toast('请先生成一张地图', 'error');
    collectRulesFromForm();
    const lockedRooms = state.currentMap.rooms
      .filter((r) => state.lockedIds.has(r.id))
      .map((r) => {
        // 指向非锁定房间的连接先断开，交由生成器重新接线
        const lockedPortIds = new Set(state.currentMap.rooms
          .filter((x) => state.lockedIds.has(x.id))
          .flatMap((x) => x.ports.map((p) => p.id)));
        return {
          ...r,
          locked: true,
          ports: r.ports.map((p) => ({ ...p, connects: lockedPortIds.has(p.connects) ? p.connects : null })),
        };
      });
    if (!lockedRooms.length) return toast('没有锁定任何房间：先在地图上选中房间并锁定', 'error');
    const result = G.generate(state.rules, currentSeed() + '-relock', { lockedRooms });
    state.lastResult = result;
    if (!result.ok) {
      state.currentMap = result.partialMap;
      state.validation = state.currentMap ? V.validate(state.currentMap, state.rules, lockedReference(lockedRooms)) : null;
      renderConflicts(result.conflicts);
    } else {
      state.currentMap = result.map;
      state.validation = V.validate(result.map, state.rules, lockedReference(lockedRooms));
      $('conflict-panel').innerHTML = '';
    }
    state.highlight = new Set();
    renderMap();
    renderIssues();
    renderStatus(result);
    toast(result.ok ? '已在保留锁定房间的前提下重新生成' : '重生成失败，已标出冲突', result.ok ? 'ok' : 'error');
  }

  function lockedReference(lockedRooms) {
    return { rooms: lockedRooms };
  }

  function clearLocks() {
    state.lockedIds.clear();
    renderMap();
    renderRoomDetail();
  }

  // ---------- 工程保存 / 打开 ----------
  function saveProject() {
    collectRulesFromForm();
    state.project.rules = JSON.parse(JSON.stringify(state.rules));
    state.project.lockedRoomIds = [...state.lockedIds];
    download('dungeon-project.dungeon.json', JSON.stringify(state.project, null, 2));
    toast('工程已保存（规则 + 全部版本）', 'ok');
  }

  function openProject(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = P.normalizeProject(JSON.parse(reader.result));
        state.project = data;
        state.rules = JSON.parse(JSON.stringify(data.rules));
        state.lockedIds = new Set(data.lockedRoomIds);
        renderRulesForm();
        renderAdjacencyEditor();
        renderVersionList();
        const active = data.versions.find((v) => v.id === data.activeVersionId) || data.versions[data.versions.length - 1];
        if (active) loadVersion(active);
        toast('工程已打开，可继续调整规则', 'ok');
      } catch (err) {
        toast('打开失败：' + err.message, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function exportMap() {
    if (!state.currentMap) return toast('没有可导出的地图', 'error');
    download('dungeon-map.json', JSON.stringify(state.currentMap, null, 2));
  }

  function importMap(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const map = JSON.parse(reader.result);
        state.currentMap = map;
        state.validation = V.validate(map, state.rules);
        renderMap();
        renderIssues();
        toast('地图已导入并完成校验', 'ok');
      } catch (err) {
        toast('导入失败：' + err.message, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // ---------- 版本管理 ----------
  function saveVersion() {
    if (!state.lastResult?.ok) return toast('只有生成成功的地图才能存为版本', 'error');
    const label = $('input-version-label').value.trim();
    const v = P.addVersion(state.project, JSON.parse(JSON.stringify(state.currentMap)), label);
    $('input-version-label').value = '';
    renderVersionList();
    toast(`已保存版本「${v.label}」`, 'ok');
  }

  function renderVersionList() {
    const host = $('version-list');
    if (!state.project.versions.length) {
      host.innerHTML = '<span class="muted">尚无保存的版本</span>';
      return;
    }
    host.innerHTML = state.project.versions.map((v) => `
      <div class="version-row ${state.project.activeVersionId === v.id ? 'active' : ''}">
        <label class="chk"><input type="checkbox" class="vcmp" data-id="${v.id}"
          ${state.compareIds.includes(v.id) ? 'checked' : ''}> 对比</label>
        <a href="#" class="vload" data-id="${v.id}"><b>${escapeHtml(v.label)}</b></a>
        <span class="muted">seed=${escapeHtml(v.seed)} · ${v.map.rooms.length}房 · ${v.createdAt.slice(0, 16)}</span>
        <button class="btn-small btn-danger vdel" data-id="${v.id}">删除</button>
      </div>`).join('');
  }

  function onVersionClick(e) {
    const cmp = e.target.closest('.vcmp');
    if (cmp) {
      const id = cmp.dataset.id;
      if (cmp.checked) {
        if (state.compareIds.length >= 2) {
          cmp.checked = false;
          return toast('最多选择两个版本对比', 'error');
        }
        state.compareIds.push(id);
      } else {
        state.compareIds = state.compareIds.filter((x) => x !== id);
      }
      return;
    }
    const load = e.target.closest('.vload');
    if (load) {
      e.preventDefault();
      const v = state.project.versions.find((x) => x.id === load.dataset.id);
      loadVersion(v);
    }
    const del = e.target.closest('.vdel');
    if (del) {
      P.removeVersion(state.project, del.dataset.id);
      state.compareIds = state.compareIds.filter((x) => x !== del.dataset.id);
      renderVersionList();
    }
  }

  function loadVersion(v) {
    state.project.activeVersionId = v.id;
    state.currentMap = JSON.parse(JSON.stringify(v.map));
    state.validation = V.validate(state.currentMap, state.rules);
    state.highlight = new Set();
    renderMap();
    renderIssues();
    renderVersionList();
    toast(`已加载版本「${v.label}」`, 'ok');
  }

  function runCompare() {
    if (state.compareIds.length !== 2) return toast('请勾选两个版本进行对比', 'error');
    const [va, vb] = state.compareIds.map((id) => state.project.versions.find((v) => v.id === id));
    const cmp = P.compareMaps(state.rules, va.map, vb.map);
    const fmt = (n) => (n > 0 ? `+${n}` : String(n));
    const row = (r) => `<tr><td>${r.label}</td><td>${r.a}</td><td>${r.b}</td>
      <td class="${r.delta > 0 ? 'delta-up' : r.delta < 0 ? 'delta-down' : ''}">${fmt(r.delta)}</td></tr>`;
    $('compare-panel').innerHTML = `
      <div class="compare-title">对比：${escapeHtml(va.label)} (A) → ${escapeHtml(vb.label)} (B)</div>
      <table class="compare-table">
        <thead><tr><th>指标</th><th>A</th><th>B</th><th>变化</th></tr></thead>
        <tbody>${cmp.rows.map(row).join('')}${cmp.typeRows.map(row).join('')}</tbody>
      </table>`;
  }

  // ---------- 工具 ----------
  function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
