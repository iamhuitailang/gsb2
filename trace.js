/*
 * trace.js — 纯追溯逻辑，不依赖 DOM。
 * 浏览器挂到 window.Trace；Node 下走 module.exports，供 node --test 使用。
 *
 * 数据模型（三套台账，均为对象数组）：
 *   原料材料 materials: { batchId, name, supplier, inboundDate, qty }
 *   生产 production:    { id, outputBatch, stage('半成品'|'成品'), inputs:[batchId...],
 *                         outputDate, note }
 *   出库明细 outbound:   { id, orderNo, productBatch, qty, shipDate, customer }
 *   更正 corrections:   { id, type:'revoke', detailId, date, reason }
 *                        revoke = 撤销一条旧的出库明细（逻辑删除，不删原行）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Trace = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function indexBy(arr, key) {
    const m = new Map();
    for (const item of arr || []) m.set(item[key], item);
    return m;
  }

  /** 当前仍有效的出库明细：原行保留，被 revoke 更正的标记为已撤销。 */
  function activeDetails(outbound, corrections) {
    const revokedIds = new Set(
      (corrections || []).filter((c) => c.type === 'revoke').map((c) => c.detailId)
    );
    return (outbound || []).map((d) => ({
      ...d,
      revoked: revokedIds.has(d.id),
    }));
  }

  /**
   * 全局缺失关联检测（与具体查询无关，页面顶部黄条用）：
   *  - danglingProductionInput: 生产记录引用了不存在的原料/半成品批次
   *  - danglingOutboundBatch:   出库明细发了一个没有生产记录的批次
   */
  function findGlobalMissing(data) {
    const known = new Set((data.materials || []).map((m) => m.batchId));
    for (const p of data.production || []) known.add(p.outputBatch);

    const missing = [];
    for (const p of data.production || []) {
      for (const input of p.inputs || []) {
        if (!known.has(input)) {
          missing.push({
            kind: 'danglingProductionInput',
            batch: input,
            ref: p.id,
            message: `生产记录 ${p.id}（产出 ${p.outputBatch}）的投入批次 ${input} 在原料/生产台账中找不到`,
          });
        }
      }
    }
    const produced = new Set((data.production || []).map((p) => p.outputBatch));
    for (const d of data.outbound || []) {
      if (!produced.has(d.productBatch)) {
        missing.push({
          kind: 'danglingOutboundBatch',
          batch: d.productBatch,
          ref: d.id,
          message: `出库明细 ${d.id}（出库单 ${d.orderNo}）的成品批次 ${d.productBatch} 没有生产记录`,
        });
      }
    }
    return missing;
  }

  /**
   * 从原料批次出发做追溯。
   * 返回：
   *   paths:      去重后的完整路径（每条路径是节点 batchId 数组，含起点）
   *   pathEdges:  路径上的生产边 { from, to, productionId }
   *   nodes:      路径涉及的所有批次
   *   production/ products/ outboundDetails: 命中记录（出库含 revoked 标记）
   *   missing:    本查询范围内的缺失关联
   *   stats:      按批次/出库单明细去重后的当前汇总
   */
  function trace(materialBatchId, data) {
    const materials = indexBy(data.materials || [], 'batchId');
    const production = data.production || [];
    const corrections = data.corrections || [];

    // 邻接表：投入批次 -> [{ to: 产出批次, productionId }]
    const adj = new Map();
    const outIndex = indexBy(production, 'id');
    for (const p of production) {
      for (const input of p.inputs || []) {
        if (!adj.has(input)) adj.set(input, []);
        adj.get(input).push({ to: p.outputBatch, productionId: p.id });
      }
    }

    // DFS 枚举所有路径（防环）。同一成品经两条路径关联时这里会得到两条。
    const paths = [];
    (function dfs(node, trail, seen) {
      const edges = adj.get(node);
      if (!edges || edges.length === 0) {
        paths.push(trail.slice());
        return;
      }
      for (const e of edges) {
        if (seen.has(e.to)) {
          paths.push(trail.concat(e.to)); // 环上只记录，不再展开
          continue;
        }
        seen.add(e.to);
        trail.push(e.to);
        dfs(e.to, trail, seen);
        trail.pop();
        seen.delete(e.to);
      }
    })(materialBatchId, [materialBatchId], new Set([materialBatchId]));

    // 去重路径（节点序列相同只留一条）
    const seenPathKeys = new Set();
    const uniquePaths = [];
    for (const path of paths) {
      const key = path.join('>');
      if (!seenPathKeys.has(key)) {
        seenPathKeys.add(key);
        uniquePaths.push(path);
      }
    }

    // 路径上的节点与生产边
    const nodeSet = new Set();
    const edgeMap = new Map();
    const productionHits = new Map();
    for (const path of uniquePaths) {
      path.forEach((n) => nodeSet.add(n));
      for (let i = 0; i < path.length - 1; i++) {
        const edgeList = adj.get(path[i]) || [];
        const edge = edgeList.find((e) => e.to === path[i + 1]);
        if (!edge) continue;
        edgeMap.set(`${path[i]}->${edge.to}#${edge.productionId}`, {
          from: path[i],
          to: edge.to,
          productionId: edge.productionId,
        });
        const rec = outIndex.get(edge.productionId);
        if (rec) productionHits.set(rec.id, rec);
      }
    }

    // 可达生产记录引用的投入批次也要纳入节点集：
    // 某中间批次自己的生产记录后到时，它不会出现在邻接边里，
    // 但会作为下游生产的投入被引用——此时作为缺失节点呈现。
    for (const rec of productionHits.values()) {
      for (const input of rec.inputs || []) nodeSet.add(input);
    }

    // 查询范围内的缺失关联：路径节点有出库但无下游生产记录、或引用悬空
    const missing = [];
    const producedBatches = new Set(production.map((p) => p.outputBatch));
    const details = activeDetails(data.outbound, corrections);

    for (const node of nodeSet) {
      if (node === materialBatchId) continue;
      if (!producedBatches.has(node) && !materials.has(node)) {
        missing.push({
          kind: 'danglingProductionInput',
          batch: node,
          message: `半成品/成品批次 ${node} 的生产记录缺失（台账后到）`,
        });
      }
    }
    for (const d of details) {
      if (nodeSet.has(d.productBatch) && !producedBatches.has(d.productBatch)) {
        if (!missing.some((m) => m.kind === 'danglingOutboundBatch' && m.batch === d.productBatch)) {
          missing.push({
            kind: 'danglingOutboundBatch',
            batch: d.productBatch,
            ref: d.id,
            message: `批次 ${d.productBatch} 已有出库明细 ${d.id}，但生产记录尚未到齐`,
          });
        }
      }
    }

    // 出库命中：发出的成品批次在路径节点集合内
    const outboundHits = details.filter((d) => nodeSet.has(d.productBatch));

    // 成品批次 = 路径末端中实际被生产为“成品”的节点；没有 stage 信息时取路径末端
    const stageById = indexBy(production, 'outputBatch');
    const productSet = new Set();
    for (const path of uniquePaths) {
      const end = path[path.length - 1];
      const rec = stageById.get(end);
      if (!rec || rec.stage === '成品') productSet.add(end);
    }

    // —— 汇总：按实际批次、出库单明细去重 ——
    const orderSet = new Set();
    let activeQty = 0;
    let revokedQty = 0;
    const activeDetailIds = new Set();
    const revokedDetailIds = new Set();
    for (const d of outboundHits) {
      orderSet.add(d.orderNo);
      if (d.revoked) {
        revokedQty += Number(d.qty) || 0;
        revokedDetailIds.add(d.id);
      } else {
        activeQty += Number(d.qty) || 0;
        activeDetailIds.add(d.id);
      }
    }

    return {
      materialBatchId,
      paths: uniquePaths,
      pathEdges: Array.from(edgeMap.values()),
      nodes: Array.from(nodeSet),
      production: Array.from(productionHits.values()),
      products: Array.from(productSet),
      outboundDetails: outboundHits,
      missing,
      stats: {
        productBatchCount: productSet.size,          // 去重后的成品批次数
        productionCount: productionHits.size,        // 去重后的生产批次数
        outboundOrderCount: orderSet.size,           // 去重后的出库单数
        outboundDetailCount: activeDetailIds.size,   // 当前有效明细数（去重）
        outboundQty: activeQty,                      // 当前有效出库件数
        revokedDetailCount: revokedDetailIds.size,
        revokedQty,
      },
    };
  }

  /** 保存快照时的版本指纹：原始台账内容变化后可提示“当前数据已变化”。 */
  function dataFingerprint(data) {
    return JSON.stringify({
      m: data.materials || [],
      p: data.production || [],
      o: data.outbound || [],
      c: data.corrections || [],
    });
  }

  return { trace, findGlobalMissing, activeDetails, dataFingerprint };
});
