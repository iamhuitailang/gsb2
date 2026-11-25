/*
 * 地牢规则模型与静态检查（UMD）
 *
 * 规则文件结构（JSON）：
 * {
 *   "name": "小型地牢",
 *   "grid": { "width": 12, "height": 10 },
 *   "maxRooms": 12,
 *   "defaultAdjacency": "deny",            // 未显式列出的类型对默认 allow/deny
 *   "adjacency": [ { "a": "start", "b": "combat", "allow": true }, ... ],
 *   "roomTypes": [
 *     {
 *       "id": "combat",
 *       "name": "战斗房",
 *       "color": "#d96a5b",
 *       "sizes": [[3,3],[4,3],[3,4]],     // 可选 [宽, 高]
 *       "min": 2, "max": 5,
 *       "required": false,                // true = 必需房间（可达性单独检查）
 *       "ports": { "n": [1], "s": [1], "e": [0], "w": [0] }
 *     }, ...
 *   ]
 * }
 *
 * ports 的 key 为方向 n/s/e/w，值为门口在该侧的偏移槽位数组：
 * 南/北侧按 x 偏移、东/西按 y 偏移，从 0 开始，必须小于该方向的房间边长。
 */
(function (root, factory) {
  const mod = factory(typeof require === 'function' ? require('./rng') : root.DungeonRNG);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.DungeonRules = mod;
})(typeof self !== 'undefined' ? self : this, function (rngMod) {
  'use strict';

  const DIRS = ['n', 'e', 's', 'w'];
  const OPPOSITE = { n: 's', s: 'n', e: 'w', w: 'e' };
  // 每个方向的单位向量（格子坐标）
  const DELTA = {
    n: { dx: 0, dy: -1 },
    s: { dx: 0, dy: 1 },
    e: { dx: 1, dy: 0 },
    w: { dx: -1, dy: 0 },
  };

  function createDefaultRules() {
    return {
      version: 1,
      name: '新建规则',
      grid: { width: 12, height: 10 },
      maxRooms: 10,
      defaultAdjacency: 'deny',
      adjacency: [],
      roomTypes: [],
    };
  }

  /** 深拷贝（纯 JSON 数据） */
  function clone(data) {
    return JSON.parse(JSON.stringify(data));
  }

  function getType(rules, typeId) {
    return (rules.roomTypes || []).find((t) => t.id === typeId) || null;
  }

  /**
   * 判断两个类型是否允许相邻。
   * 规则按数组顺序逐条匹配（a/b 无序，支持 "*" 通配），第一条命中即决定；
   * 都不命中则看 defaultAdjacency。
   */
  function canAdjacent(rules, typeA, typeB) {
    const list = rules.adjacency || [];
    for (const rule of list) {
      const hit =
        (rule.a === typeA && rule.b === typeB) ||
        (rule.a === typeB && rule.b === typeA) ||
        (rule.a === '*' && rule.b === typeB) ||
        (rule.a === typeA && rule.b === '*') ||
        (rule.a === '*' && rule.b === typeA) ||
        (rule.a === typeB && rule.b === '*');
      if (hit) return rule.allow !== false;
    }
    return rules.defaultAdjacency !== 'deny';
  }

  /** 房间某侧的边长（用于校验端口偏移） */
  function sideLength(size, dir) {
    const [w, h] = size;
    return dir === 'n' || dir === 's' ? w : h;
  }

  /** 校验单个类型定义，返回问题数组 */
  function validateType(type, index) {
    const issues = [];
    const where = `类型[${index}]${type.id ? ` "${type.id}"` : ''}`;
    if (!type.id || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(type.id)) {
      issues.push({ code: 'TYPE_ID_INVALID', message: `${where}：id 缺失或非法（须以字母开头，仅含字母数字_-）` });
    }
    if (!Array.isArray(type.sizes) || type.sizes.length === 0) {
      issues.push({ code: 'TYPE_SIZE_MISSING', message: `${where}：至少需要一个尺寸` });
    } else {
      type.sizes.forEach((s, i) => {
        if (!Array.isArray(s) || s.length !== 2 || !Number.isInteger(s[0]) || !Number.isInteger(s[1]) || s[0] < 1 || s[1] < 1) {
          issues.push({ code: 'TYPE_SIZE_INVALID', message: `${where}：尺寸 #${i} 必须是 [正整数宽, 正整数高]` });
        }
      });
    }
    type.min = Number(type.min) || 0;
    type.max = type.max === undefined || type.max === null ? type.min : Number(type.max);
    if (type.min < 0 || type.max < 0 || type.min > type.max) {
      issues.push({ code: 'TYPE_COUNT_RANGE', message: `${where}：数量范围 min/max 非法（需 0 <= min <= max）` });
    }
    const ports = type.ports || {};
    for (const d of DIRS) {
      const arr = ports[d];
      if (arr === undefined) continue;
      if (!Array.isArray(arr) || arr.some((o) => !Number.isInteger(o) || o < 0)) {
        issues.push({ code: 'PORT_INVALID', message: `${where}：${d} 侧端口必须是非负整数数组` });
      } else if (arr.length !== new Set(arr).size) {
        issues.push({ code: 'PORT_DUPLICATE', message: `${where}：${d} 侧存在重复端口偏移` });
      } else if (Array.isArray(type.sizes)) {
        const maxSize = Math.max(...type.sizes.filter((s) => Array.isArray(s)).map((s) => sideLength(s, d)));
        if (Number.isFinite(maxSize) && arr.some((o) => o >= maxSize)) {
          issues.push({ code: 'PORT_OUT_OF_RANGE', message: `${where}：${d} 侧端口偏移超出该侧边长（最大 ${maxSize - 1}）` });
        }
      }
    }
    return issues;
  }

  /**
   * 规则静态检查（生成前预检），返回结构化问题列表。
   * 覆盖：字段合法性、类型重复、数量上下限、端口、相邻关系图可达性、
   * start/end 语义、网格容量、相邻规则自相矛盾等。
   */
  function validateRules(rules) {
    const issues = [];
    if (!rules || typeof rules !== 'object') {
      return [{ code: 'RULES_NOT_OBJECT', message: '规则不是合法对象' }];
    }
    if (!rules.grid || rules.grid.width < 2 || rules.grid.height < 2) {
      issues.push({ code: 'GRID_INVALID', message: '网格宽高必须 >= 2' });
    }
    if (!Number.isInteger(rules.maxRooms) || rules.maxRooms < 1) {
      issues.push({ code: 'MAX_ROOMS_INVALID', message: 'maxRooms 必须是 >= 1 的整数' });
    }
    if (!Array.isArray(rules.roomTypes) || rules.roomTypes.length === 0) {
      issues.push({ code: 'NO_ROOM_TYPES', message: '至少需要定义一个房间类型' });
      return issues;
    }

    // 类型逐项检查 + id 去重
    const ids = new Set();
    rules.roomTypes.forEach((t, i) => {
      for (const iss of validateType(t, i)) issues.push(iss);
      if (t.id) {
        if (ids.has(t.id)) issues.push({ code: 'TYPE_DUPLICATE_ID', message: `类型 id "${t.id}" 重复` });
        ids.add(t.id);
      }
    });
    const typeIds = rules.roomTypes.map((t) => t.id);

    // 数量范围汇总
    let sumMin = 0;
    let sumMax = 0;
    const starts = [];
    const ends = [];
    for (const t of rules.roomTypes) {
      sumMin += t.min || 0;
      sumMax += t.max || 0;
      if (t.start) starts.push(t.id);
      if (t.end) ends.push(t.id);
    }
    if (starts.length !== 1) issues.push({ code: 'START_COUNT', message: `必须恰好有一个起点类型（当前 ${starts.length} 个：${starts.join(', ') || '无'}）` });
    if (ends.length !== 1) issues.push({ code: 'END_COUNT', message: `必须恰好有一个终点类型（当前 ${ends.length} 个：${ends.join(', ') || '无'}）` });
    if (starts.length === 1) {
      const st = getType(rules, starts[0]);
      if (st && (st.min || 0) < 1) issues.push({ code: 'START_MIN', message: `起点类型 "${st.id}" 的 min 必须 >= 1` });
    }
    if (ends.length === 1) {
      const en = getType(rules, ends[0]);
      if (en && (en.min || 0) < 1) issues.push({ code: 'END_MIN', message: `终点类型 "${en.id}" 的 min 必须 >= 1` });
    }
    if (Number.isInteger(rules.maxRooms)) {
      if (sumMin > rules.maxRooms) {
        issues.push({ code: 'MIN_EXCEEDS_MAXROOMS', message: `各类型 min 之和（${sumMin}）超过 maxRooms（${rules.maxRooms}），必然无解` });
      }
      if (sumMax < rules.maxRooms) {
        // 仅警告：可以不填满
        issues.push({ code: 'MAXROOMS_UNFILLABLE', severity: 'warning', message: `各类型 max 之和（${sumMax}）小于 maxRooms（${rules.maxRooms}），地图无法填满房间数上限` });
      }
    }

    // 相邻关系：检查规则引用的类型存在
    (rules.adjacency || []).forEach((r, i) => {
      for (const side of ['a', 'b']) {
        if (r[side] !== '*' && !ids.has(r[side])) {
          issues.push({ code: 'ADJACENCY_UNKNOWN_TYPE', message: `相邻规则 #${i} 引用了不存在的类型 "${r[side]}"` });
        }
      }
    });

    // 相邻可达图：从起点出发，沿"允许相邻"边做 BFS，所有 min>0 / required / end 的类型必须可达
    if (starts.length === 1 && issues.every((x) => x.code !== 'TYPE_DUPLICATE_ID')) {
      const reachable = new Set([starts[0]]);
      const queue = [starts[0]];
      while (queue.length) {
        const cur = queue.shift();
        for (const other of typeIds) {
          if (!reachable.has(other) && canAdjacent(rules, cur, other)) {
            reachable.add(other);
            queue.push(other);
          }
        }
      }
      for (const t of rules.roomTypes) {
        const needed = (t.min || 0) > 0 || t.required || t.end;
        if (needed && !reachable.has(t.id)) {
          issues.push({
            code: 'TYPE_UNREACHABLE_BY_ADJACENCY',
            message: `类型 "${t.id}" 在相邻关系图上从起点不可达：没有任何一条 allow 规则链能把它连到起点，生成必然失败`,
          });
        }
      }
      // 自相邻检查：没有任何可放置邻居的类型
      for (const t of rules.roomTypes) {
        const hasNeighbor = typeIds.some((o) => canAdjacent(rules, t.id, o));
        if (!hasNeighbor) {
          issues.push({ code: 'TYPE_NO_NEIGHBOR', message: `类型 "${t.id}" 不允许与任何类型（含自身）相邻，无法放置` });
        }
      }
    }

    // 网格容量：所有 min 房间的最小面积之和不能超过网格
    if (rules.grid && Number.isInteger(rules.grid.width)) {
      const cells = rules.grid.width * rules.grid.height;
      let minArea = 0;
      for (const t of rules.roomTypes) {
        if ((t.min || 0) > 0 && Array.isArray(t.sizes) && t.sizes.length) {
          const minS = Math.min(...t.sizes.map((s) => s[0] * s[1]));
          minArea += minS * t.min;
        }
      }
      if (minArea > cells) {
        issues.push({ code: 'GRID_TOO_SMALL', message: `满足 min 数量至少需要 ${minArea} 格，网格只有 ${cells} 格` });
      }
    }
    return issues;
  }

  /** 统计一张地图中各类型的房间数量 */
  function countByType(map) {
    const counts = {};
    for (const r of map.rooms) counts[r.type] = (counts[r.type] || 0) + 1;
    return counts;
  }

  return {
    DIRS,
    OPPOSITE,
    DELTA,
    createDefaultRules,
    clone,
    getType,
    canAdjacent,
    sideLength,
    validateRules,
    validateType,
    countByType,
    hashSeed: rngMod.hashSeed,
  };
});
