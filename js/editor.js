/* 行为树画布编辑器：SVG 渲染、平移缩放、节点拖动、拖拽连线与结构校验 */
(function (global) {
  'use strict';

  const NODE_W = 168;
  const NODE_H_BASE = 54;       // 无子标题行时
  const NODE_H_FULL = 68;       // 含参数摘要行时
  const PORT_R = 6;

  const NS = 'http://www.w3.org/2000/svg';

  class Editor {
    /**
     * @param opts { svg, getTree, getNodeStatus, getEdgeStatus, isActive,
     *               onSelect, onChange, onConnect, onDeleteSelection }
     */
    constructor(opts) {
      this.svg = opts.svg;
      this.getTree = opts.getTree;
      this.getNodeStatus = opts.getNodeStatus || (() => 'idle');
      this.getEdgeStatus = opts.getEdgeStatus || (() => 'idle');
      this.isActive = opts.isActive || (() => false);
      this.onSelect = opts.onSelect || (() => {});
      this.onChange = opts.onChange || (() => {});
      this.onConnect = opts.onConnect;                 // (parentId, childId) => {ok, reason}
      this.onDeleteSelection = opts.onDeleteSelection || (() => {});

      this.viewRoot = document.getElementById('viewRoot');
      this.nodeLayer = document.getElementById('nodeLayer');
      this.edgeLayer = document.getElementById('edgeLayer');
      this.ghost = document.getElementById('ghostEdge');

      this.scale = 1;
      this.tx = 0;
      this.ty = 0;
      this.selected = { kind: null, id: null };
      this.pendingFrom = null;   // 连线拖拽起点 { nodeId, port:'top'|'bottom', x, y }
      this.dragNode = null;
      this.pan = null;

      this._bindEvents();
    }

    /* ---------------- 视图变换 ---------------- */

    _applyTransform() {
      this.viewRoot.setAttribute('transform', `translate(${this.tx},${this.ty}) scale(${this.scale})`);
      const label = document.getElementById('zoomLabel');
      if (label) label.textContent = Math.round(this.scale * 100) + '%';
    }

    setZoom(s, cx, cy) {
      const next = BTUtils.clamp(s, 0.35, 2.2);
      if (cx == null) {
        const rect = this.svg.getBoundingClientRect();
        cx = rect.width / 2; cy = rect.height / 2;
      }
      // 以光标为锚点缩放
      const wx = (cx - this.tx) / this.scale;
      const wy = (cy - this.ty) / this.scale;
      this.scale = next;
      this.tx = cx - wx * this.scale;
      this.ty = cy - wy * this.scale;
      this._applyTransform();
    }

    resetView() {
      this.scale = 1; this.tx = 0; this.ty = 0;
      this._applyTransform();
    }

    fitView(padding) {
      const tree = this.getTree();
      const rect = this.svg.getBoundingClientRect();
      if (!tree.nodes.length) { this.resetView(); return; }
      const minX = Math.min(...tree.nodes.map((n) => n.x)) - NODE_W / 2 - (padding || 40);
      const maxX = Math.max(...tree.nodes.map((n) => n.x)) + NODE_W / 2 + (padding || 40);
      const minY = Math.min(...tree.nodes.map((n) => n.y)) - 20;
      const maxY = Math.max(...tree.nodes.map((n) => n.y)) + NODE_H_FULL + 20;
      const w = maxX - minX, h = maxY - minY;
      this.scale = BTUtils.clamp(Math.min(rect.width / w, rect.height / h), 0.35, 1.4);
      this.tx = (rect.width - w * this.scale) / 2 - minX * this.scale;
      this.ty = (rect.height - h * this.scale) / 2 - minY * this.scale;
      this._applyTransform();
    }

    _toWorld(clientX, clientY) {
      const rect = this.svg.getBoundingClientRect();
      return {
        x: (clientX - rect.left - this.tx) / this.scale,
        y: (clientY - rect.top - this.ty) / this.scale
      };
    }

    /* ---------------- 渲染 ---------------- */

    render() {
      const tree = this.getTree();
      this.nodeLayer.innerHTML = '';
      this.edgeLayer.innerHTML = '';
      const roots = BTEngineNS.findRoots(tree);
      const rootId = roots.length === 1 ? roots[0].id : null;

      // 先画连线（在节点下层）
      for (const e of tree.edges) {
        const parent = tree.nodes.find((n) => n.id === e.from);
        const child = tree.nodes.find((n) => n.id === e.to);
        if (!parent || !child) continue;
        this._renderEdge(e, parent, child);
      }
      // 再画节点
      for (const node of tree.nodes) {
        this._renderNode(node, node.id === rootId);
      }
      this._applyTransform();
    }

    _renderEdge(edge, parent, child) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'edge ' + this._statusClass(this.getEdgeStatus(edge.id)) +
        (this.selected.kind === 'edge' && this.selected.id === edge.id ? ' selected' : ''));
      g.dataset.edgeId = edge.id;

      const x1 = parent.x, y1 = parent.y + NODE_H_FULL;
      const x2 = child.x, y2 = child.y;
      const midY = (y1 + y2) / 2;
      const d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;

      const wide = document.createElementNS(NS, 'path');
      wide.setAttribute('d', d);
      wide.setAttribute('class', 'edge-hit');
      wide.setAttribute('stroke', 'transparent');
      wide.setAttribute('stroke-width', '14');
      wide.setAttribute('fill', 'none');
      wide.style.cursor = 'pointer';

      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'edge-path');

      g.appendChild(wide);
      g.appendChild(path);
      this.edgeLayer.appendChild(g);
    }

    _renderNode(node, isRoot) {
      const g = document.createElementNS(NS, 'g');
      const status = this.getNodeStatus(node.id);
      const active = this.isActive(node.id);
      g.setAttribute('class',
        `node-card type-${node.type} st-${status} ${active ? 'active' : ''} ` +
        (this.selected.kind === 'node' && this.selected.id === node.id ? 'selected' : ''));
      g.setAttribute('transform', `translate(${node.x},${node.y})`);
      g.dataset.nodeId = node.id;

      const meta = BTEngineNS.NODE_TYPES[node.type];
      const sub = this._paramSummary(node);
      const h = sub ? NODE_H_FULL : NODE_H_BASE;

      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('class', 'node-rect');
      rect.setAttribute('width', NODE_W);
      rect.setAttribute('height', h);

      const kind = document.createElementNS(NS, 'text');
      kind.setAttribute('class', 'node-kind');
      kind.setAttribute('x', 10);
      kind.setAttribute('y', 16);
      kind.textContent = meta.label.toUpperCase() + (node.type === 'loop' ? ` ×${node.params.count === '' ? '∞' : node.params.count}` : '');

      if (isRoot) {
        const flag = document.createElementNS(NS, 'text');
        flag.setAttribute('class', 'root-flag');
        flag.setAttribute('x', NODE_W - 10);
        flag.setAttribute('y', 16);
        flag.setAttribute('text-anchor', 'end');
        flag.textContent = 'ROOT';
        g.appendChild(flag);
      }

      const title = document.createElementNS(NS, 'text');
      title.setAttribute('class', 'node-title');
      title.setAttribute('x', 10);
      title.setAttribute('y', 36);
      title.textContent = node.name;

      g.appendChild(rect);
      g.appendChild(kind);
      g.appendChild(title);

      if (sub) {
        const subText = document.createElementNS(NS, 'text');
        subText.setAttribute('class', 'node-sub');
        subText.setAttribute('x', 10);
        subText.setAttribute('y', 55);
        subText.textContent = sub.length > 26 ? sub.slice(0, 25) + '…' : sub;
        g.appendChild(subText);
      }

      // 状态指示灯（右上角小圆）
      const led = document.createElementNS(NS, 'circle');
      led.setAttribute('class', 'status-led');
      led.setAttribute('cx', NODE_W - 12);
      led.setAttribute('cy', h - 11);
      led.setAttribute('r', 5);
      led.setAttribute('fill', this._statusColor(status));
      g.appendChild(led);

      // 端口：top=作为子节点的入口，bottom=作为父节点的出口
      const topPort = document.createElementNS(NS, 'circle');
      topPort.setAttribute('class', 'port port-top');
      topPort.setAttribute('cx', 0);
      topPort.setAttribute('cy', 0);
      topPort.setAttribute('r', PORT_R);
      topPort.dataset.port = 'top';
      const bottomPort = document.createElementNS(NS, 'circle');
      bottomPort.setAttribute('class', 'port port-bottom');
      bottomPort.setAttribute('cx', 0);
      bottomPort.setAttribute('cy', h);
      bottomPort.setAttribute('r', PORT_R);
      bottomPort.dataset.port = 'bottom';
      g.appendChild(topPort);
      g.appendChild(bottomPort);

      this.nodeLayer.appendChild(g);
    }

    _paramSummary(node) {
      const p = node.params;
      switch (node.type) {
        case 'condition':
          return p.key ? `${p.key} ${p.op} ${p.value}` : '未选择黑板字段';
        case 'action': {
          const meta = BTSim.ACTION_TYPES[p.actionType];
          const label = meta ? meta.label : p.actionType;
          if (p.actionType === 'goto') return `${label} → ${p.target}`;
          if (p.actionType === 'wait') return `${label} ${p.duration}ms`;
          if (p.actionType === 'log') return `${label}：${p.text || '（空）'}`;
          if (p.actionType === 'setBlackboard') {
            return p.mode === 'increment'
              ? `${label}：${p.key} += ${p.value}${p.modulo ? ' mod ' + p.modulo : ''}`
              : `${label}：${p.key} = ${p.value}`;
          }
          if (p.actionType === 'patrol') return `${label} 速度${p.speed}`;
          return label;
        }
        case 'loop':
          return p.count === '' || Number(p.count) === 0 ? '无限循环' : `循环 ${p.count} 次`;
        default:
          return '';
      }
    }

    _statusClass(s) { return s && s !== 'idle' ? 'st-' + s : ''; }
    _statusColor(s) {
      return {
        success: '#36c46e',
        failure: '#e5534b',
        running: '#e3a008',
        idle: '#5a6472'
      }[s] || '#5a6472';
    }

    /** 只刷新状态着色，不重建整个 DOM（运行期每 tick 调用，避免打断拖动） */
    refreshStatus() {
      const tree = this.getTree();
      for (const n of tree.nodes) {
        const g = this.nodeLayer.querySelector(`.node-card[data-node-id="${n.id}"]`);
        if (!g) continue;
        const status = this.getNodeStatus(n.id);
        g.setAttribute('class',
          `node-card type-${n.type} st-${status} ${this.isActive(n.id) ? 'active' : ''} ` +
          (this.selected.kind === 'node' && this.selected.id === n.id ? 'selected' : ''));
        const led = g.querySelector('.status-led');
        if (led) led.setAttribute('fill', this._statusColor(status));
      }
      for (const e of tree.edges) {
        const g = this.edgeLayer.querySelector(`.edge[data-edge-id="${e.id}"]`);
        if (!g) continue;
        g.setAttribute('class', 'edge ' + this._statusClass(this.getEdgeStatus(e.id)) +
          (this.selected.kind === 'edge' && this.selected.id === e.id ? ' selected' : ''));
      }
    }

    /* ---------------- 交互 ---------------- */

    _bindEvents() {
      this.svg.addEventListener('pointerdown', (ev) => this._onPointerDown(ev));
      window.addEventListener('pointermove', (ev) => this._onPointerMove(ev));
      window.addEventListener('pointerup', (ev) => this._onPointerUp(ev));
      this.svg.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const rect = this.svg.getBoundingClientRect();
        const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.setZoom(this.scale * factor, ev.clientX - rect.left, ev.clientY - rect.top);
      }, { passive: false });
      window.addEventListener('keydown', (ev) => {
        if ((ev.key === 'Delete' || ev.key === 'Backspace') &&
            !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
          if (this.selected.kind) {
            ev.preventDefault();
            this.onDeleteSelection();
          }
        }
      });
    }

    _onPointerDown(ev) {
      const portEl = ev.target.closest && ev.target.closest('.port');
      if (portEl) {
        const card = portEl.closest('.node-card');
        const nodeId = card.dataset.nodeId;
        const rect = this.svg.getBoundingClientRect();
        this.pendingFrom = {
          nodeId,
          port: portEl.dataset.port,
          x: ev.clientX - rect.left,
          y: ev.clientY - rect.top
        };
        this.ghost.setAttribute('visibility', 'visible');
        return;
      }

      const nodeEl = ev.target.closest && ev.target.closest('.node-card');
      if (nodeEl) {
        const nodeId = nodeEl.dataset.nodeId;
        this.select({ kind: 'node', id: nodeId });
        const w = this._toWorld(ev.clientX, ev.clientY);
        const node = this.getTree().nodes.find((n) => n.id === nodeId);
        this.dragNode = { id: nodeId, offX: w.x - node.x, offY: w.y - node.y, moved: false };
        this.svg.setPointerCapture && this.svg.setPointerCapture(ev.pointerId);
        return;
      }

      const edgeEl = ev.target.closest && ev.target.closest('.edge');
      if (edgeEl) {
        this.select({ kind: 'edge', id: edgeEl.dataset.edgeId });
        return;
      }

      // 空白处：开始平移并取消选择
      const rect = this.svg.getBoundingClientRect();
      this.pan = { sx: ev.clientX, sy: ev.clientY, tx: this.tx, ty: this.ty };
      this.svg.classList.add('panning');
      this.select({ kind: null, id: null });
    }

    _onPointerMove(ev) {
      const rect = this.svg.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;

      if (this.pendingFrom) {
        const tree = this.getTree();
        const node = tree.nodes.find((n) => n.id === this.pendingFrom.nodeId);
        const from = this.pendingFrom.port === 'bottom'
          ? { x: node.x, y: node.y + NODE_H_FULL }
          : { x: node.x, y: node.y };
        const w = this._toWorld(ev.clientX, ev.clientY);
        const midY = (from.y + w.y) / 2;
        this.ghost.setAttribute('d',
          `M ${from.x} ${from.y} C ${from.x} ${midY}, ${w.x} ${midY}, ${w.x} ${w.y}`);
        return;
      }
      if (this.dragNode) {
        const w = this._toWorld(ev.clientX, ev.clientY);
        const node = this.getTree().nodes.find((n) => n.id === this.dragNode.id);
        node.x = Math.round(w.x - this.dragNode.offX);
        node.y = Math.round(w.y - this.dragNode.offY);
        this.dragNode.moved = true;
        this.render();
        return;
      }
      if (this.pan) {
        this.tx = this.pan.tx + (ev.clientX - this.pan.sx);
        this.ty = this.pan.ty + (ev.clientY - this.pan.sy);
        this._applyTransform();
      }
    }

    _onPointerUp(ev) {
      if (this.pendingFrom) {
        const portEl = document.elementFromPoint(ev.clientX, ev.clientY);
        const targetPort = portEl && portEl.closest && portEl.closest('.port');
        if (targetPort) {
          const targetCard = targetPort.closest('.node-card');
          const targetNodeId = targetCard.dataset.nodeId;
          const from = this.pendingFrom;
          // bottom 端口拖出的是父，top 端口拖出的是子
          const parentId = from.port === 'bottom' ? from.nodeId : targetNodeId;
          const childId = from.port === 'bottom' ? targetNodeId : from.nodeId;
          if (targetPort.dataset.port === from.port) {
            this._connectReject('请从一个节点的底部圆点连到另一个节点的顶部圆点（父 → 子）');
          } else if (parentId === childId) {
            this._connectReject('不能把节点连接到自身');
          } else {
            const result = this.onConnect(parentId, childId);
            if (result && !result.ok) this._connectReject(result.reason);
          }
        }
        this.pendingFrom = null;
        this.ghost.setAttribute('visibility', 'hidden');
        this.ghost.setAttribute('d', '');
      }
      if (this.dragNode) {
        if (this.dragNode.moved) this.onChange();
        this.dragNode = null;
      }
      if (this.pan) {
        this.pan = null;
        this.svg.classList.remove('panning');
      }
    }

    _connectReject(reason) {
      // 通过自定义事件把非法原因交给 app 弹 toast
      this.svg.dispatchEvent(new CustomEvent('bt-connect-rejected', { detail: { reason } }));
    }

    select(sel) {
      this.selected = sel;
      this.render();
      this.onSelect(sel);
    }

    getSelection() { return this.selected; }
  }

  const api = { Editor, NODE_W, NODE_H_FULL, NODE_H_BASE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BTEditor = api;
})(typeof window !== 'undefined' ? window : globalThis);
