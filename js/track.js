/* 跑道几何：所有位置查询都以弧长 s 为唯一真相。
   8 字形交叉点在 x/y 上重合但对应两个不同的 s，因此按 s 查点绝不会跳区段。 */
(function (global) {
  "use strict";

  function Track(def) {
    this.def = def;
    this.wps = def.waypoints;          // 等弧长点列，s 单调递增
    this.n = this.wps.length - 1;
    this.length = def.lengthM;
    this.crossings = def.crossings.slice();
    this.checkpoints = def.checkpoints;
    this.vMax = def.maxPlausibleSpeed;
    this.maxInterpGap = def.maxInterpGapSec;
    this._segBounds = this.checkpoints.map(function (cp) { return cp.s; });
  }

  Track.prototype.xyAt = function (s) {
    if (s === null || s === undefined || Number.isNaN(s)) return null;
    s = Math.max(0, Math.min(this.length, s));
    const pos = (s / this.length) * this.n;
    let i = Math.floor(pos);
    if (i >= this.n) i = this.n - 1;
    const frac = pos - i;
    const a = this.wps[i], b = this.wps[i + 1];
    return {
      x: a.x + (b.x - a.x) * frac,
      y: a.y + (b.y - a.y) * frac,
      s: s,
    };
  };

  /* 从原始 x/y 反查最近弧长：在同 x/y 的交叉点处返回候选列表，
     由调用方用"当前 s 邻域"消歧，而不是直接取全局最近。 */
  Track.prototype.locateXY = function (x, y, nearS) {
    let best = null;
    for (let i = 0; i < this.n; i++) {
      const a = this.wps[i], b = this.wps[i + 1];
      const vx = b.x - a.x, vy = b.y - a.y;
      const l2 = vx * vx + vy * vy || 1e-9;
      let f = ((x - a.x) * vx + (y - a.y) * vy) / l2;
      f = Math.max(0, Math.min(1, f));
      const px = a.x + f * vx, py = a.y + f * vy;
      const d = Math.hypot(x - px, y - py);
      const s = a.s + f * (b.s - a.s);
      if (!best || d < best.d) best = { d: d, s: s };
    }
    if (nearS === undefined || nearS === null) return best.s;
    // 交叉点消歧：若全局最近点与当前位置距离过远，优先选同区段内的候选
    if (Math.abs(best.s - nearS) > this.length * 0.25) {
      let local = null;
      for (let i = 0; i < this.n; i++) {
        const a = this.wps[i], b = this.wps[i + 1];
        if (Math.max(a.s, b.s) < nearS - this.length * 0.3) continue;
        if (Math.min(a.s, b.s) > nearS + this.length * 0.3) continue;
        const vx = b.x - a.x, vy = b.y - a.y;
        const l2 = vx * vx + vy * vy || 1e-9;
        let f = ((x - a.x) * vx + (y - a.y) * vy) / l2;
        f = Math.max(0, Math.min(1, f));
        const px = a.x + f * vx, py = a.y + f * vy;
        const d = Math.hypot(x - px, y - py);
        const s = a.s + f * (b.s - a.s);
        if (!local || d < local.d) local = { d: d, s: s };
      }
      if (local) return local.s;
    }
    return best.s;
  };

  Track.prototype.segmentIndexAt = function (s) {
    if (s < 0) return -1;
    for (let i = 0; i < this._segBounds.length - 1; i++) {
      if (s <= this._segBounds[i + 1] + 1e-6) return i;
    }
    return this._segBounds.length - 2;
  };

  Track.prototype.segments = function () {
    const out = [];
    for (let i = 0; i < this.checkpoints.length - 1; i++) {
      out.push({
        index: i,
        name: this.checkpoints[i].name + " → " + this.checkpoints[i + 1].name,
        s0: this.checkpoints[i].s,
        s1: this.checkpoints[i + 1].s,
        length: this.checkpoints[i + 1].s - this.checkpoints[i].s,
      });
    }
    return out;
  };

  /* s 是否紧邻交叉点（用于地图上标注"交叉点"，以及命中检测提示） */
  Track.prototype.nearCrossing = function (s, tol) {
    tol = tol || 12;
    return this.crossings.some(function (c) { return Math.abs(c - s) <= tol; });
  };

  global.GhostTrack = Track;
})(window);
