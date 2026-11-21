/* geometry.js — 2D 向量、多边形检查与 SAT 碰撞检测（纯函数，无外部依赖） */
'use strict';

const Geo = (() => {

  // ---------- 向量 ----------
  const add  = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
  const sub  = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const scale = (a, s) => ({ x: a.x * s, y: a.y * s });
  const dot  = (a, b) => a.x * b.x + a.y * b.y;
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const len  = (a) => Math.hypot(a.x, a.y);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const norm = (a) => { const l = len(a); return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }; };
  const perp = (a) => ({ x: -a.y, y: a.x });           // 逆时针 90°
  const rotate = (p, ang) => {
    const c = Math.cos(ang), s = Math.sin(ang);
    return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
  };

  // ---------- 多边形检查 ----------
  // 有符号面积（逆时针为正）
  function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  // 线段严格相交（不含端点共点）
  function segProperIntersect(p1, p2, p3, p4) {
    const d1 = cross(sub(p4, p3), sub(p1, p3));
    const d2 = cross(sub(p4, p3), sub(p2, p3));
    const d3 = cross(sub(p2, p1), sub(p3, p1));
    const d4 = cross(sub(p2, p1), sub(p4, p1));
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  // 多边形自交检查：所有非相邻边对
  function selfIntersections(pts) {
    const n = pts.length, hits = [];
    if (n < 4) return hits;
    for (let i = 0; i < n; i++) {
      const a1 = pts[i], a2 = pts[(i + 1) % n];
      for (let j = i + 1; j < n; j++) {
        if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue; // 相邻边
        const b1 = pts[j], b2 = pts[(j + 1) % n];
        if (segProperIntersect(a1, a2, b1, b2)) hits.push([i, j]);
      }
    }
    return hits;
  }

  function isConvex(pts) {
    const n = pts.length;
    if (n < 4) return true;
    let sign = 0;
    for (let i = 0; i < n; i++) {
      const c = cross(sub(pts[(i + 1) % n], pts[i]), sub(pts[(i + 2) % n], pts[(i + 1) % n]));
      if (Math.abs(c) < 1e-9) continue;
      const s = Math.sign(c);
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  }

  function pointInPoly(p, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.y > p.y) !== (b.y > p.y) &&
          p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  function closestPointOnSegment(p, a, b) {
    const ab = sub(b, a);
    const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1e-12)));
    return add(a, scale(ab, t));
  }

  // ---------- 碰撞检测 ----------
  // 形状统一为世界坐标：{ type:'circle', x, y, r } 或 { type:'poly', pts:[{x,y}...] }（凸多边形）
  // 返回 null 或 { normal: 从 A 指向 B 的单位法线, depth: 穿透深度(>0), points: [接触点...] }

  function collideCircleCircle(A, B) {
    const d = sub(B, A);
    const rsum = A.r + B.r;
    const l = len(d);
    if (l >= rsum) return null;
    const n = l < 1e-9 ? { x: 1, y: 0 } : scale(d, 1 / l);
    return { normal: n, depth: rsum - l, points: [add(A, scale(n, A.r - (rsum - l) / 2))] };
  }

  // A=圆 B=多边形
  function collideCirclePoly(A, B) {
    const c = { x: A.x, y: A.y };
    let bestD = Infinity, bestP = null, bestN = null;
    const n = B.pts.length;
    for (let i = 0; i < n; i++) {
      const p = B.pts[i], q = B.pts[(i + 1) % n];
      const cp = closestPointOnSegment(c, p, q);
      const d = dist(c, cp);
      if (d < bestD) { bestD = d; bestP = cp; bestN = norm(perp(sub(q, p))); }
    }
    if (pointInPoly(c, B.pts)) {
      // 圆心在多边形内：法线取最近边外法线（指向圆，即 A 方向），需翻转为 A→B
      // 多边形顶点顺序不固定，用面积符号判断外法线方向
      const areaSign = Math.sign(polyArea(B.pts)) || 1;
      let nOut = bestN;
      // 外法线应指向多边形外：取边中点 + 法线，若在多边形外则方向正确
      const mid = add(bestP, scale(bestN, 1));
      const outward = pointInPoly(mid, B.pts) ? scale(bestN, -1) : bestN;
      void areaSign; void mid; void nOut;
      return { normal: scale(outward, -1), depth: A.r + bestD, points: [bestP] };
    }
    if (bestD >= A.r) return null;
    const dir = norm(sub(c, bestP)); // 从多边形指向圆 = B→A
    return { normal: scale(dir, -1), depth: A.r - bestD, points: [bestP] };
  }

  // SAT + 参考边裁剪，A、B 均为凸多边形
  function collidePolyPoly(A, B) {
    function maxSeparation(P, Q) {
      // P 的每条边外法线相对 Q 的最大分离度
      let best = -Infinity, bestIdx = 0;
      const n = P.length;
      const areaSign = Math.sign(polyArea(P)) || 1;
      for (let i = 0; i < n; i++) {
        const p = P[i], q = P[(i + 1) % n];
        let nrm = norm(perp(sub(q, p)));
        // 保证是外法线：CCW 多边形 perp(edge) 指向内侧
        if (areaSign > 0) nrm = scale(nrm, -1);
        let minQ = Infinity;
        for (const v of Q) minQ = Math.min(minQ, dot(nrm, sub(v, p)));
        if (minQ > best) { best = minQ; bestIdx = i; }
      }
      return { sep: best, idx: bestIdx };
    }

    const sa = maxSeparation(A, B);
    if (sa.sep > 0) return null;
    const sb = maxSeparation(B, A);
    if (sb.sep > 0) return null;

    // 选分离度更大的一侧作为参考面
    let refPoly, incPoly, refIdx, flip;
    if (sa.sep >= sb.sep) { refPoly = A; incPoly = B; refIdx = sa.idx; flip = false; }
    else                  { refPoly = B; incPoly = A; refIdx = sb.idx; flip = true; }

    const rn = refPoly.length;
    const r1 = refPoly[refIdx], r2 = refPoly[(refIdx + 1) % rn];
    const areaSign = Math.sign(polyArea(refPoly)) || 1;
    let refN = norm(perp(sub(r2, r1)));
    if (areaSign > 0) refN = scale(refN, -1); // 外法线

    // 入射边：入射多边形上法线与 -refN 最接近的边
    const m = incPoly.length;
    const incSign = Math.sign(polyArea(incPoly)) || 1;
    let incIdx = 0, minDot = Infinity;
    for (let i = 0; i < m; i++) {
      const p = incPoly[i], q = incPoly[(i + 1) % m];
      let nrm = norm(perp(sub(q, p)));
      if (incSign > 0) nrm = scale(nrm, -1);
      const d = dot(nrm, refN);
      if (d < minDot) { minDot = d; incIdx = i; }
    }
    let inc = [incPoly[incIdx], incPoly[(incIdx + 1) % m]];

    // 用参考边的两个侧面裁剪入射边
    const tangent = norm(sub(r2, r1));
    function clip(pts, nrm, offset) {
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const da = dot(nrm, a) - offset, db = dot(nrm, b) - offset;
        if (da <= 0) out.push(a);
        if (da * db < 0) {
          const t = da / (da - db);
          out.push(add(a, scale(sub(b, a), t)));
        }
      }
      return out;
    }
    inc = clip(inc, scale(tangent, -1), -dot(tangent, r1));
    if (inc.length < 2) return { normal: flip ? scale(refN, -1) : refN, depth: -Math.max(sa.sep, sb.sep), points: [] };
    inc = clip(inc, tangent, dot(tangent, r2));
    if (inc.length < 2) return { normal: flip ? scale(refN, -1) : refN, depth: -Math.max(sa.sep, sb.sep), points: [] };

    // 保留在参考面以下（穿透）的点
    const faceOff = dot(refN, r1);
    const raw = [];
    let depth = 0;
    for (const p of inc) {
      const sep = dot(refN, p) - faceOff;
      if (sep <= 1e-6) {
        raw.push(p);
        depth = Math.max(depth, -sep);
      }
    }
    // 去重（角点可能重复）
    const points = [];
    for (const p of raw) {
      if (!points.some(q => dist(p, q) < 1e-4)) points.push(p);
    }
    const normal = flip ? scale(refN, -1) : refN; // 从 A 指向 B
    return { normal, depth, points };
  }

  // 统一入口，返回法线恒为 A→B
  function collide(A, B) {
    if (A.type === 'circle' && B.type === 'circle') return collideCircleCircle(A, B);
    if (A.type === 'circle' && B.type === 'poly')   return collideCirclePoly(A, B);
    if (A.type === 'poly' && B.type === 'circle') {
      const r = collideCirclePoly(B, A);
      return r ? { normal: scale(r.normal, -1), depth: r.depth, points: r.points } : null;
    }
    return collidePolyPoly(A.pts, B.pts);
  }

  function shapeAABB(s) {
    if (s.type === 'circle') {
      return { minX: s.x - s.r, minY: s.y - s.r, maxX: s.x + s.r, maxY: s.y + s.r };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of s.pts) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY };
  }

  return {
    add, sub, scale, dot, cross, len, dist, norm, perp, rotate,
    polyArea, selfIntersections, isConvex, pointInPoly, closestPointOnSegment,
    collide, shapeAABB
  };
})();
