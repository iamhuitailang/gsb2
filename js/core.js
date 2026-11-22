/*
 * core.js — 斜俯视场景遮挡排序的纯逻辑模块（无 DOM 依赖，可在 Node 中测试）
 *
 * 核心概念：
 *  - 地面坐标：物体占的格子 footprint（可跨多格，支持部分重叠）
 *  - 所在高度 base：物体脚底所在的 z 高度
 *  - 参与排序范围 range [lo, hi]：物体在竖直方向上占据的 z 区间
 *  - 两个物体只有「屏幕投影重叠」时才比较；比较先看共格与高度区间，
 *    再看地面方位，任何无法确定或互相穿插的情况都记为冲突并稳定回退。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OcclCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STEP = 0.08; // 路线采样步长（世界单位 = 格）

  function cellKey(x, y) { return x + ',' + y; }
  function round1(v) { return Math.round(v * 1000) / 1000; }

  /* ---------------- 场景 ---------------- */

  function defaultScene() {
    return {
      grid: { cols: 11, rows: 9, cellW: 74, cellH: 38, originX: 470, originY: 96 },
      terrain: {
        deckBottom: 1.0, // 桥板底面
        deckTop: 1.35,   // 桥面（角色在桥上时脚底高度）
        decks: [{
          id: 'bridge', name: '桥',
          cells: [[4, 3], [5, 3], [6, 3], [7, 3]],
        }],
        stairs: [
          { id: 'stairW', name: '西台阶', cells: [[2, 3, 0.67], [3, 3, 1.35]] },
          { id: 'stairE', name: '东台阶', cells: [[8, 3, 0.67]] },
        ],
      },
      props: [
        { id: 'tree',  name: '大树',   cells: [[0, 1]],        base: 0, h: 1.6, color: '#2f7d4f' },
        { id: 'crate', name: '木箱',   cells: [[1, 2]],        base: 0, h: 0.55, color: '#b5814a' },
        { id: 'sign',  name: '告示牌', cells: [[2, 7]],        base: 0, h: 0.9, color: '#8a6d3b' },
        { id: 'pole',  name: '旗杆',   cells: [[7, 1]],        base: 0, h: 2.2, color: '#9aa3ad' },
        { id: 'barrel',name: '木桶',   cells: [[9, 1]],        base: 0, h: 0.7, color: '#7d5a33' },
        { id: 'rock',  name: '石头',   cells: [[10, 4]],       base: 0, h: 0.4, color: '#8b8f96' },
      ],
      hero: { start: { x: 0, y: 7 }, h: 0.9 },
    };
  }

  function defaultRoutes() {
    // 关键点对齐格中心（整数坐标），保证采样经过的格子与桥/台阶占地一致
    return [
      {
        id: 'route-over', name: '过桥路线（上桥）',
        waypoints: [[0, 7], [1, 4], [2, 3], [3, 3], [4, 3], [7, 3], [8, 3], [9, 5], [10, 7]],
      },
      {
        id: 'route-under', name: '钻桥底路线（地面）',
        waypoints: [[0, 7], [3, 6], [4, 3], [7, 3], [8, 5], [10, 7]],
      },
    ];
  }

  /* ---------------- 地形查询 ---------------- */

  function buildTerrainIndex(scene) {
    const deck = new Map(); // key -> {top, bottom, deckId}
    for (const d of scene.terrain.decks) {
      for (const [x, y] of d.cells) deck.set(cellKey(x, y), { top: scene.terrain.deckTop, bottom: scene.terrain.deckBottom, deckId: d.id });
    }
    const stair = new Map(); // key -> top
    for (const s of scene.terrain.stairs) {
      for (const [x, y, top] of s.cells) stair.set(cellKey(x, y), top);
    }
    return { deck, stair };
  }

  // 角色进入格子 (cx,cy) 时的脚底高度与层面
  // floor: 'ground'（地面/桥下）或 'top'（桥面/台阶上方）
  function surfaceAt(cx, cy, floor, scene, idx) {
    idx = idx || buildTerrainIndex(scene);
    const key = cellKey(cx, cy);
    if (idx.stair.has(key)) return { z: idx.stair.get(key), floor: 'top', kind: 'stair' };
    if (idx.deck.has(key)) {
      return floor === 'top'
        ? { z: idx.deck.get(key).top, floor: 'top', kind: 'deck' }
        : { z: 0, floor: 'ground', kind: 'under-deck' };
    }
    return { z: 0, floor: 'ground', kind: 'ground' };
  }

  /* ---------------- 等距投影 ---------------- */

  function iso(x, y, z, g) {
    return {
      x: g.originX + (x - y) * g.cellW / 2,
      y: g.originY + (x + y) * g.cellH / 2 - z * g.cellH * 2,
    };
  }

  // 物体屏幕包围盒（覆盖 footprint 全部格子与 z 区间）
  function screenAABB(obj, scene) {
    const g = scene.grid;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const zs = [obj.lo, obj.hi];
    for (const [cx, cy] of obj.cells) {
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        for (const z of zs) {
          const p = iso(cx + dx, cy + dy, z, g);
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
      }
    }
    return { minX, maxX, minY, maxY };
  }

  function aabbOverlap(a, b) {
    return !(a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY);
  }

  /* ---------------- 渲染对象构造 ---------------- */

  // 把场景（地形 + 道具 + 角色）展开成参与排序的对象列表
  // heroState: {pos:{x,y}, floor, z}
  function buildRenderables(scene, heroState, nextOrd) {
    const t = scene.terrain;
    const out = [];
    let ord = 1;
    const push = (o) => { o.ord = ord++; out.push(o); };

    for (const d of t.decks) {
      push({
        id: d.id, name: d.name, kind: 'bridge',
        cells: d.cells.map(c => [c[0], c[1]]),
        lo: t.deckBottom, hi: t.deckTop,
        color: '#6f8fae',
      });
    }
    for (const s of t.stairs) {
      const hi = Math.max(...s.cells.map(c => c[2])) + 0.05;
      push({
        id: s.id, name: s.name, kind: 'stair',
        cells: s.cells.map(c => [c[0], c[1]]),
        cellTops: new Map(s.cells.map(c => [cellKey(c[0], c[1]), c[2]])),
        lo: 0, hi,
        color: '#9b8b78',
      });
    }
    for (const p of scene.props) {
      push({
        id: p.id, name: p.name, kind: 'prop',
        cells: p.cells.map(c => [c[0], c[1]]),
        lo: p.base, hi: round1(p.base + p.h),
        base: p.base, h: p.h, color: p.color,
      });
    }
    if (heroState) {
      const hx = Math.round(heroState.pos.x), hy = Math.round(heroState.pos.y);
      push({
        id: 'hero', name: '角色', kind: 'hero',
        cells: [[hx, hy]],
        lo: round1(heroState.z), hi: round1(heroState.z + scene.hero.h),
        color: '#d9534f',
      });
    }
    if (nextOrd) nextOrd.value = ord;
    return out;
  }

  /* ---------------- 遮挡排序 ---------------- */

  function extents(obj) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of obj.cells) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { minX, maxX, minY, maxY };
  }

  function sharedCells(a, b) {
    const set = new Set(a.cells.map(c => cellKey(c[0], c[1])));
    return b.cells.filter(c => set.has(cellKey(c[0], c[1])));
  }

  function zOverlap(a, b) {
    return a.lo < b.hi && b.lo < a.hi; // 端点相接不算穿插（脚踩在桥面上）
  }

  // 返回每条约束：before 在后、after 在前（after 盖住 before）
  // conflict: null | {type: 'mutual'|'ambiguous'|'cycle', a, b, detail}
  function computeOrder(scene, renderables) {
    const objs = renderables.slice().sort((p, q) => p.ord - q.ord);
    const ext = new Map(objs.map(o => [o.id, extents(o)]));
    const boxes = new Map(objs.map(o => [o.id, screenAABB(o, scene)]));
    const constraints = [];
    const conflicts = [];
    const adj = new Map(objs.map(o => [o.id, new Set()]));
    const indeg = new Map(objs.map(o => [o.id, 0]));

    const addEdge = (before, after, c) => {
      if (!adj.get(before.id).has(after.id)) {
        adj.get(before.id).add(after.id);
        indeg.set(after.id, indeg.get(after.id) + 1);
      }
      constraints.push(c);
    };

    for (let i = 0; i < objs.length; i++) {
      for (let j = i + 1; j < objs.length; j++) {
        const a = objs[i], b = objs[j];
        if (!aabbOverlap(boxes.get(a.id), boxes.get(b.id))) {
          constraints.push({ a: a.id, b: b.id, type: 'disjoint', text: '屏幕投影不重叠，互不影响' });
          continue;
        }
        const shared = sharedCells(a, b);
        if (shared.length > 0) {
          if (zOverlap(a, b)) {
            // 同一地面坐标且高度区间互相穿插 → 冲突，按 ord 稳定回退
            const [back, front] = a.ord < b.ord ? [a, b] : [b, a];
            conflicts.push({
              type: 'mutual', a: a.id, b: b.id,
              detail: `共占 ${shared.length} 格且 z 区间 [${a.lo},${a.hi}) 与 [${b.lo},${b.hi}) 互相穿插，按创建顺序稳定回退：${back.name} → ${front.name}（后者盖住前者）`,
            });
            addEdge(back, front, { a: a.id, b: b.id, type: 'mutual-tie', conflict: true, text: '高度穿插冲突，按创建顺序回退' });
            continue;
          }
          // 高度区间不相交：高的在前
          if (a.lo >= b.hi) {
            addEdge(b, a, { a: a.id, b: b.id, type: 'z', text: `同地面坐标，${a.name} 位于上方（${b.hi} ≤ ${a.lo}），${a.name} 盖住 ${b.name}` });
          } else {
            addEdge(a, b, { a: a.id, b: b.id, type: 'z', text: `同地面坐标，${b.name} 位于上方（${a.hi} ≤ ${b.lo}），${b.name} 盖住 ${a.name}` });
          }
          continue;
        }
        // 不共格但投影重叠：按地面深度（x+y，越小越靠北/越后）
        // 等距菱形不共格时屏幕重叠必然意味着一个在另一个的北侧方向，深度可定先后；
        // 仅当深度相同（并排斜邻）且投影重叠时才是真正的方位歧义
        const ea = ext.get(a.id), eb = ext.get(b.id);
        const da = ea.minX + ea.minY, db = eb.minX + eb.minY;
        if (da < db) {
          addEdge(a, b, { a: a.id, b: b.id, type: 'north', text: `${a.name} 地面深度更小（${da} < ${db}，更靠北），${b.name} 在南侧前方盖住它` });
        } else if (db < da) {
          addEdge(b, a, { a: a.id, b: b.id, type: 'north', text: `${b.name} 地面深度更小（${db} < ${da}，更靠北），${a.name} 在南侧前方盖住它` });
        } else {
          // 深度相同、投影却重叠 → 方位无法判定，冲突并按 ord 稳定回退
          const [back, front] = a.ord < b.ord ? [a, b] : [b, a];
          conflicts.push({
            type: 'ambiguous', a: a.id, b: b.id,
            detail: `地面深度相同（x+y=${da}）且屏幕投影重叠，无法确定前后，按创建顺序稳定回退：${back.name} → ${front.name}`,
          });
          addEdge(back, front, { a: a.id, b: b.id, type: 'ambiguous-tie', conflict: true, text: '深度相同的方位歧义，按创建顺序回退' });
        }
      }
    }

    // Kahn 拓扑排序，队列按 ord 保证确定性
    const queue = objs.filter(o => indeg.get(o.id) === 0).map(o => o.id);
    const order = [];
    const byId = new Map(objs.map(o => [o.id, o]));
    while (queue.length) {
      queue.sort((u, v) => byId.get(u).ord - byId.get(v).ord);
      const id = queue.shift();
      order.push(id);
      for (const nxt of adj.get(id)) {
        indeg.set(nxt, indeg.get(nxt) - 1);
        if (indeg.get(nxt) === 0) queue.push(nxt);
      }
    }
    if (order.length < objs.length) {
      const done = new Set(order);
      const rest = objs.filter(o => !done.has(o.id)).sort((p, q) => p.ord - q.ord);
      conflicts.push({
        type: 'cycle', a: rest[0].id, b: rest[rest.length - 1].id,
        detail: '约束存在环：' + rest.map(o => o.name).join(' → ') + '，已按创建顺序打断',
      });
      for (const o of rest) order.push(o.id);
    }
    return { order, constraints, conflicts, objects: objs };
  }

  // 选中物体的逐项核对说明
  function explainObject(result, id) {
    const me = result.objects.find(o => o.id === id);
    if (!me) return [];
    const myIndex = result.order.indexOf(id);
    return result.constraints
      .filter(c => c.a === id || c.b === id)
      .map(c => {
        const otherId = c.a === id ? c.b : c.a;
        const other = result.objects.find(o => o.id === otherId);
        const otherIndex = result.order.indexOf(otherId);
        return {
          other: other.name,
          otherId,
          type: c.type,
          conflict: !!c.conflict,
          text: c.text,
          iAmInFront: myIndex > otherIndex,
        };
      });
  }

  /* ---------------- 路线 ---------------- */

  // 按固定步长展开路线，采样完全确定，保证重复播放一致
  function sampleRoute(waypoints) {
    const pts = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const [x1, y1] = waypoints[i], [x2, y2] = waypoints[i + 1];
      const len = Math.hypot(x2 - x1, y2 - y1);
      const n = Math.max(1, Math.round(len / STEP));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        pts.push({ x: round1(x1 + (x2 - x1) * t), y: round1(y1 + (y2 - y1) * t) });
      }
    }
    const last = waypoints[waypoints.length - 1];
    pts.push({ x: last[0], y: last[1] });
    return pts;
  }

  // 进入新格子时的层面切换规则（手动走动与路线模拟共用，保证两条管线一致）
  // floor 为当前层面；进台阶→上，进普通地面格→下，进桥格→保持原层面
  function enterCellFloor(floor, cx, cy, idx) {
    const key = cellKey(cx, cy);
    if (idx.stair.has(key)) return 'top';
    if (idx.deck.has(key)) return floor === 'top' ? 'top' : 'ground';
    return 'ground';
  }

  // 沿采样点推进时的角色层面/高度（纯函数推演，录制与播放共用）
  // 用「越过格子中点」判定进入新格，避免边界上四舍五入抖动导致漏切层面
  function simulateRoute(scene, samples) {
    const idx = buildTerrainIndex(scene);
    let floor = 'ground';
    let curCx = Math.round(samples[0].x), curCy = Math.round(samples[0].y);
    return samples.map(p => {
      const tx = Math.floor(p.x + 0.5), ty = Math.floor(p.y + 0.5);
      if (tx !== curCx || ty !== curCy) {
        curCx = tx; curCy = ty;
        floor = enterCellFloor(floor, curCx, curCy, idx);
      }
      const s = surfaceAt(curCx, curCy, floor, scene, idx);
      return { x: p.x, y: p.y, z: s.z, floor: s.floor, kind: s.kind, cx: curCx, cy: curCy };
    });
  }

  // 路线指纹：每个采样点的绘制顺序（前→后），用于重放一致性核对
  function routeSignature(scene, route) {
    const samples = simulateRoute(scene, sampleRoute(route.waypoints));
    return samples.map(s => {
      const r = computeOrder(scene, buildRenderables(scene, { pos: { x: s.x, y: s.y }, z: s.z, floor: s.floor }));
      return r.order.join('>');
    });
  }

  function diffSignatures(a, b) {
    const mismatches = [];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) mismatches.push(i);
    }
    return mismatches;
  }

  return {
    STEP, cellKey, round1,
    defaultScene, defaultRoutes,
    buildTerrainIndex, surfaceAt, enterCellFloor, iso, screenAABB, aabbOverlap,
    buildRenderables, computeOrder, explainObject,
    sampleRoute, simulateRoute, routeSignature, diffSignatures,
  };
});
