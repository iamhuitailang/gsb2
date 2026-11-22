/* 应用状态与地图编辑逻辑 */
(function (global) {
  'use strict';

  const E = global.TileEngine;

  const App = {
    rules: null,
    grid: null,
    seed: 20261123,
    evalCache: new Map(),
    selection: null,
    tool: 'draw',
    brushTerrain: null,
    cellSize: 34,
    history: [],
    redoStack: [],
    listeners: [],

    init(rules, grid, seed) {
      this.rules = rules;
      this.grid = grid;
      this.seed = seed == null ? this.seed : seed;
      this.evalCache = new Map();
      this.history = [];
      this.redoStack = [];
      this.selection = null;
      this.brushTerrain = rules.terrains[0] ? rules.terrains[0].id : null;
      this._refreshVersion();
      this.reevaluateAll();
    },

    onChange(fn) { this.listeners.push(fn); },
    emit(reason) { this.listeners.forEach((fn) => fn(reason)); },

    _refreshVersion() {
      this.rules._version = E.ruleVersion(this.rules);
    },

    /* ---------------- 评估（全量 / 增量） ---------------- */

    reevaluateAll() {
      this.evalCache = new Map();
      for (let y = 0; y < this.grid.h; y++) {
        for (let x = 0; x < this.grid.w; x++) {
          const idx = this.grid.idx(x, y);
          if (this.grid.get(x, y)) {
            this.evalCache.set(idx, E.evaluateCell(this.rules, this.grid, x, y, this.seed));
          } else {
            this.evalCache.delete(idx);
          }
        }
      }
    },

    /* 只重算可能变化的格（改动格 + 其 8 邻居），其它格保持原评估结果与外观 */
    reevaluateCells(changedCells) {
      const set = E.affectedCells(this.grid, changedCells);
      for (const idx of set) {
        const x = idx % this.grid.w;
        const y = Math.floor(idx / this.grid.w);
        if (this.grid.get(x, y)) {
          this.evalCache.set(idx, E.evaluateCell(this.rules, this.grid, x, y, this.seed));
        } else {
          this.evalCache.delete(idx);
        }
      }
      return set;
    },

    /* ---------------- 历史 ---------------- */

    pushHistory(label) {
      this.history.push({
        label,
        cells: this.grid.cells.slice(),
      });
      if (this.history.length > 60) this.history.shift();
      this.redoStack = [];
    },

    undo() {
      const prev = this.history.pop();
      if (!prev) return;
      this.redoStack.push({ label: prev.label, cells: this.grid.cells.slice() });
      this.restoreCells(prev.cells);
    },

    redo() {
      const next = this.redoStack.pop();
      if (!next) return;
      this.history.push({ label: next.label, cells: this.grid.cells.slice() });
      this.restoreCells(next.cells);
    },

    restoreCells(cells) {
      const changed = [];
      for (let i = 0; i < cells.length; i++) {
        if (cells[i] !== this.grid.cells[i]) {
          changed.push([i % this.grid.w, Math.floor(i / this.grid.w)]);
        }
      }
      this.grid.cells = cells.slice();
      this.reevaluateCells(changed);
      this.emit('restore');
    },

    /* ---------------- 编辑操作 ---------------- */

    paintCell(x, y, value) {
      if (!this.grid.inBounds(x, y)) return false;
      const cur = this.grid.get(x, y);
      const next = value; // null = 擦除
      if (cur === next) return false;
      this.grid.set(x, y, next);
      this.reevaluateCells([[x, y]]);
      return true;
    },

    applyStroke(points, value) {
      this.pushHistory(value == null ? '擦除' : '绘制');
      this.applyStrokeDirect(points, value);
      this.emit('paint');
    },

    /* 拖动过程中调用：只改格并增量重算，不写历史（历史由按下时统一记录） */
    applyStrokeDirect(points, value) {
      const changed = [];
      for (const [x, y] of points) {
        if (!this.grid.inBounds(x, y)) continue;
        if (this.grid.get(x, y) === value) continue;
        this.grid.set(x, y, value);
        changed.push([x, y]);
      }
      if (changed.length) this.reevaluateCells(changed);
    },

    applyFill(x, y, value) {
      const target = this.grid.get(x, y);
      if (target === value) return;
      this.pushHistory('填充');
      const region = target == null
        ? this._emptyRegion(x, y)
        : E.floodFill(this.grid, x, y);
      const changed = [];
      for (const idx of region) {
        const cx = idx % this.grid.w, cy = Math.floor(idx / this.grid.w);
        this.grid.set(cx, cy, value);
        changed.push([cx, cy]);
      }
      this.reevaluateCells(changed);
      this.emit('fill');
    },

    _emptyRegion(x, y) {
      const seen = new Set();
      const q = [[x, y]];
      seen.add(this.grid.idx(x, y));
      while (q.length) {
        const [cx, cy] = q.pop();
        for (const d of E.CARDINALS) {
          const nx = cx + E.DX[d], ny = cy + E.DY[d];
          if (!this.grid.inBounds(nx, ny)) continue;
          const k = this.grid.idx(nx, ny);
          if (seen.has(k) || this.grid.get(nx, ny) != null) continue;
          seen.add(k);
          q.push([nx, ny]);
        }
      }
      return seen;
    },

    /* ---------------- 规则变更 ---------------- */

    rulesMutated() {
      this._refreshVersion();
      // 规则改动可能影响任意格，需要全量重算
      this.reevaluateAll();
      this.emit('rules');
    },

    setSeed(seed) {
      this.seed = seed;
      this.reevaluateAll();
      this.emit('seed');
    },

    /* ---------------- 检查 / 扫描 ---------------- */

    inspect(x, y) {
      if (!this.grid.inBounds(x, y)) return null;
      this.selection = { x, y };
      if (!this.grid.get(x, y)) return { empty: true, x, y };
      // 即时重算，保证与当前规则一致
      const ev = E.evaluateCell(this.rules, this.grid, x, y, this.seed);
      this.evalCache.set(this.grid.idx(x, y), ev);
      return ev;
    },

    scanProblems() {
      const missing = [];
      const conflicts = [];
      for (const ev of E.evaluateAll(this.rules, this.grid, this.seed)) {
        if (ev.missing) missing.push(ev);
        if (ev.conflictRuleIds.length) conflicts.push(ev);
      }
      return { missing, conflicts };
    },

    /* ---------------- 保存 / 载入 ---------------- */

    serializeRules() {
      return JSON.stringify({
        format: 'tile-rules/v1',
        version: E.ruleVersion(this.rules),
        terrains: this.rules.terrains,
        tiles: this.rules.tiles,
        customRules: this.rules.customRules,
        nextCustomRuleId: this.rules.nextCustomRuleId,
      }, null, 2);
    },

    loadRules(json) {
      const data = JSON.parse(json);
      if (data.format !== 'tile-rules/v1') throw new Error('不是受支持的规则文件（format 不匹配）');
      const oldVersion = this.rules._version;
      this.rules = {
        format: 'tile-rules/v1',
        terrains: data.terrains || [],
        tiles: data.tiles || {},
        customRules: data.customRules || [],
        nextCustomRuleId: data.nextCustomRuleId || 1,
      };
      // 补齐缺失槽位，保证编辑器结构完整
      this.rules.terrains.forEach((t) => E.ensureTerrainSlots(this.rules, t.id));
      this._refreshVersion();
      this.reevaluateAll();
      this.emit('rules');
      return { oldVersion, newVersion: this.rules._version };
    },

    serializeMap() {
      // 保存当前评估快照：载入时若规则版本不同，可逐格指出可能变化的位置
      const snapshot = [];
      for (const ev of E.evaluateAll(this.rules, this.grid, this.seed)) {
        snapshot.push({
          x: ev.x, y: ev.y, terrain: ev.terrain,
          tileId: ev.tileId, rot: ev.rot, variantId: ev.variantId,
          cat: ev.cat, shape: ev.shape,
        });
      }
      return JSON.stringify({
        format: 'tile-map/v1',
        ruleVersion: this.rules._version,
        seed: this.seed,
        w: this.grid.w,
        h: this.grid.h,
        cells: this.grid.cells,
        snapshot,
      }, null, 2);
    },

    /* 返回 { warnings: [{x,y,kind,before,after}] } —— 规则版本不同时逐格对比 */
    loadMap(json) {
      const data = JSON.parse(json);
      if (data.format !== 'tile-map/v1') throw new Error('不是受支持的地图文件（format 不匹配）');
      this.grid = E.Grid.fromJSON(data);
      if (data.seed != null) this.seed = data.seed;
      this.history = [];
      this.redoStack = [];
      this.selection = null;
      this.reevaluateAll();
      this.emit('map');

      const warnings = [];
      const sameVersion = data.ruleVersion === this.rules._version;
      if (!sameVersion && Array.isArray(data.snapshot)) {
        const old = new Map(data.snapshot.map((s) => [this.grid.idx(s.x, s.y), s]));
        for (const ev of E.evaluateAll(this.rules, this.grid, this.seed)) {
          const o = old.get(this.grid.idx(ev.x, ev.y));
          if (!o) continue;
          if (o.tileId !== ev.tileId || o.rot !== ev.rot || o.variantId !== ev.variantId) {
            warnings.push({
              x: ev.x, y: ev.y, terrain: ev.terrain,
              before: { tileId: o.tileId, rot: o.rot, variantId: o.variantId },
              after: { tileId: ev.tileId, rot: ev.rot, variantId: ev.variantId },
            });
          }
        }
      }
      return { oldRuleVersion: data.ruleVersion, currentRuleVersion: this.rules._version, sameVersion, warnings };
    },

    /* 导出明确的图块编号及方向 */
    exportTileTable() {
      const lines = ['x,y,terrain,tileId,rotDeg,variantId,cat,shape,missing'];
      for (let y = 0; y < this.grid.h; y++) {
        for (let x = 0; x < this.grid.w; x++) {
          const ev = this.evalCache.get(this.grid.idx(x, y));
          if (!ev) continue;
          lines.push([
            x, y, ev.terrain,
            ev.tileId == null ? '' : ev.tileId,
            ev.rotDeg,
            ev.variantId || '',
            ev.cat || (ev.hit.kind === 'custom' ? 'custom' : ''),
            ev.shape == null ? '' : ev.shape,
            ev.missing ? '1' : '0',
          ].join(','));
        }
      }
      return lines.join('\n');
    },
  };

  global.TileApp = App;
})(typeof window !== 'undefined' ? window : globalThis);
