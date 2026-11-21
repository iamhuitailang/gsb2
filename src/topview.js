/* 顶视图：Canvas 2D，拖动控制点、滚轮缩放、显示中心线/路面轮廓/问题位置/选中段 */
(function (root) {
  'use strict';

  function TopView(canvas, callbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = callbacks || {};
    this.scale = 6;          // 世界单位 → 像素
    this.offset = { x: 0, y: 0 };
    this.dragIndex = -1;
    this.hoverIndex = -1;
    this.selected = -1;
    this.closed = true;
    this.controlPoints = [];
    this.road = null;
    this.issues = [];

    this._bind();
    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    this.resize();
  }

  TopView.prototype.resize = function () {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(50, rect.width) * dpr;
    this.canvas.height = Math.max(50, rect.height) * dpr;
    this.dpr = dpr;
    this.w = rect.width; this.h = rect.height;
    this.draw();
  };

  TopView.prototype.setData = function (controlPoints, closed, road, issues, selected) {
    this.controlPoints = controlPoints;
    this.closed = closed;
    this.road = road;
    this.issues = issues || [];
    this.selected = selected;
    this.draw();
  };

  TopView.prototype.setSelected = function (i) { this.selected = i; this.draw(); };

  TopView.prototype._bind = function () {
    const c = this.canvas;
    c.addEventListener('mousedown', (e) => this._onDown(e));
    window.addEventListener('mousemove', (e) => this._onMove(e));
    window.addEventListener('mouseup', () => { this.dragIndex = -1; c.style.cursor = 'crosshair'; });
    c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    c.addEventListener('dblclick', (e) => this._onDblClick(e));
  };

  TopView.prototype._toScreen = function (p) {
    return {
      x: this.w / 2 + (p[0] + this.offset.x) * this.scale,
      y: this.h / 2 - (p[1] + this.offset.y) * this.scale, // y 翻转，世界 y 向上
    };
  };
  TopView.prototype._toWorld = function (sx, sy) {
    const rect = this.canvas.getBoundingClientRect();
    const x = sx - rect.left, y = sy - rect.top;
    return [
      (x - this.w / 2) / this.scale - this.offset.x,
      -((y - this.h / 2) / this.scale) - this.offset.y,
    ];
  };
  TopView.prototype._hit = function (e) {
    const w = this._toWorld(e.clientX, e.clientY);
    const tol = 11 / this.scale;
    for (let i = 0; i < this.controlPoints.length; i++) {
      const p = this.controlPoints[i];
      if (Math.hypot(p[0] - w[0], p[1] - w[1]) <= tol) return i;
    }
    return -1;
  };

  TopView.prototype._onDown = function (e) {
    const i = this._hit(e);
    if (i >= 0) {
      this.dragIndex = i;
      this.selected = i;
      this.canvas.style.cursor = 'grabbing';
      this.cb.onSelect && this.cb.onSelect(i);
      this.draw();
    }
  };
  TopView.prototype._onMove = function (e) {
    if (this.dragIndex < 0) {
      const h = this._hit(e);
      if (h !== this.hoverIndex) {
        this.hoverIndex = h;
        this.canvas.style.cursor = h >= 0 ? 'grab' : 'crosshair';
      }
      return;
    }
    const w = this._toWorld(e.clientX, e.clientY);
    const p = this.controlPoints[this.dragIndex];
    // 顶视图只改 x/y，保留 z 高程
    this.cb.onDrag && this.cb.onDrag(this.dragIndex, [w[0], w[1], p[2]]);
  };
  TopView.prototype._onWheel = function (e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.scale = Math.max(1.5, Math.min(40, this.scale * factor));
    this.draw();
  };
  TopView.prototype._onDblClick = function (e) {
    const w = this._toWorld(e.clientX, e.clientY);
    this.cb.onAddAt && this.cb.onAddAt(w);
  };

  TopView.prototype._path = function (pts, closed) {
    const ctx = this.ctx;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const s = this._toScreen(p);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    if (closed) ctx.closePath();
  };

  TopView.prototype.draw = function () {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.w, this.h);

    // 背景网格
    ctx.strokeStyle = '#222a35'; ctx.lineWidth = 1;
    const gridWorld = 10;
    const px = gridWorld * this.scale;
    const ox = (this.w / 2 + this.offset.x * this.scale) % px;
    const oy = (this.h / 2 + this.offset.y * this.scale) % px;
    ctx.beginPath();
    for (let x = ox; x < this.w; x += px) { ctx.moveTo(x, 0); ctx.lineTo(x, this.h); }
    for (let y = oy; y < this.h; y += px) { ctx.moveTo(0, y); ctx.lineTo(this.w, y); }
    ctx.stroke();

    if (!this.controlPoints.length) { ctx.restore(); return; }

    // 路面轮廓（左右边缘 + 闭合填充）
    if (this.road) {
      const left = this.road.edges.left.map((p) => [p[0], p[1]]);
      const right = this.road.edges.right.map((p) => [p[0], p[1]]);
      const outline = left.concat(right.reverse());
      this._path(outline, true);
      ctx.fillStyle = 'rgba(90,130,180,0.16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(150,190,240,0.55)';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // 网格环线（每隔若干环画一条，反映弧长分布）
      ctx.strokeStyle = 'rgba(140,180,230,0.35)';
      ctx.lineWidth = 0.8;
      const stride = Math.max(1, Math.floor(this.road.rings.length / 60));
      ctx.beginPath();
      for (let i = 0; i < this.road.rings.length; i += stride) {
        const ring = this.road.rings[i];
        const a = this._toScreen(root.RoadMesh.sectionPoint(ring.frame, 1));
        const b = this._toScreen(root.RoadMesh.sectionPoint(ring.frame, -1));
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();

      // 中心线
      const center = this.road.edges.center.map((p) => [p[0], p[1]]);
      this._path(center, this.closed);
      ctx.strokeStyle = '#ffe9a8'; ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    // 样条控制中心线（无 road 数据时的兜底）
    if (!this.road && this.controlPoints.length >= 2) {
      this._path(this.controlPoints, this.closed);
      ctx.strokeStyle = '#6b7686';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    // 问题位置
    this.issues.forEach((iss) => {
      const pt = iss.point;
      if (!pt) return;
      const s = this._toScreen(pt);
      const isErr = /fold|intersection|crossing|overslope/.test(iss.type);
      ctx.beginPath();
      ctx.arc(s.x, s.y, isErr ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = isErr ? 'rgba(255,80,80,0.9)' : 'rgba(245,185,69,0.9)';
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
    });

    // 控制点连线（控制多边形）
    this._path(this.controlPoints, this.closed);
    ctx.strokeStyle = 'rgba(180,190,205,0.4)';
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
    ctx.stroke(); ctx.setLineDash([]);

    // 控制点
    this.controlPoints.forEach((p, i) => {
      const s = this._toScreen(p);
      let r = 5, fill = '#4ea1ff';
      if (i === this.selected) { r = 7; fill = '#ffd166'; }
      else if (i === this.hoverIndex) { r = 6.5; fill = '#8fc4ff'; }
      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#cdd6e2'; ctx.font = '10px monospace';
      ctx.fillText('P' + i, s.x + 8, s.y - 7);
    });

    ctx.restore();
  };

  root.RoadTopView = TopView;
})(window);
