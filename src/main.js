import './styles.css';
import { WeightViewer, BONE_COLORS } from './three/Viewer.js';
import { createArmProject, createSeamReproProject } from './core/modelFactory.js';
import {
  planNormalization,
  pruneInfluences,
  roundWeight,
  summarizeWeights,
} from './core/weights.js';
import {
  coLocatedIds,
  findDiagnostics,
  fixOnlyVertex,
  groupDiagnostics,
} from './core/diagnostics.js';
import { buildPrunedSet, compareCapsAtPoses, selectedVertexCapReport } from './core/compare.js';
import { deformProject, evaluateVertex } from './core/skinning.js';
import { parseProject, serializeProject, verifyRoundtrip } from './core/io.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const fmt = (n, digits = 3) => (Number.isFinite(Number(n)) ? Number(n).toFixed(digits) : '—');
const vid = (id) => `V${String(id).padStart(3, '0')}`;

let project = createArmProject();
let diagnostics = [];
let viewer;

const ui = {
  pose: 'strong',
  selectedVertexId: project.config.selectedVertexId ?? project.mesh.namedVertices.seamBadUpper ?? 0,
  selectedBoneIndex: project.config.selectedBoneIndex ?? 2,
  overlay: 'bone',
  showSkeleton: true,
  showGhost: false,
  capTab: 2,
  draft: null,
  plan: null,
  verification: null,
};

function resetDraft() {
  const vertex = project.mesh.vertices[ui.selectedVertexId];
  if (!vertex) {
    ui.draft = { influences: [], locks: {} };
  } else {
    ui.draft = {
      influences: vertex.influences.map((inf) => ({ ...inf })),
      locks: Object.fromEntries(
        Object.entries(vertex.locks ?? {}).map(([key, value]) => [String(key), Number(value)]),
      ),
    };
  }
  replanDraft();
}

function replanDraft() {
  if (!ui.draft) return;
  ui.plan = planNormalization(ui.draft.influences, ui.draft.locks);
}

function boneName(boneIndex) {
  const bone = project.skeleton[Number(boneIndex)];
  if (bone) return bone.nameZh ? `${bone.nameZh} · ${bone.name}` : bone.name;
  return `失效骨骼 #${String(boneIndex)}`;
}

function boneBadge(boneIndex) {
  const valid = Number.isInteger(Number(boneIndex)) && Number(boneIndex) >= 0 && Number(boneIndex) < project.skeleton.length;
  return `<span class="badge ${valid ? 'info' : 'critical'}">${boneName(boneIndex)}</span>`;
}

function toast(message, type = 'info', timeout = 4200) {
  const root = $('#toastRoot');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  window.setTimeout(() => el.remove(), timeout);
}

function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function currentCoLocated() {
  return coLocatedIds(project, ui.selectedVertexId);
}

function selectVertex(id, options = {}) {
  const nextId = Number(id);
  if (!project.mesh.vertices[nextId]) return;
  ui.selectedVertexId = nextId;
  project.config.selectedVertexId = nextId;
  resetDraft();
  viewer.setSelectedVertex(nextId, currentCoLocated());
  renderInspector();
  if (options.focus) viewer.focusVertex(nextId);
  updateViewportStatus();
}

function selectBone(index) {
  ui.selectedBoneIndex = Number(index);
  ui.overlay = 'bone';
  project.config.selectedBoneIndex = ui.selectedBoneIndex;
  renderLeft();
  renderViewportOverlay();
  refreshColors();
}

function loadProject(nextProject, options = {}) {
  project = nextProject;
  diagnostics = findDiagnostics(project);
  ui.pose = project.config?.pose && project.meta?.poses?.[project.config.pose] ? project.config.pose : 'strong';
  const configuredId = Number(project.config?.selectedVertexId);
  ui.selectedVertexId = project.mesh.vertices[configuredId]
    ? configuredId
    : project.mesh.namedVertices?.seamBadUpper ?? project.mesh.vertices[0].id;
  const configuredBone = Number(project.config?.selectedBoneIndex);
  ui.selectedBoneIndex =
    Number.isInteger(configuredBone) && configuredBone >= 0 && configuredBone < project.skeleton.length
      ? configuredBone
      : Math.min(2, project.skeleton.length - 1);
  ui.overlay = 'bone';
  ui.showGhost = false;
  ui.verification = null;
  resetDraft();

  viewer.loadProject(project);
  viewer.setSkeletonVisible(ui.showSkeleton);
  viewer.setDiagnostics(diagnostics, project);
  viewer.setSelectedVertex(ui.selectedVertexId, currentCoLocated());

  renderAll();
  refreshDeformation();
  if (options.focusSelected) viewer.focusVertex(ui.selectedVertexId);
}

function afterProjectMutation(message) {
  diagnostics = findDiagnostics(project);
  viewer.setDiagnostics(diagnostics, project);
  resetDraft();
  renderLeft();
  renderInspector();
  refreshDeformation();
  if (message) toast(message);
}

function commitDraft() {
  const id = ui.selectedVertexId;
  replanDraft();
  if (!ui.plan?.ok) {
    toast(`未保存，原数据保留：${ui.plan?.message ?? '权重计划无效'}`, 'error', 6000);
    return;
  }

  const influences = ui.draft.influences.map((inf, slot) => {
    const planned = ui.plan.values.find((v) => v.slot === slot);
    if (planned) {
      return { bone: Number(inf.bone), weight: roundWeight(planned.weight, 6) };
    }
    return { bone: inf.bone, weight: Number(inf.weight) || 0 };
  });

  project = {
    ...project,
    mesh: {
      ...project.mesh,
      vertices: project.mesh.vertices.map((vertex) =>
        vertex.id === id ? { ...vertex, influences, locks: { ...ui.draft.locks } } : vertex,
      ),
    },
  };
  afterProjectMutation(`${vid(id)} 已保存并归一；锁定合计 ${ui.plan.lockedTotal.toFixed(3)}，可分配余量 ${ui.plan.distributable.toFixed(3)}。`);
}

function fixSelectedOnly() {
  const id = ui.selectedVertexId;
  const result = fixOnlyVertex(project, id);
  if (!result.ok) {
    toast(`自动修复失败，原数据保留：${result.fix?.actions?.join('；')}`, 'error', 6000);
    return;
  }
  project = result.project;
  afterProjectMutation(`已只修复 ${vid(id)}：${result.fix.actions.join('；')}。其他顶点未写入。`, 'success', 6000);
  viewer.focusVertex(id);
}

/* ---------- rendering: left ---------- */

function renderLeft() {
  const groups = groupDiagnostics(diagnostics);
  const coGroups = coLocatedGroupsSafe();
  const counts = { all: diagnostics.length, zero: groups.zero.length, invalid: groups.invalid.length, far: groups.far.length };

  $('#leftPanel').innerHTML = `
    <section class="panel-section">
      <h2>显示</h2>
      <div class="segmented" style="width:100%; display:grid; grid-template-columns:repeat(3,1fr);">
        <button data-action="set-overlay" data-overlay="bone" class="${ui.overlay === 'bone' ? 'active' : ''}">骨骼权重</button>
        <button data-action="set-overlay" data-overlay="difference" class="${ui.overlay === 'difference' ? 'active' : ''}">2/4 骨差异</button>
        <button data-action="set-overlay" data-overlay="none" class="${ui.overlay === 'none' ? 'active' : ''}">本色</button>
      </div>
      <div class="row wrap" style="margin-top:9px;">
        <button class="btn tiny ${ui.showSkeleton ? 'primary' : ''}" data-action="toggle-skeleton">${ui.showSkeleton ? '隐藏骨架' : '显示骨架'}</button>
        <button class="btn tiny ${ui.showGhost ? 'primary' : ''}" data-action="toggle-ghost">${ui.showGhost ? '隐藏 2 骨线框' : '显示 2 骨线框'}</button>
      </div>
      <p class="hint" style="margin-bottom:0;">点击模型顶点选择；点击细骨条可选择骨骼。拖拽旋转，滚轮缩放。</p>
    </section>

    <section class="panel-section">
      <h2>骨骼 / 影响颜色</h2>
      <div class="bone-list">
        ${project.skeleton
          .map((bone, i) => {
            const used = project.mesh.vertices.filter((v) => v.influences.some((x) => Number(x.bone) === i && Number(x.weight) > 0.001)).length;
            return `
              <button class="bone-button ${ui.selectedBoneIndex === i ? 'active' : ''}" data-action="select-bone" data-id="${i}">
                <span class="swatch" style="--bone-color:${BONE_COLORS[i % BONE_COLORS.length]}"></span>
                <span>${bone.nameZh ? `${bone.nameZh}` : bone.name}<br><span class="muted">${bone.name}</span></span>
                <span class="bone-index">${used} 点</span>
              </button>`;
          })
          .join('')}
      </div>
    </section>

    <section class="panel-section">
      <h2>可定位问题 · ${counts.all}</h2>
      <div class="kpi-grid" style="margin-bottom:9px;">
        <div class="kpi"><div class="value">${counts.zero}</div><div class="label">零权重</div></div>
        <div class="kpi"><div class="value">${counts.invalid}</div><div class="label">编号失效</div></div>
        <div class="kpi"><div class="value">${counts.far}</div><div class="label">影响过远</div></div>
      </div>
      <div class="diagnostic-list">
        ${diagnostics
          .map(
            (d) => `
          <button class="diagnostic-item ${d.severity}" data-action="locate" data-id="${d.vertexId}">
            <span class="badge ${d.category === 'zero' ? 'warning' : d.severity}">${categoryLabel(d.category)}</span>
            <div style="margin-top:4px;">${d.message}</div>
          </button>`,
          )
          .join('')}
        ${diagnostics.length === 0 ? '<div class="callout success">未发现零权重、失效编号或远距离影响。</div>' : ''}
      </div>
      <button class="btn good" style="width:100%; margin-top:9px;" data-action="fix-current">仅修复当前选中点 ${vid(ui.selectedVertexId)}</button>
      <p class="hint">不会提供“全部一起改”：每次修复只替换当前顶点 ID，旁边已调/已锁的点保持原对象和数值。</p>
    </section>

    <section class="panel-section">
      <h2>同位置独立顶点</h2>
      <div class="co-list">
        ${coGroups
          .slice(0, 12)
          .map(
            (g) => `
          <div class="callout" style="padding:7px 8px;">
            <div class="muted mono">${g.position.map((n) => n.toFixed(3)).join(', ')}</div>
            <div class="row wrap" style="margin-top:5px;">
              ${g.ids.map((id) => `<button class="btn tiny ${id === ui.selectedVertexId ? 'primary' : ''}" data-action="select-vertex" data-id="${id}">${vid(id)}</button>`).join('')}
            </div>
          </div>`,
          )
          .join('')}
        ${coGroups.length === 0 ? '<span class="hint">没有重合静止位置。</span>' : ''}
      </div>
    </section>
  `;
}

function coLocatedGroupsSafe() {
  // Local import avoids a circular top-level concern; function is pure.
  const map = new Map();
  for (const vertex of project.mesh.vertices) {
    const p = project.mesh.restPositions[vertex.id] ?? vertex.position;
    const key = p.map((n) => Number(n).toFixed(4)).join(',');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(vertex.id);
  }
  return [...map.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, ids, position: key.split(',').map(Number) }));
}

function categoryLabel(category) {
  return { zero: '零权重', invalid: '骨骼失效', far: '影响很远' }[category] ?? category;
}

/* ---------- rendering: inspector ---------- */

function renderInspector() {
  const id = ui.selectedVertexId;
  const vertex = project.mesh.vertices[id];
  if (!vertex) {
    $('#inspector').innerHTML = '<section class="panel-section"><p>没有选中顶点。</p></section>';
    return;
  }
  const evaluation = evaluateVertex(project, id, ui.pose);
  const coIds = currentCoLocated();
  const selectedDiagnostics = diagnostics.filter((d) => d.vertexId === id);
  const summary = summarizeWeights(vertex);

  $('#inspector').innerHTML = `
    <section class="panel-section">
      <div class="row between">
        <h2 style="margin:0;">顶点 ${vid(id)}</h2>
        <span class="badge ${summary.rawSum > 0.98 && summary.rawSum < 1.02 ? 'good' : 'warning'}">原始合计 ${fmt(summary.rawSum, 3)}</span>
      </div>
      ${vertex.note ? `<div class="callout info" style="margin-top:8px;">${vertex.note}</div>` : ''}
      ${vertex.tags?.length ? `<div class="row wrap" style="margin-top:8px;">${vertex.tags.map((t) => `<span class="badge">${t}</span>`).join('')}</div>` : ''}

      <h3>变形前后位置 · ${project.meta.poses[ui.pose]?.label ?? ui.pose}</h3>
      <table class="data-table">
        <tr><th></th><th>X</th><th>Y</th><th>Z</th></tr>
        <tr><td>静止</td>${evaluation.rest.map((n) => `<td class="mono">${fmt(n)}</td>`).join('')}</tr>
        <tr><td>弯曲后</td>${evaluation.posed.map((n) => `<td class="mono">${fmt(n)}</td>`).join('')}</tr>
        <tr><td>差值</td>${evaluation.delta.map((n) => `<td class="mono">${fmt(n)}</td>`).join('')}</tr>
      </table>
      <div class="hint">位移长度 <strong class="mono">${fmt(evaluation.distance, 4)}</strong>；白色球=静止位置，黄色球=当前姿势位置，黑线连接两者。</div>

      <h3>同一空间位置的独立网格顶点</h3>
      <div class="row wrap">
        ${coIds.map((otherId) => `<button class="btn tiny ${otherId === id ? 'primary' : ''}" data-action="select-vertex" data-id="${otherId}">${vid(otherId)}${otherId === id ? ' 当前' : ''}</button>`).join('')}
      </div>
      <div class="hint">这些点在静止姿势重合，但顶点 ID、骨骼编号和权重分别存储；可逐个选择核对。</div>

      ${selectedDiagnostics.length ? `
        <h3>当前点问题</h3>
        <div class="stack">${selectedDiagnostics.map((d) => `<div class="callout ${d.severity === 'critical' ? 'error' : ''}">${d.message}</div>`).join('')}</div>
        <button class="btn good" style="margin-top:8px;" data-action="fix-current">仅自动修复 ${vid(id)}</button>
      ` : '<div class="callout success" style="margin-top:9px;">当前点没有零权重 / 失效编号 / 远距离影响提示。</div>'}
    </section>

    <section class="panel-section">
      <h2>权重编辑与锁定</h2>
      <table class="weights-table">
        <thead><tr><th>骨骼</th><th>滑杆</th><th>权重/锁定值</th><th>锁</th><th></th></tr></thead>
        <tbody>
          ${ui.draft.influences
            .map((inf, slot) => {
              const bone = Number(inf.bone);
              const locked = Object.prototype.hasOwnProperty.call(ui.draft.locks, String(bone));
              const value = locked ? Number(ui.draft.locks[String(bone)]) : Number(inf.weight) || 0;
              return `
                <tr>
                  <td>${boneBadge(inf.bone)}</td>
                  <td><input type="range" min="0" max="1" step="0.01" value="${Math.max(0, Math.min(1, value))}" data-draft-input="weight" data-slot="${slot}" ${locked ? 'disabled' : ''} aria-label="权重滑杆"></td>
                  <td><input type="number" min="0" max="1" step="0.01" value="${fmt(value, 3)}" data-draft-input="${locked ? 'locked-weight' : 'weight'}" data-slot="${slot}"></td>
                  <td><button class="lock-button ${locked ? 'locked' : ''}" data-action="lock-toggle" data-bone="${bone}" ${Number.isInteger(bone) ? '' : 'disabled'} title="${Number.isInteger(bone) ? '锁定后归一不会改变此值' : '无效编号不能锁定，请先删除或修复'}">${locked ? '🔒' : '🔓'}</button></td>
                  <td><button class="icon-button" data-action="remove-inf" data-slot="${slot}" title="删除影响行">×</button></td>
                </tr>`;
            })
            .join('')}
        </tbody>
      </table>
      <div class="row" style="margin-top:8px;">
        <select id="addBoneSelect" class="btn" style="padding:6px;">
          ${project.skeleton.map((b) => `<option value="${b.index}">${boneName(b.index)}</option>`).join('')}
        </select>
        <button class="btn tiny" data-action="add-inf">添加影响骨骼</button>
      </div>
      <div id="planPreview" style="margin-top:10px;"></div>
      <div class="row" style="margin-top:9px;">
        <button class="btn primary" data-action="commit-draft" ${ui.plan?.ok ? '' : 'disabled'}>检查并保存归一结果</button>
        <button class="btn" data-action="reset-draft">还原修改</button>
      </div>
    </section>

    <section class="panel-section">
      <h2>每点骨骼数上限对比</h2>
      ${renderCompareStats()}
      <div class="segmented" style="display:grid; grid-template-columns:1fr 1fr; margin:10px 0;">
        <button class="${ui.capTab === 2 ? 'active' : ''}" data-action="cap-tab" data-k="2">最多 2 根</button>
        <button class="${ui.capTab === 4 ? 'active' : ''}" data-action="cap-tab" data-k="4">最多 4 根</button>
      </div>
      ${renderCapReport(ui.capTab)}
      <div class="callout" style="margin-top:9px;">
        <strong>并列保留顺序：</strong>
        <ol style="margin:5px 0 0 18px; padding:0;">
          ${(project.meta?.tieRule ?? ['权重降序', '并列时锁定优先', '骨骼表顺序 / 编号小者', '原槽位靠前']).map((r) => `<li>${r}</li>`).join('')}
        </ol>
      </div>
    </section>

    <section class="panel-section">
      <h2>导出 / 读回校验 / 小样例</h2>
      <div class="stack">
        <button class="btn primary" data-action="export">导出网格权重和当前配置 JSON</button>
        <label class="btn" for="importFile" style="text-align:center;">导入 JSON 并读回</label>
        <button class="btn" data-action="verify">序列化 → 读回 → 校验静止/轻微/明显弯曲</button>
        <div id="verifyResult"></div>
        <button class="btn" data-action="load-seam">加载可导入的接缝最小样例</button>
        <button class="btn" data-action="show-sample">查看直接复现代码片段</button>
        <p class="hint">命令行也可运行 <span class="mono">npm run sample</span>，直接打印两个重合顶点在 82° 弯曲后的位置差。</p>
      </div>
    </section>
  `;

  renderPlanPreview();
  if (ui.verification) renderVerification(ui.verification);
}

function renderPlanPreview() {
  const host = $('#planPreview');
  if (!host || !ui.plan) return;
  const p = ui.plan;
  if (!p.ok) {
    host.innerHTML = `<div class="callout error"><strong>不能归一保存：</strong>${p.message ?? '计划无效'}<br><span class="hint">当前项目数据未被修改；请降低锁定值或解锁骨骼。</span></div>`;
    const btn = $('[data-action="commit-draft"]');
    if (btn) btn.disabled = true;
    return;
  }
  host.innerHTML = `
    <div class="callout ${p.distributable < 1e-6 ? 'success' : 'info'}" role="status">
      <strong>保存前提示</strong>
      <div class="row between"><span>锁定总量</span><strong class="mono">${fmt(p.lockedTotal, 4)}</strong></div>
      <div class="row between"><span>归一后可分配给未锁定骨骼</span><strong class="mono">${fmt(p.distributable, 4)}</strong></div>
      <div class="row between"><span>未锁定原始权重和 / 缩放</span><span class="mono">${fmt(p.unlockedRawSum, 3)} × ${fmt(p.scale, 3)}</span></div>
      ${p.evenFallback ? '<div class="hint">未锁定原始权重均为 0，剩余权重将平均分配。</div>' : ''}
      <div class="hint">保存后总权重为 1；锁定值逐位保持不变。</div>
    </div>`;
  const btn = $('[data-action="commit-draft"]');
  if (btn) btn.disabled = false;
}

function renderCapReport(k) {
  const id = ui.selectedVertexId;
  const report = selectedVertexCapReport(project, id, k);
  if (!report) return '';
  const invalidIgnored = report.ignored.filter(
    (entry) => !Number.isInteger(entry.bone) || entry.bone < 0 || entry.bone >= project.skeleton.length,
  );
  return `
    <h3>当前 ${vid(id)}：上限 ${k}</h3>
    ${report.message ? `<div class="callout error">${report.message}</div>` : ''}
    <table class="data-table">
      <thead><tr><th>骨骼</th><th>原权重</th><th>重分配后</th><th>状态</th></tr></thead>
      <tbody>
        ${report.retained
          .map(
            (r) => `<tr>
              <td>${boneBadge(r.bone)}</td>
              <td class="mono">${fmt(r.beforeWeight, 3)}</td>
              <td class="mono"><strong>${fmt(r.afterWeight, 3)}</strong></td>
              <td><span class="badge good">保留${r.locked ? ' / 锁' : ''}</span></td>
            </tr>`,
          )
          .join('')}
        ${report.discarded
          .map(
            (r) => `<tr>
              <td>${boneBadge(r.bone)}</td>
              <td class="mono diff-drop">${fmt(r.beforeWeight, 3)}</td>
              <td class="mono">0.000</td>
              <td><span class="badge critical">舍去，权重按规则重分配</span></td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    ${report.discarded.length ? `<p class="hint">被舍去行原有的 ${report.discarded.reduce((s, r) => s + r.beforeWeight, 0).toFixed(3)} 权重已按保留行比例/锁定规则分配。</p>` : '<p class="hint">该点影响数不超过上限，没有骨骼被舍去。</p>'}
    ${invalidIgnored.length ? `<div class="callout error">不参与截断/蒙皮的失效编号：${invalidIgnored.map((r) => boneBadge(r.bone)).join(' ')}。请在上方权重表或诊断修复中处理。</div>` : ''}
    ${report.tieGroup.length > 1 ? `<div class="callout info">临界并列权重涉及骨骼：${report.tieGroup.map((b) => boneBadge(b)).join(' ')}；按明确顺序得到当前保留/舍去结果。</div>` : ''}
  `;
}

function renderCompareStats() {
  const cmp = compareCapsAtPoses(project, ['rest', 'slight', 'strong']);
  const labels = { rest: '静止', slight: '轻微弯曲', strong: '明显弯曲' };
  return `
    <table class="data-table">
      <thead><tr><th>姿势</th><th>最大位移差</th><th>平均差</th><th>变化点数</th></tr></thead>
      <tbody>
        ${['rest', 'slight', 'strong']
          .map((pose) => {
            const s = cmp.poses[pose].cap2VsCap4;
            return `<tr>
              <td>${labels[pose]}</td>
              <td class="mono"><strong>${fmt(s.max, 4)}</strong></td>
              <td class="mono">${fmt(s.mean, 5)}</td>
              <td class="mono">${s.changed}/${s.count}</td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table>
    <p class="hint">数值为同一姿势下“每点最多 2 骨”和“最多 4 骨”两套变形结果的欧氏距离，单位与网格相同。</p>
  `;
}

function renderVerification(result) {
  const host = $('#verifyResult');
  if (!host) return;
  const row = (name, s) => `<div class="row between"><span>${name}</span><span class="mono">max ${fmt(s.max, 8)} / mean ${fmt(s.mean, 8)}</span></div>`;
  host.innerHTML = `<div class="callout ${result.ok ? 'success' : 'error'}">
    <strong>${result.ok ? '读回核对通过' : '读回核对存在误差'}</strong>
    <div class="hint">${result.vertexCount} 顶点 · ${result.boneCount} 骨骼 · ${result.bytes} bytes</div>
    ${row('静止', result.rest)}
    ${row('轻微', result.slight)}
    ${row('明显弯曲', result.strong)}
  </div>`;
}

/* ---------- viewport overlay / scene updates ---------- */

function renderViewportOverlay(legend = null) {
  const host = $('#viewportOverlay');
  if (!host) return;
  if (ui.overlay === 'bone') {
    host.innerHTML = `
      <strong>${boneName(ui.selectedBoneIndex)} 的表面影响</strong>
      <div class="hint">颜色越深，该骨骼权重越高；失效编号不会得到有效变形。</div>
      <div class="legend">
        <div class="legend-bar" style="background:linear-gradient(90deg,#eef2f7,#cde2fb,#6da7ec,#2a78d6,#0d366b);"></div>
        <div class="legend-labels"><span>0</span><span>0.5</span><span>1.0</span></div>
      </div>`;
  } else if (ui.overlay === 'difference' && legend) {
    host.innerHTML = `
      <strong>最多 2 骨 vs 最多 4 骨</strong>
      <div class="hint">当前姿势每点位置差；最深点 ${vid(legend.maxVertexId)}。</div>
      <div class="kpi-grid" style="margin:8px 0;">
        <div class="kpi"><div class="value">${fmt(legend.max, 3)}</div><div class="label">最大差</div></div>
        <div class="kpi"><div class="value">${fmt(legend.mean, 4)}</div><div class="label">平均差</div></div>
        <div class="kpi"><div class="value">${legend.changed}</div><div class="label">变化点</div></div>
      </div>
      <div class="legend">
        <div class="legend-bar" style="background:linear-gradient(90deg,#fff7ec,#fdd0a2,#f16913,#8c2d04);"></div>
        <div class="legend-labels"><span>0</span><span>${fmt(legend.max, 3)}</span></div>
      </div>`;
  } else {
    host.innerHTML = `<strong>检查器视口</strong><div class="hint">选择“骨骼权重”查看影响色，或运行 2/4 骨对比查看形状差。</div>`;
  }
}

function updateViewportStatus() {
  const host = $('#viewportStatus');
  if (!host) return;
  const id = ui.selectedVertexId;
  const v = project.mesh.vertices[id];
  if (!v) {
    host.textContent = '未选择顶点';
    return;
  }
  const e = evaluateVertex(project, id, ui.pose);
  host.innerHTML = `${vid(id)} · ${project.meta.poses[ui.pose]?.label ?? ui.pose} · 位移 ${e.distance.toFixed(4)} · 同位置顶点 ${currentCoLocated().map(vid).join(' / ')}`;
}

function refreshColors() {
  if (!viewer?.geometry) return;
  if (ui.overlay === 'bone') {
    viewer.setWeightColors(ui.selectedBoneIndex);
    renderViewportOverlay();
  } else if (ui.overlay === 'none') {
    viewer.setNeutralColors();
    renderViewportOverlay();
  } else {
    refreshDifferenceColors();
  }
}

function computeDifference() {
  const set2 = buildPrunedSet(project, 2);
  const set4 = buildPrunedSet(project, 4);
  const p2 = deformProject(project, ui.pose, { influenceOverrides: set2.overrides });
  const p4 = deformProject(project, ui.pose, { influenceOverrides: set4.overrides });
  const diffs = new Array(project.mesh.vertices.length).fill(0);
  let max = 0;
  let sum = 0;
  let changed = 0;
  let maxVertexId = -1;
  for (let id = 0; id < diffs.length; id += 1) {
    const d = Math.hypot(
      p2.positions[id * 3] - p4.positions[id * 3],
      p2.positions[id * 3 + 1] - p4.positions[id * 3 + 1],
      p2.positions[id * 3 + 2] - p4.positions[id * 3 + 2],
    );
    diffs[id] = d;
    sum += d;
    if (d > 1e-5) changed += 1;
    if (d > max) {
      max = d;
      maxVertexId = id;
    }
  }
  return { p2, p4, diffs, max, mean: sum / Math.max(1, diffs.length), changed, maxVertexId };
}

function refreshGhostOnly() {
  if (!ui.showGhost) {
    viewer.updateGhost(null);
    return;
  }
  const { p2 } = computeDifference();
  viewer.updateGhost(p2.positions);
}

function refreshDifferenceColors() {
  const result = computeDifference();
  viewer.setDifferenceColors(result.diffs, result.max);
  if (ui.showGhost) viewer.updateGhost(result.p2.positions);
  else viewer.updateGhost(null);
  renderViewportOverlay({
    max: result.max,
    mean: result.mean,
    changed: result.changed,
    maxVertexId: result.maxVertexId,
  });
}

function refreshDeformation() {
  const deformed = deformProject(project, ui.pose);
  viewer.updateDeformed(deformed);
  refreshColors();
  if (ui.showGhost && ui.overlay !== 'difference') refreshGhostOnly();
  updateViewportStatus();
}

function renderAll() {
  renderTopbar();
  renderLeft();
  renderInspector();
  renderViewportOverlay();
  updateViewportStatus();
}

function renderTopbar() {
  $('#poseButtons').innerHTML = Object.entries(project.meta.poses)
    .map(
      ([key, pose]) =>
        `<button data-action="set-pose" data-pose="${key}" class="${ui.pose === key ? 'active' : ''}">${pose.label}</button>`,
    )
    .join('');
}

/* ---------- sample / verification / io ---------- */

const SAMPLE_CODE = `import { createSeamReproProject } from './src/core/modelFactory.js';
import { deformProject, evaluateVertex } from './src/core/skinning.js';

const rig = createSeamReproProject();
for (const id of [0, 1]) {
  console.log(id, evaluateVertex(rig, id, 'strong'));
}
// V000 权重 上臂 .12 / 前臂 .88，几乎被旁边前臂骨带走；
// V001 同静止坐标，权重 上臂 .88 / 前臂 .12，仍留在上臂。
// 82° 弯曲后两者 posed 位置明显不同，这就是可直接重现的接缝撕裂。
const d = deformProject(rig, 'strong');
console.log('seam delta =', Math.hypot(
  d.positions[0] - d.positions[3],
  d.positions[1] - d.positions[4],
  d.positions[2] - d.positions[5],
));`;

function showSampleModal() {
  $('#modalRoot').innerHTML = `
    <div class="modal-backdrop" data-action="close-modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="row between">
          <h2>接缝问题最小复现</h2>
          <button class="btn tiny" data-action="close-modal">关闭</button>
        </div>
        <p>样例中有两个独立顶点，静止位置完全相同 <span class="mono">(0, 0.240, 0)</span>，但权重相反。点击“加载接缝最小样例”可在浏览器中选择 A/B 两个顶点核对。</p>
        <pre class="code-block">${escapeHtml(SAMPLE_CODE)}</pre>
      </div>
    </div>`;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function runVerification() {
  try {
    ui.verification = verifyRoundtrip(project);
    renderInspector();
    $('#verifyResult')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast(ui.verification.ok ? '导出字符串并重新解析成功，静止和弯曲姿势误差低于阈值。' : '读回完成，但数值误差超过阈值。', ui.verification.ok ? 'success' : 'error', 6000);
  } catch (error) {
    toast(`读回校验失败：${error.message}`, 'error', 7000);
  }
}

function exportProject() {
  project.config = {
    ...project.config,
    pose: ui.pose,
    selectedVertexId: ui.selectedVertexId,
    selectedBoneIndex: ui.selectedBoneIndex,
    overlay: ui.overlay,
    showSkeleton: ui.showSkeleton,
    showGhost: ui.showGhost,
    capTab: ui.capTab,
  };
  const text = serializeProject(project);
  download(`arm-weights-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, text);
  toast('已导出网格、骨骼、权重、锁和当前配置。', 'success');
}

function importProjectFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const restored = parseProject(String(reader.result));
      loadProject(restored);
      const check = verifyRoundtrip(restored);
      ui.verification = check;
      renderInspector();
      toast(`导入成功并完成读回核对：${check.ok ? '通过' : '有误差'}；静止 max=${check.rest.max.toExponential(2)}，强弯 max=${check.strong.max.toExponential(2)}`, check.ok ? 'success' : 'error', 7000);
    } catch (error) {
      toast(`导入失败：${error.message}`, 'error', 8000);
    }
  };
  reader.onerror = () => toast('读取文件失败。', 'error');
  reader.readAsText(file);
}

/* ---------- global events ---------- */

document.addEventListener('click', (event) => {
  const actionEl = event.target.closest('[data-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  const id = actionEl.dataset.id !== undefined ? Number(actionEl.dataset.id) : null;

  switch (action) {
    case 'set-pose':
      ui.pose = actionEl.dataset.pose;
      project.config.pose = ui.pose;
      renderTopbar();
      renderInspector();
      refreshDeformation();
      break;
    case 'select-vertex':
      selectVertex(id, { focus: event.shiftKey });
      break;
    case 'locate':
      selectVertex(id, { focus: true });
      break;
    case 'select-bone':
      selectBone(id);
      break;
    case 'set-overlay':
      ui.overlay = actionEl.dataset.overlay;
      renderLeft();
      refreshColors();
      break;
    case 'toggle-skeleton':
      ui.showSkeleton = !ui.showSkeleton;
      viewer.setSkeletonVisible(ui.showSkeleton);
      renderLeft();
      break;
    case 'toggle-ghost':
      ui.showGhost = !ui.showGhost;
      renderLeft();
      if (ui.overlay === 'difference') refreshDifferenceColors();
      else refreshGhostOnly();
      break;
    case 'fix-current':
      fixSelectedOnly();
      break;
    case 'lock-toggle': {
      const bone = String(actionEl.dataset.bone);
      replanDraft();
      if (Object.prototype.hasOwnProperty.call(ui.draft.locks, bone)) {
        delete ui.draft.locks[bone];
      } else {
        const row = ui.draft.influences.find((inf) => String(Number(inf.bone)) === bone || String(inf.bone) === bone);
        ui.draft.locks[bone] = Math.max(0, Math.min(1, Number(row?.weight ?? 0)));
      }
      replanDraft();
      renderInspector();
      break;
    }
    case 'remove-inf': {
      const slot = Number(actionEl.dataset.slot);
      ui.draft.influences.splice(slot, 1);
      replanDraft();
      renderInspector();
      break;
    }
    case 'add-inf': {
      const select = $('#addBoneSelect');
      const bone = Number(select?.value ?? 0);
      if (ui.draft.influences.some((inf) => Number(inf.bone) === bone)) {
        toast(`${boneName(bone)} 已在影响列表中；可直接修改权重。`, 'info');
        break;
      }
      ui.draft.influences.push({ bone, weight: 0 });
      replanDraft();
      renderInspector();
      break;
    }
    case 'commit-draft':
      commitDraft();
      break;
    case 'reset-draft':
      resetDraft();
      renderInspector();
      break;
    case 'cap-tab':
      ui.capTab = Number(actionEl.dataset.k);
      renderInspector();
      break;
    case 'export':
      exportProject();
      break;
    case 'verify':
      runVerification();
      break;
    case 'load-arm':
      loadProject(createArmProject(), { focusSelected: false });
      toast('已重新生成程序化手臂和骨架。');
      break;
    case 'load-seam':
      loadProject(createSeamReproProject(), { focusSelected: true });
      toast('已加载接缝最小样例：两个顶点静止位置相同但权重相反。', 'success', 6000);
      break;
    case 'show-sample':
      showSampleModal();
      break;
    case 'close-modal':
    case 'close-modal-backdrop':
      if (action === 'close-modal-backdrop' && event.target !== actionEl) break;
      $('#modalRoot').innerHTML = '';
      break;
    default:
      break;
  }
});

document.addEventListener('input', (event) => {
  const input = event.target;
  if (input.id === 'importFile') return;
  if (input.dataset.draftInput) {
    const slot = Number(input.dataset.slot);
    const raw = Number(input.value);
    const value = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    const inf = ui.draft.influences[slot];
    if (!inf) return;
    if (input.dataset.draftInput === 'locked-weight') {
      const boneKey = String(Number(inf.bone));
      ui.draft.locks[boneKey] = value;
      inf.weight = value;
    } else {
      inf.weight = value;
      const lockKey = String(Number(inf.bone));
      if (Object.prototype.hasOwnProperty.call(ui.draft.locks, lockKey)) ui.draft.locks[lockKey] = value;
    }
    // Sync the range/number pair without rebuilding the table and losing focus.
    $$(`[data-slot="${slot}"][data-draft-input]`).forEach((peer) => {
      if (peer !== input) peer.value = Number(value).toFixed(peer.type === 'number' ? 3 : 2);
    });
    replanDraft();
    renderPlanPreview();
  }
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'importFile') {
    const file = event.target.files?.[0];
    if (file) importProjectFile(file);
    event.target.value = '';
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') $('#modalRoot').innerHTML = '';
});

/* ---------- boot ---------- */

function boot() {
  $('#app').innerHTML = `
    <div class="app">
      <header class="topbar">
        <div class="brand">三维权重检查器<small>本地生成 · 肘部接缝 · 不做完整动画编辑器</small></div>
        <div class="topbar-group segmented" id="poseButtons" aria-label="姿势切换"></div>
        <div class="topbar-group">
          <button class="btn" data-action="load-arm">重新生成手臂</button>
          <button class="btn" data-action="load-seam">接缝小样例</button>
        </div>
        <div class="spacer"></div>
        <div class="topbar-group">
          <button class="btn" data-action="verify">读回校验</button>
          <button class="btn primary" data-action="export">导出 JSON</button>
          <label class="btn" for="importFile">导入</label>
          <input id="importFile" class="file-input" type="file" accept=".json,application/json" />
        </div>
      </header>
      <main class="workspace">
        <aside class="sidebar" id="leftPanel"></aside>
        <section class="viewport-wrap">
          <div id="viewport"></div>
          <div class="viewport-overlay" id="viewportOverlay"></div>
          <div class="viewport-status" id="viewportStatus"></div>
        </section>
        <aside class="inspector" id="inspector"></aside>
      </main>
      <div id="modalRoot"></div>
      <div id="toastRoot"></div>
    </div>`;

  const viewport = $('#viewport');
  viewer = new WeightViewer(viewport, {
    onSelectVertex: (id) => selectVertex(id),
    onSelectBone: (index) => selectBone(index),
  });

  diagnostics = findDiagnostics(project);
  resetDraft();
  viewer.loadProject(project);
  viewer.setDiagnostics(diagnostics, project);
  viewer.setSelectedVertex(ui.selectedVertexId, currentCoLocated());
  renderAll();
  refreshDeformation();
}

boot();
