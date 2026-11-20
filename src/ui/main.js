// 应用主控：网格状态、选区、UV 套切换、工具栏动作、报告更新与文件 IO。

import * as THREE from 'three';
import { ThreeView } from './three-view.js';
import { UVView } from './uv-view.js';
import { findIslands, toggleSeam, undirectedKey, cornerOfEdge } from '../core/topology.js';
import { unwrapFaces } from '../core/unwrap.js';
import { packIslands, translateIsland, scaleIsland, rotateIsland, islandBounds } from '../core/islands.js';
import { inspectUV } from '../core/inspect.js';
import { addUvSet, removeUvSet } from '../core/mesh.js';
import { parseOBJ, parseMTL, exportOBJ, saveProject, loadProject } from '../core/objio.js';

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.mesh = null;
    this.activeSet = 0;
    this.selectedFaces = new Set();
    this.mode = 'select';
    this.report = null;

    this.three = new ThreeView($('canvas-3d'), {
      onPickFace: (f, additive) => this.pickFace3D(f, additive),
      onPickSeam: (f) => this.pickSeam3D(f),
      onPickEmpty: () => { this.selectedFaces.clear(); this.syncSelection(); },
    });
    this.uv = new UVView($('canvas-uv'), {
      onPickUV: (f, additive) => this.pickFaceUV(f, additive),
      onDragIsland: (islandId, du, dv) => this.dragIsland(islandId, du, dv),
    });

    this.bindToolbar();
    this.setStatus('就绪：点击「加载示例」或导入 OBJ 开始');
  }

  // ---------- 网格装载 ----------
  loadMesh(mesh) {
    this.mesh = mesh;
    this.activeSet = 0;
    this.selectedFaces.clear();
    this.three.setMesh(mesh);
    this.uv.setMesh(mesh, this.activeSet);
    this.refreshUvSetSelector();
    this.three.setMode(this.mode);
    this.updateReport();
    this.setStatus(`已加载 ${mesh.name}：${mesh.faces.length} 面 / ${mesh.positions.length} 顶点 / ${mesh.uvSets.length} 套 UV`);
  }

  async loadSample() {
    const base = import.meta.env.BASE_URL;
    const [objText, mtlText] = await Promise.all([
      fetch(`${base}sample_grooved_block.obj`).then((r) => r.text()),
      fetch(`${base}sample_grooved_block.mtl`).then((r) => r.text()),
    ]);
    const mesh = parseOBJ(objText, 'sample_grooved_block');
    Object.assign(mesh.materials, parseMTL(mtlText));
    this.loadMesh(mesh);
  }

  // ---------- 选择联动 ----------
  pickFace3D(face, additive) {
    if (face === null || face === undefined) return;
    if (additive) {
      if (this.selectedFaces.has(face)) this.selectedFaces.delete(face);
      else this.selectedFaces.add(face);
    } else {
      this.selectedFaces = new Set([face]);
    }
    this.syncSelection();
  }

  pickFaceUV(face, additive) {
    if (face === null) return;
    if (additive) {
      if (this.selectedFaces.has(face)) this.selectedFaces.delete(face);
      else this.selectedFaces.add(face);
    } else {
      this.selectedFaces = new Set([face]);
    }
    this.syncSelection();
  }

  pickSeam3D(face) {
    // 选离射线命中点最近的那条边：简化为切换该面三条内部边中的第一条可切边，
    // 更精确的做法由 pointer 命中边决定；这里取面的最短边，通常符合直觉
    const { faces, positions, topology, seams } = this.mesh;
    let best = null;
    let bestLen = Infinity;
    for (let k = 0; k < 3; k++) {
      const a = faces[face][k];
      const b = faces[face][(k + 1) % 3];
      if (cornerOfEdge(topology, b, a) < 0) continue; // 边界跳过
      const pa = new THREE.Vector3(...positions[a]);
      const pb = new THREE.Vector3(...positions[b]);
      const len = pa.distanceTo(pb);
      if (len < bestLen) { bestLen = len; best = [a, b]; }
    }
    if (!best) { this.setStatus('该边是网格边界，边界本身即切缝'); return; }
    toggleSeam(seams, topology, best[0], best[1]);
    this.three.setSeams(seams);
    this.uv.refresh();
    this.setStatus(`切缝 ${undirectedKey(best[0], best[1])} ${seams.has(undirectedKey(best[0], best[1])) ? '已标记' : '已取消'}（共 ${seams.size} 条）`);
  }

  syncSelection() {
    this.three.setSelection(this.selectedFaces);
    this.uv.setSelection(this.selectedFaces);
    this.updateStatusPanel();
  }

  dragIsland(islandId, du, dv) {
    if (islandId === null || !this.mesh) return;
    translateIsland(this.mesh, islandId, du, dv, this.activeSet);
    this.uv.refresh();
    this.scheduleReport();
  }

  // ---------- 工具栏动作 ----------
  bindToolbar() {
    $('btn-load-sample').onclick = () => this.loadSample();
    $('file-obj').onchange = (e) => this.importOBJ(e.target.files[0]);
    $('select-mode').onchange = (e) => {
      this.mode = e.target.value;
      this.three.setMode(this.mode);
    };
    $('btn-unwrap').onclick = () => this.unwrap();
    $('btn-clear-seam').onclick = () => {
      if (!this.mesh) return;
      this.mesh.seams.clear();
      this.three.setSeams(this.mesh.seams);
      this.uv.refresh();
      this.setStatus('已清除全部切缝');
    };
    $('btn-pack').onclick = () => this.pack();
    $('btn-refresh-report').onclick = () => this.updateReport();

    document.querySelectorAll('.uv-transform button').forEach((btn) => {
      btn.onclick = () => this.transform(btn.dataset.xf);
    });

    $('select-uvset').onchange = (e) => this.switchUvSet(Number(e.target.value));
    $('btn-add-uvset').onclick = () => this.addSet();
    $('btn-del-uvset').onclick = () => this.deleteSet();

    $('btn-save-project').onclick = () => this.saveProjectFile();
    $('file-project').onchange = (e) => this.openProjectFile(e.target.files[0]);
    $('btn-export-obj').onclick = () => this.exportObjFile();
  }

  unwrap() {
    if (!this.mesh) return;
    const mode = $('select-unwrap-mode').value;
    const target = this.selectedFaces.size ? this.selectedFaces : null;
    const regions = unwrapFaces(this.mesh, target, this.activeSet, { mode });
    this.uv.refresh();
    this.syncSelection();
    this.updateReport();
    this.setStatus(`已${target ? '展开选中区域' : '整体展开'}：${regions} 个连通区域（${mode === 'planar' ? '平面投影' : '等距展开'}）`);
  }

  pack() {
    if (!this.mesh) return;
    const margin = Number($('input-margin').value) || 0.02;
    const r = packIslands(this.mesh, this.activeSet, margin);
    this.uv.refresh();
    this.syncSelection();
    this.updateReport();
    this.setStatus(`自动排布完成：${r.islandCount} 个岛，留白 ${margin}，UV 面积覆盖率 ${(r.coverage * 100).toFixed(1)}%`);
  }

  transform(action) {
    if (!this.mesh) return;
    const id = this.currentIslandId();
    if (id === null) { this.setStatus('请先在 UV 视图选择一个岛/面'); return; }
    const step = 0.02;
    switch (action) {
      case 'left': translateIsland(this.mesh, id, -step, 0, this.activeSet); break;
      case 'right': translateIsland(this.mesh, id, step, 0, this.activeSet); break;
      case 'up': translateIsland(this.mesh, id, 0, step, this.activeSet); break;
      case 'down': translateIsland(this.mesh, id, 0, -step, this.activeSet); break;
      case 'rot+': rotateIsland(this.mesh, id, Math.PI / 12, this.activeSet); break;
      case 'rot-': rotateIsland(this.mesh, id, -Math.PI / 12, this.activeSet); break;
      case 'grow': scaleIsland(this.mesh, id, 1.1, 1.1, this.activeSet); break;
      case 'shrink': scaleIsland(this.mesh, id, 0.9, 0.9, this.activeSet); break;
    }
    this.uv.refresh();
    this.syncSelection();
    this.scheduleReport();
  }

  currentIslandId() {
    if (!this.selectedFaces.size) return null;
    const { faceIsland } = findIslands(this.mesh, this.activeSet);
    return faceIsland[ [...this.selectedFaces][0] ];
  }

  // ---------- 多套 UV ----------
  refreshUvSetSelector() {
    const sel = $('select-uvset');
    sel.innerHTML = '';
    this.mesh.uvSets.forEach((_, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = this.mesh.uvNames?.[i] ?? `UVSet ${i + 1}`;
      sel.appendChild(opt);
    });
    sel.value = this.activeSet;
  }

  switchUvSet(index) {
    this.activeSet = index;
    this.uv.setMesh(this.mesh, index);
    this.uv.setSelection(this.selectedFaces);
    this.updateReport();
    this.updateStatusPanel();
    this.setStatus(`切换到 ${this.mesh.uvNames?.[index] ?? `UVSet ${index + 1}`}（其他 UV 套保持不变）`);
  }

  addSet() {
    if (!this.mesh) return;
    const idx = addUvSet(this.mesh);
    this.activeSet = idx;
    this.refreshUvSetSelector();
    this.uv.setMesh(this.mesh, idx);
    this.updateReport();
    this.setStatus(`已新增 UV 套 #${idx + 1}（复制当前套内容，之后独立编辑）`);
  }

  deleteSet() {
    if (!this.mesh) return;
    if (!removeUvSet(this.mesh, this.activeSet)) {
      this.setStatus('至少保留一套 UV，无法删除');
      return;
    }
    this.activeSet = Math.max(0, this.activeSet - 1);
    this.refreshUvSetSelector();
    this.uv.setMesh(this.mesh, this.activeSet);
    this.updateReport();
  }

  // ---------- 报告 ----------
  scheduleReport() {
    clearTimeout(this._reportTimer);
    this._reportTimer = setTimeout(() => this.updateReport(), 200);
  }

  updateReport() {
    if (!this.mesh) return;
    this.report = inspectUV(this.mesh, this.activeSet);
    const r = this.report;
    const sum = $('report-summary');
    const chip = (cls, n, label) =>
      `<div class="chip ${cls}"><b>${n}</b><span>${label}</span></div>`;
    sum.innerHTML =
      chip('', r.islandCount, 'UV 岛') +
      chip(r.overlaps.length ? 'bad' : 'ok', r.overlaps.length, '重叠') +
      chip(r.outOfBounds.length ? 'warn' : 'ok', r.outOfBounds.length, '越界') +
      chip(r.tinyIslands.length ? 'warn' : 'ok', r.tinyIslands.length, '过小');

    const list = $('report-list');
    const items = [];
    for (const o of r.overlaps) {
      items.push(`<div class="report-item overlap" data-jump="${o.faces[0]}">⚠ ${o.message}</div>`);
    }
    for (const o of r.outOfBounds) {
      items.push(`<div class="report-item oob" data-jump-island="${o.island}">⚠ ${o.message}</div>`);
    }
    for (const t of r.tinyIslands) {
      items.push(`<div class="report-item tiny" data-jump-island="${t.island}">⚠ ${t.message}</div>`);
    }
    if (!items.length) {
      items.push('<div class="report-item ok-line">✓ 未发现重叠、越界或过小岛</div>');
    }
    list.innerHTML = items.join('');
    list.querySelectorAll('[data-jump]').forEach((el) => {
      el.onclick = () => this.jumpToFace(Number(el.dataset.jump));
    });
    list.querySelectorAll('[data-jump-island]').forEach((el) => {
      el.onclick = () => this.jumpToIsland(Number(el.dataset.jumpIsland));
    });
    this.updateStatusPanel();
  }

  jumpToFace(face) {
    this.selectedFaces = new Set([face]);
    this.syncSelection();
  }

  jumpToIsland(islandId) {
    const { islands } = findIslands(this.mesh, this.activeSet);
    this.selectedFaces = new Set(islands[islandId]);
    this.syncSelection();
  }

  updateStatusPanel() {
    if (!this.mesh) return;
    const { islands } = findIslands(this.mesh, this.activeSet);
    const id = this.currentIslandId();
    const b = id !== null ? islandBounds(this.mesh, islands[id], this.activeSet) : null;
    $('status-panel').innerHTML = `
      <div>网格：<b>${this.mesh.name}</b>（${this.mesh.faces.length} 面）</div>
      <div>当前 UV 套：<b>${this.mesh.uvNames?.[this.activeSet] ?? this.activeSet + 1}</b> / 共 ${this.mesh.uvSets.length} 套</div>
      <div>切缝：<b>${this.mesh.seams.size}</b> 条 · 选中面：<b>${this.selectedFaces.size}</b></div>
      <div>岛总数：<b>${islands.length}</b>${id !== null ? ` · 当前岛 #${id}（${islands[id].length} 面）` : ''}</div>
      ${b ? `<div>岛包围盒：${b.width.toFixed(3)} × ${b.height.toFixed(3)}，面积 ${b.area.toExponential(2)}</div>` : ''}
    `;
  }

  // ---------- 文件 IO ----------
  importOBJ(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const mesh = parseOBJ(String(reader.result), file.name.replace(/\.obj$/i, ''));
      this.loadMesh(mesh);
    };
    reader.readAsText(file);
  }

  saveProjectFile() {
    if (!this.mesh) return;
    const json = saveProject(this.mesh, {
      camera: this.three.getViewState(),
      activeSet: this.activeSet,
      selection: [...this.selectedFaces],
    });
    this.download(`${this.mesh.name}.uvproj.json`, json, 'application/json');
    this.setStatus('项目已保存（含全部 UV 套与切缝，重新打开可恢复布局）');
  }

  openProjectFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const { mesh, viewState } = loadProject(String(reader.result));
      this.loadMesh(mesh);
      if (viewState.activeSet !== undefined) this.switchUvSet(viewState.activeSet);
      if (viewState.selection?.length) {
        this.selectedFaces = new Set(viewState.selection);
        this.syncSelection();
      }
      this.three.setViewState(viewState.camera);
      this.setStatus(`项目已恢复：${mesh.name}`);
    };
    reader.readAsText(file);
  }

  exportObjFile() {
    if (!this.mesh) return;
    const mtlName = `${this.mesh.name}.mtl`;
    const { obj, mtl } = exportOBJ(this.mesh, this.activeSet, mtlName);
    this.download(`${this.mesh.name}_uv${this.activeSet + 1}.obj`, obj, 'text/plain');
    this.download(mtlName, mtl, 'text/plain');
    this.setStatus(`已导出 OBJ + MTL（使用 ${this.mesh.uvNames?.[this.activeSet] ?? `UV 套 ${this.activeSet + 1}`}，含 vt 纹理坐标与切缝）`);
  }

  download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  setStatus(text) {
    $('status-text').textContent = text;
  }
}

const app = new App();
// 暴露给演示/调试页与控制台使用（应用本身不依赖全局变量）
if (typeof window !== 'undefined') {
  window.uvApp = app;
  // ?demo=1 时自动跑一遍完整工作流，供 headless 截图与手工快速预览
  if (new URLSearchParams(window.location.search).has('demo')) {
    (async () => {
      await app.loadSample();
      app.unwrap();
      app.pack();
      app.addSet();
      app.switchUvSet(0);
      window.__demoDone = true;
    })();
  }
}
export default app;
