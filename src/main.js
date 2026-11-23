// 应用入口：接线工具栏、菜单、文件 IO、弹窗与全局快捷键
import { Store } from './store.js';
import { CanvasView } from './canvas.js';
import { LayersPanel } from './layers.js';
import { PropertiesPanel } from './properties.js';
import { createDoc, DEFAULT_STYLE, findNode, deserializeDoc } from './model.js';
import { docToSvgString, docToPngBlob, downloadBlob, downloadText, importSvg } from './svgio.js';
import { SAMPLES, buildSampleDoc } from './samples.js';

const $ = (sel) => document.querySelector(sel);

const store = new Store();
const canvas = new CanvasView(store, $('#canvas-mount'), {
  getNewStyle: () => ({ ...DEFAULT_STYLE(), ...window.__draftStyle }),
  onStructureChange: () => { /* render 由 store 订阅统一处理 */ },
});
// 供自动化测试访问（不影响正常使用）
window.__storeForTest = store;
window.__canvasForTest = canvas;
window.__testApi = { docToSvgString, docToPngBlob, importSvg, deserializeDoc };
const layersPanel = new LayersPanel(store, $('#layers-panel'));
layersPanel.bindRename();
new PropertiesPanel(store, $('#properties-panel'));

// ---------- 工具按钮 ----------
document.querySelectorAll('[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => store.setTool(btn.dataset.tool));
});
store.subscribe((kind) => {
  if (kind !== 'tool' && kind !== 'doc') return;
  document.querySelectorAll('[data-tool]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === store.tool);
  });
});

// ---------- 视图按钮 ----------
$('#zoom-in').onclick = () => canvas.zoomButton(1.2);
$('#zoom-out').onclick = () => canvas.zoomButton(1 / 1.2);
$('#zoom-fit').onclick = () => canvas.fitView();
$('#zoom-label').textContent = '100%';
store.subscribe((kind) => {
  if (kind === 'view') $('#zoom-label').textContent = `${Math.round(store.view.zoom * 100)}%`;
});

// ---------- 撤销重做 ----------
const updateHistoryBtns = () => {
  $('#btn-undo').disabled = !store.canUndo;
  $('#btn-redo').disabled = !store.canRedo;
  $('#btn-undo').title = store.canUndo ? `撤销：${store.lastLabel}` : '暂无撤销';
};
$('#btn-undo').onclick = () => store.undo();
$('#btn-redo').onclick = () => store.redo();
store.subscribe(updateHistoryBtns);
updateHistoryBtns();

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); }
  if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); store.redo(); }
  if (k === 's') { e.preventDefault(); saveProject(); }
  if (k === 'o') { e.preventDefault(); $('#open-project').click(); }
  if (k === 'a') {
    e.preventDefault();
    const ids = [];
    const walk = (list) => list.forEach((n) => {
      if (n.type === 'path' && n.visible && !n.locked) ids.push(n.id);
      if (n.type === 'group') walk(n.children);
    });
    walk(store.doc.layers);
    store.select(ids);
  }
});

// ---------- 弹窗 ----------
function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }
document.querySelectorAll('.modal-close').forEach((b) => {
  b.onclick = () => b.closest('.modal').classList.remove('show');
});
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('pointerdown', (e) => { if (e.target === m) m.classList.remove('show'); });
});

// ---------- 新建文档 ----------
$('#btn-new').onclick = () => openModal('#modal-new');
$('#new-confirm').onclick = () => {
  const w = clampInt($('#new-width').value, 16, 4096, 800);
  const h = clampInt($('#new-height').value, 16, 4096, 600);
  store.loadDoc(createDoc(w, h));
  closeModal('#modal-new');
  setTimeout(() => canvas.fitView(), 0);
};
function clampInt(v, min, max, dft) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dft;
  return Math.min(max, Math.max(min, n));
}

// ---------- 工程保存 / 打开（自有 JSON 格式，保证结构一致） ----------
function saveProject() {
  downloadText(store.toJSON(), 'vector-project.json', 'application/json');
  store.dirty = false;
}
$('#btn-save').onclick = saveProject;

$('#open-project').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    store.loadJSON(text);
    setTimeout(() => canvas.fitView(), 0);
    toast('工程已打开');
  } catch (err) {
    toast(`打开失败：${err.message}`, true);
  }
  e.target.value = '';
});

// ---------- SVG 导入 ----------
$('#import-svg').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const { doc, warnings } = importSvg(text);
    store.loadDoc(doc);
    setTimeout(() => canvas.fitView(), 0);
    if (warnings.length) openWarnings(warnings);
    else toast('SVG 导入完成，可继续编辑');
  } catch (err) {
    toast(`导入失败：${err.message}`, true);
  }
  e.target.value = '';
});

function openWarnings(warnings) {
  $('#warnings-list').replaceChildren(...warnings.map((w) => {
    const li = document.createElement('li');
    li.textContent = w;
    return li;
  }));
  openModal('#modal-warnings');
}

// ---------- SVG / PNG 导出 ----------
$('#btn-export-svg').onclick = () => {
  downloadText(docToSvgString(store.doc), 'artwork.svg');
  toast('SVG 已导出');
};

$('#btn-export-png').onclick = () => {
  const info = $('#png-size-info');
  info.textContent = `画布原始尺寸 ${store.doc.width} × ${store.doc.height}，导出按等比缩放，路径比例不变。`;
  $('#png-width').value = store.doc.width * 2;
  $('#png-bg').value = '';
  openModal('#modal-png');
};
$('#png-confirm').onclick = async () => {
  const width = clampInt($('#png-width').value, 1, 8192, store.doc.width * 2);
  const background = $('#png-bg').value || null;
  try {
    const blob = await docToPngBlob(store.doc, { width, background });
    downloadBlob(blob, 'artwork.png');
    closeModal('#modal-png');
    toast(`PNG 已导出（${width}px 宽，等比缩放）`);
  } catch (err) {
    toast(`导出失败：${err.message}`, true);
  }
};

// ---------- 样例 ----------
const sampleMenu = $('#sample-menu');
SAMPLES.forEach((s) => {
  const b = document.createElement('button');
  b.className = 'menu-item';
  b.textContent = s.name;
  b.onclick = () => {
    store.loadDoc(buildSampleDoc(s));
    setTimeout(() => canvas.fitView(), 0);
    sampleMenu.hidden = true;
    toast(`已载入样例：${s.name}`);
  };
  sampleMenu.append(b);
});
$('#btn-samples').onclick = (e) => {
  sampleMenu.hidden = !sampleMenu.hidden;
  e.stopPropagation();
};
document.addEventListener('click', () => { sampleMenu.hidden = true; });
sampleMenu.addEventListener('click', (e) => e.stopPropagation());

// ---------- 默认新路径样式（取当前选中路径样式作为草稿） ----------
window.__draftStyle = {};
store.subscribe((kind) => {
  if (kind !== 'selection') return;
  const id = store.selection.paths[0];
  const n = id && findNode(store.doc.layers, id);
  if (n?.type === 'path') window.__draftStyle = { ...n.style };
});

// ---------- 提示条 ----------
let toastTimer = null;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- 关闭前提醒 ----------
window.addEventListener('beforeunload', (e) => {
  if (store.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// 初始空白文档
store.loadDoc(createDoc(800, 600));
setTimeout(() => canvas.fitView(), 0);
