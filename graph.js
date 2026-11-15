/* graph.js — 流向图渲染（内联 SVG，无外部依赖）。挂 window.Graph。 */
(function () {
  'use strict';

  // 调色板经 dataviz 校验（categorical 3 slots, light）；状态色仅用于状态
  const COLORS = {
    material: '#2a78d6', // blue
    semi: '#eb6834',     // orange
    product: '#1baf7a',  // aqua（对比度 WARN 由节点内直接文字标签兜底）
    edge: '#8c959f',
    revoked: '#cf222e',
    missingFill: '#fff8e6',
    missingStroke: '#eac54f',
    surface: '#ffffff',
    text: '#24292f',
  };

  const NODE_W = 132;
  const NODE_H = 52;
  const COL_GAP = 88;
  const ROW_GAP = 26;
  const PAD = 24;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  /**
   * 按路径分层（最长路径深度 = 列），同列节点按名称稳定排序后纵向排列。
   * 返回 { positions: Map<id,{x,y,depth}>, width, height, columns: Map<depth, ids[]> }
   */
  function layout(nodeIds, paths, edges) {
    const depth = new Map();
    for (const id of nodeIds) depth.set(id, 0);
    // 多轮松弛：边 from.depth + 1 <= to.depth
    const byFrom = new Map();
    for (const e of edges) {
      if (!byFrom.has(e.from)) byFrom.set(e.from, []);
      byFrom.get(e.from).push(e.to);
    }
    for (let round = 0; round < nodeIds.length; round++) {
      let changed = false;
      for (const e of edges) {
        const d = (depth.get(e.from) ?? 0) + 1;
        if (d > (depth.get(e.to) ?? 0)) {
          depth.set(e.to, d);
          changed = true;
        }
      }
      if (!changed) break;
    }

    const columns = new Map();
    for (const id of nodeIds) {
      const d = depth.get(id) ?? 0;
      if (!columns.has(d)) columns.set(d, []);
      columns.get(d).push(id);
    }
    for (const ids of columns.values()) ids.sort();

    const positions = new Map();
    let maxRows = 0;
    for (const [d, ids] of columns) {
      maxRows = Math.max(maxRows, ids.length);
      ids.forEach((id, row) => {
        positions.set(id, {
          x: PAD + d * (NODE_W + COL_GAP),
          y: PAD + row * (NODE_H + ROW_GAP),
          depth: d,
          row,
        });
      });
    }

    const width = PAD * 2 + columns.size * NODE_W + (columns.size - 1) * COL_GAP;
    const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP;
    return { positions, width, height };
  }

  function nodeKind(id, productionById, materials, missingBatches) {
    if (materials.has(id)) return { kind: 'material', label: '原料', color: COLORS.material };
    if (missingBatches && missingBatches.has(id)) {
      return { kind: 'missing', label: '记录缺失', color: COLORS.missingStroke };
    }
    const rec = productionById.get(id);
    if (rec && rec.stage === '半成品') return { kind: 'semi', label: '半成品', color: COLORS.semi };
    return { kind: 'product', label: '成品', color: COLORS.product };
  }

  /**
   * @param result trace() 的结果
   * @param ctx { materials, production, revokedDetailIds:Set, missingBatches:Set }
   * @param onJump 点击节点/边的回调（类型, id）
   */
  function render(result, ctx, onJump) {
    const materials = new Map((ctx.materials || []).map((m) => [m.batchId, m]));
    const productionById = new Map((ctx.production || []).map((p) => [p.outputBatch, p]));
    const missingBatches = ctx.missingBatches || new Set();
    const nodeIds = result.nodes;
    const { positions, width, height } = layout(nodeIds, result.paths, result.pathEdges);

    // 出库节点（成品批次 -> 出库单；撤销的用红色虚线）需先算出来确定画布尺寸
    const outByProduct = new Map();
    for (const d of result.outboundDetails) {
      if (!outByProduct.has(d.productBatch)) outByProduct.set(d.productBatch, []);
      outByProduct.get(d.productBatch).push(d);
    }
    const outNodes = [];
    for (const [productBatch, details] of outByProduct) {
      const anchor = positions.get(productBatch);
      if (!anchor) continue;
      details.forEach((d, i) => {
        outNodes.push({
          d,
          x: anchor.x + NODE_W + COL_GAP,
          y: anchor.y + i * (NODE_H + ROW_GAP),
          anchor,
        });
      });
    }
    const graphWidth = Math.max(width, outNodes.length ? Math.max(...outNodes.map((n) => n.x + NODE_W)) + PAD : width);
    const graphHeight = Math.max(height, outNodes.length ? Math.max(...outNodes.map((n) => n.y + NODE_H)) + PAD : height);

    const svgParts = [];
    svgParts.push(
      `<svg width="${graphWidth}" height="${graphHeight}" viewBox="0 0 ${graphWidth} ${graphHeight}" role="img" aria-label="批次流向图">`
    );
    svgParts.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="${COLORS.edge}"/></marker>
      <marker id="arrow-revoked" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="${COLORS.revoked}"/></marker></defs>`);

    // 边
    for (const e of result.pathEdges) {
      const a = positions.get(e.from);
      const b = positions.get(e.to);
      if (!a || !b) continue;
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2;
      const midX = (x1 + x2) / 2;
      svgParts.push(
        `<g class="g-edge-group" data-jump="production:${escapeHtml(e.productionId)}" style="cursor:pointer">
          <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="g-edge" marker-end="url(#arrow)"/>
          <rect x="${midX - 34}" y="${y1 - 9}" width="68" height="16" rx="8" fill="${COLORS.surface}" opacity="0.85"/>
          <text x="${midX}" y="${y1 + 3}" text-anchor="middle" class="g-edge-label">${escapeHtml(e.productionId)}</text>
        </g>`
      );
    }

    for (const { d, x, y, anchor } of outNodes) {
      const x1 = anchor.x + NODE_W;
      const y1 = anchor.y + NODE_H / 2;
      const x2 = x;
      const y2 = y + NODE_H / 2;
      const cls = d.revoked ? 'g-edge revoked' : 'g-edge';
      const marker = d.revoked ? 'url(#arrow-revoked)' : 'url(#arrow)';
      svgParts.push(
        `<g data-jump="outbound:${escapeHtml(d.id)}" style="cursor:pointer">
          <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}" marker-end="${marker}"/>
        </g>`
      );
    }

    // 批次节点
    for (const id of nodeIds) {
      const p = positions.get(id);
      const meta = nodeKind(id, productionById, materials, missingBatches);
      const isMissing = missingBatches.has(id);
      const fill = isMissing ? COLORS.missingFill : meta.color;
      const stroke = isMissing ? COLORS.missingStroke : meta.color;
      const textFill = isMissing ? COLORS.text : '#ffffff';
      svgParts.push(
        `<g class="g-node" data-jump="batch:${escapeHtml(id)}" style="cursor:pointer">
          <title>${escapeHtml(id)}（${meta.label}）— 点击查看原始台账</title>
          <rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1.2" ${isMissing ? 'stroke-dasharray="6 4"' : ''}/>
          <text x="${p.x + NODE_W / 2}" y="${p.y + 21}" text-anchor="middle" fill="${textFill}" font-size="13" font-weight="600">${escapeHtml(id)}</text>
          <text x="${p.x + NODE_W / 2}" y="${p.y + 39}" text-anchor="middle" fill="${textFill}" font-size="11" opacity="0.92">${escapeHtml(isMissing ? '记录缺失 · 待补齐' : meta.label)}</text>
        </g>`
      );
    }

    // 出库单节点
    for (const { d, x, y } of outNodes) {
      const fill = d.revoked ? '#ffebe9' : '#f6f8fa';
      const stroke = d.revoked ? COLORS.revoked : '#8c959f';
      const badge = d.revoked ? '（已撤销）' : '';
      svgParts.push(
        `<g class="g-node" data-jump="outbound:${escapeHtml(d.id)}" style="cursor:pointer">
          <title>出库单 ${escapeHtml(d.orderNo)} 明细 ${escapeHtml(d.id)} — 点击查看原始台账</title>
          <rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1.2" ${d.revoked ? 'stroke-dasharray="5 4"' : ''}/>
          <text x="${x + NODE_W / 2}" y="${y + 21}" text-anchor="middle" fill="${COLORS.text}" font-size="13" font-weight="600">${escapeHtml(d.orderNo)}${badge}</text>
          <text x="${x + NODE_W / 2}" y="${y + 39}" text-anchor="middle" fill="${d.revoked ? COLORS.revoked : '#57606a'}" font-size="11">${d.qty} 件 · 明细 ${escapeHtml(d.id)}</text>
        </g>`
      );
    }

    svgParts.push('</svg>');

    const wrap = document.createElement('div');
    wrap.className = 'graph-wrap';
    wrap.innerHTML = svgParts.join('');
    wrap.addEventListener('click', (ev) => {
      const target = ev.target.closest('[data-jump]');
      if (!target) return;
      const [type, id] = target.dataset.jump.split(':');
      onJump(type, id);
    });
    return wrap;
  }

  window.Graph = { render, COLORS };
})();
