/* 跑道地图：SVG 绘制。命中检测在弧长空间做（沿折线取最近 s），
   交叉点处 x/y 相同但 s 不同，因此点击不会跳到另一个同位置区段。 */
(function (global) {
  "use strict";

  function MapView(svg, track) {
    this.svg = svg;
    this.track = track;
    this.W = 560;
    this.H = 380;
    this.M = 34;
    this._computeProjection();
    this.onSegmentClick = null;
    this._buildBase();
  }

  MapView.prototype._computeProjection = function () {
    const xs = this.track.wps.map(function (p) { return p.x; });
    const ys = this.track.wps.map(function (p) { return p.y; });
    const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    const sx = (this.W - 2 * this.M) / (maxX - minX);
    const sy = (this.H - 2 * this.M) / (maxY - minY);
    const k = Math.min(sx, sy);
    const ox = (this.W - k * (maxX - minX)) / 2 - k * minX;
    const oy = (this.H - k * (maxY - minY)) / 2 - k * minY;
    this.proj = function (x, y) { return [ox + k * x, oy - k * y]; };
  };

  MapView.prototype._path = function (s0, s1) {
    const wps = this.track.wps;
    const i0 = Math.max(0, Math.floor(s0 / this.track.length * this.track.n));
    const i1 = Math.min(this.track.n, Math.ceil(s1 / this.track.length * this.track.n));
    let d = "";
    for (let i = i0; i <= i1; i++) {
      const p = this.proj(wps[i].x, wps[i].y);
      d += (i === i0 ? "M" : "L") + p[0].toFixed(1) + " " + p[1].toFixed(1);
    }
    return d;
  };

  MapView.prototype._buildBase = function () {
    const self = this;
    const NS = "http://www.w3.org/2000/svg";
    this.svg.innerHTML = "";
    this.svg.setAttribute("viewBox", "0 0 " + this.W + " " + this.H);
    this.svg.classList.add("map");

    // 底轨
    const base = document.createElementNS(NS, "path");
    base.setAttribute("d", this._path(0, this.track.length));
    base.setAttribute("class", "track-base");
    this.svg.appendChild(base);

    // 分段叠加层（透明宽描边做命中区）
    this.segLayer = document.createElementNS(NS, "g");
    this.track.segments().forEach(function (seg) {
      const hit = document.createElementNS(NS, "path");
      hit.setAttribute("d", self._path(seg.s0, seg.s1));
      hit.setAttribute("class", "seg-hit");
      hit.addEventListener("click", function () {
        if (self.onSegmentClick) self.onSegmentClick(seg.index);
      });
      hit.appendChild(document.createElementNS(NS, "title"))
        .textContent = "段" + (seg.index + 1) + "：" + seg.name +
          "（" + seg.length.toFixed(0) + "m），点击回放该段";
      self.segLayer.appendChild(hit);

      const thin = document.createElementNS(NS, "path");
      thin.setAttribute("d", self._path(seg.s0, seg.s1));
      thin.setAttribute("class", "seg-line seg-line-" + seg.index);
      self.segLayer.appendChild(thin);
    });
    this.svg.appendChild(this.segLayer);

    // 交叉点标注
    this.track.crossings.forEach(function (s) {
      const p = self.track.xyAt(s);
      const xy = self.proj(p.x, p.y);
      const g = document.createElementNS(NS, "g");
      const ring = document.createElementNS(NS, "circle");
      ring.setAttribute("cx", xy[0]); ring.setAttribute("cy", xy[1]);
      ring.setAttribute("r", 6); ring.setAttribute("class", "crossing");
      g.appendChild(ring);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", xy[0] + 10); t.setAttribute("y", xy[1] - 8);
      t.setAttribute("class", "crossing-label");
      t.textContent = "交叉点 s=" + s.toFixed(0) + "m";
      g.appendChild(t);
      g.appendChild(document.createElementNS(NS, "title"))
        .textContent = "两条区段在此空间相交，弧长不同；点击按 s 命中，不会串段";
      self.svg.appendChild(g);
    });

    // 检查点
    this.cpLayer = document.createElementNS(NS, "g");
    this.track.checkpoints.forEach(function (cp, idx) {
      const p = self.track.xyAt(cp.s);
      const xy = self.proj(p.x, p.y);
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "cp-group cp-" + cp.id);
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", xy[0]); c.setAttribute("cy", xy[1]);
      c.setAttribute("r", idx === 0 || cp.isFinish ? 7 : 5);
      c.setAttribute("class", "cp-dot");
      g.appendChild(c);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", xy[0] + 9); t.setAttribute("y", xy[1] + 4);
      t.setAttribute("class", "cp-label");
      t.textContent = cp.name + " (" + cp.s.toFixed(0) + "m)";
      g.appendChild(t);
      self.cpLayer.appendChild(g);
    });
    this.svg.appendChild(this.cpLayer);

    // 两台车的标记与尾迹
    this.markers = {};
    this.trails = {};
    ["baseline", "comparison"].forEach(function (role) {
      const trail = document.createElementNS(NS, "path");
      trail.setAttribute("class", "trail trail-" + role);
      self.svg.appendChild(trail);
      self.trails[role] = trail;

      const m = document.createElementNS(NS, "g");
      m.setAttribute("class", "marker marker-" + role);
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("r", 7); dot.setAttribute("class", "marker-dot");
      const ring = document.createElementNS(NS, "circle");
      ring.setAttribute("r", 11); ring.setAttribute("class", "marker-ring");
      const t = document.createElementNS(NS, "text");
      t.setAttribute("class", "marker-text"); t.setAttribute("y", -12);
      m.appendChild(ring); m.appendChild(dot); m.appendChild(t);
      self.svg.appendChild(m);
      this.markers[role] = { g: m, dot: dot, text: t };
    }, this);
  };

  /* 高亮某一分段 */
  MapView.prototype.highlightSegment = function (idx) {
    this.segLayer.querySelectorAll(".seg-line").forEach(function (el, i) {
      el.classList.toggle("seg-active", i === idx);
    });
  };

  /* 领先路段着色（在分段描边上叠加颜色段） */
  MapView.prototype.renderLeaders = function (profile) {
    const NS = "http://www.w3.org/2000/svg";
    if (this.leaderLayer) this.svg.removeChild(this.leaderLayer);
    const layer = document.createElementNS(NS, "g");
    layer.setAttribute("class", "leader-layer");
    profile.forEach(function (span) {
      if (span.leader === "tie") return;
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", this._path(span.s0, span.s1));
      path.setAttribute("class", "leader leader-" + span.leader);
      layer.appendChild(path);
    }, this);
    this.svg.insertBefore(layer, this.cpLayer);
    this.leaderLayer = layer;
  };

  MapView.prototype.clearLeaders = function () {
    if (this.leaderLayer) { this.svg.removeChild(this.leaderLayer); this.leaderLayer = null; }
  };

  /* 更新车辆位置。state: {kind, s}；unknown 时画成空心问号标记 */
  MapView.prototype.updateMarker = function (role, state, label) {
    const m = this.markers[role];
    if (!state || state.kind === "outside" || state.s === null || state.s === undefined) {
      m.g.style.display = "none";
      return;
    }
    m.g.style.display = "";
    const p = this.track.xyAt(state.s);
    const xy = this.proj(p.x, p.y);
    m.g.setAttribute("transform", "translate(" + xy[0].toFixed(1) + "," + xy[1].toFixed(1) + ")");
    m.dot.classList.toggle("marker-unknown", state.kind === "unknown");
    m.dot.classList.toggle("marker-interp", state.kind === "interpolated");
    m.text.textContent = label;
  };

  MapView.prototype.updateTrail = function (role, run, tMs) {
    // 尾迹只画到当前时刻；无证据区间断开
    const wps = this.track.wps;
    let d = "", pen = null;
    const samples = run.samples;
    for (let i = 0; i < samples.length && samples[i].t <= tMs; i++) {
      const q = samples[i];
      if (q.flags.backward || q.flags.implausible) { pen = null; continue; }
      if (i > 0) {
        const gap = run.gaps.find(function (g) { return g.t0 === samples[i - 1].t && g.t1 === q.t; });
        if (gap && !gap.interpolable) { pen = null; continue; }
      }
      const p = this.track.xyAt(q.s);
      const xy = this.proj(p.x, p.y);
      d += (pen ? "L" : "M") + xy[0].toFixed(1) + " " + xy[1].toFixed(1);
      pen = xy;
    }
    this.trails[role].setAttribute("d", d);
  };

  MapView.prototype.resetTrails = function () {
    Object.keys(this.trails).forEach(function (k) {
      this.trails[k].setAttribute("d", "");
    }, this);
  };

  global.GhostMap = MapView;
})(window);
