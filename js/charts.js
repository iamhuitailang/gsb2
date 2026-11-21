/* 两张 SVG 折线图：
   1) 差距-进度图：delta(s)，零线居中，无证据区间断开并灰显
   2) 时间-进度图：两趟各自 t(s)，用于按路线进度对齐观察
   均带十字线 + 提示层；悬停回调把当前 s 传给播放器做联动。 */
(function (global) {
  "use strict";

  const W = 720, H = 240, M = { t: 18, r: 16, b: 34, l: 52 };
  const NS = "http://www.w3.org/2000/svg";

  function LineChart(svg, opts) {
    this.svg = svg;
    this.opts = opts; // {xLabel, yLabel, zeroLine}
    this.onHover = null;
    this.svg.innerHTML = "";
    this.svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    this.svg.classList.add("chart");
    this._buildScaffold();
  }

  LineChart.prototype._buildScaffold = function () {
    const g = document.createElementNS(NS, "g");
    this.svg.appendChild(g);
    this.plot = g;

    this.gridLayer = document.createElementNS(NS, "g");
    this.seriesLayer = document.createElementNS(NS, "g");
    this.axisLayer = document.createElementNS(NS, "g");
    this.cross = document.createElementNS(NS, "g");
    this.cross.style.display = "none";
    this.crossLine = document.createElementNS(NS, "line");
    this.crossLine.setAttribute("class", "cross-line");
    this.crossDot = document.createElementNS(NS, "circle");
    this.crossDot.setAttribute("r", 4);
    this.crossDot.setAttribute("class", "cross-dot");
    this.cross.appendChild(this.crossLine);
    this.cross.appendChild(this.crossDot);

    g.appendChild(this.gridLayer);
    g.appendChild(this.seriesLayer);
    g.appendChild(this.axisLayer);
    g.appendChild(this.cross);

    this.tip = document.createElement("div");
    this.tip.className = "chart-tip";
    this.tip.style.display = "none";
    this.svg.parentNode.style.position = "relative";
    this.svg.parentNode.appendChild(this.tip);

    this.svg.addEventListener("mousemove", this._mouse.bind(this));
    this.svg.addEventListener("mouseleave", function () {
      this.cross.style.display = "none";
      this.tip.style.display = "none";
      if (this.onHover) this.onHover(null);
    }.bind(this));
  };

  LineChart.prototype._scales = function (series) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    series.forEach(function (s) {
      s.points.forEach(function (p) {
        if (p.y === null || Number.isNaN(p.y)) return;
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      });
    });
    if (!isFinite(x0)) { x0 = 0; x1 = 1; y0 = 0; y1 = 1; }
    if (this.opts.zeroLine) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    const pad = (y1 - y0) * 0.08;
    y0 -= pad; y1 += pad;
    this.x0 = x0; this.x1 = x1; this.y0 = y0; this.y1 = y1;
    this.sx = function (x) {
      return M.l + (x - x0) / Math.max(x1 - x0, 1e-9) * (W - M.l - M.r);
    };
    this.sy = function (y) {
      return H - M.b - (y - y0) / (y1 - y0) * (H - M.t - M.b);
    };
  };

  LineChart.prototype._grid = function (xTicks, yTicks, xFmt, yFmt) {
    const self = this;
    this.gridLayer.innerHTML = "";
    this.axisLayer.innerHTML = "";
    yTicks.forEach(function (v) {
      const y = self.sy(v);
      const ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", M.l); ln.setAttribute("x2", W - M.r);
      ln.setAttribute("y1", y); ln.setAttribute("y2", y);
      ln.setAttribute("class", v === 0 && self.opts.zeroLine ? "grid-zero" : "grid");
      self.gridLayer.appendChild(ln);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", M.l - 8); t.setAttribute("y", y + 4);
      t.setAttribute("class", "axis-text"); t.setAttribute("text-anchor", "end");
      t.textContent = yFmt(v);
      self.axisLayer.appendChild(t);
    });
    xTicks.forEach(function (v) {
      const x = self.sx(v);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", x); t.setAttribute("y", H - M.b + 18);
      t.setAttribute("class", "axis-text"); t.setAttribute("text-anchor", "middle");
      t.textContent = xFmt(v);
      self.axisLayer.appendChild(t);
    });
    const xl = document.createElementNS(NS, "text");
    xl.setAttribute("x", (W + M.l - M.r) / 2); xl.setAttribute("y", H - 4);
    xl.setAttribute("class", "axis-title"); xl.setAttribute("text-anchor", "middle");
    xl.textContent = this.opts.xLabel;
    this.axisLayer.appendChild(xl);

    const yl = document.createElementNS(NS, "text");
    yl.setAttribute("x", 14); yl.setAttribute("y", (H - M.b + M.t) / 2);
    yl.setAttribute("class", "axis-title");
    yl.setAttribute("transform", "rotate(-90 14 " + ((H - M.b + M.t) / 2) + ")");
    yl.setAttribute("text-anchor", "middle");
    yl.textContent = this.opts.yLabel;
    this.axisLayer.appendChild(yl);
  };

  /* series: [{name, role, points:[{x,y,kind}]}] */
  LineChart.prototype.setData = function (series, xTicks, yTicks, xFmt, yFmt) {
    const self = this;
    this.series = series;
    this._scales(series);
    this._grid(xTicks, yTicks, xFmt, yFmt);
    this.seriesLayer.innerHTML = "";

    series.forEach(function (s) {
      // 按 kind 拆段，unknown 断开
      let seg = [];
      const flush = function () {
        if (seg.length < 2) { seg = []; return; }
        const path = document.createElementNS(NS, "path");
        path.setAttribute("d", seg.map(function (p, i) {
          return (i ? "L" : "M") + self.sx(p.x).toFixed(1) + " " + self.sy(p.y).toFixed(1);
        }).join(""));
        path.setAttribute("class", "series series-" + s.role +
          (seg[0].kind === "interpolated" ? " series-interp" : ""));
        self.seriesLayer.appendChild(path);
        seg = [];
      };
      let prevKind = null;
      s.points.forEach(function (p) {
        if (p.y === null || Number.isNaN(p.y)) { flush(); prevKind = null; return; }
        if (prevKind && p.kind !== prevKind) flush();
        seg.push(p);
        prevKind = p.kind;
      });
      flush();

      // 未知区间在 x 轴上画灰色提示条
      let u0 = null;
      s.points.forEach(function (p, i) {
        const unk = p.y === null || Number.isNaN(p.y);
        if (unk && u0 === null) u0 = p.x;
        if (!unk && u0 !== null) {
          self._unknownBand(u0, p.x); u0 = null;
        }
      });
      if (u0 !== null) self._unknownBand(u0, s.points[s.points.length - 1].x);
    });

    // 图例
    const legend = document.createElementNS(NS, "g");
    legend.setAttribute("class", "legend");
    series.forEach(function (s, i) {
      const x = W - M.r - 210 + i * 105;
      const ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", x); ln.setAttribute("x2", x + 22);
      ln.setAttribute("y1", 12); ln.setAttribute("y2", 12);
      ln.setAttribute("class", "series series-" + s.role);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", x + 27); t.setAttribute("y", 16);
      t.setAttribute("class", "legend-text");
      t.textContent = s.name;
      legend.appendChild(ln); legend.appendChild(t);
    });
    this.axisLayer.appendChild(legend);
  };

  LineChart.prototype._unknownBand = function (x0, x1) {
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", this.sx(x0));
    r.setAttribute("width", Math.max(1, this.sx(x1) - this.sx(x0)));
    r.setAttribute("y", M.t);
    r.setAttribute("height", H - M.t - M.b);
    r.setAttribute("class", "unknown-band");
    this.seriesLayer.insertBefore(r, this.seriesLayer.firstChild);
  };

  LineChart.prototype._mouse = function (ev) {
    if (!this.series) return;
    const rect = this.svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / rect.width * W;
    const x = this.x0 + (px - M.l) / (W - M.l - M.r) * (this.x1 - this.x0);
    this.cross.style.display = "";
    this.tip.style.display = "";
    this.crossLine.setAttribute("x1", this.sx(x));
    this.crossLine.setAttribute("x2", this.sx(x));
    this.crossLine.setAttribute("y1", M.t);
    this.crossLine.setAttribute("y2", H - M.b);

    const rows = [];
    this.series.forEach(function (s) {
      let best = null;
      s.points.forEach(function (p) {
        if (p.y === null || Number.isNaN(p.y)) return;
        if (!best || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
      });
      if (best) rows.push({ name: s.name, role: s.role, p: best });
    });
    const first = rows[0];
    if (first) {
      this.crossDot.setAttribute("cx", this.sx(first.p.x));
      this.crossDot.setAttribute("cy", this.sy(first.p.y));
    }
    this.tip.innerHTML = this.opts.tipHtml(x, rows);
    const tipX = Math.min(rect.width - 170, (this.sx(x) / W) * rect.width + 14);
    this.tip.style.left = tipX + "px";
    this.tip.style.top = "8px";
    if (this.onHover) this.onHover(x);
  };

  global.GhostChart = LineChart;
})(window);
