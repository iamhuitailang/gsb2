// 应用主控制器：工具状态、画布交互、寻路重算、面板联动、工程保存/载入/导出。
import { CELL, inBounds } from '../core/geometry.js';
import { NavEngine } from '../core/engine.js';
import { WEIGHT_PRESETS } from '../core/pathfinding.js';
import {
  serializeProject, deserializeProject, exportNavData,
} from '../core/serialize.js';
import { Camera, Renderer } from './render.js';
import { Minimap } from './minimap.js';

const TOOL_CELL = {
  walk: CELL.WALK,
  block: CELL.BLOCK,
  road: CELL.ROAD,
  mud: CELL.MUD,
  eraser: CELL.WALK,
};
const TERRAIN_NAME = {
  [CELL.WALK]: '普通可行走',
  [CELL.BLOCK]: '障碍',
  [CELL.ROAD]: '路面（×0.6）',
  [CELL.MUD]: '泥泞（×2.5）',
};
const COMPONENT_COLORS = ['#5aa8ff', '#ff5d8f', '#37d9c0', '#ffcc00', '#b388ff', '#ff8a65', '#81c784'];

class App {
  constructor() {
    this.canvas = document.getElementById('mainCanvas');
    this.renderer = new Renderer(this.canvas);
    this.camera = new Camera();
    this.minimap = new Minimap(document.getElementById('minimap'), this);
    this.tool = 'block';
    this.brushRadius = 0;
    this.painting = false;
    this.panning = false;
    this.spaceHeld = false;
    this.lastPointer = null;
    this.dirty = false;
    this.bgImage = null;
    this.fileName = 'untitled.nav.json';
    this.weights = { ...WEIGHT_PRESETS.shortest.weights };
    this.preset = 'shortest';
    this.state = {
      engine: null,
      camera: this.camera,
      primaryResult: null,
      compareResult: null,
      reach: null,
      dirtyRect: null,
      hover: null,
      showUnreachable: true,
      showExplored: false,
      showRegions: true,
      showClearance: false,
    };
    this._bindEvents();
    this.renderer.resize();
    this._loadSample('showcase', true).then(() => {
      this._refreshPanel();
      this._draw();
    });
    this._frame = 0;
    window.addEventListener('resize', () => {
      this.renderer.resize();
      if (this.state.engine) this._draw();
    });
  }

  // ---------- 工程 / 样例 ----------

  _newMap() {
    const w = Number(prompt('地图宽度（格）', '40'));
    const h = Number(prompt('地图高度（格）', '30'));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 5 || h < 5 || w > 300 || h > 300) {
      this.toast('尺寸需在 5~300 之间');
      return;
    }
    this._setEngine(new NavEngine({ width: w, height: h, agentRadius: 0.5 }));
    this.fileName = 'untitled.nav.json';
    this.dirty = false;
    this.toast(`已新建 ${w}×${h} 地图`);
  }

  async _loadSample(name, silent = false) {
    const res = await fetch(`samples/${name}.json`);
    if (!res.ok) {
      this.toast(`样例 ${name} 加载失败，请先运行 npm run generate:samples`);
      return;
    }
    const data = await res.json();
    const { engine, meta } = deserializeProject(data);
    this._setEngine(engine);
    this.fileName = `${name}.nav.json`;
    this.dirty = false;
    document.getElementById('agentRadius').value = engine.agentRadius;
    if (!silent) this.toast(`已载入样例：${meta.title || name}`);
  }

  _setEngine(engine) {
    this.state.engine = engine;
    this.state.dirtyRect = null;
    this.camera.x = 0;
    this.camera.y = 0;
    this.camera.scale = Math.min(
      32,
      Math.floor(Math.min(this.renderer.viewW / engine.w, this.renderer.viewH / engine.h) * 0.92),
      28,
    );
    this.camera.scale = Math.max(8, this.camera.scale);
    this._recomputePaths();
    this._refreshPanel();
    this._draw();
  }

  // ---------- 寻路 ----------

  _currentWeights() {
    return { ...this.weights };
  }

  _recomputePaths() {
    const e = this.state.engine;
    if (!e) return;
    this.state.primaryResult = e.computePath(this._currentWeights());
    this.state.reach = e.reachabilityFrom(e.start);
    if (this._compareOn()) {
      this.state.compareResult = e.computePath(WEIGHT_PRESETS.shortest.weights);
    } else {
      this.state.compareResult = null;
    }
  }

  _compareOn() {
    return document.getElementById('compareToggle').checked && this.preset !== 'shortest';
  }

  // ---------- 编辑 ----------

  _applyPaint(cellX, cellY) {
    const e = this.state.engine;
    const value = TOOL_CELL[this.tool];
    if (value === undefined) return;
    const rect = e.paint(cellX, cellY, value, this.brushRadius);
    if (rect) {
      this.state.dirtyRect = rect;
      this._afterEdit();
    }
  }

  _afterEdit() {
    const e = this.state.engine;
    // 起终点若因侵蚀失效，回退到某个可通行格（全图不可通行时保持原下标并由横幅提示）
    if (!e.passable[e.start]) {
      const fallback = e._firstPassable();
      if (fallback !== null) e.start = fallback;
    }
    if (!e.passable[e.goal]) {
      const fallback = e._firstPassable();
      if (fallback !== null) e.goal = fallback;
    }
    this._recomputePaths();
    this._refreshPanel();
    this.dirty = true;
    this._draw();
  }

  _placeEndpoint(which, x, y) {
    const ok = this.state.engine.setEndpoint(which, x, y);
    if (!ok) {
      this.toast('该格在当前角色半径下不可通行，无法放置');
      return;
    }
    this._recomputePaths();
    this._refreshPanel();
    this.dirty = true;
    this._draw();
  }

  _addNote(x, y) {
    const text = prompt('标注内容：', '检查点');
    if (!text) return;
    this.state.engine.addAnnotation(x, y, text);
    this._refreshPanel();
    this.dirty = true;
    this._draw();
  }

  // ---------- 指针交互 ----------

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._onDown(e));
    c.addEventListener('pointermove', (e) => this._onMove(e));
    window.addEventListener('pointerup', () => {
      this.painting = false;
      this.panning = false;
      c.classList.remove('panning');
    });
    c.addEventListener('pointerleave', () => {
      this.state.hover = null;
      this._hideTooltip();
      this._draw();
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      this.camera.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12,
        e.clientX - rect.left, e.clientY - rect.top,
        this.renderer.viewW, this.renderer.viewH);
      this._draw();
    }, { passive: false });

    // 工具按钮
    document.getElementById('toolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tool]');
      if (btn) this._selectTool(btn.dataset.tool);
    });
    document.getElementById('brushSize').addEventListener('input', (e) => {
      this.brushRadius = Math.max(0, Number(e.target.value) || 0);
    });
    document.getElementById('agentRadius').addEventListener('input', (e) => {
      const r = Math.max(0, Number(e.target.value) || 0);
      this.state.engine.setAgentRadius(r);
      this._afterEdit();
    });

    // 权重
    document.getElementById('weightPreset').addEventListener('change', (e) => {
      this.preset = e.target.value;
      if (this.preset !== 'custom') {
        this.weights = { ...WEIGHT_PRESETS[this.preset].weights };
        this._syncWeightSliders();
      }
      this._recomputePaths();
      this._refreshPanel();
      this._draw();
    });
    for (const id of ['wDistance', 'wTerrain', 'wWall']) {
      document.getElementById(id).addEventListener('input', () => {
        this.weights = {
          distance: Number(document.getElementById('wDistance').value),
          terrain: Number(document.getElementById('wTerrain').value),
          wall: Number(document.getElementById('wWall').value),
        };
        this.preset = 'custom';
        document.querySelector('input[name="preset"][value="custom"]').checked = true;
        this._syncWeightSliders(false);
        this._recomputePaths();
        this._refreshPanel();
        this._draw();
      });
    }
    document.getElementById('compareToggle').addEventListener('change', () => {
      this._recomputePaths();
      this._refreshPanel();
      this._draw();
    });

    // 图层
    const layerBind = [
      ['layerUnreachable', 'showUnreachable'],
      ['layerExplored', 'showExplored'],
      ['layerRegions', 'showRegions'],
      ['layerClearance', 'showClearance'],
    ];
    for (const [domId, stateKey] of layerBind) {
      document.getElementById(domId).addEventListener('change', (e) => {
        this.state[stateKey] = e.target.checked;
        this._draw();
      });
    }

    // 文件
    document.getElementById('newMapBtn').addEventListener('click', () => this._guardDirty(() => this._newMap()));
    document.getElementById('openFileBtn').addEventListener('click', () => document.getElementById('fileInput').click());
    document.getElementById('fileInput').addEventListener('change', (e) => this._openFile(e.target.files[0]));
    document.getElementById('saveFileBtn').addEventListener('click', () => this._saveProject());
    document.getElementById('exportGridBtn').addEventListener('click', () => this._export('grid'));
    document.getElementById('exportGraphBtn').addEventListener('click', () => this._export('graph'));
    document.getElementById('bgBtn').addEventListener('click', () => document.getElementById('bgInput').click());
    document.getElementById('bgInput').addEventListener('change', (e) => this._loadBg(e.target.files[0]));
    document.getElementById('bgOpacity').addEventListener('input', () => this._draw());

    // 键盘快捷键
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const map = {
        w: 'walk', b: 'block', r: 'road', m: 'mud',
        s: 'start', g: 'goal', n: 'note', h: 'pan', e: 'eraser',
      };
      if (map[e.key.toLowerCase()]) this._selectTool(map[e.key.toLowerCase()]);
    });

    this._buildSampleButtons();
  }

  _selectTool(tool) {
    this.tool = tool;
    this.canvas.classList.toggle('pan-mode', tool === 'pan');
    document.querySelectorAll('button[data-tool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
  }

  _onDown(e) {
    const cell = this._eventCell(e);
    if (!cell) return;
    if (this.tool === 'pan' || e.button === 1 || this.spaceHeld) {
      this.panning = true;
      this.canvas.classList.add('panning');
      this.lastPointer = { x: e.clientX, y: e.clientY };
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    if (this.tool === 'start') return this._placeEndpoint('start', cell.x, cell.y);
    if (this.tool === 'goal') return this._placeEndpoint('goal', cell.x, cell.y);
    if (this.tool === 'note') return this._addNote(cell.x, cell.y);
    this.painting = true;
    this._applyPaint(cell.x, cell.y);
  }

  _onMove(e) {
    const cell = this._eventCell(e);
    if (this.panning && this.lastPointer) {
      this.camera.pan(this.lastPointer.x - e.clientX, this.lastPointer.y - e.clientY);
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this._draw();
      return;
    }
    if (!cell) return;
    this.state.hover = cell;
    if (this.painting && (this.tool === 'block' || this.tool === 'walk'
      || this.tool === 'road' || this.tool === 'mud' || this.tool === 'eraser')) {
      this._applyPaint(cell.x, cell.y);
    } else {
      this._showTooltip(e, cell);
      this._draw();
    }
  }

  _eventCell(e) {
    const rect = this.canvas.getBoundingClientRect();
    const cell = this.camera.screenToCell(e.clientX - rect.left, e.clientY - rect.top);
    if (!inBounds(this.state.engine.w, this.state.engine.h, cell.x, cell.y)) return null;
    return cell;
  }

  // ---------- 面板 ----------

  _syncWeightSliders(updateValues = true) {
    if (updateValues) {
      document.getElementById('wDistance').value = this.weights.distance;
      document.getElementById('wTerrain').value = this.weights.terrain;
      document.getElementById('wWall').value = this.weights.wall;
    }
    document.getElementById('wDistanceVal').textContent = Number(document.getElementById('wDistance').value).toFixed(1);
    document.getElementById('wTerrainVal').textContent = Number(document.getElementById('wTerrain').value).toFixed(1);
    document.getElementById('wWallVal').textContent = Number(document.getElementById('wWall').value).toFixed(1);
  }

  _refreshPanel() {
    this._syncWeightSliders();
    const e = this.state.engine;
    if (!e) return;
    const r = this.state.primaryResult;
    const banner = document.getElementById('statusBanner');
    const summary = document.getElementById('pathSummary');
    const breakdown = document.getElementById('pathBreakdown');
    const compare = document.getElementById('compareSummary');

    const startLabel = e.labels[e.start];
    const goalLabel = e.labels[e.goal];
    if (e.componentCount === 0) {
      banner.className = 'banner error';
      banner.textContent = '当前角色半径下没有任何可通行格，请缩小半径或清除障碍';
    } else if (!e.passable[e.start] || !e.passable[e.goal]) {
      banner.className = 'banner error';
      banner.textContent = '起点或终点在当前角色半径下不可通行';
    } else if (startLabel !== goalLabel) {
      banner.className = 'banner warn';
      banner.textContent = `不可达：起点位于分量 ${startLabel}，终点位于分量 ${goalLabel}，两者不连通`;
    } else if (r && r.found) {
      banner.className = 'banner ok';
      banner.textContent = `可达：路径 ${r.path.length} 个节点，搜索探索 ${r.explored} 格`;
    }

    if (r && r.found) {
      summary.innerHTML = `总代价 <span style="color:var(--pink)">${r.cost.toFixed(2)}</span>`;
      breakdown.innerHTML = `
        <span>距离段</span><b>${r.breakdown.distance.toFixed(2)}</b>
        <span>地形段</span><b>${r.breakdown.terrain.toFixed(2)}</b>
        <span>贴墙段</span><b>${r.breakdown.wall.toFixed(2)}</b>
        <span>路径长度</span><b>${r.edges.reduce((s, x) => s + x.len, 0).toFixed(2)} 格</b>`;
    } else {
      summary.textContent = '无可达路径';
      breakdown.innerHTML = '';
    }

    if (this._compareOn() && this.state.compareResult && this.state.compareResult.found) {
      const cr = this.state.compareResult;
      const diff = r.found ? (r.cost - cr.cost) : NaN;
      compare.innerHTML = `
        <div><span class="pink">当前权重</span>：${r.found ? r.cost.toFixed(2) : '不可达'}</div>
        <div><span class="teal">最短距离</span>：${cr.cost.toFixed(2)}（长度 ${cr.edges.reduce((s, x) => s + x.len, 0).toFixed(2)} 格）</div>
        <div>代价差：${Number.isFinite(diff) ? (diff >= 0 ? '+' : '') + diff.toFixed(2) : '—'}</div>`;
    } else {
      compare.innerHTML = '';
    }

    // 连通分量
    const list = document.getElementById('componentList');
    list.innerHTML = '';
    for (let label = 1; label <= e.componentCount; label++) {
      const row = document.createElement('div');
      row.className = 'comp-row';
      const color = COMPONENT_COLORS[(label - 1) % COMPONENT_COLORS.length];
      const isStart = label === startLabel;
      const isGoal = label === goalLabel;
      row.innerHTML = `
        <span><span class="comp-dot" style="background:${color}"></span>
        分量 ${label} · ${e.componentSizes[label]} 格
        ${isStart ? '（含起点）' : ''}${isGoal ? '（含终点）' : ''}</span>
        <button>定位</button>`;
      row.querySelector('button').addEventListener('click', () => {
        let target = -1;
        for (let i = 0; i < e.size; i++) if (e.labels[i] === label) { target = i; break; }
        if (target >= 0) {
          this.camera.centerOn(target % e.w, (target / e.w) | 0,
            this.renderer.viewW, this.renderer.viewH, e.w, e.h);
          this._draw();
        }
      });
      list.appendChild(row);
    }

    // 标注
    const ul = document.getElementById('annotationList');
    ul.innerHTML = '';
    if (e.annotations.length === 0) {
      ul.innerHTML = '<li style="color:var(--muted)">暂无标注</li>';
    }
    for (const a of e.annotations) {
      const li = document.createElement('li');
      const blocked = !e.passable[a.y * e.w + a.x];
      li.innerHTML = `<span class="ann-text" title="${a.text}">#${a.id} (${a.x},${a.y})${blocked ? ' ⚠落在不可通行格' : ''} ${a.text}</span>`;
      const del = document.createElement('button');
      del.textContent = '删除';
      del.addEventListener('click', () => {
        e.removeAnnotation(a.id);
        this._refreshPanel();
        this.dirty = true;
        this._draw();
      });
      li.appendChild(del);
      li.addEventListener('click', (ev) => {
        if (ev.target === del) return;
        this.camera.centerOn(a.x, a.y, this.renderer.viewW, this.renderer.viewH, e.w, e.h);
        this._draw();
      });
      ul.appendChild(li);
    }
  }

  _showTooltip(e, cell) {
    const e0 = this.state.engine;
    const i = cell.y * e0.w + cell.x;
    const tip = document.getElementById('tooltip');
    const rect = this.canvas.getBoundingClientRect();
    const rows = [
      ['坐标', `(${cell.x}, ${cell.y})`],
      ['地形', TERRAIN_NAME[e0.cells[i]]],
      ['clearance', e0.clearance[i].toFixed(2)],
      ['角色可通行', e0.passable[i] ? '是' : '否'],
      ['连通分量', e0.labels[i] || '—'],
    ];
    if (this.state.primaryResult && this.state.primaryResult.gScore) {
      const g = this.state.primaryResult.gScore[i];
      rows.push(['起点累计代价 g', g >= 1e17 ? '∞（未探索）' : g.toFixed(2)]);
    }
    const edge = this._edgeCostAt(i);
    if (edge) rows.push(['该格入边代价', edge.toFixed(2)]);
    tip.innerHTML = `<div class="tt-title">格子信息</div>` +
      rows.map(([k, v]) => `<div class="tt-row"><span>${k}</span><b>${v}</b></div>`).join('');
    tip.classList.remove('hidden');
    const tw = tip.offsetWidth;
    let x = e.clientX - rect.left + 14;
    if (x + tw > this.renderer.viewW - 8) x = e.clientX - rect.left - tw - 14;
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.min(e.clientY - rect.top + 14, this.renderer.viewH - 160)}px`;
  }

  _edgeCostAt(i) {
    const r = this.state.primaryResult;
    if (!r || !r.edges) return null;
    const edge = r.edges.find((x) => x.to === i);
    return edge ? edge.cost : null;
  }

  _hideTooltip() {
    document.getElementById('tooltip').classList.add('hidden');
  }

  _buildSampleButtons() {
    const wrap = document.getElementById('sampleList');
    const samples = [
      ['narrow-pass', '窄通道', '宽度 3 与宽度 1 的开口，调大角色半径观察封路'],
      ['dead-end', '死路', '主通道分出三个死胡同，验证 A* 不进死分支'],
      ['isolated', '孤立区域', '封闭庭院与孤岛，终点不可达演示'],
      ['showcase', '综合演示', '窄通道+死路+孤岛+三种地形同屏'],
    ];
    for (const [name, title, desc] of samples) {
      const btn = document.createElement('button');
      btn.innerHTML = `<div class="sample-title">${title}</div><div class="sample-desc">${desc}</div>`;
      btn.addEventListener('click', () => this._guardDirty(() => this._loadSample(name)));
      wrap.appendChild(btn);
    }
  }

  // ---------- 文件 IO ----------

  _guardDirty(fn) {
    if (this.dirty && !confirm('当前修改尚未保存，确定要切换吗？')) return;
    fn();
  }

  _download(json, name) {
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  _saveProject() {
    const json = serializeProject(this.state.engine, {
      weights: this._currentWeights(),
      preset: this.preset,
      layers: {
        showUnreachable: this.state.showUnreachable,
        showExplored: this.state.showExplored,
        showRegions: this.state.showRegions,
      },
    });
    this._download(json, this.fileName);
    this.dirty = false;
    this.toast(`工程已保存：${this.fileName}`);
  }

  async _openFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const { engine, meta } = deserializeProject(data);
      this._setEngine(engine);
      this.fileName = file.name;
      if (meta.weights) {
        this.weights = { ...meta.weights };
        this.preset = meta.preset || 'custom';
        const radio = document.querySelector(`input[name="preset"][value="${this.preset}"]`);
        if (radio) radio.checked = true;
      }
      document.getElementById('agentRadius').value = engine.agentRadius;
      this.dirty = false;
      this.toast(`已打开工程：${file.name}`);
    } catch (err) {
      this.toast(`打开失败：${err.message}`);
    }
    document.getElementById('fileInput').value = '';
  }

  _export(mode) {
    const json = exportNavData(this.state.engine, this._currentWeights(), mode);
    const base = this.fileName.replace(/\.nav\.json$/, '');
    this._download(json, `${base}.nav-${mode}.json`);
    this.toast(`已导出${mode === 'grid' ? '栅格' : '邻接图'}导航数据`);
  }

  _loadBg(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      this.bgImage = img;
      this._draw();
      this.toast('底图已载入（仅作参考，不会写入工程文件）');
    };
    img.src = url;
    document.getElementById('bgInput').value = '';
  }

  // ---------- 渲染 ----------

  _draw() {
    if (this._frame || !this.state.engine) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      this._drawBg();
      this.renderer.draw(this.state);
      this.minimap.draw();
    });
  }

  scheduleDraw() {
    this._draw();
  }

  _drawBg() {
    if (!this.bgImage) return;
    const ctx = this.renderer.ctx;
    const opacity = Number(document.getElementById('bgOpacity').value);
    const e = this.state.engine;
    const worldW = e.w * this.camera.scale;
    const worldH = e.h * this.camera.scale;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.drawImage(this.bgImage, -this.camera.x, -this.camera.y, worldW, worldH);
    ctx.restore();
  }

  toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }
}

// 空格临时平移
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
    e.preventDefault();
    if (window.__app) {
      window.__app.spaceHeld = true;
      window.__app._selectTool('pan');
    }
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && window.__app) window.__app.spaceHeld = false;
});

window.addEventListener('DOMContentLoaded', () => {
  window.__app = new App();
  const app = window.__app;
  app._selectTool('block');
});
