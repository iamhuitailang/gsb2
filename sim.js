/*
 * sim.js — 传送带机关逐步预演：核心模拟逻辑（无 DOM 依赖，可在 Node 中测试）
 *
 * 每步（tick）语义：
 *   1. 每个方块根据脚下格子提出移动提议（方向格按箭头；分流格按颜色规则；停止格/空地不动）。
 *   2. 争用：多个方块提议同一目标格时，按可配置的争用规则选出唯一赢家，其余落败等待。
 *   3. 链式解算：赢家的目标格在本步末必须为空（空格，或占据者本步也成功移出）。
 *      循环带上若无空位（提议构成闭环），整环判为死锁，谁都不动 —— 同时移动不允许叠方块。
 *   4. 失败分类：waiting（下一步可能恢复，如争用落败、前方方块正在移动）
 *                 stuck（结构性卡死，如环路全满、被停止格阻挡、轨道尽头）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Sim = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const DIRS = {
    N: { dx: 0, dy: -1, arrow: '↑', name: '上' },
    E: { dx: 1, dy: 0, arrow: '→', name: '右' },
    S: { dx: 0, dy: 1, arrow: '↓', name: '下' },
    W: { dx: -1, dy: 0, arrow: '←', name: '左' },
  };
  const DIR_ORDER = ['N', 'E', 'S', 'W'];
  const COLORS = ['red', 'blue', 'green', 'yellow', 'purple'];
  const COLOR_NAMES = { red: '红', blue: '蓝', green: '绿', yellow: '黄', purple: '紫' };
  const CONTENTION_NAMES = {
    dir: '方向优先（上>右>下>左，同向小编号优先）',
    id: '编号小者优先',
    color: '颜色优先（红>蓝>绿>黄>紫，同色小编号优先）',
  };

  const key = (x, y) => x + ',' + y;

  function createGrid(w, h) {
    const g = [];
    for (let y = 0; y < h; y++) {
      const row = [];
      for (let x = 0; x < w; x++) row.push({ type: 'empty' });
      g.push(row);
    }
    return g;
  }

  function defaultRules() {
    return {
      contention: 'dir', // 'dir' | 'id' | 'color'
      splitter: { color: 'red', matchDir: 'E', otherDir: 'S' },
    };
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function pickWinner(ids, rules, proposals, blocksById) {
    const rank = (id) => {
      if (rules.contention === 'dir') return DIR_ORDER.indexOf(proposals.get(id).dir) * 1000 + id;
      if (rules.contention === 'color') return COLORS.indexOf(blocksById.get(id).color) * 1000 + id;
      return id;
    };
    return ids.reduce((a, b) => (rank(b) < rank(a) ? b : a));
  }

  /**
   * 推进一个固定步。直接修改 state.blocks 的位置与 state.tick。
   * @param state {grid, blocks:[{id,color,x,y}], tick}
   * @param rules 见 defaultRules()
   * @returns record 本步记录：{tick, moves, fails, stays, deadlock}
   */
  function computeTick(state, rules) {
    const grid = state.grid, blocks = state.blocks;
    const h = grid.length, w = grid[0].length;
    const blocksById = new Map(blocks.map((b) => [b.id, b]));
    const occ = new Map(); // "x,y" -> blockId（本步开始时的占据情况）
    for (const b of blocks) occ.set(key(b.x, b.y), b.id);

    const proposals = new Map();   // id -> {dir, tx, ty}
    const boundaryFail = new Map(); // id -> {dir, tx, ty} 提议出界/无轨道
    const stays = new Map();        // id -> reason 本步无提议

    // ---- 1. 生成提议 ----
    for (const b of blocks) {
      const cell = grid[b.y][b.x];
      if (!cell || cell.type === 'empty') { stays.set(b.id, '不在传送带上，无动力'); continue; }
      if (cell.type === 'stop') { stays.set(b.id, '停止格：保持不动'); continue; }
      let dir;
      if (cell.type === 'belt') dir = cell.dir;
      else dir = b.color === rules.splitter.color ? rules.splitter.matchDir : rules.splitter.otherDir;
      const tx = b.x + DIRS[dir].dx, ty = b.y + DIRS[dir].dy;
      const tcell = ty >= 0 && ty < h && tx >= 0 && tx < w ? grid[ty][tx] : null;
      if (!tcell || tcell.type === 'empty') { boundaryFail.set(b.id, { dir, tx, ty }); continue; }
      proposals.set(b.id, { dir, tx, ty });
    }

    // ---- 2. 争用：同一目标格只能有一个赢家 ----
    const byTarget = new Map();
    for (const [id, p] of proposals) {
      const k = key(p.tx, p.ty);
      (byTarget.get(k) || byTarget.set(k, []).get(k)).push(id);
    }
    const winners = new Set();
    const loserTo = new Map(); // 落败者 id -> 赢家 id
    for (const ids of byTarget.values()) {
      const win = pickWinner(ids, rules, proposals, blocksById);
      winners.add(win);
      for (const id of ids) if (id !== win) loserTo.set(id, win);
    }

    // ---- 3. 链式解算：目标格本步末必须为空 ----
    const resolved = new Map(); // winnerId -> {ok, reason?, blockedBy?, cycle?}
    function resolveWinner(id, stack) {
      if (resolved.has(id)) return resolved.get(id).ok;
      const p = proposals.get(id);
      const occId = occ.get(key(p.tx, p.ty));
      if (occId === undefined) { resolved.set(id, { ok: true }); return true; }
      if (!winners.has(occId)) {
        // 占据者本步不移出：停止格 / 无提议 / 越界失败 / 争用落败
        const ob = blocksById.get(occId);
        const ocell = grid[ob.y][ob.x];
        const why = ocell && ocell.type === 'stop' ? `#${occId} 停在停止格上`
          : loserTo.has(occId) ? `#${occId} 争用落败未移动`
          : boundaryFail.has(occId) ? `#${occId} 前方无轨道未移动`
          : `#${occId} 本步不移动`;
        resolved.set(id, { ok: false, blockedBy: occId, reason: `目标格 (${p.tx},${p.ty}) 被占据：${why}` });
        return false;
      }
      const idx = stack.indexOf(occId);
      if (idx >= 0) {
        // 提议构成闭环且环上无空位：整环死锁
        const cyc = stack.slice(idx).concat(id);
        const label = cyc.map((c) => '#' + c).join(' → ') + ' → #' + occId;
        for (const cid of cyc) {
          resolved.set(cid, { ok: false, cycle: true, reason: `环路死锁：${label}，循环带全满无空位` });
        }
        return false;
      }
      const ok = resolveWinner(occId, stack.concat(id));
      if (resolved.has(id)) return resolved.get(id).ok; // 可能刚被环路检测标记
      if (ok) { resolved.set(id, { ok: true }); return true; }
      resolved.set(id, { ok: false, blockedBy: occId, reason: `前方 #${occId} 无法移动，连锁等待` });
      return false;
    }
    for (const id of winners) resolveWinner(id, []);

    // ---- 4. 失败分类：waiting（下步可能恢复）vs stuck（结构性卡死）----
    const cls = new Map();
    function classify(id, seen) {
      if (cls.has(id)) return cls.get(id);
      if (seen.has(id)) return 'stuck';
      seen.add(id);
      let c = 'stuck';
      if (loserTo.has(id)) {
        const win = loserTo.get(id);
        const wr = resolved.get(win);
        c = wr && wr.ok ? 'waiting' : classify(win, seen);
      } else {
        const r = resolved.get(id);
        if (r && !r.ok && !r.cycle && r.blockedBy !== undefined) c = classify(r.blockedBy, seen);
      }
      cls.set(id, c);
      return c;
    }

    // ---- 5. 汇总记录并应用移动 ----
    const record = { tick: state.tick + 1, moves: [], fails: [], stays: [], deadlock: false };
    for (const b of blocks) {
      const id = b.id;
      if (stays.has(id)) { record.stays.push({ id, reason: stays.get(id) }); continue; }
      if (boundaryFail.has(id)) {
        const f = boundaryFail.get(id);
        record.fails.push({
          id, cls: 'stuck', dir: f.dir, target: [f.tx, f.ty],
          reason: `提议向${DIRS[f.dir].name}到 (${f.tx},${f.ty})：超出轨道`,
        });
        continue;
      }
      const p = proposals.get(id);
      if (loserTo.has(id)) {
        record.fails.push({
          id, cls: classify(id, new Set()), dir: p.dir, target: [p.tx, p.ty],
          reason: `提议向${DIRS[p.dir].name}到 (${p.tx},${p.ty})：与 #${loserTo.get(id)} 争用同一格，按「${CONTENTION_NAMES[rules.contention]}」落败`,
        });
        continue;
      }
      const r = resolved.get(id);
      if (r && r.ok) {
        record.moves.push({ id, from: [b.x, b.y], to: [p.tx, p.ty], dir: p.dir });
      } else {
        record.fails.push({
          id, cls: r.cycle ? 'stuck' : classify(id, new Set()), dir: p.dir, target: [p.tx, p.ty],
          reason: r.reason,
        });
      }
    }
    for (const m of record.moves) {
      const b = blocksById.get(m.id);
      b.x = m.to[0];
      b.y = m.to[1];
    }
    record.deadlock = proposals.size > 0 && record.moves.length === 0;
    state.tick += 1;
    return record;
  }

  return {
    DIRS, DIR_ORDER, COLORS, COLOR_NAMES, CONTENTION_NAMES,
    key, createGrid, defaultRules, clone, computeTick,
  };
});
