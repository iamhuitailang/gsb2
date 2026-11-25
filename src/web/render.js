/*
 * 地图 SVG 渲染器（浏览器端）
 * 负责：网格、房间、端口、连接边、问题高亮、锁定标记、点击选择。
 */
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CELL = 40;

  function el(tag, attrs, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** 端口在房间边界上的坐标（网格坐标系，整数格点） */
  function portEdgePoint(room, port) {
    switch (port.dir) {
      case 'n': return { x: room.x + port.offset, y: room.y };
      case 's': return { x: room.x + port.offset, y: room.y + room.h };
      case 'e': return { x: room.x + room.w, y: room.y + port.offset };
      case 'w': return { x: room.x, y: room.y + port.offset };
      default: return null;
    }
  }

  /**
   * 渲染地图。
   * @param svg    目标 <svg> 元素
   * @param map    地图对象（失败时可传 partialMap）
   * @param rules  规则
   * @param opts   { validation, selectedId, highlight:Set, lockedIds:Set, onSelect, zoom }
   */
  function render(svg, map, rules, opts) {
    opts = opts || {};
    const zoom = opts.zoom || 1;
    const cell = CELL * zoom;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!map) {
      svg.appendChild(el('text', { x: 12, y: 24, class: 'placeholder' }, '尚未生成地图'));
      return;
    }

    const W = map.grid.width;
    const H = map.grid.height;
    svg.setAttribute('viewBox', `0 0 ${W * cell} ${H * cell}`);

    const root = el('g', {});
    svg.appendChild(root);

    // 背景
    root.appendChild(el('rect', { x: 0, y: 0, width: W * cell, height: H * cell, class: 'grid-bg' }));

    // 网格线
    for (let x = 0; x <= W; x++) {
      root.appendChild(el('line', { x1: x * cell, y1: 0, x2: x * cell, y2: H * cell, class: 'grid-line' }));
    }
    for (let y = 0; y <= H; y++) {
      root.appendChild(el('line', { x1: 0, y1: y * cell, x2: W * cell, y2: y * cell, class: 'grid-line' }));
    }

    const typeMap = new Map((rules.roomTypes || []).map((t) => [t.id, t]));
    const portIndex = new Map();
    for (const r of map.rooms) for (const p of r.ports || []) portIndex.set(p.id, { room: r, port: p });

    const reachable = opts.validation?.reachable || null;
    const highlight = opts.highlight || new Set();
    const lockedIds = opts.lockedIds || new Set();

    // 房间
    for (const room of map.rooms) {
      const t = typeMap.get(room.type);
      const color = t?.color || '#999';
      const isSelected = room.id === opts.selectedId;
      const isLocked = lockedIds.has(room.id) || room.locked;
      const unreachable = reachable && !reachable.has(room.id);
      const cls = ['room', isSelected ? 'selected' : '', isLocked ? 'locked' : '', unreachable ? 'unreachable' : '']
        .filter(Boolean).join(' ');
      const rect = el('rect', {
        x: room.x * cell + 1.5,
        y: room.y * cell + 1.5,
        width: room.w * cell - 3,
        height: room.h * cell - 3,
        rx: 6,
        class: cls,
        fill: color,
      });
      rect.addEventListener('click', () => opts.onSelect && opts.onSelect(room.id));
      root.appendChild(rect);

      // 问题高亮描边
      if (highlight.has('room:' + room.id)) {
        root.appendChild(el('rect', {
          x: room.x * cell, y: room.y * cell,
          width: room.w * cell, height: room.h * cell,
          rx: 8, class: 'issue-ring',
        }));
      }

      // 标签
      const label = `${room.id} · ${t?.name || room.type}${isLocked ? ' 🔒' : ''}`;
      const text = el('text', {
        x: (room.x + room.w / 2) * cell,
        y: (room.y + 0.32) * cell,
        class: 'room-label',
      }, label);
      text.addEventListener('click', () => opts.onSelect && opts.onSelect(room.id));
      root.appendChild(text);
      const sub = el('text', {
        x: (room.x + room.w / 2) * cell,
        y: (room.y + 0.62) * cell,
        class: 'room-sub',
      }, `${room.w}×${room.h}`);
      root.appendChild(sub);
    }

    // 连接边（沿房间边界点连线，跨过边界格）
    for (const edge of map.edges || []) {
      const pa = portIndex.get(edge.a);
      const pb = portIndex.get(edge.b);
      if (!pa || !pb) {
        // 悬空边，红色虚线提示
        root.appendChild(el('text', { x: 10, y: H * cell - 8, class: 'error-text' }, `存在悬空连接 ${edge.a}-${edge.b}`));
        continue;
      }
      const a = portEdgePoint(pa.room, pa.port);
      const b = portEdgePoint(pb.room, pb.port);
      // 端点取端口世界格中心（边界外一格的中心），连线跨过共享边界
      const ca = window.DungeonGenerator.portWorldCell(pa.room, pa.port);
      const cb = window.DungeonGenerator.portWorldCell(pb.room, pb.port);
      const hot = highlight.has('port:' + edge.a) || highlight.has('port:' + edge.b);
      root.appendChild(el('line', {
        x1: (ca.x + 0.5) * cell, y1: (ca.y + 0.5) * cell,
        x2: (cb.x + 0.5) * cell, y2: (cb.y + 0.5) * cell,
        class: hot ? 'edge edge-hot' : 'edge',
      }));
    }

    // 端口标记（画在端口世界格中心）
    for (const room of map.rooms) {
      for (const port of room.ports || []) {
        const wc = window.DungeonGenerator.portWorldCell(room, port);
        if (wc.x < 0 || wc.y < 0 || wc.x >= W || wc.y >= H) continue;
        const cx = (wc.x + 0.5) * cell;
        const cy = (wc.y + 0.5) * cell;
        const orphan = !port.connects;
        const hot = highlight.has('port:' + port.id);
        const cls = ['port', orphan ? 'port-orphan' : 'port-linked', hot ? 'port-hot' : ''].filter(Boolean).join(' ');
        root.appendChild(el('rect', {
          x: cx - cell * 0.14, y: cy - cell * 0.14,
          width: cell * 0.28, height: cell * 0.28, rx: 2, class: cls,
        }));
      }
    }
  }

  window.DungeonRender = { render, portEdgePoint, CELL };
})();
