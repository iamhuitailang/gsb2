// 应用入口：UI 事件、store 订阅渲染、导入导出、区域对比联动。
import { store, meshFromJSON, meshToJSON, entryStats } from './store.js';
import { Viewer } from './viewer.js';
import { parseOBJ, writeOBJ } from '../core/obj.js';
import { regionComparison } from '../core/metrics.js';
import { subdividedCube, detailedIcosphere, twoDisconnectedParts } from '../core/samples.js';

const $ = (id) => document.getElementById(id);
const viewer = new Viewer($('viewer'));

let specMode = 'ratio';
let picked = null; // { entryId, candidateId, region }

// ---------------- 工具 ----------------
function toast(message, type = '') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${type}`;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fmt(n, digits = 5) {
  if (!Number.isFinite(n)) return '-';
  if (Math.abs(n) >= 10000) return n.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  return Number(n.toFixed(digits)).toString();
}
function pct(x) { return `${(x * 100).toFixed(1)}%`; }

function metricClass(normalizedHausdorff) {
  if (normalizedHausdorff < 0.01) return 'metric-good';
  if (normalizedHausdorff < 0.05) return 'metric-mid';
  return 'metric-bad';
}

// ---------------- 渲染：网格列表 ----------------
function renderMeshList() {
  const ul = $('mesh-list');
  ul.innerHTML = '';
  $('mesh-count').textContent = store.entries.length ? `(${store.entries.length})` : '';
  for (const entry of store.entries) {
    const stats = entryStats(entry);
    const li = document.createElement('li');
    li.className = `mesh-item ${entry.id === store.activeEntryId ? 'active' : ''}`;
    li.innerHTML = `
      <div>
        <div class="name">${entry.name}
          ${entry.cleaned ? '<span class="badge clean">已清理</span>' : ''}
        </div>
        <div class="meta">${stats.componentCount} 个连通分量 ·
          原始 ${stats.originalFaceCount.toLocaleString()} 面 / ${stats.originalVertexCount.toLocaleString()} 点
          ${entry.cleaned ? `→ 基础 ${stats.baseFaceCount.toLocaleString()} 面` : ''}
        </div>
      </div>
      <button class="del" title="移除网格">✕</button>`;
    li.addEventListener('click', (e) => {
      if (e.target.classList.contains('del')) {
        store.removeEntry(entry.id);
      } else {
        store.selectEntry(entry.id);
      }
    });
    ul.appendChild(li);
  }
}

// ---------------- 渲染：体检报告 ----------------
function renderInspection() {
  const entry = store.activeEntry;
  const panel = $('panel-inspect');
  if (!entry) { panel.style.opacity = 0.5; $('inspect-report').innerHTML = '<p class="hint">请先载入网格。</p>'; return; }
  panel.style.opacity = 1;
  const r = entry.inspection;
  const cls = (n) => (n > 0 ? 'bad' : 'ok');
  $('inspect-report').innerHTML = `
    <div class="stat-row"><span>连通分量（独立对象）</span><span class="v">${r.componentCount}</span></div>
    <div class="stat-row"><span>顶点数 / 三角面数</span><span class="v">${r.before.vertexCount.toLocaleString()} / ${r.before.faceCount.toLocaleString()}</span></div>
    <div class="stat-row"><span class="${cls(r.duplicateVertexCount)}">重复顶点（焊接可移除）</span><span class="v ${cls(r.duplicateVertexCount)}">${r.duplicateVertexCount}</span></div>
    <div class="stat-row"><span class="${cls(r.degenerateFaceCount)}">退化面（零面积/重复索引）</span><span class="v ${cls(r.degenerateFaceCount)}">${r.degenerateFaceCount}</span></div>
    <div class="stat-row"><span class="${cls(r.isolatedVertexCount)}">孤立点（未被面引用）</span><span class="v ${cls(r.isolatedVertexCount)}">${r.isolatedVertexCount}</span></div>`;

  const hasClean = !!entry.cleaned;
  $('btn-revert').hidden = !hasClean;
  $('btn-clean').textContent = hasClean ? '重新生成清理版本' : '生成清理版本';
  const cr = $('clean-result');
  if (hasClean) {
    const rep = entry.cleaned.report;
    cr.innerHTML = `
      <div>当前基础网格：<b>${rep.after.faceCount.toLocaleString()}</b> 面 /
      <b>${rep.after.vertexCount.toLocaleString()}</b> 点（原始版本始终保留）</div>
      ${rep.steps.map((s) => {
        if (s.action === 'weld') return `<div class="step">焊接重复点：移除 ${s.removedVertices} 个顶点，${s.collapsedFaces} 个面因此塌缩被剔除</div>`;
        if (s.action === 'removeDegenerate') return `<div class="step">删除退化面：${s.removedFaces} 个</div>`;
        return `<div class="step">删除孤立点：${s.removedVertices} 个</div>`;
      }).join('')}`;
  } else {
    cr.innerHTML = '';
  }
}

// ---------------- 渲染：候选列表 ----------------
function renderCandidates() {
  const entry = store.activeEntry;
  const wrap = $('candidate-list');
  wrap.innerHTML = '';
  if (!entry || !entry.candidates.length) {
    wrap.innerHTML = '<p class="hint">还没有候选。在左侧设置比例或目标面数后点击“生成候选”。</p>';
    return;
  }
  for (const c of entry.candidates) {
    const card = document.createElement('div');
    card.className = `candidate-card ${c.id === store.activeCandidateId ? 'active' : ''}`;
    const requested = c.mode === 'ratio' ? pct(c.requested) : `${c.requested} 面`;
    card.innerHTML = `
      <button class="del" title="删除候选">✕</button>
      <div class="head">
        <span class="title">目标 ${requested} → 实际 ${pct(c.ratio)}</span>
      </div>
      <div class="grid2">
        <span>实际面数</span><b>${c.actualFaceCount.toLocaleString()} / ${c.baseFaceCount.toLocaleString()}</b>
        <span>顶点数</span><b>${c.actualVertexCount.toLocaleString()} / ${c.baseVertexCount.toLocaleString()}</b>
        <span>Hausdorff*</span><b class="${metricClass(c.metrics.normalizedHausdorff)}">${fmt(c.metrics.hausdorff)}</b>
        <span>相对包围盒</span><b class="${metricClass(c.metrics.normalizedHausdorff)}">${pct(c.metrics.normalizedHausdorff)}</b>
        <span>RMS 距离</span><b>${fmt(c.metrics.rms)}</b>
        <span>计算耗时</span><b>${c.timeMs} ms</b>
        <span>分量预算/结果</span><b>[${c.componentBudgets.join(',')}] → [${c.componentFacesAfter.join(',')}]</b>
      </div>
      ${c.warning ? `<div class="warn-line">⚠ ${c.warning}</div>` : ''}`;
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('del')) {
        store.removeCandidate(entry.id, c.id);
      } else {
        store.selectCandidate(c.id);
      }
    });
    wrap.appendChild(card);
  }
}

// ---------------- 渲染：视图 ----------------
function renderViewer() {
  const entry = store.activeEntry;
  const candidate = store.activeCandidate;
  const s = store.viewSettings;
  if (!entry) {
    viewer.setContent(null, null, s);
    $('view-stats').textContent = '';
    return;
  }
  const originalMesh = meshFromJSON(entry.original);
  const baseMesh = store.baseMeshOf(entry);
  const candidateMesh = candidate ? meshFromJSON(candidate.mesh) : null;

  viewer.setContent(originalMesh, candidateMesh, s);
  viewer.setSplitMode(s.mode);
  viewer.toggleOriginal(s.showOriginal);
  viewer.setOriginalOpacity(s.originalOpacity);
  viewer.toggleWireframe(s.showWireframe);
  if (candidate && s.showHeatmap) {
    // 重新计算逐顶点偏差用于热力图
    import('../core/metrics.js').then(({ deviationReport }) => {
      const dev = deviationReport(baseMesh, candidateMesh);
      viewer.setDeviation(dev.perVertexBackward);
      viewer.applyHeatmap(candidateMesh, dev.perVertexBackward);
    });
  } else {
    viewer.clearHeatmap();
  }

  const stats = entryStats(entry);
  $('view-stats').textContent = candidate
    ? `${entry.name} · 原始 ${stats.originalFaceCount.toLocaleString()} 面 → 候选 ${candidate.actualFaceCount.toLocaleString()} 面（${pct(candidate.ratio)}）· Hausdorff ${fmt(candidate.metrics.hausdorff)}`
    : `${entry.name} · ${stats.originalFaceCount.toLocaleString()} 面（尚未选择候选）`;
  document.body.classList.toggle('split-mode', s.mode === 'split');
}

// ---------------- 区域对比 ----------------
viewer.onRegionPicked = (payload) => {
  const entry = store.activeEntry;
  const candidate = store.activeCandidate;
  if (payload && payload.unsupported) {
    toast('请切换到「叠加对比」模式后再选取区域');
    return;
  }
  if (!payload || !entry || !candidate) {
    picked = null;
    $('region-empty').hidden = false;
    $('region-detail').hidden = true;
    viewer.clearRegion();
    return;
  }
  const baseMesh = store.baseMeshOf(entry);
  const candidateMesh = meshFromJSON(candidate.mesh);
  const result = regionComparison(baseMesh, candidateMesh, payload.region);
  picked = { entryId: entry.id, candidateId: candidate.id, region: payload.region };
  $('region-empty').hidden = true;
  $('region-detail').hidden = false;
  $('region-vcount').textContent = result.vertexCount.toLocaleString();
  $('region-avg').textContent = fmt(result.averageDistance);
  $('region-max').textContent = fmt(result.maxDistance);
  $('region-navg').textContent = result.normalDeltaAvg ? `${fmt(result.normalDeltaAvg, 2)}°` : '-';
  $('region-nmax').textContent = result.normalDeltaMax ? `${fmt(result.normalDeltaMax, 2)}°` : '-';
};

// ---------------- 事件：示例与导入 ----------------
$('btn-sample-cube').addEventListener('click', () => {
  const e = store.addEntry(subdividedCube(16, 2));
  toast(`已载入规则模型：${e.inspection.duplicateVertexCount} 个重复顶点，可用于清理演示`, 'success');
});
$('btn-sample-sphere').addEventListener('click', () => {
  store.addEntry(detailedIcosphere(4, 1.4, 0.22));
  toast('已载入高细节噪声球（5120 面）', 'success');
});
$('btn-sample-two').addEventListener('click', () => {
  store.addEntry(twoDisconnectedParts());
  toast('已载入双分离对象，可验证独立分量不会被错误焊接', 'success');
});

$('file-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const { meshes, warnings } = parseOBJ(text);
    for (const mesh of meshes) store.addEntry(mesh);
    toast(`导入 ${meshes.length} 个网格${warnings.length ? `；${warnings.length} 条提示` : ''}`, 'success');
    if (warnings.length) console.warn('OBJ 解析提示：', warnings);
  } catch (err) {
    toast(`导入失败：${err.message}`, 'error');
  }
  e.target.value = '';
});

// ---------------- 事件：清理 ----------------
$('btn-clean').addEventListener('click', () => {
  const entry = store.activeEntry;
  if (!entry) return;
  const options = {
    weld: $('opt-weld').checked,
    removeDegenerate: $('opt-degenerate').checked,
    removeIsolated: $('opt-isolated').checked,
    tolerance: parseFloat($('opt-tolerance').value) || 1e-6,
  };
  store.applyCleanup(entry.id, options);
  toast('已生成清理版本，原始网格保留在数据中', 'success');
});
$('btn-revert').addEventListener('click', () => {
  const entry = store.activeEntry;
  if (!entry) return;
  store.revertCleanup(entry.id);
  toast('已恢复为原始版本', 'success');
});

// ---------------- 事件：候选生成 ----------------
document.querySelectorAll('#spec-mode .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#spec-mode .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    specMode = btn.dataset.mode;
    $('spec-values').value = specMode === 'ratio' ? '0.75, 0.5, 0.25, 0.1' : '2000, 800, 300';
    $('spec-hint').textContent = specMode === 'ratio'
      ? '逗号分隔；比例范围 (0,1]，一次生成多个候选。'
      : '逗号分隔的目标三角面数，每个值生成一个候选。';
  });
});

$('boundary-weight').addEventListener('input', (e) => {
  const w = parseInt(e.target.value, 10);
  $('boundary-value').textContent = w;
  store.setView({ boundaryWeight: w });
});

$('btn-generate').addEventListener('click', () => {
  const entry = store.activeEntry;
  if (!entry) { toast('请先载入网格', 'error'); return; }
  const raw = $('spec-values').value.split(',').map((s) => parseFloat(s.trim())).filter((v) => Number.isFinite(v));
  if (!raw.length) { toast('请填写至少一个候选值', 'error'); return; }
  let specs;
  if (specMode === 'ratio') {
    if (raw.some((v) => v <= 0 || v > 1)) { toast('比例必须在 (0,1] 范围内', 'error'); return; }
    specs = raw.map((v) => ({ mode: 'ratio', value: v }));
  } else {
    if (raw.some((v) => v < 1)) { toast('目标面数必须 >= 1', 'error'); return; }
    specs = raw.map((v) => ({ mode: 'faces', value: Math.round(v) }));
  }
  const t0 = performance.now();
  const created = store.generateCandidates(entry.id, specs);
  const ms = Math.round(performance.now() - t0);
  toast(`生成 ${created.length} 个候选，总耗时 ${ms} ms`, 'success');
});

$('btn-regenerate').addEventListener('click', () => {
  const entry = store.activeEntry;
  if (!entry) return;
  store.regenerateCandidates(entry.id);
  toast('已按保存的参数重新生成候选', 'success');
});

// ---------------- 事件：视图设置 ----------------
document.querySelectorAll('#view-mode .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#view-mode .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    store.setView({ mode: btn.dataset.mode });
  });
});
$('view-original').addEventListener('change', (e) => store.setView({ showOriginal: e.target.checked }));
$('view-opacity').addEventListener('input', (e) => store.setView({ originalOpacity: parseFloat(e.target.value) }));
$('view-wireframe').addEventListener('change', (e) => store.setView({ showWireframe: e.target.checked }));
$('view-heatmap').addEventListener('change', (e) => store.setView({ showHeatmap: e.target.checked }));
$('btn-clear-region').addEventListener('click', () => viewer.onRegionPicked(null));

// ---------------- 事件：项目保存/打开 ----------------
$('btn-save-project').addEventListener('click', () => {
  if (!store.entries.length) { toast('没有可保存的网格', 'error'); return; }
  download(`lod-project-${new Date().toISOString().slice(0, 10)}.json`, store.serializeProject(), 'application/json');
  toast('项目已保存（含全部几何与候选参数）', 'success');
});

$('file-project').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    store.loadProject(await file.text());
    toast('项目已恢复，候选参数可通过“重新生成”复算', 'success');
    $('btn-regenerate').hidden = false;
  } catch (err) {
    toast(`项目打开失败：${err.message}`, 'error');
  }
  e.target.value = '';
});

// ---------------- 事件：导出 ----------------
$('btn-export').addEventListener('click', () => {
  const entry = store.activeEntry;
  const candidate = store.activeCandidate;
  if (!candidate) { toast('请先选择一个候选版本', 'error'); return; }
  const mesh = meshFromJSON(candidate.mesh);
  const meta = {
    来源网格: entry.name,
    生成时间: candidate.createdAt,
    简化模式: candidate.mode === 'ratio' ? '比例' : '目标面数',
    请求参数: candidate.requested,
    简化比例: `${(candidate.ratio * 100).toFixed(2)}%`,
    原始面数: candidate.baseFaceCount,
    导出面数: candidate.actualFaceCount,
    原始顶点数: candidate.baseVertexCount,
    导出顶点数: candidate.actualVertexCount,
    边界权重: candidate.boundaryWeight,
    Hausdorff距离: candidate.metrics.hausdorff,
    相对包围盒偏差: `${(candidate.metrics.normalizedHausdorff * 100).toFixed(3)}%`,
    RMS距离: candidate.metrics.rms,
  };
  download(`${entry.name}-lod-${pct(candidate.ratio).replace('%', 'pct')}.obj`, writeOBJ(mesh, meta));
  toast('OBJ 已导出，元数据写入文件头注释', 'success');
});

$('btn-export-original').addEventListener('click', () => {
  const entry = store.activeEntry;
  if (!entry) { toast('请先选择网格', 'error'); return; }
  const mesh = store.baseMeshOf(entry);
  const meta = {
    来源网格: entry.name,
    版本: entry.cleaned ? '清理后基础网格（原始版本保留在项目中）' : '原始网格',
    面数: mesh.faceCount,
    顶点数: mesh.vertexCount,
  };
  download(`${entry.name}-base.obj`, writeOBJ(mesh, meta));
  toast('基础网格 OBJ 已导出', 'success');
});

// ---------------- store 订阅：统一重渲染 ----------------
store.subscribe(() => {
  renderMeshList();
  renderInspection();
  renderCandidates();
  renderViewer();
  $('btn-regenerate').hidden = !(store.activeEntry?.candidates.length);
});

// 初始渲染
renderMeshList();
renderInspection();
renderCandidates();
renderViewer();

// 暴露给控制台调试
window.__lod = { store, meshFromJSON, meshToJSON };
window.__viewer = viewer;
