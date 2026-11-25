/*
 * 地牢地图生成器（UMD）
 *
 * 思路：
 *  1. 预检规则（rules.validateRules），有错直接返回规则冲突
 *  2. 初始化占用网格；若存在锁定房间，先落位并校验合法性
 *  3. 从起点开始，沿"空闲端口"回溯扩展：每次选一个端口 + 一个合法
 *     （类型/尺寸/端口偏移/网格/不重叠/相邻规则）的房间放下去，
 *     主对接端口在放置时显式连接，其余对齐端口顺手连接
 *  4. 先满足所有类型的 min 数量，再尽力填满 maxRooms 并消化空闲端口
 *  5. 节点预算耗尽仍未满足 min -> 返回结构化冲突（哪条规则挡住了多少次、
 *     哪些类型数量不够），而不是笼统的"生成失败"
 *
 * 同一种子 + 同一规则 + 同一锁定集合 => 逐字节稳定的结果。
 */
(function (root, factory) {
  const deps = factory(
    typeof require === 'function' ? require('./rng') : root.DungeonRNG,
    typeof require === 'function' ? require('./rules') : root.DungeonRules
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = deps;
  else root.DungeonGenerator = deps;
})(typeof self !== 'undefined' ? self : this, function (rngMod, rulesMod) {
  'use strict';

  const { OPPOSITE, getType, canAdjacent, validateRules } = rulesMod;
  const DEFAULT_BUDGET = 100000;

  /** 计算端口在网格上的世界坐标（端口位于房间外侧那一个格子） */
  function portWorldCell(room, port) {
    const { x, y, w, h } = room;
    const o = port.offset;
    switch (port.dir) {
      case 'n': return { x: x + o, y: y - 1 };
      case 's': return { x: x + o, y: y + h };
      case 'e': return { x: x + w, y: y + o };
      case 'w': return { x: x - 1, y: y + o };
      default: throw new Error('bad dir ' + port.dir);
    }
  }

  /**
   * 根据宿主端口、新房间对接侧端口偏移，反推新房间左上角坐标。
   * 约束：两个端口的"世界格"（房间外侧那格）必须是同一格。
   * 世界格规则：n=(x+o, y-1) s=(x+o, y+h) e=(x+w, y+o) w=(x-1, y+o)
   */
  function anchorFor(hostRoom, hostPort, size, newPortOffset) {
    const [w, h] = size;
    const cell = portWorldCell(hostRoom, hostPort);
    switch (hostPort.dir) {
      // 新房在北侧，对接端口朝南 s：cell.y = newY + h，cell.x = newX + no
      case 'n': return { x: cell.x - newPortOffset, y: cell.y - h };
      // 新房在南侧，对接端口朝北 n：cell.y = newY - 1 => newY = cell.y + 1
      case 's': return { x: cell.x - newPortOffset, y: cell.y + 1 };
      // 新房在东侧，对接端口朝西 w：cell.x = newX - 1 => newX = cell.x + 1
      case 'e': return { x: cell.x + 1, y: cell.y - newPortOffset };
      // 新房在西侧，对接端口朝东 e：cell.x = newX + w => newX = cell.x - w
      case 'w': return { x: cell.x - w, y: cell.y - newPortOffset };
      default: throw new Error('bad dir');
    }
  }

  function makeContext(rules, seed, budget) {
    const rng = rngMod.makeRng(seed);
    const W = rules.grid.width;
    const H = rules.grid.height;
    const occupancy = Array.from({ length: H }, () => new Array(W).fill(null));
    const ctx = {
      rules,
      rng,
      W,
      H,
      occupancy,
      rooms: [],
      edges: [],
      counts: {},
      portSeq: 0,
      roomSeq: 0,
      nodeVisits: 0,
      budget,
      conflicts: new Map(), // key -> {code, message, detail, count}
    };
    for (const t of rules.roomTypes) ctx.counts[t.id] = 0;
    return ctx;
  }

  function bumpConflict(ctx, code, message, detail) {
    const key = code + '|' + JSON.stringify(detail || {});
    const c = ctx.conflicts.get(key);
    if (c) c.count += 1;
    else ctx.conflicts.set(key, { code, message, detail: detail || null, count: 1 });
  }

  function inBounds(ctx, x, y, w, h) {
    return x >= 0 && y >= 0 && x + w <= ctx.W && y + h <= ctx.H;
  }

  function areaFree(ctx, x, y, w, h) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        if (ctx.occupancy[yy][xx] !== null) return false;
      }
    }
    return true;
  }

  function stamp(ctx, room, value) {
    for (let yy = room.y; yy < room.y + room.h; yy++) {
      for (let xx = room.x; xx < room.x + room.w; xx++) {
        ctx.occupancy[yy][xx] = value;
      }
    }
  }

  /** 实例化一个类型的端口列表（偏移来自类型定义），返回前记录起始序号便于回滚 */
  function instantiatePorts(ctx, roomId, typeDef) {
    const ports = [];
    for (const dir of rulesMod.DIRS) {
      const offsets = (typeDef.ports && typeDef.ports[dir]) || [];
      for (const offset of offsets) {
        ctx.portSeq += 1;
        ports.push({ id: 'p' + ctx.portSeq, dir, offset, roomId, connects: null });
      }
    }
    return ports;
  }

  function connectPorts(ctx, pa, pb) {
    pa.connects = pb.id;
    pb.connects = pa.id;
    ctx.edges.push({ a: pa.id, b: pb.id });
  }

  function findPort(ctx, portId) {
    for (const r of ctx.rooms) {
      const p = r.ports.find((pp) => pp.id === portId);
      if (p) return p;
    }
    return null;
  }

  function findRoom(ctx, roomId) {
    return ctx.rooms.find((r) => r.id === roomId) || null;
  }

  /**
   * 判断格子 (cx, cy) 是否位于房间某一侧的边界条带上。
   * 只有边界格才能作为该侧端口的世界格，落在房间内部的占用格不算对接。
   */
  function isBorderCell(room, dir, cx, cy) {
    switch (dir) {
      case 'n': return cy === room.y - 1 && cx >= room.x && cx < room.x + room.w;
      case 's': return cy === room.y + room.h && cx >= room.x && cx < room.x + room.w;
      case 'e': return cx === room.x + room.w && cy >= room.y && cy < room.y + room.h;
      case 'w': return cx === room.x - 1 && cy >= room.y && cy < room.y + room.h;
      default: return false;
    }
  }

  /**
   * 放置房间并显式建立主连接。
   * @param mainPort 宿主的空闲端口
   * @param newPortOffset 本次候选选中的、新房间对接侧端口的偏移
   * @return {room, joined:[portPair...]}，joined 含主连接与顺手连接，供回溯回滚
   */
  function placeRoom(ctx, typeDef, size, anchor, locked, mainPort, newPortOffset) {
    ctx.roomSeq += 1;
    const id = 'r' + ctx.roomSeq;
    const room = {
      id,
      type: typeDef.id,
      x: anchor.x,
      y: anchor.y,
      w: size[0],
      h: size[1],
      locked: !!locked,
      ports: instantiatePorts(ctx, id, typeDef),
    };
    stamp(ctx, room, id);
    ctx.rooms.push(room);
    ctx.counts[typeDef.id] += 1;

    const joined = [];
    if (mainPort) {
      // 显式主连接：必须用候选选中的那个端口（偏移 newPortOffset），不能按宿主偏移猜
      const faceDir = OPPOSITE[mainPort.dir];
      const newPort = room.ports.find((p) => p.dir === faceDir && p.offset === newPortOffset && !p.connects);
      const cellOk = newPort && (() => {
        const c = portWorldCell(room, newPort);
        const hc = portWorldCell(findRoom(ctx, mainPort.roomId), mainPort);
        return c.x === hc.x && c.y === hc.y;
      })();
      if (newPort && cellOk && !mainPort.connects) {
        connectPorts(ctx, newPort, mainPort);
        joined.push([newPort, mainPort]);
      }
    }
    // 顺手连接：与其他已有房间对齐且双方空闲的端口
    for (const np of room.ports) {
      if (np.connects) continue;
      const cell = portWorldCell(room, np);
      if (cell.x < 0 || cell.y < 0 || cell.x >= ctx.W || cell.y >= ctx.H) continue;
      const neighborId = ctx.occupancy[cell.y][cell.x];
      if (!neighborId || neighborId === room.id) continue;
      const neighbor = findRoom(ctx, neighborId);
      if (!neighbor) continue;
      const wantDir = OPPOSITE[np.dir];
      if (!isBorderCell(neighbor, wantDir, cell.x, cell.y)) continue;
      const match = neighbor.ports.find(
        (op) => !op.connects && op.dir === wantDir &&
          portWorldCell(neighbor, op).x === cell.x && portWorldCell(neighbor, op).y === cell.y
      );
      if (match) {
        connectPorts(ctx, np, match);
        joined.push([np, match]);
      }
    }
    return { room, joined };
  }

  /** 回溯：断开连接、腾空网格、弹出房间，并回滚计数器 */
  function removeRoom(ctx, placed) {
    const { room, joined } = placed;
    for (const [a, b] of joined) {
      a.connects = null;
      b.connects = null;
    }
    ctx.edges = ctx.edges.filter((e) => !joined.some(([a, b]) =>
      (e.a === a.id && e.b === b.id) || (e.a === b.id && e.b === a.id)));
    stamp(ctx, room, null);
    ctx.rooms.pop();
    ctx.counts[room.type] -= 1;
    ctx.portSeq -= room.ports.length;
    ctx.roomSeq -= 1;
  }

  /** 枚举从某个空闲端口出发的全部合法落位方案（已做几何与规则检查） */
  function enumerateCandidates(ctx, port, hostRoom) {
    const out = [];
    const faceDir = OPPOSITE[port.dir]; // 新房间用于对接的一侧
    for (const typeDef of ctx.rules.roomTypes) {
      if ((ctx.counts[typeDef.id] || 0) >= (typeDef.max || 0)) continue;
      if (!canAdjacent(ctx.rules, hostRoom.type, typeDef.id)) {
        bumpConflict(ctx, 'ADJACENCY_DENIED', `相邻规则禁止 "${hostRoom.type}" 与 "${typeDef.id}" 相邻`, { a: hostRoom.type, b: typeDef.id });
        continue;
      }
      const sizes = ctx.rng.shuffle(typeDef.sizes);
      for (const size of sizes) {
        const offsets = ((typeDef.ports && typeDef.ports[faceDir]) || []).slice();
        for (const offset of ctx.rng.shuffle(offsets)) {
          const anchor = anchorFor(hostRoom, port, size, offset);
          if (!inBounds(ctx, anchor.x, anchor.y, size[0], size[1])) {
            bumpConflict(ctx, 'OUT_OF_BOUNDS', `房间 "${typeDef.id}"（${size[0]}x${size[1]}）从端口 ${port.id} 扩展会超出网格`, { type: typeDef.id, port: port.id });
            continue;
          }
          if (!areaFree(ctx, anchor.x, anchor.y, size[0], size[1])) {
            bumpConflict(ctx, 'OVERLAP', `房间 "${typeDef.id}" 落在 (${anchor.x},${anchor.y}) 与已有房间重叠`, { type: typeDef.id, x: anchor.x, y: anchor.y });
            continue;
          }
          // 主连接偏移必须与宿主端口一致（anchor 已据此计算，这里再确认类型定义里确实有该端口）
          out.push({ typeDef, size, anchor, offset });
        }
      }
    }
    // 未达 min 的类型优先
    out.sort((a, b) => {
      const ga = Math.max(0, (a.typeDef.min || 0) - (ctx.counts[a.typeDef.id] || 0));
      const gb = Math.max(0, (b.typeDef.min || 0) - (ctx.counts[b.typeDef.id] || 0));
      return gb - ga;
    });
    return out;
  }

  function allMinsMet(ctx) {
    return ctx.rules.roomTypes.every((t) => (ctx.counts[t.id] || 0) >= (t.min || 0));
  }

  function freePorts(ctx) {
    const list = [];
    for (const r of ctx.rooms) {
      for (const p of r.ports) {
        if (!p.connects) list.push({ port: p, room: r });
      }
    }
    return list;
  }

  /** 阶段一：回溯满足所有 min；每放一个房间都通过主连接挂在已连通的图上 */
  function dfsRequired(ctx) {
    if (allMinsMet(ctx)) return true;
    if (ctx.rooms.length >= ctx.rules.maxRooms) return false;
    if (++ctx.nodeVisits > ctx.budget) return false;

    const ports = ctx.rng.shuffle(freePorts(ctx));
    for (const { port, room } of ports) {
      const candidates = enumerateCandidates(ctx, port, room);
      for (const cand of candidates) {
        const placed = placeRoom(ctx, cand.typeDef, cand.size, cand.anchor, false, port, cand.offset);
        // 主连接必须建立成功，否则该落位无效
        const mainOk = placed.joined.some(([a, b]) => a.id === port.id || b.id === port.id);
        if (mainOk && dfsRequired(ctx)) return true;
        removeRoom(ctx, placed);
      }
    }
    return false;
  }

  /** 估算某落位能新连上几个端口（含主对接），填充期优先选连接多的 */
  function countPotentialJoins(ctx, cand, mainPort) {
    let score = 1; // 主连接
    const fake = { x: cand.anchor.x, y: cand.anchor.y, w: cand.size[0], h: cand.size[1], id: '__probe__', ports: [] };
    for (const d of rulesMod.DIRS) {
      for (const offset of (cand.typeDef.ports && cand.typeDef.ports[d]) || []) {
        fake.ports.push({ id: 'probe', dir: d, offset, connects: null, roomId: '__probe__' });
      }
    }
    for (const np of fake.ports) {
      const cell = portWorldCell(fake, np);
      if (cell.x < 0 || cell.y < 0 || cell.x >= ctx.W || cell.y >= ctx.H) continue;
      const neighborId = ctx.occupancy[cell.y][cell.x];
      if (!neighborId) continue;
      const neighbor = findRoom(ctx, neighborId);
      if (!neighbor) continue;
      const wantDir = OPPOSITE[np.dir];
      if (!isBorderCell(neighbor, wantDir, cell.x, cell.y)) continue;
      if (neighbor.ports.some((op) => !op.connects && op.dir === wantDir)) score += 1;
    }
    return score;
  }

  /** 阶段二：贪心填充，尽量消化空闲端口、逼近 maxRooms（只做有效主连接） */
  function fillRemaining(ctx) {
    while (ctx.rooms.length < ctx.rules.maxRooms) {
      if (++ctx.nodeVisits > ctx.budget) break;
      const ports = freePorts(ctx);
      if (!ports.length) break;
      let best = null;
      for (const { port, room } of ctx.rng.shuffle(ports)) {
        for (const cand of enumerateCandidates(ctx, port, room)) {
          const score = countPotentialJoins(ctx, cand, port);
          if (!best || score > best.score) best = { cand, port, score };
        }
      }
      if (!best) break;
      const { cand, port } = best;
      const placed = placeRoom(ctx, cand.typeDef, cand.size, cand.anchor, false, port, cand.offset);
      const mainOk = placed.joined.some(([a, b]) => a.id === port.id || b.id === port.id);
      if (!mainOk) {
        removeRoom(ctx, placed);
        break; // 理论不会发生；发生说明几何异常，停止填充
      }
    }
  }

  /** 落位锁定房间并做合法性检查，返回错误数组（空 = 通过） */
  function installLocked(ctx, lockedRooms) {
    const errors = [];
    for (const lr of lockedRooms) {
      const typeDef = getType(ctx.rules, lr.type);
      if (!typeDef) {
        errors.push({ code: 'LOCKED_UNKNOWN_TYPE', message: `锁定房间 ${lr.id || ''} 引用了规则中不存在的类型 "${lr.type}"`, detail: { room: lr.id, type: lr.type } });
        continue;
      }
      if (!inBounds(ctx, lr.x, lr.y, lr.w, lr.h)) {
        errors.push({ code: 'LOCKED_OUT_OF_BOUNDS', message: `锁定房间 ${lr.id}（${lr.type}）超出网格边界`, detail: { room: lr.id } });
        continue;
      }
      if (!areaFree(ctx, lr.x, lr.y, lr.w, lr.h)) {
        errors.push({ code: 'LOCKED_OVERLAP', message: `锁定房间 ${lr.id}（${lr.type}）与其他锁定房间重叠`, detail: { room: lr.id } });
        continue;
      }
      // 锁定房间保留外部 id 与端口定义，计数器同步到最大编号
      ctx.roomSeq += 1;
      const room = {
        id: lr.id || ('r' + ctx.roomSeq),
        type: lr.type,
        x: lr.x,
        y: lr.y,
        w: lr.w,
        h: lr.h,
        locked: true,
        ports: (lr.ports || []).map((p) => {
          ctx.portSeq += 1;
          return { id: p.id || ('p' + ctx.portSeq), dir: p.dir, offset: p.offset, roomId: lr.id, connects: p.connects || null };
        }),
      };
      stamp(ctx, room, room.id);
      ctx.rooms.push(room);
      ctx.counts[room.type] = (ctx.counts[room.type] || 0) + 1;
    }
    if (errors.length) return errors;

    // 恢复锁定房间之间的连接并校验几何对齐
    for (const room of ctx.rooms) {
      if (!room.locked) continue;
      for (const np of room.ports) {
        if (!np.connects) continue;
        const other = findPort(ctx, np.connects);
        if (!other) {
          errors.push({ code: 'LOCKED_BROKEN_CONNECTION', message: `锁定房间 ${room.id} 的端口 ${np.id} 指向不存在的端口 ${np.connects}`, detail: { room: room.id, port: np.id } });
          continue;
        }
        const cellA = portWorldCell(room, np);
        const otherRoom = findRoom(ctx, other.roomId);
        const cellB = portWorldCell(otherRoom, other);
        if (cellA.x !== cellB.x || cellA.y !== cellB.y || other.dir !== OPPOSITE[np.dir]) {
          errors.push({ code: 'LOCKED_BROKEN_CONNECTION', message: `锁定连接 ${np.id} <-> ${other.id} 几何上没有对齐`, detail: { port: np.id } });
        }
        if (!ctx.edges.some((e) => (e.a === np.id && e.b === other.id) || (e.b === np.id && e.a === other.id))) {
          ctx.edges.push({ a: np.id, b: other.id });
        }
      }
    }
    // 几何相邻的锁定房间对必须满足相邻规则
    for (let i = 0; i < ctx.rooms.length; i++) {
      for (let j = i + 1; j < ctx.rooms.length; j++) {
        const a = ctx.rooms[i];
        const b = ctx.rooms[j];
        if (shareEdge(a, b) && !canAdjacent(ctx.rules, a.type, b.type)) {
          errors.push({ code: 'LOCKED_ADJACENCY_DENIED', message: `锁定房间 ${a.id}（${a.type}）与 ${b.id}（${b.type}）几何相邻，但相邻规则禁止`, detail: { a: a.id, b: b.id } });
        }
      }
    }
    for (const t of ctx.rules.roomTypes) {
      if ((ctx.counts[t.id] || 0) > (t.max || 0)) {
        errors.push({ code: 'LOCKED_EXCEEDS_MAX', message: `类型 "${t.id}" 已锁定 ${ctx.counts[t.id]} 个，超过 max=${t.max}`, detail: { type: t.id } });
      }
    }
    return errors;
  }

  function shareEdge(a, b) {
    const touchX = a.x === b.x + b.w || b.x === a.x + a.w;
    const overlapY = !(a.y + a.h <= b.y || b.y + b.h <= a.y);
    const touchY = a.y === b.y + b.h || b.y === a.y + a.h;
    const overlapX = !(a.x + a.w <= b.x || b.x + b.w <= a.x);
    return (touchX && overlapY) || (touchY && overlapX);
  }

  function snapshot(ctx, seed) {
    return {
      version: 1,
      rulesName: ctx.rules.name || '',
      seed: typeof seed === 'string' ? seed : String(seed),
      grid: { width: ctx.W, height: ctx.H },
      rooms: JSON.parse(JSON.stringify(ctx.rooms)),
      edges: JSON.parse(JSON.stringify(ctx.edges)),
      generatedAt: new Date(0).toISOString(),
      nodeVisits: ctx.nodeVisits,
    };
  }

  /** 汇总失败冲突：计数器转排序数组，补充未满足的 min 与预算信息 */
  function buildFailure(ctx, seed, extra) {
    const conflicts = [...ctx.conflicts.values()].sort((a, b) => b.count - a.count);
    const missing = ctx.rules.roomTypes
      .filter((t) => (ctx.counts[t.id] || 0) < (t.min || 0))
      .map((t) => ({ type: t.id, need: t.min, have: ctx.counts[t.id] || 0 }));
    if (missing.length) {
      conflicts.unshift({
        code: 'MIN_NOT_MET',
        message: `以下类型未达到最小数量：${missing.map((m) => `${m.type}（需 ${m.need}，有 ${m.have}）`).join('；')}`,
        detail: missing,
        count: 1,
      });
    }
    if (extra) conflicts.unshift(extra);
    if (ctx.nodeVisits >= ctx.budget && !conflicts.some((c) => c.code === 'BUDGET_EXHAUSTED')) {
      conflicts.push({
        code: 'BUDGET_EXHAUSTED',
        message: `回溯节点预算（${ctx.budget}）耗尽：空间/规则组合过于受限，上面的高频冲突就是主要拦路条件`,
        detail: { budget: ctx.budget, nodeVisits: ctx.nodeVisits },
        count: 1,
      });
    }
    return { ok: false, conflicts, partialMap: snapshot(ctx, seed) };
  }

  /** 在网格中随机挑一个不越界、不重叠的位置放置起点 */
  function placeStart(ctx, startType) {
    const positions = [];
    for (const size of startType.sizes) {
      for (let y = 0; y + size[1] <= ctx.H; y++) {
        for (let x = 0; x + size[0] <= ctx.W; x++) {
          positions.push({ size, x, y });
        }
      }
    }
    for (const cand of ctx.rng.shuffle(positions)) {
      if (areaFree(ctx, cand.x, cand.y, cand.size[0], cand.size[1])) {
        placeRoom(ctx, startType, cand.size, { x: cand.x, y: cand.y }, false, null);
        return true;
      }
    }
    return false;
  }

  /**
   * 主入口。
   * @param rules 规则对象
   * @param seed  种子（字符串/数字）
   * @param opts  { lockedRooms, budget }
   * @returns { ok:true, map, warnings } 或 { ok:false, conflicts, partialMap }
   */
  function generate(rules, seed, opts = {}) {
    const ruleIssues = validateRules(rules);
    const hardIssues = ruleIssues.filter((i) => i.severity !== 'warning');
    if (hardIssues.length) {
      return {
        ok: false,
        conflicts: hardIssues.map((i) => ({ code: i.code, message: i.message, detail: null, count: 1 })),
        partialMap: null,
      };
    }
    const ctx = makeContext(rules, seed, opts.budget || DEFAULT_BUDGET);
    const locked = (opts.lockedRooms || []).filter(Boolean);
    const lockedErrors = installLocked(ctx, locked);
    if (lockedErrors.length) {
      return { ok: false, conflicts: lockedErrors, partialMap: snapshot(ctx, seed) };
    }

    const startType = rules.roomTypes.find((t) => t.start);
    const hasStart = ctx.rooms.some((r) => r.type === startType.id);
    if (!hasStart && !placeStart(ctx, startType)) {
      return buildFailure(ctx, seed, {
        code: 'NO_PLACEMENT_FOR_START',
        message: `起点类型 "${startType.id}" 在网格内找不到任何合法位置`,
        detail: { type: startType.id },
        count: 1,
      });
    }

    if (!dfsRequired(ctx)) {
      return buildFailure(ctx, seed, null);
    }
    fillRemaining(ctx);

    const map = snapshot(ctx, seed);
    map.generatedAt = new Date().toISOString();
    return { ok: true, map, warnings: ruleIssues.filter((i) => i.severity === 'warning') };
  }

  return {
    generate,
    portWorldCell,
    anchorFor,
    installLocked,
    DEFAULT_BUDGET,
  };
});
