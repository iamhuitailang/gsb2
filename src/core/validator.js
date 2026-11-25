/*
 * 地图校验器（UMD）
 *
 * 检查项：
 *  几何类   越界 / 重叠
 *  结构类   端口悬空引用、连接未对齐、对齐但未连接（潜在漏门）
 *  数量类   各类型数量是否落在 [min, max]
 *  连通类   起点->终点连通、必需房间从起点可达、无孤立房间（与主图不连通）
 *  门口类   孤立门口（端口朝向空地/网格外且没有连接）
 *  锁定类   锁定房间与参考地图相比是否被改动
 *
 * 每个问题带 anchors（roomId / portId / edge），UI 据此在图上高亮。
 */
(function (root, factory) {
  const deps = factory(
    typeof require === 'function' ? require('./rng') : root.DungeonRNG,
    typeof require === 'function' ? require('./rules') : root.DungeonRules,
    typeof require === 'function' ? require('./generator') : root.DungeonGenerator
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = deps;
  else root.DungeonValidator = deps;
})(typeof self !== 'undefined' ? self : this, function (rngMod, rulesMod, genMod) {
  'use strict';

  const { OPPOSITE, getType } = rulesMod;

  function issue(severity, code, message, anchors) {
    return { severity, code, message, anchors: anchors || [] };
  }

  /** 格子是否位于房间某侧边界条带（端口世界格的正确判定） */
  function isBorderCell(room, dir, cx, cy) {
    switch (dir) {
      case 'n': return cy === room.y - 1 && cx >= room.x && cx < room.x + room.w;
      case 's': return cy === room.y + room.h && cx >= room.x && cx < room.x + room.w;
      case 'e': return cx === room.x + room.w && cy >= room.y && cy < room.y + room.h;
      case 'w': return cx === room.x - 1 && cy >= room.y && cy < room.y + room.h;
      default: return false;
    }
  }

  /** 找到端口世界格所在的边界邻居房间及对应方向，没有则 null */
  function neighborAtPort(map, room, port) {
    const cell = genMod.portWorldCell(room, port);
    if (cell.x < 0 || cell.y < 0 || cell.x >= map.grid.width || cell.y >= map.grid.height) return null;
    const wantDir = OPPOSITE[port.dir];
    for (const o of map.rooms) {
      if (o.id === room.id) continue;
      if (isBorderCell(o, wantDir, cell.x, cell.y)) return o;
    }
    return null;
  }

  /** 建立 room / port 索引 */
  function indexMap(map) {
    const roomById = new Map();
    const portById = new Map();
    for (const r of map.rooms) {
      roomById.set(r.id, r);
      for (const p of r.ports || []) portById.set(p.id, p);
    }
    return { roomById, portById };
  }

  /** 邻接表（按房间，边来自端口连接） */
  function buildAdjacency(map, portById) {
    const adj = new Map();
    for (const r of map.rooms) adj.set(r.id, new Set());
    for (const e of map.edges || []) {
      const pa = portById.get(e.a);
      const pb = portById.get(e.b);
      if (!pa || !pb) continue;
      adj.get(pa.roomId)?.add(pb.roomId);
      adj.get(pb.roomId)?.add(pa.roomId);
    }
    return adj;
  }

  function validate(map, rules, lockedReference) {
    const issues = [];
    if (!map || !Array.isArray(map.rooms)) {
      return [issue('error', 'MAP_INVALID', '地图对象不合法')];
    }
    const { roomById, portById } = indexMap(map);

    // ---------- 几何：越界 ----------
    for (const r of map.rooms) {
      if (r.x < 0 || r.y < 0 || r.x + r.w > map.grid.width || r.y + r.h > map.grid.height) {
        issues.push(issue('error', 'ROOM_OUT_OF_BOUNDS', `房间 ${r.id}（${r.type}）超出 ${map.grid.width}x${map.grid.height} 网格`, [{ type: 'room', id: r.id }]));
      }
    }

    // ---------- 几何：重叠 ----------
    for (let i = 0; i < map.rooms.length; i++) {
      for (let j = i + 1; j < map.rooms.length; j++) {
        const a = map.rooms[i];
        const b = map.rooms[j];
        const overlapX = a.x < b.x + b.w && b.x < a.x + a.w;
        const overlapY = a.y < b.y + b.h && b.y < a.y + a.h;
        if (overlapX && overlapY) {
          issues.push(issue('error', 'ROOM_OVERLAP', `房间 ${a.id} 与 ${b.id} 区域重叠`, [{ type: 'room', id: a.id }, { type: 'room', id: b.id }]));
        }
      }
    }

    // ---------- 结构：端口连接完整性与几何对齐 ----------
    const seenEdges = new Set();
    for (const r of map.rooms) {
      const typeDef = getType(rules, r.type);
      for (const p of r.ports || []) {
        if (!p.connects) continue;
        const other = portById.get(p.connects);
        if (!other) {
          issues.push(issue('error', 'PORT_DANGLING', `端口 ${p.id}（房间 ${r.id}）连接的 ${p.connects} 不存在`, [{ type: 'port', id: p.id }, { type: 'room', id: r.id }]));
          continue;
        }
        if (other.connects !== p.id) {
          issues.push(issue('error', 'PORT_NOT_MUTUAL', `端口 ${p.id} -> ${other.id} 不是双向连接`, [{ type: 'port', id: p.id }, { type: 'port', id: other.id }]));
        }
        const edgeKey = [p.id, other.id].sort().join('|');
        if (seenEdges.has(edgeKey)) continue;
        seenEdges.add(edgeKey);
        const cellA = genMod.portWorldCell(r, p);
        const otherRoom = roomById.get(other.roomId);
        if (!otherRoom) continue;
        const cellB = genMod.portWorldCell(otherRoom, other);
        if (cellA.x !== cellB.x || cellA.y !== cellB.y || other.dir !== OPPOSITE[p.dir]) {
          issues.push(issue('error', 'CONNECTION_MISALIGNED', `连接 ${p.id} <-> ${other.id} 几何上未对齐`, [{ type: 'port', id: p.id }, { type: 'port', id: other.id }, { type: 'edge', id: edgeKey }]));
        }
      }
    }

    // ---------- 对齐但未连接（潜在漏门，警告） ----------
    for (const r of map.rooms) {
      for (const p of r.ports || []) {
        if (p.connects) continue;
        const neighbor = neighborAtPort(map, r, p);
        if (!neighbor) continue;
        const cell = genMod.portWorldCell(r, p);
        const wantDir = OPPOSITE[p.dir];
        const counterpart = (neighbor.ports || []).find((op) => !op.connects && op.dir === wantDir &&
          genMod.portWorldCell(neighbor, op).x === cell.x && genMod.portWorldCell(neighbor, op).y === cell.y);
        if (counterpart) {
          issues.push(issue('warning', 'ALIGNED_UNCONNECTED', `房间 ${r.id} 与 ${neighbor.id} 门口对齐却没有连接（漏门？）`, [
            { type: 'port', id: p.id }, { type: 'port', id: counterpart.id },
          ]));
        }
      }
    }

    // ---------- 数量规则 ----------
    const counts = rulesMod.countByType(map);
    for (const t of rules.roomTypes) {
      const n = counts[t.id] || 0;
      if (n < (t.min || 0)) {
        issues.push(issue('error', 'TYPE_BELOW_MIN', `类型 "${t.id}" 只有 ${n} 个，少于 min=${t.min}`, [{ type: 'type', id: t.id }]));
      }
      if (n > (t.max || 0)) {
        issues.push(issue('error', 'TYPE_ABOVE_MAX', `类型 "${t.id}" 有 ${n} 个，超过 max=${t.max}`, [{ type: 'type', id: t.id }]));
      }
    }
    for (const typeId of Object.keys(counts)) {
      if (!getType(rules, typeId)) {
        issues.push(issue('error', 'UNKNOWN_TYPE', `地图包含规则未定义的类型 "${typeId}"`, [{ type: 'type', id: typeId }]));
      }
    }

    // ---------- 连通性 ----------
    const adj = buildAdjacency(map, portById);
    const startRoom = map.rooms.find((r) => getType(rules, r.type)?.start);
    const endRoom = map.rooms.find((r) => getType(rules, r.type)?.end);
    if (!startRoom) {
      issues.push(issue('error', 'NO_START', '地图中没有起点房间'));
    }
    if (!endRoom) {
      issues.push(issue('error', 'NO_END', '地图中没有终点房间'));
    }
    const reachable = new Set();
    if (startRoom) {
      const queue = [startRoom.id];
      reachable.add(startRoom.id);
      while (queue.length) {
        const cur = queue.shift();
        for (const nb of adj.get(cur) || []) {
          if (!reachable.has(nb)) {
            reachable.add(nb);
            queue.push(nb);
          }
        }
      }
      // 起 -> 终
      if (endRoom && !reachable.has(endRoom.id)) {
        issues.push(issue('error', 'END_UNREACHABLE', `终点房间 ${endRoom.id} 从起点不可达（地图被断开）`, [
          { type: 'room', id: startRoom.id }, { type: 'room', id: endRoom.id },
        ]));
      }
      // 必需房间可达
      for (const r of map.rooms) {
        const t = getType(rules, r.type);
        if (t?.required && !reachable.has(r.id)) {
          issues.push(issue('error', 'REQUIRED_UNREACHABLE', `必需房间 ${r.id}（${r.type}）从起点不可达`, [{ type: 'room', id: r.id }]));
        }
      }
    }
    // 孤立房间（完全不在主连通分量内）
    for (const r of map.rooms) {
      if (startRoom && !reachable.has(r.id)) {
        issues.push(issue('error', 'ROOM_ISOLATED', `房间 ${r.id}（${r.type}）与起点所在连通分量断开`, [{ type: 'room', id: r.id }]));
      }
    }
    // 零连接房间（没有任何门）
    for (const r of map.rooms) {
      if ((adj.get(r.id) || new Set()).size === 0 && map.rooms.length > 1) {
        issues.push(issue('error', 'ROOM_NO_DOORS', `房间 ${r.id}（${r.type}）没有任何门口连接`, [{ type: 'room', id: r.id }]));
      }
    }

    // ---------- 孤立门口 ----------
    for (const r of map.rooms) {
      for (const p of r.ports || []) {
        if (p.connects) continue;
        const cell = genMod.portWorldCell(r, p);
        const outside = cell.x < 0 || cell.y < 0 || cell.x >= map.grid.width || cell.y >= map.grid.height;
        const neighbor = neighborAtPort(map, r, p);
        if (!neighbor) {
          issues.push(issue('warning', 'ORPHAN_PORT',
            outside ? `房间 ${r.id} 的端口 ${p.id} 朝向网格外，没有连接（孤立门口）`
                    : `房间 ${r.id} 的端口 ${p.id} 朝向空地，没有连接（孤立门口）`,
            [{ type: 'port', id: p.id }, { type: 'room', id: r.id }]));
        }
      }
    }

    // ---------- 锁定房间完整性 ----------
    if (lockedReference && Array.isArray(lockedReference.rooms)) {
      for (const ref of lockedReference.rooms.filter((r) => r.locked)) {
        const cur = map.rooms.find((r) => r.id === ref.id);
        if (!cur) {
          issues.push(issue('error', 'LOCKED_ROOM_MISSING', `锁定房间 ${ref.id} 在重新生成后丢失`, [{ type: 'room', id: ref.id }]));
          continue;
        }
        const fields = ['type', 'x', 'y', 'w', 'h'];
        for (const f of fields) {
          if (cur[f] !== ref[f]) {
            issues.push(issue('error', 'LOCKED_ROOM_MODIFIED', `锁定房间 ${ref.id} 的 ${f} 被改动（${ref[f]} -> ${cur[f]}）`, [{ type: 'room', id: ref.id }]));
          }
        }
        if (!cur.locked) {
          issues.push(issue('error', 'LOCKED_ROOM_UNLOCKED', `锁定房间 ${ref.id} 的锁定标记丢失`, [{ type: 'room', id: ref.id }]));
        }
        const refPorts = JSON.stringify((ref.ports || []).map((p) => [p.dir, p.offset]).sort());
        const curPorts = JSON.stringify((cur.ports || []).map((p) => [p.dir, p.offset]).sort());
        if (refPorts !== curPorts) {
          issues.push(issue('error', 'LOCKED_ROOM_PORTS_CHANGED', `锁定房间 ${ref.id} 的门口布局被改动`, [{ type: 'room', id: ref.id }]));
        }
      }
    }

    // 汇总
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');
    return {
      ok: errors.length === 0,
      issues,
      errors,
      warnings,
      reachable: startRoom ? reachable : new Set(),
    };
  }

  return { validate };
});
