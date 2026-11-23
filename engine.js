/*
 * 二维可破坏结构规则引擎（纯格子，无刚体/粒子）
 *
 * 坐标：x 向右、y 向下，(0,0) 在左上；地板为 y === height 的虚拟行。
 * 单元(cell)：锚(anchor，不可移动)或砖(brick，带颜色与唯一 id)。
 * 连接(edge)：两个正交相邻单元之间的可断边；没有边的相邻砖不属于同一团。
 *
 * 确定性约定（全部可在事件日志中追查）：
 *  - 一次破坏操作里的所有单元/连接先一次性移除，再统一重算连通与下落，
 *    与点选顺序无关。
 *  - 每个下落时刻(tick)，团块按「最低格 y 降序 → 最左 x 升序 → id 升序」处理；
 *    两团争夺同一格时，先处理的团落入，后处理的团在该格产生 collision 事件，
 *    绝不重叠、不丢砖。
 */

(function (global) {
  'use strict';

  const ANCHOR = 'anchor';
  const BRICK = 'brick';

  // ---------- 基础工具 ----------

  function cellKey(x, y) {
    return x + ',' + y;
  }

  function parseKey(key) {
    const i = key.indexOf(',');
    return { x: Number(key.slice(0, i)), y: Number(key.slice(i + 1)) };
  }

  function edgeKey(k1, k2) {
    return k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
  }

  function parseEdgeKey(ek) {
    const i = ek.indexOf('|');
    return { a: ek.slice(0, i), b: ek.slice(i + 1) };
  }

  const NEIGHBORS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  function cloneMap(m) {
    return new Map(m);
  }

  // 32 位 FNV-1a，用于重跑校验
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function stateHash(cells, edges) {
    const c = Array.from(cells.keys()).sort().join(';');
    const e = Array.from(edges.keys()).sort().join(';');
    return fnv1a(c + '#' + e);
  }

  // ---------- 连通性 ----------

  /**
   * 返回 { clusters, supportedKeys, clusterOf }
   * 团 = 由边连接起来的单元集合（孤立单元自身也是一团）。
   * supportedKeys = 沿边可达任意锚的全部单元。
   */
  function computeConnectivity(width, height, cells, edges) {
    const clusterOf = new Map();
    const clusters = [];
    let nextId = 1;

    const allKeys = Array.from(cells.keys()).sort(); // 排序保证 id 分配确定
    for (const start of allKeys) {
      if (clusterOf.has(start)) continue;
      const id = 'C' + nextId++;
      const set = new Set();
      const stack = [start];
      let hasAnchor = false;
      let minX = Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      while (stack.length) {
        const k = stack.pop();
        if (set.has(k)) continue;
        set.add(k);
        clusterOf.set(k, id);
        const cell = cells.get(k);
        if (cell.type === ANCHOR) hasAnchor = true;
        const p = parseKey(k);
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        const { x, y } = p;
        for (const [dx, dy] of NEIGHBORS) {
          const nk = cellKey(x + dx, y + dy);
          if (set.has(nk) || !cells.has(nk)) continue;
          if (edges.has(edgeKey(k, nk))) stack.push(nk);
        }
      }
      clusters.push({ id, cells: set, hasAnchor, minX, minY, maxY });
    }

    const supportedKeys = new Set();
    for (const cl of clusters) {
      if (!cl.hasAnchor) continue;
      for (const k of cl.cells) supportedKeys.add(k);
    }
    return { clusters, supportedKeys, clusterOf };
  }

  // ---------- 引擎 ----------

  class Engine {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.cells = new Map(); // key -> {type, color?, id?}
      this.edges = new Map(); // edgeKey -> {id}
      this.events = []; // 含每事件后的快照
      this._brickSeq = 1;
      this._edgeSeq = 1;
      this._tickSeq = 0;
      this._initialSnapshot = this._snapshot();
    }

    // ----- 编辑期操作 -----

    addCell(x, y, type, color) {
      const k = cellKey(x, y);
      if (this.cells.has(k)) return false;
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
      const cell = { type };
      if (type === BRICK) {
        cell.id = 'B' + this._brickSeq++;
        cell.color = color || 0;
      }
      this.cells.set(k, cell);
      return true;
    }

    removeCellEdit(x, y) {
      const k = cellKey(x, y);
      if (!this.cells.has(k)) return false;
      this.cells.delete(k);
      // 单元消失，其关联边一并删除
      for (const ek of Array.from(this.edges.keys())) {
        const { a, b } = parseEdgeKey(ek);
        if (a === k || b === k) this.edges.delete(ek);
      }
      return true;
    }

    /** 在两个正交相邻且都有单元的格之间加边；返回是否成功 */
    toggleEdge(x1, y1, x2, y2) {
      const k1 = cellKey(x1, y1);
      const k2 = cellKey(x2, y2);
      if (!this.cells.has(k1) || !this.cells.has(k2)) return false;
      const adj = NEIGHBORS.some(
        ([dx, dy]) => x1 + dx === x2 && y1 + dy === y2
      );
      if (!adj) return false;
      const ek = edgeKey(k1, k2);
      if (this.edges.has(ek)) {
        this.edges.delete(ek);
        return false;
      }
      this.edges.set(ek, { id: 'E' + this._edgeSeq++ });
      return true;
    }

    hasEdge(x1, y1, x2, y2) {
      return this.edges.has(edgeKey(cellKey(x1, y1), cellKey(x2, y2)));
    }

    /** 编辑结束：把当前布局固定为初始快照并清空事件 */
    commitLayout() {
      this.events = [];
      this._initialSnapshot = this._snapshot();
    }

    reset() {
      this._restore(this._initialSnapshot);
      this.events = [];
    }

    // ----- 快照 / 撤回 -----

    _snapshot() {
      return {
        width: this.width,
        height: this.height,
        cells: Array.from(this.cells.entries()),
        edges: Array.from(this.edges.entries()),
        brickSeq: this._brickSeq,
        edgeSeq: this._edgeSeq,
        tickSeq: this._tickSeq,
      };
    }

    _restore(snap) {
      this.width = snap.width;
      this.height = snap.height;
      this.cells = new Map(snap.cells.map(([k, v]) => [k, { ...v }]));
      this.edges = new Map(snap.edges.map(([k, v]) => [k, { ...v }]));
      this._brickSeq = snap.brickSeq;
      this._edgeSeq = snap.edgeSeq;
      this._tickSeq = snap.tickSeq || 0;
    }

    /** 回到第 seq 个事件之后（seq = -1 表示回到初始布局） */
    rewind(seq) {
      if (seq < -1 || seq >= this.events.length) return false;
      const snap = seq === -1 ? this._initialSnapshot : this.events[seq].snapshot;
      this._restore(snap);
      this.events = this.events.slice(0, seq + 1);
      return true;
    }

    get initialSnapshot() {
      return this._initialSnapshot;
    }

    // ----- 破坏操作（核心规则） -----

    /**
     * op: { cells: [key...], edges: [edgeKey...], label? }
     * 所有目标先一次性移除，再结算支撑与下落。返回本次产生的事件。
     */
    applyRemoval(op) {
      const before = this.events.length;
      this._tickSeq += 1;
      const opTick = this._tickSeq; // 本次破坏操作的编号
      let subTick = 0;
      const tickAt = () => opTick * 1000 + subTick;

      // 1) 统一收集存在的目标（排序保证确定性，与传入顺序无关）
      const removedCells = [];
      const removedCellSet = new Set();
      for (const k of (op.cells || []).slice().sort()) {
        const cell = this.cells.get(k);
        if (!cell || removedCellSet.has(k)) continue;
        removedCellSet.add(k);
        removedCells.push({ key: k, ...parseKey(k), ...cell });
      }
      const explicitEdges = new Set();
      for (const ek of (op.edges || []).slice().sort()) {
        if (this.edges.has(ek)) explicitEdges.add(ek);
      }
      // 单元被移除时，挂在它上面的边自动断裂
      const autoEdges = new Set();
      for (const ek of this.edges.keys()) {
        const { a, b } = parseEdgeKey(ek);
        if (removedCellSet.has(a) || removedCellSet.has(b)) {
          if (!explicitEdges.has(ek)) autoEdges.add(ek);
        }
      }
      const allRemovedEdges = Array.from(
        new Set([...explicitEdges, ...autoEdges])
      ).sort();

      // 2) 一次性落地移除
      for (const k of removedCellSet) this.cells.delete(k);
      for (const ek of allRemovedEdges) this.edges.delete(ek);

      this._emit('removal', tickAt(), {
        label: op.label || null,
        removedCells,
        explicitEdges: Array.from(explicitEdges).sort(),
        autoEdges: Array.from(autoEdges).sort(),
      });

      // 3) 重算连通团，区分失稳 / 互托 / 稳定
      const info = computeConnectivity(this.width, this.height, this.cells, this.edges);
      const status = this._classifyClusters(info);

      const falling = info.clusters.filter((c) => status.get(c.id) === 'fall');
      // 相互托住只统计无锚团：含锚团（含孤立锚）本就不动，不进事件
      const held = info.clusters.filter(
        (c) => status.get(c.id) === 'held' && !c.hasAnchor
      );

      if (falling.length) {
        this._emit('support-lost', tickAt(), {
          clusters: falling.map((c) => ({
            id: c.id,
            cells: Array.from(c.cells).sort(),
          })),
        });
      }
      if (held.length) {
        this._emit('mutual-hold', tickAt(), {
          clusters: held.map((c) => c.id),
          cells: held.map((c) => ({ id: c.id, cells: Array.from(c.cells).sort() })),
          reason: '各无锚团单独下移都会被对方或地板挡住，形成相互托住的死锁',
        });
      }

      // 4) 逐 tick 下落，直到本步无人可动
      if (falling.length) {
        this._runFall(falling, info, (n) => {
          subTick = n;
          return tickAt();
        });
      }

      // 5) 落定事件 + 校验指纹
      const finalInfo = computeConnectivity(
        this.width,
        this.height,
        this.cells,
        this.edges
      );
      const brickCount = Array.from(this.cells.values()).filter(
        (c) => c.type === BRICK
      ).length;
      this._emit('settle', tickAt(), {
        movingClusters: falling.map((c) => c.id),
        heldClusters: held.map((c) => c.id),
        brickCount,
        clusterCount: finalInfo.clusters.length,
        hash: stateHash(this.cells, this.edges),
      });

      return this.events.slice(before);
    }

    /**
     * 团块三分类：
     *  fall    —— 最终会下移（阻挡者也在下移，则随之一起动）
     *  held    —— 无锚但不会下移（接地/靠稳团，或多团互锁死锁）
     */
    _classifyClusters(info) {
      const status = new Map(); // fall | held | pending
      const byId = new Map(info.clusters.map((c) => [c.id, c]));

      const blockerBelow = (cl) => {
        // 返回该团正下方的阻挡：'ground' | 团 id | null（畅通）
        for (const k of cl.cells) {
          const { x, y } = parseKey(k);
          if (y + 1 >= this.height) return 'ground';
          const below = cellKey(x, y + 1);
          if (!this.cells.has(below) || cl.cells.has(below)) continue;
          const bid = info.clusterOf.get(below);
          if (bid !== cl.id) return bid;
        }
        return null;
      };

      for (const cl of info.clusters) {
        if (cl.hasAnchor) {
          status.set(cl.id, 'held'); // 含锚团本身不动
          continue;
        }
        const b = blockerBelow(cl);
        if (b === null) status.set(cl.id, 'fall');
        else if (b === 'ground') status.set(cl.id, 'held');
        else if (byId.get(b).hasAnchor) status.set(cl.id, 'held'); // 被含锚团挡住
        else status.set(cl.id, 'pending'); // 挡住的是另一个无锚团，待裁决
      }

      // 不动点传播：阻挡者 fall → 我也 fall；阻挡者 held → 我 held；
      // 若剩下的 pending 团互相阻挡成环，则为互托死锁，统一 held。
      let changed = true;
      while (changed) {
        changed = false;
        for (const cl of info.clusters) {
          if (status.get(cl.id) !== 'pending') continue;
          const b = blockerBelow(cl);
          if (b === 'ground' || b === null) continue;
          const bs = status.get(b);
          if (bs === 'fall') {
            status.set(cl.id, 'fall');
            changed = true;
          } else if (bs === 'held') {
            status.set(cl.id, 'held');
            changed = true;
          }
        }
      }
      // 仍为 pending 的无锚团互相阻挡成环 → 相互托住
      for (const cl of info.clusters) {
        if (status.get(cl.id) === 'pending') status.set(cl.id, 'held');
      }
      return status;
    }

    _runFall(falling, info, tickFor) {
      // 复制一份可变团状态；id 沿用连通分析结果
      const live = new Map(
        falling.map((cl) => [
          cl.id,
          { id: cl.id, cells: new Set(cl.cells), settled: false },
        ])
      );

      const order = () =>
        Array.from(live.values())
          .filter((c) => !c.settled)
          .map((c) => {
            let maxY = -Infinity;
            let minX = Infinity;
            for (const k of c.cells) {
              const p = parseKey(k);
              if (p.y > maxY) maxY = p.y;
              if (p.x < minX) minX = p.x;
            }
            return { c, maxY, minX };
          })
          .sort((a, b) => b.maxY - a.maxY || a.minX - b.minX || (a.c.id < b.c.id ? -1 : 1));

      let tick = 0;
      const maxTicks = this.width * this.height * 4; // 安全阀
      while (tick < maxTicks) {
        tick++;
        const tickSeq = tickFor(tick);
        let anyMoved = false;
        for (const { c } of order()) {
          if (c.settled) continue;
          const result = this._tryMoveDown(c, live, tickSeq);
          if (result.moved) anyMoved = true;
          else c.settled = true;
        }
        if (!anyMoved) break;
      }
    }

    /** 尝试把一团整体下移一格；团内形状（含边）保持不变 */
    _tryMoveDown(cluster, live, tickSeq) {
      const destOf = new Map();
      for (const k of cluster.cells) {
        const { x, y } = parseKey(k);
        const nk = cellKey(x, y + 1);
        destOf.set(k, nk);
        if (y + 1 >= this.height) {
          this._emit('collision', tickSeq, {
            clusterId: cluster.id,
            blocker: 'ground',
            contested: { x, y: y + 1 },
            tieRule: null,
          });
          return { moved: false };
        }
      }
      // 目标格不能被本团之外的任何单元占用
      for (const [oldK, newK] of destOf) {
        if (cluster.cells.has(newK)) continue; // 团内纵向相邻，自己落自己的旧格
        const occupier = this.cells.get(newK);
        if (!occupier) continue;
        const owner = this._ownerCluster(newK, live);
        this._emit('collision', tickSeq, {
          clusterId: cluster.id,
          blocker: owner || 'static',
          contested: parseKey(newK),
          tieRule:
            '同 tick 处理顺序：最低格 y 降序 → 最左 x 升序 → 团 id 升序；先到者占格',
        });
        return { moved: false };
      }

      // 移动单元
      const movedCells = new Map();
      for (const [oldK, newK] of destOf) {
        movedCells.set(newK, this.cells.get(oldK));
        this.cells.delete(oldK);
      }
      for (const [k, v] of movedCells) this.cells.set(k, v);

      // 重写团内边的键（边 id 保持不变）
      const oldEdgeKeys = [];
      for (const ek of this.edges.keys()) {
        const { a, b } = parseEdgeKey(ek);
        if (cluster.cells.has(a) && cluster.cells.has(b)) oldEdgeKeys.push(ek);
      }
      for (const ek of oldEdgeKeys) {
        const edge = this.edges.get(ek);
        this.edges.delete(ek);
        const { a, b } = parseEdgeKey(ek);
        this.edges.set(edgeKey(destOf.get(a), destOf.get(b)), edge);
      }

      cluster.cells = new Set(destOf.values());
      this._emit('fall', tickSeq, {
        clusterId: cluster.id,
        cells: Array.from(cluster.cells).sort(),
      });
      return { moved: true };
    }

    _ownerCluster(key, live) {
      for (const c of live.values()) {
        if (c.cells.has(key)) return c.id;
      }
      return null;
    }

    _emit(type, tick, data) {
      const ev = {
        seq: this.events.length,
        tick,
        type,
        data,
        snapshot: this._snapshot(),
        hash: stateHash(this.cells, this.edges),
      };
      this.events.push(ev);
    }

    // ----- 导出 / 重跑校验 -----

    /** 导出初始布局（不含事件） */
    exportLayout() {
      const snap = this._initialSnapshot;
      return {
        format: 'destruct-grid/1',
        width: snap.width,
        height: snap.height,
        cells: snap.cells.map(([key, cell]) => ({ key, ...cell })),
        edges: snap.edges.map(([key, edge]) => ({ key, ...edge })),
      };
    }

    loadLayout(layout) {
      this.width = layout.width;
      this.height = layout.height;
      this.cells = new Map(
        layout.cells.map((c) => [
          c.key,
          {
            type: c.type,
            // 兼容缺 id 的外部存档：加载后统一补号
            id: c.id || (c.type === BRICK ? 'B' + this._brickSeq++ : undefined),
            color: c.color ?? 0,
          },
        ])
      );
      this.edges = new Map(
        layout.edges.map((e) => [e.key, { id: e.id || 'E' + this._edgeSeq++ }])
      );
      this._brickSeq = maxSeq(this.cells, 'B') + 1;
      this._edgeSeq = maxSeqEdges(this.edges) + 1;
      this._tickSeq = 0;
      this.events = [];
      this._initialSnapshot = this._snapshot();
    }
  }

  function maxSeq(cells, prefix) {
    let n = 0;
    for (const c of cells.values()) {
      if (c.id && c.id.startsWith(prefix)) {
        n = Math.max(n, Number(c.id.slice(prefix.length)) || 0);
      }
    }
    return n;
  }
  function maxSeqEdges(edges) {
    let n = 0;
    for (const e of edges.values()) {
      if (e.id && e.id.startsWith('E')) n = Math.max(n, Number(e.id.slice(1)) || 0);
    }
    return n;
  }

  /**
   * 重跑校验：用同一布局与同一组破坏操作跑一个全新引擎，
   * 核对每步指纹、最终砖数与无重叠不变量。
   */
  function verifyScenario(layout, operations) {
    const eng = new Engine(layout.width, layout.height);
    eng.loadLayout(layout);
    const initialBricks = Array.from(eng.cells.values()).filter(
      (c) => c.type === BRICK
    ).length;

    const stepChecks = [];
    let cumulativeRemoved = 0;
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      cumulativeRemoved += (op.cells || []).filter(
        (k) => eng.cells.get(k)?.type === BRICK
      ).length;
      eng.applyRemoval(op);
      // 不变量：一格一单元
      const keys = Array.from(eng.cells.keys());
      const unique = new Set(keys);
      const noOverlap = keys.length === unique.size;
      // 不变量：所有边两端都存在且正交相邻
      let edgesValid = true;
      for (const ek of eng.edges.keys()) {
        const { a, b } = parseEdgeKey(ek);
        if (!eng.cells.has(a) || !eng.cells.has(b)) {
          edgesValid = false;
          break;
        }
        const pa = parseKey(a);
        const pb = parseKey(b);
        if (Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y) !== 1) edgesValid = false;
      }
      const brickCount = Array.from(eng.cells.values()).filter(
        (c) => c.type === BRICK
      ).length;
      // 不变量：砖数严格守恒（只可能被显式移除，不会凭空增减）
      const bricksConserved = brickCount === initialBricks - cumulativeRemoved;
      stepChecks.push({
        operation: i,
        brickCount,
        expectedBrickCount: initialBricks - cumulativeRemoved,
        hash: eng.events[eng.events.length - 1].hash,
        noOverlap,
        edgesValid,
        bricksConserved,
      });
    }
    const finalBricks = Array.from(eng.cells.values()).filter(
      (c) => c.type === BRICK
    ).length;
    const expectedBricks = initialBricks - cumulativeRemoved;
    return {
      ok:
        finalBricks === expectedBricks &&
        stepChecks.every(
          (s) => s.noOverlap && s.edgesValid && s.bricksConserved
        ),
      expectedBricks,
      finalBricks,
      finalHash: eng.events.length ? eng.events[eng.events.length - 1].hash : null,
      stepChecks,
      events: eng.events,
    };
  }

  /**
   * 互锁样例构造器：中央列放四颗交错种子（A 两颗、B 两颗），
   * A 绕左列、B 绕右列分别补出连通路径，形成两条互咬的竖蛇。
   * 任一团单独下移都会被另一团或地板挡住（immobile 断言）。
   */
  function buildInterlock(canvasW, canvasH) {
    const C = Math.floor(canvasW / 2);
    const L = C - 1;
    const R = C + 1;
    const t = Math.floor(canvasH / 2) - 2;

    const seedsA = [
      [C, t],
      [C, t + 2],
    ];
    const seedsB = [
      [C, t + 1],
      [C, t + 3],
    ];
    const setA = new Set(seedsA.map(([x, y]) => cellKey(x, y)));
    const setB = new Set(seedsB.map(([x, y]) => cellKey(x, y)));

    function bfsPath(start, goal, blocked) {
      const q = [start];
      const startKey = cellKey(start[0], start[1]);
      const prev = new Map([[startKey, null]]);
      while (q.length) {
        const [x, y] = q.shift();
        const k = cellKey(x, y);
        if (x === goal[0] && y === goal[1]) {
          const path = [];
          let cur = k;
          while (cur) {
            path.push(cur);
            cur = prev.get(cur);
          }
          return path.reverse();
        }
        for (const [dx, dy] of NEIGHBORS) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= canvasW || ny >= canvasH) continue;
          const nk = cellKey(nx, ny);
          if (prev.has(nk) || blocked.has(nk)) continue;
          prev.set(nk, k);
          q.push([nx, ny]);
        }
      }
      return null;
    }

    const extend = (start, goal, blocked) => {
      const path = bfsPath(start, goal, blocked);
      if (!path) return false;
      for (const k of path) blocked.add(k);
      return path;
    };

    // A：上种子 → 左列 → 下行到 t+3 → 回中央列 t+4
    let blocked = new Set(setB);
    const a1 = extend(seedsA[0], [L, t], blocked);
    const a2 = a1 && extend([L, t], [L, t + 3], blocked);
    const a3 = a2 && extend([L, t + 3], [C, t + 4], blocked);
    if (!a3) return null;
    for (const k of [...a1, ...a2, ...a3]) setA.add(k);

    // B：下种子 → 右列 → 上行到 t → 探到中央列 t-1
    blocked = new Set(setA);
    const b1 = extend(seedsB[1], [R, t + 3], blocked);
    const b2 = b1 && extend([R, t + 3], [R, t], blocked);
    const b3 = b2 && extend([R, t], [C, t - 1], blocked);
    if (!b3) return null;
    for (const k of [...b1, ...b2, ...b3]) setB.add(k);

    const cells = [];
    const edges = [];
    for (const [side, set] of [
      ['A', setA],
      ['B', setB],
    ]) {
      const keys = Array.from(set).sort();
      for (const k of keys) cells.push({ key: k, side });
      for (const k of keys) {
        const { x, y } = parseKey(k);
        for (const [dx, dy] of NEIGHBORS) {
          const nk = cellKey(x + dx, y + dy);
          if (set.has(nk)) {
            const ek = edgeKey(k, nk);
            if (!edges.includes(ek)) edges.push(ek);
          }
        }
      }
    }

    const blockedBy = (set, other) => {
      for (const k of set) {
        const { x, y } = parseKey(k);
        if (y + 1 >= canvasH || other.has(cellKey(x, y + 1))) return true;
      }
      return false;
    };
    const immobile = blockedBy(setA, setB) && blockedBy(setB, setA);
    return { cells, edges, setA, setB, immobile, C, L, R, t };
  }

  const api = {
    ANCHOR,
    BRICK,
    cellKey,
    parseKey,
    edgeKey,
    parseEdgeKey,
    computeConnectivity,
    stateHash,
    buildInterlock,
    verifyScenario,
    Engine,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.DestructEngine = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
