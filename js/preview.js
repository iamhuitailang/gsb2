/*
 * preview.js — 单个预览：设备框、组件渲染、命中测试、拖动改约束、辅助线
 * 所有坐标换算都基于屏幕坐标/缩放比，保证缩放下点击与拖动仍落在正确组件上
 */
(function (root) {
  'use strict';
  var M = root.ULCModel;
  var E = root.ULCEngine;

  function PreviewView(opts) {
    this.container = opts.container;
    this.onSelect = opts.onSelect || function () {};
    this.onChange = opts.onChange || function () {};
    this.onHitTest = opts.onHitTest || function () {};
    this.scale = 1;
    this.selectedId = null;
    this.result = null;
    this.nodes = [];
    this.screen = null;
    this.showGuides = true;
    this.drag = null;
    this._bind();
  }

  PreviewView.prototype._bind = function () {
    var self = this;
    var stage = this.container.querySelector('.pv-stage');

    stage.addEventListener('click', function (ev) {
      if (self._dragged) { self._dragged = false; return; }
      var p = self.toScreenPoint(ev);
      var id = E.hitTest(self.result, p.x, p.y);
      self.onSelect(id);
    });

    stage.addEventListener('mousemove', function (ev) {
      var p = self.toScreenPoint(ev);
      var id = E.hitTest(self.result, p.x, p.y);
      stage.style.cursor = id ? 'pointer' : 'default';
      self.onHitTest(p, id);
      if (self.drag) self._applyDrag(ev);
    });

    stage.addEventListener('mousedown', function (ev) {
      var p = self.toScreenPoint(ev);
      var id = E.hitTest(self.result, p.x, p.y);
      if (!id) return;
      var node = M.findNode(self.nodes, id);
      if (!node) return;
      ev.preventDefault();
      self.drag = {
        id: id,
        startX: p.x, startY: p.y,
        moved: false,
        origLeft: node.leftAnchor, origRight: node.rightAnchor,
        origTop: node.topAnchor, origBottom: node.bottomAnchor
      };
    });

    window.addEventListener('mouseup', function () {
      if (self.drag) {
        if (!self.drag.moved) { /* 普通点击交给 click */ }
        self.drag = null;
      }
    });
  };

  PreviewView.prototype._applyDrag = function (ev) {
    var p = this.toScreenPoint(ev);
    var d = this.drag;
    var dx = p.x - d.startX, dy = p.y - d.startY;
    if (Math.abs(dx) + Math.abs(dy) < 2) return;
    d.moved = true;
    this._dragged = true;
    var node = M.findNode(this.nodes, d.id);
    var frame = this.result.frames[d.id];
    if (!frame) return;

    // 水平：有锚点就改对应边距；无锚点（流式子项）则整体不能拖
    if (Math.abs(dx) >= Math.abs(dy)) {
      if (node.leftAnchor) {
        var la = cloneAnchor(node.leftAnchor);
        if (la.mode === 'fixed') {
          la.value = clamp((d.origLeft ? d.origLeft.value : la.value) + dx, 0, this.screen.w);
          this.onChange({ kind: 'setAnchor', nodeId: d.id, slot: 'leftAnchor', anchor: la });
        }
      } else if (node.rightAnchor) {
        var ra = cloneAnchor(node.rightAnchor);
        if (ra.mode === 'fixed') {
          ra.value = clamp((d.origRight ? d.origRight.value : ra.value) - dx, 0, this.screen.w);
          this.onChange({ kind: 'setAnchor', nodeId: d.id, slot: 'rightAnchor', anchor: ra });
        }
      }
    } else {
      if (node.topAnchor) {
        var ta = cloneAnchor(node.topAnchor);
        if (ta.mode === 'fixed') {
          ta.value = clamp((d.origTop ? d.origTop.value : ta.value) + dy, 0, this.screen.h);
          this.onChange({ kind: 'setAnchor', nodeId: d.id, slot: 'topAnchor', anchor: ta });
        }
      } else if (node.bottomAnchor) {
        var ba = cloneAnchor(node.bottomAnchor);
        if (ba.mode === 'fixed') {
          ba.value = clamp((d.origBottom ? d.origBottom.value : ba.value) - dy, 0, this.screen.h);
          this.onChange({ kind: 'setAnchor', nodeId: d.id, slot: 'bottomAnchor', anchor: ba });
        }
      }
    }
  };

  PreviewView.prototype.toScreenPoint = function (ev) {
    var rect = this.container.querySelector('.pv-screen').getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left) / this.scale,
      y: (ev.clientY - rect.top) / this.scale
    };
  };

  PreviewView.prototype.render = function (params) {
    this.nodes = params.nodes;
    this.screen = params.screen;
    this.result = params.result;
    this.vars = params.vars;
    this.selectedId = params.selectedId;
    this.showGuides = params.showGuides;

    var stage = this.container.querySelector('.pv-stage');
    var sw = this.screen.w, sh = this.screen.h;
    var hostW = stage.clientWidth || 360;
    var hostH = stage.clientHeight || 520;
    this.scale = Math.min((hostW - 24) / sw, (hostH - 24) / sh, 1);

    var screenEl = this.container.querySelector('.pv-screen');
    screenEl.style.width = sw + 'px';
    screenEl.style.height = sh + 'px';
    screenEl.style.transform = 'scale(' + this.scale + ')';

    this._renderSafeArea(screenEl);
    this._renderNodes(screenEl);
    if (this.showGuides) this._renderGuides(screenEl);
    this._renderBadges();
  };

  PreviewView.prototype._renderSafeArea = function (screenEl) {
    var s = this.screen.safe;
    var el = screenEl.querySelector('.pv-safe');
    el.style.display = (s.top || s.right || s.bottom || s.left) ? 'block' : 'none';
    el.style.top = s.top + 'px';
    el.style.right = s.right + 'px';
    el.style.bottom = s.bottom + 'px';
    el.style.left = s.left + 'px';
  };

  PreviewView.prototype._renderNodes = function (screenEl) {
    var self = this;
    var layer = screenEl.querySelector('.pv-nodes');
    layer.innerHTML = '';
    var byId = {};
    this.nodes.forEach(function (n) { byId[n.id] = n; });

    this.result.order.forEach(function (id) {
      var node = byId[id];
      if (!node) return;
      var el = document.createElement('div');
      el.className = 'pv-node pv-' + node.type;
      el.dataset.id = id;
      var hidden = self.result.hiddenReason[id];
      if (hidden) {
        el.classList.add('pv-hidden');
        el.title = '主动隐藏：' + hidden.text;
      }
      var f = self.result.frames[id];
      if (f) {
        el.style.left = f.x + 'px';
        el.style.top = f.y + 'px';
        el.style.width = f.w + 'px';
        el.style.height = f.h + 'px';
      } else {
        el.style.display = 'none';
        return;
      }
      if (id === self.selectedId) el.classList.add('pv-selected');

      var issueOnNode = self.result.issues.some(function (iss) {
        return iss.nodeIds.indexOf(id) >= 0;
      });
      if (issueOnNode) el.classList.add('pv-has-issue');
      if (self.result.issues.some(function (iss) {
        return iss.kind === 'conflict' && iss.nodeIds.indexOf(id) >= 0;
      })) el.classList.add('pv-conflict');
      if (self.result.issues.some(function (iss) {
        return iss.type === 'clip' && iss.nodeIds.indexOf(id) >= 0;
      })) el.classList.add('pv-clipped');

      self._paintContent(el, node);
      layer.appendChild(el);
    });
  };

  PreviewView.prototype._paintContent = function (el, node) {
    if (node.type === 'icon') {
      el.innerHTML = root.ULCIcons.svg(node.icon, Math.min(22, node.width.value || 20));
      el.style.color = node.color;
    } else if (node.type === 'bar') {
      var fillVal = node.fillVar && this.vars[node.fillVar] != null
        ? Number(this.vars[node.fillVar]) : node.fill;
      var pct = Math.max(0, Math.min(1, fillVal / Math.max(1, node.fillMax)));
      el.innerHTML =
        '<div class="pv-bar-track">' +
        '<div class="pv-bar-fill" style="width:' + (pct * 100) + '%;background:' + node.color + '"></div>' +
        '</div>';
    } else if (node.type === 'edge') {
      el.classList.add('pv-edge-line');
      el.style.background = node.color;
    } else if (node.type === 'text') {
      var raw = root.ULCMeasure.resolveVar(node, this.vars);
      var f = this.result.frames[node.id];
      var shown = root.ULCMeasure.ellipsize(raw, node.maxWidth > 0 ? node.maxWidth : f.w - 4);
      el.textContent = shown;
      el.style.color = node.color;
    } else {
      if (node.color && node.color !== 'transparent') el.style.background = node.color;
    }
  };

  PreviewView.prototype._renderGuides = function (screenEl) {
    var layer = screenEl.querySelector('.pv-guides');
    layer.innerHTML = '';
    var self = this;
    this.nodes.forEach(function (n) {
      if (self.result.hiddenReason[n.id]) return;
      M.anchorSlots().forEach(function (slot) {
        var a = n[slot];
        if (!a) return;
        var line = document.createElement('div');
        line.className = 'pv-guide-line';
        var f = self.result.frames[n.id];
        if (!f) return;
        if (slot === 'leftAnchor' || slot === 'rightAnchor') {
          var x = a.ref === M.SCREEN_ID
            ? (a.edge === 'right' ? self.screen.w - (self.screen.safe.right || 0) : (self.screen.safe.left || 0))
            : (function () {
                var rf = self.result.frames[a.ref];
                return rf ? (a.edge === 'right' ? rf.x + rf.w : rf.x) : null;
              })();
          if (x == null) return;
          line.style.left = x + 'px';
          line.style.top = '0';
          line.style.width = '1px';
          line.style.height = '100%';
        } else {
          var y = a.ref === M.SCREEN_ID
            ? (a.edge === 'bottom' ? self.screen.h - (self.screen.safe.bottom || 0) : (self.screen.safe.top || 0))
            : (function () {
                var rf = self.result.frames[a.ref];
                return rf ? (a.edge === 'bottom' ? rf.y + rf.h : rf.y) : null;
              })();
          if (y == null) return;
          line.style.top = y + 'px';
          line.style.left = '0';
          line.style.height = '1px';
          line.style.width = '100%';
        }
        layer.appendChild(line);
      });
    });
  };

  PreviewView.prototype._renderBadges = function () {
    var bar = this.container.querySelector('.pv-legend');
    var hiddenCount = this.result.stats.hidden;
    var clipped = this.result.issues.filter(function (i) { return i.type === 'clip'; }).length;
    var occluded = this.result.issues.filter(function (i) { return i.type === 'occlusion'; }).length;
    bar.innerHTML =
      '<span class="lg lg-hidden">主动隐藏 ' + hiddenCount + '</span>' +
      '<span class="lg lg-clipped">被裁切 ' + clipped + '</span>' +
      '<span class="lg lg-occluded">被遮挡 ' + occluded + '</span>' +
      '<span class="lg lg-conflict">约束冲突 ' + this.result.stats.conflicts + '</span>';
  };

  function cloneAnchor(a) {
    return JSON.parse(JSON.stringify(a));
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  root.ULCPreviewView = PreviewView;
})(typeof self !== 'undefined' ? self : this);
