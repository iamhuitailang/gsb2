/*
 * 工程文件与生成版本管理（UMD）
 *
 * .dungeon.json 工程文件：
 * {
 *   "format": "dungeon-editor", "formatVersion": 1,
 *   "rules": {...},
 *   "versions": [ { "id", "label", "seed", "map", "createdAt", "note" }, ... ],
 *   "activeVersionId": "...",
 *   "lockedRoomIds": [...]
 * }
 *
 * 版本对比在两份地图之间做：房间数量、类型分布、连通分量、问题数等。
 */
(function (root, factory) {
  const deps = factory(
    typeof require === 'function' ? require('./rules') : root.DungeonRules,
    typeof require === 'function' ? require('./validator') : root.DungeonValidator
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = deps;
  else root.DungeonProject = deps;
})(typeof self !== 'undefined' ? self : this, function (rulesMod, validatorMod) {
  'use strict';

  const FORMAT = 'dungeon-editor';
  const FORMAT_VERSION = 1;

  function createProject(rules) {
    return {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      rules: rules || rulesMod.createDefaultRules(),
      versions: [],
      activeVersionId: null,
      lockedRoomIds: [],
      createdAt: new Date().toISOString(),
    };
  }

  function normalizeProject(data) {
    if (!data || data.format !== FORMAT) {
      throw new Error('不是本编辑器的工程文件（缺少 format=dungeon-editor）');
    }
    if (data.formatVersion > FORMAT_VERSION) {
      throw new Error(`工程文件版本 ${data.formatVersion} 比当前编辑器支持的 ${FORMAT_VERSION} 新，请升级编辑器`);
    }
    data.versions = Array.isArray(data.versions) ? data.versions : [];
    data.lockedRoomIds = Array.isArray(data.lockedRoomIds) ? data.lockedRoomIds : [];
    return data;
  }

  function addVersion(project, map, label, note) {
    const id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const version = {
      id,
      label: label || `版本 ${project.versions.length + 1}`,
      seed: map.seed,
      map,
      note: note || '',
      createdAt: new Date().toISOString(),
    };
    project.versions.push(version);
    project.activeVersionId = id;
    return version;
  }

  function removeVersion(project, versionId) {
    const i = project.versions.findIndex((v) => v.id === versionId);
    if (i < 0) return false;
    project.versions.splice(i, 1);
    if (project.activeVersionId === versionId) {
      project.activeVersionId = project.versions.length ? project.versions[project.versions.length - 1].id : null;
    }
    return true;
  }

  /** 单份地图的统计快照（用于对比表） */
  function mapStats(rules, map) {
    const counts = rulesMod.countByType(map);
    const validation = validatorMod.validate(map, rules);
    // 连通分量数
    const seen = new Set();
    const adj = new Map(map.rooms.map((r) => [r.id, new Set()]));
    for (const e of map.edges || []) {
      const pa = map.rooms.find((r) => r.ports.some((p) => p.id === e.a));
      const pb = map.rooms.find((r) => r.ports.some((p) => p.id === e.b));
      if (pa && pb) {
        adj.get(pa.id)?.add(pb.id);
        adj.get(pb.id)?.add(pa.id);
      }
    }
    let components = 0;
    for (const r of map.rooms) {
      if (seen.has(r.id)) continue;
      components += 1;
      const q = [r.id];
      seen.add(r.id);
      while (q.length) {
        const cur = q.shift();
        for (const nb of adj.get(cur) || []) {
          if (!seen.has(nb)) {
            seen.add(nb);
            q.push(nb);
          }
        }
      }
    }
    const totalPorts = map.rooms.reduce((s, r) => s + (r.ports?.length || 0), 0);
    const orphanPorts = totalPorts - (map.edges || []).length * 2;
    return {
      rooms: map.rooms.length,
      edges: (map.edges || []).length,
      components,
      counts,
      orphanPorts,
      errors: validation.errors.length,
      warnings: validation.warnings.length,
      nodeVisits: map.nodeVisits || 0,
    };
  }

  /** 对比两份地图，返回带 delta 的表结构 */
  function compareMaps(rules, mapA, mapB) {
    const a = mapStats(rules, mapA);
    const b = mapStats(rules, mapB);
    const typeIds = new Set([...Object.keys(a.counts), ...Object.keys(b.counts)]);
    const rows = [
      { key: 'rooms', label: '房间总数', a: a.rooms, b: b.rooms, delta: b.rooms - a.rooms },
      { key: 'edges', label: '门口连接数', a: a.edges, b: b.edges, delta: b.edges - a.edges },
      { key: 'components', label: '连通分量（1 为全连通）', a: a.components, b: b.components, delta: b.components - a.components },
      { key: 'orphanPorts', label: '孤立门口数', a: a.orphanPorts, b: b.orphanPorts, delta: b.orphanPorts - a.orphanPorts },
      { key: 'errors', label: '校验错误数', a: a.errors, b: b.errors, delta: b.errors - a.errors },
      { key: 'warnings', label: '警告数', a: a.warnings, b: b.warnings, delta: b.warnings - a.warnings },
      { key: 'nodeVisits', label: '回溯节点数', a: a.nodeVisits, b: b.nodeVisits, delta: b.nodeVisits - a.nodeVisits },
    ];
    const typeRows = [...typeIds].map((id) => ({
      key: 'type:' + id,
      label: `类型 ${id} 数量`,
      a: a.counts[id] || 0,
      b: b.counts[id] || 0,
      delta: (b.counts[id] || 0) - (a.counts[id] || 0),
    }));
    return { rows, typeRows, statsA: a, statsB: b };
  }

  return {
    FORMAT,
    FORMAT_VERSION,
    createProject,
    normalizeProject,
    addVersion,
    removeVersion,
    mapStats,
    compareMaps,
  };
});
