/* 向心 Catmull-Rom 样条（alpha=0.5），弧长参数化，支持开口/闭合 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vec3.js'));
  else root.RoadSpline = factory(root.RoadVec3);
})(typeof self !== 'undefined' ? self : this, function (V) {
  'use strict';

  const ALPHA = 0.5;

  function tj(ti, pi, pj) {
    return ti + Math.pow(V.dist(pi, pj), ALPHA);
  }

  /** 单个跨度内插值，u ∈ [0,1]；返回位置与切向 */
  function evalSpan(p0, p1, p2, p3, u) {
    let t0 = 0;
    const t1 = tj(t0, p0, p1);
    const t2 = tj(t1, p1, p2);
    const t3 = tj(t2, p2, p3);
    const t = t1 + (t2 - t1) * u; // 映射到实际参数区间

    const safe = (a, b) => (Math.abs(b - a) < 1e-9 ? 0 : (t - a) / (b - a));

    const A1 = V.lerp(p0, p1, safe(t0, t1));
    const A2 = V.lerp(p1, p2, safe(t1, t2));
    const A3 = V.lerp(p2, p3, safe(t2, t3));
    const B1 = V.lerp(A1, A2, safe(t0, t2));
    const B2 = V.lerp(A2, A3, safe(t1, t3));
    return V.lerp(B1, B2, safe(t0, t3));
  }

  function evalSpanTangent(p0, p1, p2, p3, t) {
    const e = 1e-4;
    const ta = Math.max(0, t - e);
    const tb = Math.min(1, t + e);
    const a = evalSpan(p0, p1, p2, p3, ta);
    const b = evalSpan(p0, p1, p2, p3, tb);
    return V.normalize(V.sub(b, a));
  }

  /**
   * 构建样条
   * @param {Array<[number,number,number]>} points 控制点
   * @param {boolean} closed
   */
  function build(points, closed) {
    const n = points.length;
    const spanCount = closed ? n : n - 1;

    function spanPoints(i) {
      const at = (idx) => {
        if (closed) return points[((idx % n) + n) % n];
        return points[Math.max(0, Math.min(n - 1, idx))];
      };
      return [at(i - 1), at(i), at(i + 1), at(i + 2)];
    }

    function evalAt(u) {
      // u ∈ [0, spanCount)，闭合时 spanCount=n
      let i = Math.floor(u);
      let t = u - i;
      if (i >= spanCount) { i = spanCount - 1; t = 1; }
      const [p0, p1, p2, p3] = spanPoints(i);
      return {
        pos: evalSpan(p0, p1, p2, p3, t),
        tangent: evalSpanTangent(p0, p1, p2, p3, t),
        span: i,
        t,
      };
    }

    // 弧长表：每个跨度细分 48 段
    const DIV = 48;
    const arc = []; // {u, s, pos}
    let total = 0;
    let prev = null;
    for (let i = 0; i < spanCount; i++) {
      for (let k = 0; k < DIV; k++) {
        const u = i + k / DIV;
        const pos = evalAt(u).pos;
        if (prev) total += V.dist(prev, pos);
        arc.push({ u, s: total, pos });
        prev = pos;
      }
    }
    // 终点：闭合时严格回到首控制点，保证接缝顶点位置一致
    const endU = spanCount;
    const endPos = closed ? points[0].slice() : evalAt(spanCount - 1e-9).pos;
    total += V.dist(prev, endPos);
    arc.push({ u: endU, s: total, pos: endPos });

    /** 弧长 s → u（二分） */
    function uAtDistance(s) {
      const ss = Math.max(0, Math.min(total, s));
      let lo = 0, hi = arc.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (arc[mid].s <= ss) lo = mid; else hi = mid;
      }
      const a = arc[lo], b = arc[hi];
      const f = b.s > a.s ? (ss - a.s) / (b.s - a.s) : 0;
      return a.u + (b.u - a.u) * f;
    }

    function sampleAtDistance(sIn) {
      // 仅当 s 恰好为总长度（接缝收尾点）时归一化到 s=0，
      // 保证 s=0 与 s=L 走完全相同的查找路径；接近 L 的普通站保持原值
      const atSeam = closed && sIn >= total - 1e-9;
      const s = atSeam ? 0 : Math.max(0, Math.min(total, sIn));
      const u = uAtDistance(s);
      const r = evalAt(u);
      // 闭合曲线在接缝里程处精确回到首控制点
      const pos = atSeam ? points[0].slice() : r.pos;
      // 曲率：对弧长求切向导数
      const h = Math.min(0.5, total * 1e-3);
      const s1 = Math.max(0, s - h), s2 = Math.min(total, s + h);
      const T1 = evalAt(uAtDistance(s1)).tangent;
      const T2 = evalAt(uAtDistance(s2)).tangent;
      const kappa = V.len(V.sub(T2, T1)) / Math.max(1e-9, s2 - s1);
      let tangent = r.tangent;
      // 闭合曲线接缝处做宽幅切向混合：以到接缝的环绕距离 d 为参数，
      // 在“本侧原始切向”与“对侧等距点的原始切向”之间对称过渡。
      // d=0（s=0 与 s=L）权重严格相等，两端切向恒等且无窄区间突变
      if (closed) {
        const blendLen = Math.min(8, total * 0.05);
        const d = Math.min(s, total - s);
        if (d < blendLen) {
          const w = 0.5 * (1 - Math.cos(Math.PI * d / blendLen)); // d=0→0.5, d=blendLen→1
          const otherS = s < total / 2 ? s + total - 2 * d : s - total + 2 * d;
          const other = evalAt(uAtDistance(otherS)).tangent;
          tangent = V.normalize(V.add(V.scale(r.tangent, w), V.scale(other, 1 - w)));
        }
      }
      return {
        s,
        u,
        pos,
        tangent,
        span: r.span,
        t: r.t,
        curvature: kappa,
        radius: kappa > 1e-6 ? 1 / kappa : Infinity,
      };
    }

    return {
      points,
      closed,
      spanCount,
      totalLength: total,
      arc,
      evalAt,
      uAtDistance,
      sampleAtDistance,
    };
  }

  /**
   * 按弧长自适应布站：先等弧长，再按最大转角加密
   * @returns 站点数组，闭合时含 s=L 的收尾环
   */
  function sampleStations(spline, opts) {
    const step = opts.arcLengthStep;
    const maxAngle = (opts.maxTurnAngleDeg * Math.PI) / 180;
    const minStep = opts.minStep || 0.25;
    const L = spline.totalLength;

    // 等弧长布站：闭合时内部站严格小于 L，末尾单独补 s=L 收尾
    const ss = [];
    for (let s = 0; s < L - 1e-7; s += step) ss.push(Math.min(s, L));
    ss.push(L);
    const lastPair = ss.length - 1; // 闭合时最后一对是接缝对（s=L→s=0），不参与转角加密

    // 多轮完整扫描：每轮把所有超限区间一分为二，直到没有区间需要细分为止。
    // 不能每轮 break 后从头扫——否则接缝附近区间会反复占用细分额度，远处弯道被饿死。
    let guard = 0;
    let any = true;
    while (any && guard++ < 400) {
      any = false;
      for (let i = 0; i < ss.length - 1; i++) {
        const gap = ss[i + 1] - ss[i];
        // 二分后两侧各为 gap/2，若会低于 minStep 则该区间已到分辨率下限，停止细分
        if (gap < minStep * 2 * 0.999) continue;
        const a = spline.sampleAtDistance(ss[i]);
        const b = spline.sampleAtDistance(ss[i + 1]);
        const cosA = V.dot(a.tangent, b.tangent);
        const angle = Math.acos(Math.max(-1, Math.min(1, cosA)));
        if (angle > maxAngle) {
          ss.splice(i + 1, 0, (ss[i] + ss[i + 1]) / 2);
          any = true;
          i++; // 跳过新插入的点，留到下一轮处理；不能 break，否则远处区间被饿死
        }
      }
    }
    return ss.map((s) => spline.sampleAtDistance(s));
  }

  return { build, sampleStations };
});
