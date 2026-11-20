/* 主应用：把编辑器、引擎、模拟世界、各面板与持久化串联起来 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const { STATUS } = BTEngineNS;

  /* ---------------- 全局状态 ---------------- */

  let project = null;
  let blackboard = null;
  let simulation = null;
  let engine = null;
  let editor = null;
  let logger = null;

  let runState = 'stopped';   // stopped | running | paused | finished
  let tickTimer = null;
  let lastTickAt = 0;
  let speed = 1;
  let initialBlackboard = null;   // 工程加载/导入时的黑板基线，「重置整树」回到这里
  const autosave = BTUtils.debounce(() => BTProject.saveToStorage(project), 300);

  /* ---------------- 初始化 ---------------- */

  function init() {
    project = BTProject.loadFromStorage();
    if (!project) project = BTExamples.buildExampleProject();
    initialBlackboard = BTUtils.deepClone(project.blackboard);

    blackboard = new BTBlackboard.Blackboard(project.blackboard, () => {
      project.blackboard = blackboard.snapshot();
      renderBlackboardPanel();
      autosave();
    });

    logger = createLogger();
    simulation = new BTSim.Simulation($('simCanvas'), blackboard, logger, () => {
      project.scene = simulation.getSnapshot();
      renderScenePanel();
      autosave();
    });
    simulation.loadScene(project.scene);

    editor = new BTEditor.Editor({
      svg: $('editorSvg'),
      getTree: currentTree,
      getNodeStatus: (id) => engine ? engine.getState(id).status : STATUS.IDLE,
      getEdgeStatus: (id) => (engine && engine.edgeStates[id]) || STATUS.IDLE,
      isActive: (id) => engine ? engine.activePath.has(id) : false,
      onSelect: renderPropertyPanel,
      onChange: () => { autosave(); },
      onConnect: handleConnect,
      onDeleteSelection: handleDeleteSelection
    });
    $('editorSvg').addEventListener('bt-connect-rejected', (ev) => {
      toast('非法连接：' + ev.detail.reason, 'error');
    });

    bindTopbar();
    bindPalette();
    bindRunControls();
    bindBlackboardPanel();
    bindScenePanel();
    switchTree(project.activeTreeId, true);
    renderAll();
    logger.log('info', '工程已加载，包含 ' + project.trees.length + ' 个示例行为树，点击「▶ 运行」开始调试');
    validateAndWarn(true);
  }

  function currentTree() {
    return project.trees.find((t) => t.id === project.activeTreeId) || project.trees[0];
  }

  /* ---------------- 树标签页 ---------------- */

  function bindTopbar() {
    $('btnNewTree').addEventListener('click', () => {
      const tree = BTProject.createTree('行为树 ' + (project.trees.length + 1));
      project.trees.push(tree);
      project.activeTreeId = tree.id;
      switchTree(tree.id);
      toast('已新建行为树', 'success');
    });
    $('btnExport').addEventListener('click', () => {
      const name = BTProject.exportFile(project);
      toast('项目已导出：' + name, 'success');
    });
    $('btnImport').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imported = BTProject.parseImport(reader.result);
          stopRun();
          project = imported;
          initialBlackboard = BTUtils.deepClone(project.blackboard);
          blackboard.load(project.blackboard);
          simulation.loadScene(project.scene);
          project.activeTreeId = project.trees[0] ? project.trees[0].id : null;
          if (project.trees.length) switchTree(project.activeTreeId, true);
          renderAll();
          toast(`导入成功：${project.trees.length} 个行为树`, 'success');
          autosave();
        } catch (e) {
          toast('导入失败：' + e.message, 'error');
        } finally {
          ev.target.value = '';
        }
      };
      reader.readAsText(file);
    });
  }

  function renderTreeTabs() {
    const wrap = $('treeTabs');
    wrap.innerHTML = '';
    for (const tree of project.trees) {
      const tab = document.createElement('div');
      tab.className = 'tree-tab' + (tree.id === project.activeTreeId ? ' active' : '');
      tab.innerHTML = BTUtils.escapeHtml(tree.name) +
        (project.trees.length > 1 ? '<span class="tab-close" title="删除该树">✕</span>' : '');
      tab.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('tab-close')) {
          deleteTree(tree.id);
        } else {
          switchTree(tree.id);
        }
      });
      wrap.appendChild(tab);
    }
  }

  function switchTree(treeId, keepView) {
    if (!treeId) { editor && editor.render(); return; }
    project.activeTreeId = treeId;
    stopRun();
    engine = new BTEngineNS.BTEngine(currentTree(), blackboard, simulation.getActionHandlers(), logger);
    editor.select({ kind: null, id: null });
    editor.render();
    if (!keepView) editor.resetView();
    renderTreeTabs();
    renderPropertyPanel();
    updateRunUI();
    autosave();
  }

  function deleteTree(treeId) {
    if (project.trees.length <= 1) {
      toast('至少要保留一个行为树', 'error');
      return;
    }
    const tree = project.trees.find((t) => t.id === treeId);
    if (!confirm(`确定删除行为树「${tree.name}」吗？该操作不可撤销。`)) return;
    stopRun();
    project.trees = project.trees.filter((t) => t.id !== treeId);
    if (project.activeTreeId === treeId) {
      project.activeTreeId = project.trees[0].id;
    }
    switchTree(project.activeTreeId, true);
    toast('已删除行为树', 'success');
  }

  /* ---------------- 节点库 ---------------- */

  function bindPalette() {
    const palette = $('palette');
    for (const [type, meta] of Object.entries(BTEngineNS.NODE_TYPES)) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.title = meta.desc;
      btn.textContent = '＋ ' + meta.label;
      btn.style.borderLeft = `3px solid ${meta.color}`;
      btn.addEventListener('click', () => addNode(type));
      palette.appendChild(btn);
    }
  }

  function addNode(type) {
    const tree = currentTree();
    const rect = $('editorSvg').getBoundingClientRect();
    const center = editor._toWorld(rect.width / 2, rect.height / 2);
    const node = BTProject.createNode(
      type, BTEngineNS.NODE_TYPES[type].label,
      Math.round(center.x - 84 + (Math.random() * 60 - 30)),
      Math.round(center.y - 30 + (Math.random() * 60 - 30))
    );
    tree.nodes.push(node);
    invalidateRuntime('结构已变更');
    editor.select({ kind: 'node', id: node.id });
    autosave();
  }

  function handleConnect(parentId, childId) {
    const tree = currentTree();
    const check = BTEngineNS.validateConnection(tree, parentId, childId);
    if (!check.ok) return check;
    tree.edges.push(BTProject.createEdge(parentId, childId));
    invalidateRuntime('连线已变更');
    editor.render();
    autosave();
    return { ok: true, reason: '' };
  }

  function handleDeleteSelection() {
    const sel = editor.getSelection();
    const tree = currentTree();
    if (sel.kind === 'node') {
      const node = tree.nodes.find((n) => n.id === sel.id);
      if (!node) return;
      tree.nodes = tree.nodes.filter((n) => n.id !== sel.id);
      tree.edges = tree.edges.filter((e) => e.from !== sel.id && e.to !== sel.id);
      invalidateRuntime('节点已删除');
      editor.select({ kind: null, id: null });
      toast(`已删除节点「${node.name}」及其连线`, 'success');
    } else if (sel.kind === 'edge') {
      tree.edges = tree.edges.filter((e) => e.id !== sel.id);
      invalidateRuntime('连线已删除');
      editor.select({ kind: null, id: null });
    }
    autosave();
  }

  /* ---------------- 属性面板 ---------------- */

  function renderPropertyPanel() {
    const panel = $('propertyPanel');
    const sel = editor.getSelection();
    const tree = currentTree();
    if (!sel.kind) {
      const result = BTEngineNS.validateTree(tree);
      panel.innerHTML = renderTreeHealth(result);
      return;
    }
    if (sel.kind === 'edge') {
      const edge = tree.edges.find((e) => e.id === sel.id);
      if (!edge) { panel.innerHTML = '<p class="muted">连线不存在</p>'; return; }
      const parent = tree.nodes.find((n) => n.id === edge.from);
      const child = tree.nodes.find((n) => n.id === edge.to);
      panel.innerHTML = `
        <div class="prop-title">连线</div>
        <p class="muted">父节点：<b>${BTUtils.escapeHtml(parent.name)}</b><br>
        子节点：<b>${BTUtils.escapeHtml(child.name)}</b></p>
        <div class="prop-actions">
          <button class="btn btn-danger" id="propDeleteEdge">删除连线</button>
        </div>`;
      $('propDeleteEdge').addEventListener('click', handleDeleteSelection);
      return;
    }

    const node = tree.nodes.find((n) => n.id === sel.id);
    if (!node) { panel.innerHTML = '<p class="muted">节点不存在</p>'; return; }
    const meta = BTEngineNS.NODE_TYPES[node.type];
    const st = engine ? engine.getState(node.id).status : STATUS.IDLE;

    let html = `
      <div class="prop-title">
        <span class="type-badge" style="background:${meta.color}">${meta.label}</span>
        <span>${BTUtils.escapeHtml(node.name)}</span>
      </div>
      <p class="muted" style="margin:0 0 10px">${meta.desc}</p>
      <p class="muted">运行状态：<b style="color:${statusColor(st)}">${statusLabel(st)}</b></p>
      <label class="field"><span>节点名称（重命名不影响连线与引用）</span>
        <input id="propName" value="${BTUtils.escapeHtml(node.name)}"></label>`;

    html += renderTypeFields(node);
    html += renderChildOrder(tree, node);
    html += `<div class="prop-actions">
      <button class="btn btn-danger" id="propDeleteNode">删除节点</button>
    </div>`;
    panel.innerHTML = html;

    $('propName').addEventListener('input', (ev) => {
      node.name = ev.target.value;
      autosave();
      editor.render();
    });
    bindTypeFields(node);
    bindChildOrder(tree, node);
    $('propDeleteNode').addEventListener('click', handleDeleteSelection);
  }

  function renderTypeFields(node) {
    const p = node.params;
    if (node.type === 'condition') {
      const keys = Object.keys(blackboard.data);
      const opts = keys.map((k) =>
        `<option value="${BTUtils.escapeHtml(k)}" ${p.key === k ? 'selected' : ''}>${BTUtils.escapeHtml(k)}</option>`).join('');
      const opOpts = BTEngineNS.OPS.map((o) =>
        `<option value="${o}" ${p.op === o ? 'selected' : ''}>${o}</option>`).join('');
      return `
        <label class="field"><span>黑板字段</span>
          <select id="propKey"><option value="">— 请选择 —</option>${opts}</select></label>
        <label class="field"><span>比较运算符</span><select id="propOp">${opOpts}</select></label>
        <label class="field"><span>比较值（true/false/数字/字符串）</span>
          <input id="propValue" value="${BTUtils.escapeHtml(p.value)}"></label>
        ${p.key && !blackboard.has(p.key) ? '<p class="muted" style="color:#e5534b">该字段当前不在黑板中，运行时按失败处理</p>' : ''}`;
    }
    if (node.type === 'loop') {
      return `<label class="field"><span>循环次数（0 = 无限循环）</span>
        <input id="propCount" type="number" min="0" step="1" value="${BTUtils.escapeHtml(p.count)}"></label>`;
    }
    if (node.type === 'action') {
      const typeOpts = Object.entries(BTSim.ACTION_TYPES).map(([t, m]) =>
        `<option value="${t}" ${p.actionType === t ? 'selected' : ''}>${m.label}</option>`).join('');
      let extra = '';
      if (p.actionType === 'wait') {
        extra = `<label class="field"><span>等待时长（毫秒）</span>
          <input id="p_duration" type="number" min="0" step="100" value="${BTUtils.escapeHtml(p.duration)}"></label>`;
      } else if (p.actionType === 'goto') {
        const markers = ['home', 'player',
          ...simulation.scene.patrolPoints.map((pp) => pp.id)];
        const markerOpts = markers.map((m) =>
          `<option value="${m}" ${p.target === m ? 'selected' : ''}>${m}</option>`).join('');
        extra = `<label class="field"><span>目标标记</span><select id="p_target">${markerOpts}</select></label>
          <label class="field"><span>移动速度（像素/秒）</span>
          <input id="p_speed" type="number" min="1" step="5" value="${BTUtils.escapeHtml(p.speed)}"></label>`;
      } else if (p.actionType === 'patrol') {
        extra = `<label class="field"><span>移动速度（像素/秒）</span>
          <input id="p_speed" type="number" min="1" step="5" value="${BTUtils.escapeHtml(p.speed)}"></label>`;
      } else if (p.actionType === 'log') {
        extra = `<label class="field"><span>日志文本</span>
          <input id="p_text" value="${BTUtils.escapeHtml(p.text)}"></label>`;
      } else if (p.actionType === 'setBlackboard') {
        const keys = Object.keys(blackboard.data);
        const keyOpts = keys.map((k) =>
          `<option value="${BTUtils.escapeHtml(k)}" ${p.key === k ? 'selected' : ''}>${BTUtils.escapeHtml(k)}</option>`).join('');
        extra = `
          <label class="field"><span>黑板字段</span><select id="p_key"><option value="">— 请选择 —</option>${keyOpts}</select></label>
          <label class="field"><span>模式</span>
            <select id="p_mode">
              <option value="assign" ${p.mode !== 'increment' ? 'selected' : ''}>赋值</option>
              <option value="increment" ${p.mode === 'increment' ? 'selected' : ''}>自增</option>
            </select></label>
          <label class="field"><span id="p_value_label">值</span>
            <input id="p_value" value="${BTUtils.escapeHtml(p.value)}"></label>
          <label class="field" id="p_modulo_wrap"><span>模数（可选，自增后按模回绕，例如巡逻点数）</span>
            <input id="p_modulo" value="${BTUtils.escapeHtml(p.modulo || '')}"></label>`;
      }
      return `<label class="field"><span>动作类型</span>
        <select id="propActionType">${typeOpts}</select></label>${extra}
        <p class="muted">${BTUtils.escapeHtml(BTSim.ACTION_TYPES[p.actionType].desc)}</p>`;
    }
    return '';
  }

  function bindTypeFields(node) {
    const p = node.params;
    const bind = (id, key, opts) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener(opts && opts.event || 'input', () => {
        let v = el.value;
        if (opts && opts.number) v = v === '' ? '' : Number(v);
        p[key] = v;
        if (opts && opts.rerender) renderPropertyPanel();
        editor.render();
        autosave();
      });
    };
    if (node.type === 'condition') {
      bind('propKey', 'key', { event: 'change' });
      bind('propOp', 'op', { event: 'change' });
      bind('propValue', 'value');
    } else if (node.type === 'loop') {
      bind('propCount', 'count');
    } else if (node.type === 'action') {
      $('propActionType').addEventListener('change', (ev) => {
        p.actionType = ev.target.value;
        Object.assign(p, BTProject.actionParamsFor(p.actionType));
        invalidateRuntime('动作参数已变更');
        renderPropertyPanel();
        editor.render();
        autosave();
      });
      bind('p_duration', 'duration');
      bind('p_target', 'target', { event: 'change' });
      bind('p_speed', 'speed');
      bind('p_text', 'text');
      bind('p_key', 'key', { event: 'change' });
      bind('p_mode', 'mode', { event: 'change', rerender: true });
      bind('p_value', 'value');
      bind('p_modulo', 'modulo');
    }
  }

  function renderChildOrder(tree, node) {
    const children = BTEngineNS.getChildren(tree, node.id);
    if (!children.length) return '';
    return `<h3 style="margin-top:14px">子节点顺序（${children.length}）</h3>
      <div class="order-btns">
        <button class="btn btn-mini" id="orderUp">↑ 上移</button>
        <button class="btn btn-mini" id="orderDown">↓ 下移</button>
      </div>
      <p class="muted" id="orderName" style="margin:6px 0 0"></p>`;
  }

  function bindChildOrder(tree, node) {
    const children = BTEngineNS.getChildren(tree, node.id);
    if (!children.length) return;
    $('orderName').textContent = '当前顺序：' + children.map((c) => c.name).join(' → ');
    $('orderUp').addEventListener('click', () => moveChild(node, -1));
    $('orderDown').addEventListener('click', () => moveChild(node, 1));
  }

  function moveChild(parent, dir) {
    const tree = currentTree();
    const edges = tree.edges.filter((e) => e.from === parent.id);
    if (edges.length < 2) return;
    const all = tree.edges;
    const pos = edges.map((e) => all.indexOf(e));
    if (dir < 0) {
      // 把第一个子节点与第二个交换（上移）
      const a = pos[0], b = pos[1];
      [all[a], all[b]] = [all[b], all[a]];
    } else {
      // 把最后一个子节点与倒数第二个交换（下移）
      const a = pos[pos.length - 2], b = pos[pos.length - 1];
      [all[a], all[b]] = [all[b], all[a]];
    }
    invalidateRuntime('子节点顺序已调整');
    editor.render();
    renderPropertyPanel();
    autosave();
  }

  function renderTreeHealth(result) {
    const errs = result.errors.map((e) => `<li>${BTUtils.escapeHtml(e.message)}</li>`).join('');
    const warns = result.warnings.map((w) => `<li>${BTUtils.escapeHtml(w.message)}</li>`).join('');
    return `
      <div class="prop-title">树结构检查</div>
      ${result.valid
        ? '<p style="color:var(--success)">✓ 结构合法，可以运行</p>'
        : `<ul style="color:var(--failure);padding-left:18px;margin:6px 0">${errs}</ul>`}
      ${warns ? `<ul style="color:var(--running);padding-left:18px;margin:6px 0">${warns}</ul>` : ''}
      <p class="muted">选中节点或连线可编辑属性；从子节点顶部圆点拖线到父节点底部圆点建立父子关系。</p>`;
  }

  /* ---------------- 黑板面板 ---------------- */

  function bindBlackboardPanel() {
    // 事件委托：重命名 / 删除 / 即时改值
    $('blackboardPanel').addEventListener('click', (ev) => {
      const btn = ev.target.closest('.icon-btn');
      if (!btn) return;
      const key = btn.dataset.key;
      if (btn.dataset.act === 'del') {
        if (!confirm(`删除黑板字段「${key}」？引用它的条件节点会在运行时按失败处理。`)) return;
        blackboard.remove(key);
        project.blackboard = blackboard.snapshot();
        editor.render();
        renderPropertyPanel();
        toast('已删除黑板字段 ' + key, 'success');
        autosave();
      } else if (btn.dataset.act === 'rename') {
        const next = prompt('重命名黑板字段（所有行为树中的引用会同步更新）：', key);
        if (!next || next === key) return;
        try {
          BTProject.renameBlackboardKey(project, key, next);
          blackboard.load(project.blackboard);
          editor.render();
          renderPropertyPanel();
          toast(`字段已重命名：${key} → ${next}，引用未丢失`, 'success');
          autosave();
        } catch (e) {
          toast(e.message, 'error');
        }
      }
    });
    $('blackboardPanel').addEventListener('change', (ev) => {
      if (!ev.target.classList.contains('bb-value-input')) return;
      const key = ev.target.dataset.key;
      blackboard.set(key, BTUtils.coerceValue(ev.target.value));
      project.blackboard = blackboard.snapshot();
      if (runState === 'paused') {
        toast(`已更新「${key}」，可点单步/继续从当前节点重新求值`, 'success');
      }
      autosave();
    });
  }

  function renderBlackboardPanel() {
    const panel = $('blackboardPanel');
    const rows = blackboard.entries().map(([k, v]) => {
      const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      return `
        <div class="bb-row">
          <div><div class="bb-key">${BTUtils.escapeHtml(k)}</div><div class="bb-type">${type}</div></div>
          <input class="bb-value-input" data-key="${BTUtils.escapeHtml(k)}"
                 value="${BTUtils.escapeHtml(BTUtils.formatValue(v))}"
                 ${runState === 'running' ? 'disabled title="运行中不可编辑，请先暂停"' : ''}>
          <div class="bb-actions">
            <button class="icon-btn" data-act="rename" data-key="${BTUtils.escapeHtml(k)}" title="重命名（同步更新引用）">✎</button>
            <button class="icon-btn" data-act="del" data-key="${BTUtils.escapeHtml(k)}" title="删除">🗑</button>
          </div>
        </div>`;
    }).join('');
    panel.innerHTML = rows + `
      <div class="bb-add">
        <input id="bbNewKey" placeholder="新字段名">
        <input id="bbNewValue" placeholder="初始值">
        <button class="btn btn-mini" id="bbAddBtn">添加</button>
      </div>`;
    $('bbAddBtn').addEventListener('click', () => {
      const k = $('bbNewKey').value.trim();
      if (!k) { toast('字段名不能为空', 'error'); return; }
      if (blackboard.has(k)) { toast('字段已存在', 'error'); return; }
      blackboard.set(k, BTUtils.coerceValue($('bbNewValue').value));
      project.blackboard = blackboard.snapshot();
      $('bbNewKey').value = ''; $('bbNewValue').value = '';
      renderPropertyPanel();
      autosave();
    });
  }

  /* ---------------- 场景面板 ---------------- */

  function bindScenePanel() {
    $('scenePanel').addEventListener('click', (ev) => {
      const btn = ev.target.closest('.icon-btn');
      if (!btn || btn.dataset.act !== 'del-pp') return;
      simulation.removePatrolPoint(btn.dataset.id);
      project.scene = simulation.getSnapshot();
      renderScenePanel();
      renderPropertyPanel();
      autosave();
    });
  }

  function renderScenePanel() {
    const s = simulation.scene;
    const row = (name, pos) => `
      <div class="scene-row">
        <span class="marker-name">${name}</span>
        <span class="marker-pos">(${Math.round(pos.x)}, ${Math.round(pos.y)})</span>
      </div>`;
    const ppRows = s.patrolPoints.map((pp) => `
      <div class="scene-row">
        <span class="marker-name">${pp.id}</span>
        <span class="marker-pos">(${Math.round(pp.x)}, ${Math.round(pp.y)})</span>
        <button class="icon-btn" data-act="del-pp" data-id="${pp.id}" title="删除巡逻点">🗑</button>
      </div>`).join('');
    $('scenePanel').innerHTML =
      row('agent 角色', s.agent) + row('player 玩家', s.player) + row('home 家', s.home) +
      '<h3 style="margin-top:8px">巡逻点（' + s.patrolPoints.length + '）</h3>' +
      ppRows +
      '<div class="add-row"><button class="btn btn-mini" id="addPpBtn">＋ 添加巡逻点</button></div>';
    $('addPpBtn').addEventListener('click', () => {
      simulation.addPatrolPoint();
      project.scene = simulation.getSnapshot();
      renderScenePanel();
      renderPropertyPanel();
      autosave();
    });
  }

  /* ---------------- 日志 ---------------- */

  function createLogger() {
    const MAX = 300;
    return {
      log(level, msg) {
        const panel = $('logPanel');
        const line = document.createElement('div');
        line.className = 'log-line log-' + level;
        const t = new Date();
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        const ss = String(t.getSeconds()).padStart(2, '0');
        line.innerHTML = `<span class="log-time">${hh}:${mm}:${ss}</span>${BTUtils.escapeHtml(msg)}`;
        panel.appendChild(line);
        while (panel.children.length > MAX) panel.removeChild(panel.firstChild);
        panel.scrollTop = panel.scrollHeight;
      }
    };
  }

  /* ---------------- 运行控制 ---------------- */

  function bindRunControls() {
    $('btnRun').addEventListener('click', onRun);
    $('btnPause').addEventListener('click', onPause);
    $('btnStep').addEventListener('click', onStep);
    $('btnReset').addEventListener('click', onReset);
    $('btnClearLog').addEventListener('click', () => { $('logPanel').innerHTML = ''; });
    $('speedRange').addEventListener('input', (ev) => {
      speed = Number(ev.target.value);
      $('speedLabel').textContent = speed.toFixed(1) + '×';
      if (runState === 'running') scheduleTick();
    });
    $('tickInterval').addEventListener('change', (ev) => {
      let v = Number(ev.target.value);
      if (Number.isNaN(v) || v < 100) v = 500;
      ev.target.value = v;
      if (runState === 'running') scheduleTick();
    });
    $('btnZoomIn').addEventListener('click', () => editor.setZoom(editor.scale * 1.2));
    $('btnZoomOut').addEventListener('click', () => editor.setZoom(editor.scale / 1.2));
    $('btnFit').addEventListener('click', () => editor.fitView());
  }

  function ensureEngine() {
    const tree = currentTree();
    if (!engine || engine.tree !== tree) {
      engine = new BTEngineNS.BTEngine(tree, blackboard, simulation.getActionHandlers(), logger);
    }
    const result = BTEngineNS.validateTree(tree);
    if (!result.valid) {
      for (const e of result.errors) toast('无法运行：' + e.message, 'error');
      logger.log('warn', '运行被拦截：树结构存在 ' + result.errors.length + ' 个错误');
      return false;
    }
    for (const w of result.warnings) logger.log('warn', w.message);
    return true;
  }

  function onRun() {
    if (runState === 'running') return;
    if (runState === 'stopped' || runState === 'finished') {
      if (!ensureEngine()) return;
      logger.log('info', `▶ 开始运行行为树「${currentTree().name}」`);
    } else if (runState === 'paused') {
      logger.log('info', '继续运行');
    }
    runState = 'running';
    updateRunUI();
    scheduleTick();
  }

  function onPause() {
    if (runState !== 'running') return;
    runState = 'paused';
    clearTimeout(tickTimer);
    tickTimer = null;
    updateRunUI();
    logger.log('info', '⏸ 已暂停，可在右侧查看/修改黑板变量，然后继续或单步');
    editor.refreshStatus();
  }

  function onStep() {
    if (runState === 'running') return;
    if (runState === 'stopped' || runState === 'finished') {
      if (!ensureEngine()) return;
      logger.log('info', `单步调试「${currentTree().name}」`);
    }
    runState = 'paused';
    doTick(currentInterval());
    updateRunUI();
  }

  function onReset() {
    stopRun();
    runState = 'stopped';
    if (engine) engine.reset();
    // 场景与黑板都恢复到工程加载时的基线（用户自建字段保留）
    simulation.reset(project.scene, initialBlackboard);
    project.blackboard = blackboard.snapshot();
    renderBlackboardPanel();
    editor.refreshStatus();
    updateRunUI();
    logger.log('info', '⟲ 整棵树与调试场景已重置，黑板恢复初始值');
  }

  function stopRun() {
    clearTimeout(tickTimer);
    tickTimer = null;
    runState = 'stopped';
    updateRunUI();
  }

  /** 结构/参数变化后让旧运行状态失效 */
  function invalidateRuntime(reason) {
    if (runState !== 'stopped') {
      stopRun();
      logger.log('warn', '运行已停止：' + reason);
      toast('运行已停止：' + reason, 'error');
    }
    if (engine) engine.reset();
    editor.render();
  }

  function currentInterval() {
    return Math.max(100, Number($('tickInterval').value) || 500);
  }

  function scheduleTick() {
    clearTimeout(tickTimer);
    const interval = currentInterval() / speed;
    lastTickAt = performance.now();
    tickTimer = setTimeout(() => {
      if (runState !== 'running') return;
      const dt = performance.now() - lastTickAt;
      doTick(dt);
      if (runState === 'running') scheduleTick();
    }, interval);
  }

  function doTick(dt) {
    simulation.prepareTick(Math.min(dt, currentInterval() * 1.5));
    const rootStatus = engine.tick(dt, { tick: engine.tickCount + 1 });
    simulation.draw();
    editor.refreshStatus();
    renderPropertyPanel();
    updateRunUI();
    if (rootStatus === STATUS.SUCCESS || rootStatus === STATUS.FAILURE) {
      runState = 'finished';
      clearTimeout(tickTimer);
      tickTimer = null;
      updateRunUI();
      logger.log(rootStatus === STATUS.SUCCESS ? 'success' : 'failure',
        `整棵树执行结束，根节点返回：${statusLabel(rootStatus)}。可修改黑板后单步，或点「重置整树」重新跑`);
    }
  }

  function updateRunUI() {
    $('btnRun').disabled = runState === 'running';
    $('btnPause').disabled = runState !== 'running';
    $('btnStep').disabled = runState === 'running';
    // 黑板输入框的 disabled 状态取决于运行状态，状态切换时同步重渲染
    renderBlackboardPanel();
    const state = $('simState');
    state.className = 'sim-state ' + runState;
    const label = {
      stopped: '已停止',
      running: `运行中 · tick #${engine ? engine.tickCount : 0}`,
      paused: `已暂停 · tick #${engine ? engine.tickCount : 0}`,
      finished: `已结束 · 根节点 ${engine ? statusLabel(engine.lastRootStatus) : ''}`
    }[runState];
    state.innerHTML = '<span class="state-dot"></span>' + label;
  }

  /* ---------------- 杂项 ---------------- */

  function validateAndWarn(silent) {
    const result = BTEngineNS.validateTree(currentTree());
    if (!silent || !result.valid) {
      result.errors.forEach((e) => toast(e.message, 'error'));
    }
  }

  function renderAll() {
    renderTreeTabs();
    renderBlackboardPanel();
    renderScenePanel();
    editor.render();
    renderPropertyPanel();
    updateRunUI();
  }

  function statusLabel(s) {
    return { idle: '未执行', success: '成功 ✓', failure: '失败 ✕', running: '运行中 …' }[s] || s;
  }
  function statusColor(s) {
    return { idle: 'var(--idle)', success: 'var(--success)', failure: 'var(--failure)', running: 'var(--running)' }[s] || 'var(--text)';
  }

  let toastSeq = 0;
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast toast-' + (kind || 'info');
    el.textContent = msg;
    $('toasts').appendChild(el);
    const id = ++toastSeq;
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .25s';
      setTimeout(() => el.remove(), 260);
    }, kind === 'error' ? 4200 : 2600);
    if (kind === 'error') logger.log('warn', msg);
    return id;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
