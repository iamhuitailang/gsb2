/*
 * 自动铺地块规则引擎（纯逻辑，无 DOM 依赖，可在 Node 中直接测试）
 *
 * 邻接模型：8 方向掩码（blob / 47-slice 同族模型）
 *   方向位: 0=N 1=E 2=S 3=W 4=NE 5=SE 6=SW 7=NW
 *   掩码某位置 1 表示该邻居与本格属于同一地表。
 * 256 种邻接掩码按"旋转等价类"归并为若干规范图块(shape)，
 * 每个规范图块记录：类别(cat)、规范掩码(canonMask)、需要顺时针旋转的次数(rot)。
 */
(function (global) {
  'use strict';

  const DIR_NAMES = ['N', 'E', 'S', 'W', 'NE', 'SE', 'SW', 'NW'];
  const DIR_NAMES_CN = ['北', '东', '南', '西', '东北', '东南', '西南', '西北'];
  const DX = [0, 1, 0, -1, 1, 1, -1, -1];
  const DY = [-1, 0, 1, 0, -1, 1, 1, -1];
  const CARDINALS = [0, 1, 2, 3];
  // 斜向方向 -> 与其相接的两个正向 [逆时针侧, 顺时针侧]
  const DIAG_CARD = { 4: [1, 0], 5: [2, 1], 6: [3, 2], 7: [0, 3] };

  const CAT_INFO = {
    isolated:  { label: '孤立块', n: 0 },
    edge:      { label: '边（单接）', n: 1 },
    outer:     { label: '外角（邻接两边）', n: 2 },
    connector: { label: '连接（对边贯通）', n: 2 },
    inner:     { label: '内角（三接）', n: 3 },
    interior:  { label: '内部（四接）', n: 4 },
  };
  const CAT_ORDER = ['isolated', 'edge', 'outer', 'connector', 'inner', 'interior'];

  function popcount(v) {
    v = v - ((v >> 1) & 0x5555);
    v = (v & 0x3333) + ((v >> 2) & 0x3333);
    return ((v + (v >> 4)) & 0x0f0f) % 255;
  }

  function rotDir(d, r) {
    r = ((r % 4) + 4) % 4;
    if (d < 4) return (d + r) % 4;
    return 4 + (((d - 4) + r) % 4);
  }

  function rotateMask(mask, r) {
    let out = 0;
    for (let i = 0; i < 8; i++) {
      if (mask & (1 << i)) out |= 1 << rotDir(i, r);
    }
    return out;
  }

  function isAdjacentPair(card) {
    const bits = CARDINALS.filter((d) => card & (1 << d));
    return ((bits[1] - bits[0] + 4) % 4) !== 2;
  }

  /*
   * "无关斜向"：某斜向两侧的两个正向都为同类时，该斜向无论取什么都不改变
   * 图块形态（边缘已被两个正向完整覆盖）。剥离后，剩下的位全部是相关位。
   */
  function stripIrrelevantDiag(mask) {
    let out = mask & 0x0f;
    for (const d of [4, 5, 6, 7]) {
      const [a, b] = DIAG_CARD[d];
      const bothSame = (mask & (1 << a)) && (mask & (1 << b));
      if (!bothSame && (mask & (1 << d))) out |= 1 << d;
    }
    return out;
  }

  /*
   * 规范帧朝向（只看正向位）：
   *   edge      唯一正向 = N
   *   outer     两个正向 = N,E
   *   connector 两个正向 = E,W
   *   inner     缺失正向 = N（即 E,S,W）
   * 形态 key = 剥离无关斜向后的规范帧掩码本身，天然区分所有相关斜向组合。
   */
  const REF_CARD = { isolated: 0x0, edge: 0x1, outer: 0x3, connector: 0xa, inner: 0xe, interior: 0xf };

  function canonicalize(mask) {
    const n = popcount(mask & 0x0f);
    const cat = n === 0 ? 'isolated'
      : n === 1 ? 'edge'
      : n === 2 ? (isAdjacentPair(mask & 0x0f) ? 'outer' : 'connector')
      : n === 3 ? 'inner' : 'interior';

    let best = null;
    for (let r = 0; r < 4; r++) {
      const rotated = rotateMask(mask, r);
      const card = rotated & 0x0f;
      const isRef = (cat === 'interior' || cat === 'isolated') || card === REF_CARD[cat];
      const key = stripIrrelevantDiag(rotated);
      // 非规范朝向加惩罚，保证旋转对称的形态也能稳定选出同一帧
      const scored = (isRef ? 0 : 256) + key;
      if (!best || scored < best.scored) best = { cat, key, rot: r, scored };
    }
    // canonMask 已剥离无关斜向：它只描述真正影响外观的位，
    // 原掩码 = 规范帧反向旋转 + 任意无关斜向取值。
    return { cat, key: best.key, rot: best.rot, canonMask: best.key };
  }

  /* 扫描全部 256 种掩码，建立规范图块注册表 */
  function buildShapeRegistry() {
    const groups = {}; // cat -> Map(key -> {canonMask, masks})
    for (let mask = 0; mask < 256; mask++) {
      const c = canonicalize(mask);
      if (!groups[c.cat]) groups[c.cat] = new Map();
      if (!groups[c.cat].has(c.key)) {
        groups[c.cat].set(c.key, { cat: c.cat, key: c.key, canonMask: c.key, masks: [] });
      }
      const g = groups[c.cat].get(c.key);
      g.masks.push(mask);
      // 同组内：剥离无关斜向并旋回规范帧后必须完全一致
      if (rotateMask(stripIrrelevantDiag(mask), c.rot) !== g.canonMask) {
        throw new Error('规范掩码不一致: ' + mask);
      }
      // 正向位必须是该类别的规范朝向
      if ((g.canonMask & 0x0f) !== REF_CARD[c.cat]) {
        throw new Error('规范朝向错误: ' + mask);
      }
    }
    const shapes = {};
    const list = [];
    for (const cat of CAT_ORDER) {
      shapes[cat] = [];
      const keys = [...groups[cat].keys()].sort((a, b) => a - b);
      keys.forEach((key, shapeIdx) => {
        const g = groups[cat].get(key);
        const orientations = new Set();
        for (let r = 0; r < 4; r++) orientations.add(rotateMask(g.canonMask, r));
        const rec = {
          cat,
          shape: shapeIdx,
          key,
          canonMask: g.canonMask,
          masks: g.masks,
          orientationCount: orientations.size,
        };
        shapes[cat].push(rec);
        list.push(rec);
      });
    }
    return { shapes, list };
  }

  const REGISTRY = buildShapeRegistry();

  function lookupShape(cat, key) {
    return REGISTRY.shapes[cat].find((s) => s.key === key);
  }

  /* ---------------- 网格 ---------------- */

  class Grid {
    constructor(w, h, cells) {
      this.w = w;
      this.h = h;
      this.cells = cells || new Array(w * h).fill(null);
    }
    idx(x, y) { return y * this.w + x; }
    inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
    get(x, y) {
      if (!this.inBounds(x, y)) return null;
      return this.cells[this.idx(x, y)];
    }
    set(x, y, t) {
      if (this.inBounds(x, y)) this.cells[this.idx(x, y)] = t;
    }
    clone() {
      return new Grid(this.w, this.h, this.cells.slice());
    }
    static fromJSON(data) {
      const g = new Grid(data.w, data.h);
      data.cells.forEach((t, i) => { g.cells[i] = t || null; });
      return g;
    }
  }

  function neighborMask(grid, x, y, terrain) {
    let mask = 0;
    for (let d = 0; d < 8; d++) {
      if (grid.get(x + DX[d], y + DY[d]) === terrain) mask |= 1 << d;
    }
    return mask;
  }

  /* ---------------- 随机（固定种子可复现） ---------------- */

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function cellRandom(seed, x, y, salt) {
    return mulberry32(fnv1a(String(seed)) ^ Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca77) ^ (salt || 0));
  }

  /* ---------------- 规则匹配 ---------------- */

  // match: 长度 8 的数组，1=要求同类 0=要求非同类 -1=通配
  function ruleMatches(match, mask) {
    for (let d = 0; d < 8; d++) {
      if (match[d] === -1 || match[d] === undefined) continue;
      const bit = (mask >> d) & 1;
      if (match[d] !== bit) return false;
    }
    return true;
  }

  function emptyRuleset() {
    return {
      format: 'tile-rules/v1',
      terrains: [],
      // tiles[terrainId][cat][shape] = { tileId:number|null, variantIds:string[] }
      tiles: {},
      customRules: [],
      nextCustomRuleId: 1,
    };
  }

  function ensureTerrainSlots(rules, terrainId) {
    if (!rules.tiles[terrainId]) {
      const slots = {};
      for (const cat of CAT_ORDER) {
        slots[cat] = REGISTRY.shapes[cat].map(() => ({ tileId: null, variantIds: [] }));
      }
      rules.tiles[terrainId] = slots;
    }
  }

  function ruleVersion(rules) {
    const payload = {
      terrains: rules.terrains,
      tiles: rules.tiles,
      customRules: rules.customRules,
    };
    return 'rv-' + fnv1a(JSON.stringify(payload)).toString(16).padStart(8, '0');
  }

  /*
   * 评估单格。返回值包含检查器需要的全部调试信息。
   */
  function evaluateCell(rules, grid, x, y, seed) {
    const terrain = grid.get(x, y);
    const base = { x, y, terrain, empty: !terrain };
    if (!terrain) return base;

    const neighbors = {};
    for (let d = 0; d < 8; d++) {
      neighbors[d] = grid.get(x + DX[d], y + DY[d]);
    }
    const mask = neighborMask(grid, x, y, terrain);
    const canon = canonicalize(mask);

    let cat = canon.cat;
    let shapeIdx = lookupShape(cat, canon.key).shape;
    let rot = canon.rot;
    let hit = { kind: 'auto', cat, shape: shapeIdx, key: canon.key };
    let conflictRuleIds = [];
    let tileId = null;
    let variantIds = [];

    const matching = rules.customRules
      .filter((r) => r.terrain === terrain && ruleMatches(r.match, mask))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

    if (matching.length) {
      const topPriority = matching[0].priority;
      const top = matching.filter((r) => r.priority === topPriority);
      if (top.length > 1) conflictRuleIds = top.map((r) => r.id);
      const r = top[0];
      hit = { kind: 'custom', ruleId: r.id, priority: r.priority, allMatching: matching.map((m) => m.id) };
      tileId = r.tileId;
      rot = ((r.rot || 0) % 4 + 4) % 4;
      if (r.variantIds) variantIds = r.variantIds.slice();
      cat = null; shapeIdx = null;
    } else {
      ensureTerrainSlots(rules, terrain);
      const slot = rules.tiles[terrain][cat][shapeIdx];
      if (slot && slot.tileId != null) {
        tileId = slot.tileId;
        variantIds = (slot.variantIds || []).slice();
      }
    }

    const missing = tileId == null;
    let variantId = null;
    if (!missing) {
      const rng = cellRandom(seed, x, y, fnv1a(tileId + '|' + (rules._version || ruleVersion(rules))));
      if (variantIds.length) variantId = variantIds[Math.floor(rng() * variantIds.length)];
    }

    return {
      ...base,
      mask,
      neighbors,
      canonMask: canon.canonMask,
      cat,
      shape: shapeIdx,
      rot,
      rotDeg: rot * 90,
      hit,
      conflictRuleIds,
      missing,
      tileId,
      variantId,
    };
  }

  /* 全图评估（用于扫描缺项/冲突和保存快照） */
  function evaluateAll(rules, grid, seed) {
    const out = [];
    for (let y = 0; y < grid.h; y++) {
      for (let x = 0; x < grid.w; x++) {
        if (grid.get(x, y)) out.push(evaluateCell(rules, grid, x, y, seed));
      }
    }
    return out;
  }

  /* 洪水填充：返回与 (x,y) 同地表的连通格集合 */
  function floodFill(grid, x, y) {
    const target = grid.get(x, y);
    const seen = new Set();
    if (target == null) return seen;
    const queue = [[x, y]];
    seen.add(grid.idx(x, y));
    while (queue.length) {
      const [cx, cy] = queue.pop();
      for (const d of CARDINALS) {
        const nx = cx + DX[d], ny = cy + DY[d];
        if (!grid.inBounds(nx, ny)) continue;
        const k = grid.idx(nx, ny);
        if (seen.has(k)) continue;
        if (grid.get(nx, ny) !== target) continue;
        seen.add(k);
        queue.push([nx, ny]);
      }
    }
    return seen;
  }

  /* 编辑后真正受影响的格：被改格本身 + 其 8 邻居（只有它们的掩码可能变化） */
  function affectedCells(grid, changed) {
    const set = new Set();
    for (const [x, y] of changed) {
      for (let d = -1; d <= 1; d++) {
        for (let e = -1; e <= 1; e++) {
          const nx = x + d, ny = y + e;
          if (grid.inBounds(nx, ny)) set.add(grid.idx(nx, ny));
        }
      }
    }
    return set;
  }

  global.TileEngine = {
    DIR_NAMES, DIR_NAMES_CN, DX, DY, CARDINALS, DIAG_CARD,
    CAT_INFO, CAT_ORDER,
    rotateMask, canonicalize, popcount,
    registry: REGISTRY,
    Grid, neighborMask,
    fnv1a, cellRandom,
    ruleMatches, emptyRuleset, ensureTerrainSlots, ruleVersion,
    evaluateCell, evaluateAll, floodFill, affectedCells,
  };
})(typeof window !== 'undefined' ? window : globalThis);
