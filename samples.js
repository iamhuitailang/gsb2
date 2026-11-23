/*
 * 内置样例：双锚桥 / 断后相互托住（平面互锁）/ 并排落入窄槽
 * 每个样例返回 { layout, operations, title, description, expect }
 */
(function (global) {
  'use strict';
  const E = global.DestructEngine || require('./engine.js');
  const { cellKey, edgeKey, buildInterlock, BRICK, ANCHOR } = E;

  // 把“单元表 + 边表”整理成引擎 layout；砖需要稳定 id 用于事件追溯
  function makeLayout(width, height, cellList, edgeList) {
    let brickSeq = 1;
    const cells = cellList.map(([x, y, type, color]) => {
      const out = { key: cellKey(x, y), type, color: color ?? 0 };
      if (type === BRICK) out.id = 'B' + brickSeq++;
      return out;
    });
    let edgeSeq = 1;
    const edges = edgeList.map((pairs) => {
      const [a, b] = pairs;
      return {
        key: edgeKey(cellKey(a[0], a[1]), cellKey(b[0], b[1])),
        id: 'E' + edgeSeq++,
      };
    });
    return { format: 'destruct-grid/1', width, height, cells, edges };
  }

  // ---------- 样例 1：双锚桥 ----------
  function sampleBridge() {
    const W = 11;
    const H = 9;
    const cells = [];
    const edges = [];

    cells.push([1, 1, ANCHOR], [9, 1, ANCHOR]);
    // 桥面 x=2..8
    for (let x = 2; x <= 8; x++) cells.push([x, 1, BRICK, 0]);
    // 两条吊链
    for (const y of [2, 3]) {
      cells.push([3, y, BRICK, 1]);
      cells.push([7, y, BRICK, 1]);
    }
    // 桥面连锚、桥面内连接
    for (let x = 1; x < 9; x++) {
      edges.push([
        [x, 1],
        [x + 1, 1],
      ]);
    }
    // 吊链
    edges.push([[3, 1], [3, 2]], [[3, 2], [3, 3]]);
    edges.push([[7, 1], [7, 2]], [[7, 2], [7, 3]]);

    const layout = makeLayout(W, H, cells, edges);
    const operations = [
      {
        label: '打掉左吊链中段砖（3,2）',
        cells: [cellKey(3, 2)],
        edges: [],
      },
      {
        label: '划断右吊链连接（7,1)-(7,2)',
        cells: [],
        edges: [edgeKey(cellKey(7, 1), cellKey(7, 2))],
      },
    ];
    return {
      id: 'bridge',
      title: '样例一：双锚桥',
      layout,
      operations,
      description:
        '桥面由两座锚共同拉住。第一步拆掉左吊链中段砖，链下段整团坠落而桥面与右链仍被锚挂住；' +
        '第二步只划断一条连接，右链随后掉落。验证“同一次移除先结算、与点选顺序无关”。',
      expect: '两次操作各有一团下落；桥面始终连通双锚不动；最终砖数 = 初始砖数 - 1。',
    };
  }

  // ---------- 样例 2：断后相互托住（平面互锁死锁） ----------
  function sampleInterlock() {
    const W = 13;
    const H = 13;
    const built = buildInterlock(W, H);
    if (!built || !built.immobile) {
      throw new Error('互锁构造失败：画布不足，需放大');
    }

    const cellList = [];
    const edgeList = [];
    for (const c of built.cells) {
      cellList.push([
        E.parseKey(c.key).x,
        E.parseKey(c.key).y,
        BRICK,
        c.side === 'A' ? 2 : 3,
      ]);
    }
    for (const ek of built.edges) {
      const { a, b } = E.parseEdgeKey(ek);
      edgeList.push([[E.parseKey(a).x, E.parseKey(a).y], [E.parseKey(b).x, E.parseKey(b).y]]);
    }

    // 找两团最上方的格
    const topOf = (set) =>
      Array.from(set)
        .map((k) => ({ k, ...E.parseKey(k) }))
        .sort((a, b) => a.y - b.y || a.x - b.x)[0];
    const aTop = topOf(built.setA);
    const bTop = topOf(built.setB);

    // 锚 + 两根销钉：确定性地在画布上找空位，每根销钉直接贴在对应团的顶格上，
    // 再用一条短链把销钉挂到锚。拔掉销钉后两团回到纯互锁状态。
    const occupied = new Set(built.cells.map((c) => c.key));
    const inBounds = (p) => p.x >= 0 && p.y >= 0 && p.x < W && p.y < H;
    const isFree = (p) => inBounds(p) && !occupied.has(cellKey(p.x, p.y));
    const neigh = (p) =>
      [
        { x: p.x, y: p.y - 1 },
        { x: p.x - 1, y: p.y },
        { x: p.x + 1, y: p.y },
        { x: p.x, y: p.y + 1 },
      ].filter(isFree);

    // 销钉：顶格旁边第一个空位
    const placePin = (top) => {
      const pin = neigh(top)[0];
      if (!pin) throw new Error('互锁样例：找不到销钉位');
      occupied.add(cellKey(pin.x, pin.y));
      return pin;
    };
    const pinA = placePin(aTop);
    const pinB = placePin(bTop);

    // 锚：两销钉之外、且与至少一根销钉正交相邻的空位；找不到就放宽到任意空位
    let anchor = null;
    for (const p of [...neigh(pinA), ...neigh(pinB)]) {
      if (isFree(p)) {
        anchor = p;
        break;
      }
    }
    if (!anchor) {
      outer: for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const p = { x, y };
          if (isFree(p)) {
            anchor = p;
            break outer;
          }
        }
    }
    if (!anchor) throw new Error('互锁样例：找不到锚位');
    occupied.add(cellKey(anchor.x, anchor.y));

    // 用 BFS 找“锚 → 销钉”的短链（以已占用格为障碍，终点放行），路径上的格成为挂链砖
    const chainTo = (pin) => {
      const startKey = cellKey(anchor.x, anchor.y);
      const goalKey = cellKey(pin.x, pin.y);
      const blocked = new Set(occupied);
      blocked.delete(goalKey); // 终点销钉本身可抵达
      const q = [[anchor.x, anchor.y]];
      const prev = new Map([[startKey, null]]);
      while (q.length) {
        const [x, y] = q.shift();
        const k = cellKey(x, y);
        if (k === goalKey) {
          const path = [];
          let cur = k;
          while (cur) {
            path.push(cur);
            cur = prev.get(cur);
          }
          return path.reverse().map((kk) => E.parseKey(kk));
        }
        for (const [dx, dy] of [
          [0, -1],
          [-1, 0],
          [1, 0],
          [0, 1],
        ]) {
          const nx = x + dx;
          const ny = y + dy;
          const nk = cellKey(nx, ny);
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (prev.has(nk) || (blocked.has(nk) && nk !== goalKey)) continue;
          prev.set(nk, k);
          q.push([nx, ny]);
        }
      }
      return null;
    };

    cellList.push([anchor.x, anchor.y, ANCHOR]);
    cellList.push([pinA.x, pinA.y, BRICK, 4]);
    cellList.push([pinB.x, pinB.y, BRICK, 4]);
    edgeList.push([[pinA.x, pinA.y], [aTop.x, aTop.y]]);
    edgeList.push([[pinB.x, pinB.y], [bTop.x, bTop.y]]);

    for (const pin of [pinA, pinB]) {
      const path = chainTo(pin);
      if (!path) throw new Error('互锁样例：挂链不可达');
      for (let i = 0; i < path.length - 1; i++) {
        const u = path[i];
        const v = path[i + 1];
        // 路径中间格作为挂链砖（锚与销钉已在 cellList 中）
        if (i > 0 && i < path.length - 2) {
          const k = cellKey(u.x, u.y);
          if (!occupied.has(k)) {
            cellList.push([u.x, u.y, BRICK, 4]);
            occupied.add(k);
          }
        }
        edgeList.push([
          [u.x, u.y],
          [v.x, v.y],
        ]);
      }
    }

    const layout = makeLayout(W, H, cellList, edgeList);
    const operations = [
      {
        label: '同时拔掉两根销钉',
        cells: [cellKey(pinA.x, pinA.y), cellKey(pinB.x, pinB.y)],
        edges: [],
      },
    ];
    return {
      id: 'interlock',
      title: '样例二：断掉后相互托住',
      layout,
      operations,
      description:
        '两团砖在平面内交错咬合，各自单独下移都会被对方挡住。初始由同一座锚经两根销钉挂住；' +
        '一次操作同时拔掉销钉后，两团都失去支撑却都无法下落，产生 mutual-hold（相互托住）事件而非坠落。',
      expect: '出现 mutual-hold 事件、零 fall 事件；两团位置不变、砖数不变。',
    };
  }

  // ---------- 样例 3：并排落入窄槽 ----------
  function sampleSlot() {
    const W = 9;
    const H = 12;
    const cells = [];
    const edges = [];

    // 窄槽：x=3 与 x=5 两列锚墙（y=6..11），槽身为 x=4，地板为隐式 y=12
    for (let y = 6; y <= 11; y++) {
      cells.push([3, y, ANCHOR], [5, y, ANCHOR]);
    }
    // 两团都是槽内纯竖茎，各用一根旁侧销钉挂到锚上；拔掉销钉即整条竖直扎入槽中。
    // 左团 L：竖茎 (4,2..4)，销钉 (3,4) 挂锚 (2,4)
    cells.push([2, 4, ANCHOR]);
    cells.push([3, 4, BRICK, 4]);
    cells.push([4, 2, BRICK, 2], [4, 3, BRICK, 2], [4, 4, BRICK, 2]);
    // 右团 R：竖茎 (4,0..1)，销钉 (5,1) 挂锚 (6,1)
    cells.push([6, 1, ANCHOR]);
    cells.push([5, 1, BRICK, 4]);
    cells.push([4, 0, BRICK, 3], [4, 1, BRICK, 3]);

    // L 挂点与团内边
    edges.push([[2, 4], [3, 4]], [[3, 4], [4, 4]], [[4, 4], [4, 3]], [[4, 3], [4, 2]]);
    // R 挂点与团内边
    edges.push([[6, 1], [5, 1]], [[5, 1], [4, 1]], [[4, 1], [4, 0]]);

    const layout = makeLayout(W, H, cells, edges);
    const operations = [
      {
        label: '同时拔掉两根槽外销钉',
        cells: [cellKey(3, 4), cellKey(5, 1)],
        edges: [],
      },
    ];
    return {
      id: 'slot',
      title: '样例三：并排落入窄槽',
      layout,
      operations,
      description:
        '两团砖都是伸进同一列窄槽的竖茎，各自用槽外一根销钉挂在锚上。一次操作同时拔掉两根销钉，' +
        '两团整体竖直下坠；低位团先移动、高位团争夺同一格时产生带取舍规则的 collision 事件，' +
        '最终五块砖上下叠在槽内，绝不重叠或丢砖。',
      expect: 'fall 事件后出现 collision（含 tieRule 说明）；五砖叠落槽内 y=7..11；砖数 = 初始 - 2。',
    };
  }

  const samples = { bridge: sampleBridge, interlock: sampleInterlock, slot: sampleSlot };

  if (typeof module !== 'undefined' && module.exports) module.exports = samples;
  else global.DestructSamples = samples;
})(typeof globalThis !== 'undefined' ? globalThis : this);
