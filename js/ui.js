/* UI：工具栏、图层面板、图块面板、碰撞配置、对话框、快捷键 */
'use strict';

var UI = {}; // var 声明：挂到 window，供 editor.js 的 window.UI 守卫检测

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

const $ = id => document.getElementById(id);

/* ---------- 状态栏 ---------- */
UI.updateStatusBar = function () {
  const layer = activeLayer();
  if (!Ed.level || !layer) return;
  const h = Ed.hover;
  $('st-pos').textContent = h ? `格子 (${h.x}, ${h.y})` : '—';
  let cellInfo = '';
  if (h) {
    const id = layerTileAt(layer, h.x, h.y);
    if (id) {
      const def = tileDef(id);
      cellInfo = `图块 #${id} ${def.name}｜碰撞: ${COLLISION_SHAPE_NAMES[def.collision]}` +
        (def.tags.length ? `｜标签: ${def.tags.map(t => TAG_NAMES[t] || t).join('/')}` : '');
    }
  }
  $('st-cell').textContent = cellInfo;
  $('st-level').textContent =
    `关卡 ${Ed.level.width}×${Ed.level.height} 格（${levelWidthPx(Ed.level)}×${levelHeightPx(Ed.level)}px）` +
    `｜图层「${layer.name}」${layer.cellSize}px`;
  $('st-hint').textContent = '空格+拖动平移｜滚轮缩放';
};

UI.updateZoomLabel = function () {
  $('zoom-label').textContent = Math.round(Ed.zoom * 100) + '%';
};

/* ---------- 图层面板 ---------- */
UI.refreshLayers = function () {
  const ul = $('layer-list');
  ul.innerHTML = '';
  // 列表自上而下 = 渲染自顶向底，所以倒序显示
  const layers = [...Ed.level.layers].reverse();
  for (const layer of layers) {
    const li = document.createElement('li');
    if (layer.id === Ed.activeLayerId) li.classList.add('active');

    const vis = document.createElement('button');
    vis.textContent = layer.visible ? '👁' : '–';
    vis.title = '显示/隐藏';
    vis.onclick = e => { e.stopPropagation(); layer.visible = !layer.visible; UI.refreshLayers(); requestRender(); };

    const name = document.createElement('span');
    name.className = 'lname';
    name.textContent = layer.name;
    name.title = '双击重命名';
    name.ondblclick = e => {
      e.stopPropagation();
      const n = prompt('图层名称', layer.name);
      if (n && n !== layer.name) {
        const before = cloneLevel(Ed.level);
        layer.name = n;
        History.push({ kind: 'layers', before, after: cloneLevel(Ed.level) });
        UI.refreshLayers(); UI.updateStatusBar();
      }
    };

    const size = document.createElement('span');
    size.className = 'lsize';
    size.textContent = layer.cellSize + 'px';

    const up = document.createElement('button');
    up.textContent = '↑'; up.title = '上移（更靠近顶层）';
    up.onclick = e => { e.stopPropagation(); moveLayer(layer, 1); };
    const down = document.createElement('button');
    down.textContent = '↓'; down.title = '下移';
    down.onclick = e => { e.stopPropagation(); moveLayer(layer, -1); };
    const del = document.createElement('button');
    del.textContent = '✕'; del.title = '删除图层';
    del.onclick = e => { e.stopPropagation(); removeLayer(layer); };

    li.append(vis, name, size, up, down, del);
    li.onclick = () => {
      if (Ed.floating) endMove(false);
      Ed.activeLayerId = layer.id;
      Ed.selection = null;
      UI.refreshLayers(); UI.updateStatusBar(); requestRender();
    };
    ul.appendChild(li);
  }
};

function moveLayer(layer, dir) {
  const arr = Ed.level.layers;
  const i = arr.indexOf(layer);
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  const before = cloneLevel(Ed.level);
  arr.splice(i, 1);
  arr.splice(j, 0, layer);
  History.push({ kind: 'layers', before, after: cloneLevel(Ed.level) });
  UI.refreshLayers(); UI.refreshHistoryButtons(); requestRender();
}

function removeLayer(layer) {
  if (Ed.level.layers.length <= 1) { toast('至少保留一个图层'); return; }
  if (!confirm(`删除图层「${layer.name}」？（可撤销）`)) return;
  const before = cloneLevel(Ed.level);
  Ed.level.layers = Ed.level.layers.filter(l => l !== layer);
  if (Ed.activeLayerId === layer.id) Ed.activeLayerId = Ed.level.layers[0].id;
  History.push({ kind: 'layers', before, after: cloneLevel(Ed.level) });
  UI.refreshLayers(); UI.refreshHistoryButtons(); UI.updateStatusBar(); requestRender();
}

function addLayer(name, cellSize) {
  const before = cloneLevel(Ed.level);
  const layer = createLayer(name, cellSize);
  Ed.level.layers.push(layer);
  Ed.activeLayerId = layer.id;
  History.push({ kind: 'layers', before, after: cloneLevel(Ed.level) });
  UI.refreshLayers(); UI.refreshHistoryButtons(); UI.updateStatusBar(); requestRender();
}

/* ---------- 图块面板与碰撞配置 ---------- */
UI.buildPalette = function () {
  const pal = $('palette');
  pal.innerHTML = '';
  for (const def of TILE_DEFS) {
    if (def.id === 0) continue;
    const el = document.createElement('div');
    el.className = 'tile';
    el.title = `#${def.id} ${def.name}`;
    // 用图集生成背景
    const cv = document.createElement('canvas');
    cv.width = cv.height = TILE_SRC_SIZE;
    cv.getContext('2d').drawImage(TILESET_IMG, 0, def.id * TILE_SRC_SIZE, TILE_SRC_SIZE, TILE_SRC_SIZE, 0, 0, TILE_SRC_SIZE, TILE_SRC_SIZE);
    el.style.backgroundImage = `url(${cv.toDataURL()})`;
    if (def.id === Ed.currentTile) el.classList.add('active');
    el.onclick = () => {
      Ed.currentTile = def.id;
      if (Ed.tool === 'eraser') setTool('brush');
      UI.buildPalette();
      UI.buildTileConfig();
    };
    pal.appendChild(el);
  }
};

UI.buildTileConfig = function () {
  const body = $('tile-config-body');
  const def = tileDef(Ed.currentTile);
  if (!def) { body.innerHTML = '<p class="dim">选择一个图块</p>'; return; }
  body.innerHTML = '';

  const title = document.createElement('p');
  title.innerHTML = `<b>#${def.id} ${def.name}</b>`;
  body.appendChild(title);

  const lab = document.createElement('label');
  lab.textContent = '碰撞形状 ';
  const sel = document.createElement('select');
  for (const s of COLLISION_SHAPES) {
    const o = document.createElement('option');
    o.value = s; o.textContent = COLLISION_SHAPE_NAMES[s];
    if (def.collision === s) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => { def.collision = sel.value; requestRender(); UI.updateStatusBar(); };
  lab.appendChild(sel);
  body.appendChild(lab);

  const tagsDiv = document.createElement('div');
  tagsDiv.className = 'tags';
  for (const t of KNOWN_TAGS) {
    const l = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = def.tags.includes(t);
    cb.onchange = () => {
      def.tags = cb.checked ? [...def.tags, t] : def.tags.filter(x => x !== t);
      UI.updateStatusBar();
    };
    l.append(cb, TAG_NAMES[t]);
    tagsDiv.appendChild(l);
  }
  body.appendChild(tagsDiv);

  const hint = document.createElement('p');
  hint.className = 'dim';
  hint.textContent = '配置随地图一起导出';
  body.appendChild(hint);
};

/* ---------- 工具与历史按钮 ---------- */
function setTool(tool) {
  Ed.tool = tool;
  document.querySelectorAll('#toolbar .tool').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool));
  if (tool !== 'select') { Ed.selection = null; if (Ed.floating) endMove(false); }
  requestRender();
}

UI.refreshHistoryButtons = function () {
  $('btn-undo').disabled = History.undoStack.length === 0;
  $('btn-redo').disabled = History.redoStack.length === 0;
};

UI.refreshAll = function () {
  UI.refreshLayers();
  UI.buildPalette();
  UI.buildTileConfig();
  UI.refreshHistoryButtons();
  UI.updateStatusBar();
  UI.updateZoomLabel();
};

/* ---------- 文件操作 ---------- */
function doSave() {
  saveToLocal(Ed.level);
  downloadJSON(serializeLevel(Ed.level), (Ed.level.name || 'level') + '.json');
  toast('已保存到本地存储并导出 JSON');
}

function doOpen() { $('file-input').click(); }

function onFileChosen(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch (err) { alert('文件不是有效的 JSON：' + err.message); return; }
    const { level, errors } = deserializeLevel(data);
    if (!level) { alert('地图文件校验失败：\n' + errors.join('\n')); return; }
    setLevel(level);
    toast(`已打开「${level.name}」`);
  };
  reader.readAsText(file);
}

/* ---------- 对话框 ---------- */
function wireDialogs() {
  $('btn-new').onclick = () => $('dlg-new').showModal();
  $('new-cancel').onclick = () => $('dlg-new').close();
  $('new-ok').onclick = () => {
    const level = createLevel($('new-name').value.trim() || '未命名关卡',
      +$('new-tilesize').value,
      Math.max(1, +$('new-w').value | 0),
      Math.max(1, +$('new-h').value | 0));
    level.layers.push(createLayer('图层 1', level.tileSize));
    setLevel(level);
    $('dlg-new').close();
  };

  $('btn-add-layer').onclick = () => $('dlg-layer').showModal();
  $('layer-cancel').onclick = () => $('dlg-layer').close();
  $('layer-ok').onclick = () => {
    addLayer($('layer-name').value.trim() || '新图层', +$('layer-cellsize').value);
    $('dlg-layer').close();
  };

  // 尺寸调整：输入变化即时预览
  const rsInputs = ['rs-left', 'rs-right', 'rs-top', 'rs-bottom'];
  const readD = () => ({
    left: +$('rs-left').value | 0, right: +$('rs-right').value | 0,
    top: +$('rs-top').value | 0, bottom: +$('rs-bottom').value | 0,
  });
  const updatePreview = () => {
    const d = readD();
    const result = resizeLevel(Ed.level, d, false);
    if (!result) {
      $('rs-summary').textContent = '尺寸无效（宽高至少为 1 格）';
      Ed.resizePreview = null;
    } else {
      const nRemoved = result.removed.reduce((n, r) => n + r.cells.length, 0);
      $('rs-summary').textContent =
        `新尺寸：${result.newW}×${result.newH} 格` +
        (nRemoved ? `，将裁掉 ${nRemoved} 个图块（画布中红色预览）` : '，无图块被裁掉');
      Ed.resizePreview = { d, result };
    }
    requestRender();
  };
  $('btn-resize').onclick = () => {
    rsInputs.forEach(id => { $(id).value = 0; });
    $('dlg-resize').showModal();
    updatePreview();
  };
  rsInputs.forEach(id => { $(id).oninput = updatePreview; });
  // 无论以何种方式关闭（按钮/Esc），都清除预览
  $('dlg-resize').addEventListener('close', () => {
    if (Ed.resizePreview) { Ed.resizePreview = null; requestRender(); }
  });
  $('rs-cancel').onclick = () => { $('dlg-resize').close(); };
  $('rs-ok').onclick = () => {
    const d = readD();
    const result = resizeLevel(Ed.level, d, false);
    if (!result) { toast('尺寸无效'); return; }
    if ((d.left || d.right || d.top || d.bottom)) applyResize(d);
    else Ed.resizePreview = null;
    requestRender();
    $('dlg-resize').close();
  };
}

/* ---------- 快捷键 ---------- */
function onKeyDown(e) {
  if (e.target.matches('input, select, textarea') || e.target.closest('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;

  if (e.code === 'Space') { Ed.spaceDown = true; Ed.canvas.style.cursor = 'grab'; e.preventDefault(); return; }

  if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
  if (mod && e.code === 'KeyS') { e.preventDefault(); doSave(); return; }
  if (mod && e.code === 'KeyO') { e.preventDefault(); doOpen(); return; }
  if (mod && e.code === 'KeyA') { e.preventDefault(); selectAll(); return; }
  if (mod) return;

  switch (e.code) {
    case 'KeyB': setTool('brush'); break;
    case 'KeyE': setTool('eraser'); break;
    case 'KeyG': e.shiftKey ? toggleGrid() : setTool('fill'); break;
    case 'KeyM': setTool('select'); break;
    case 'KeyC': cycleCollisionView(); break;
    case 'KeyR': $('btn-resize').click(); break;
    case 'Delete': case 'Backspace': clearSelection(); break;
    case 'Escape': cancelActiveGesture(); break;
    case 'Equal': case 'NumpadAdd': zoomAt(Ed.canvas.clientWidth / 2, Ed.canvas.clientHeight / 2, 1.25); break;
    case 'Minus': case 'NumpadSubtract': zoomAt(Ed.canvas.clientWidth / 2, Ed.canvas.clientHeight / 2, 0.8); break;
    case 'Digit0': centerView(); break;
    case 'BracketLeft': cycleLayer(-1); break;
    case 'BracketRight': cycleLayer(1); break;
  }
}

function onKeyUp(e) {
  if (e.code === 'Space') { Ed.spaceDown = false; Ed.canvas.style.cursor = 'crosshair'; }
}

function cycleLayer(dir) {
  const arr = Ed.level.layers;
  const i = arr.findIndex(l => l.id === Ed.activeLayerId);
  const j = (i + dir + arr.length) % arr.length;
  if (Ed.floating) endMove(false);
  Ed.activeLayerId = arr[j].id;
  Ed.selection = null;
  UI.refreshLayers(); UI.updateStatusBar(); requestRender();
}

function toggleGrid() {
  Ed.showGrid = !Ed.showGrid;
  $('chk-grid').checked = Ed.showGrid;
  requestRender();
}

function cycleCollisionView() {
  const order = ['off', 'active', 'all'];
  Ed.collisionView = order[(order.indexOf(Ed.collisionView) + 1) % order.length];
  $('sel-collision-view').value = Ed.collisionView;
  requestRender();
}

/* ---------- 初始化 ---------- */
function initUI() {
  document.querySelectorAll('#toolbar .tool').forEach(b => {
    b.onclick = () => setTool(b.dataset.tool);
  });
  setTool('brush');

  $('btn-undo').onclick = undo;
  $('btn-redo').onclick = redo;
  $('btn-save').onclick = doSave;
  $('btn-open').onclick = doOpen;
  $('btn-sample').onclick = () => {
    if (!window.SAMPLE_LEVEL) { alert('未找到内置示例（sample/sample-level.js）'); return; }
    const { level, errors } = deserializeLevel(JSON.parse(JSON.stringify(window.SAMPLE_LEVEL)));
    if (!level) { alert('示例数据校验失败：\n' + errors.join('\n')); return; }
    setLevel(level);
    toast('已加载示例关卡');
  };
  $('file-input').onchange = onFileChosen;

  $('sel-collision-view').onchange = e => { Ed.collisionView = e.target.value; requestRender(); };
  $('chk-grid').onchange = e => { Ed.showGrid = e.target.checked; requestRender(); };
  $('chk-bounds').onchange = e => { Ed.showBounds = e.target.checked; requestRender(); };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('beforeunload', () => { if (Ed.level) saveToLocal(Ed.level); });

  wireDialogs();
}
