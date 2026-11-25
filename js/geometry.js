/*
 * geometry.js — 二维光照几何核心
 *
 * 可见多边形采用“端点三射线”法（Nicky Case / Red Blob Games 经典做法）：
 * 对每个墙端点沿其方向射出 a-eps、a、a+eps 三条射线，取最近交点，
 * 按极角排序后围成多边形。三射线保证拐角两侧的开/闭区域都被采样到，
 * 配合墙体最后覆盖绘制，拐角与接头处不会出现穿光缝。
 *
 * 同时以 UMD-lite 方式导出，方便 Node 下跑单元测试。
 */
(function (root, factory) {
  const api = factory();
  root.Geometry = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const EPS_ANGLE = 1e-4;     // 端点两侧辅助射线的角度偏移（弧度）；
                              // 越小，端点外侧的阴影楔越窄（在墙端处为亚像素），
                              // 1e-4 兼顾双精度数值稳定性
  const EPS_T = 1e-9;       // 射线参数最小正值，过滤反向/共线交点
  const EPS_U = 1e-9;       // 线段参数容差
  const ON_WALL_EPS = 1.5;  // 判定“灯贴墙”的距离（世界单位，等于画布像素）
  const RAY_SEEDS = 96;     // 无墙端点时的兜底全周射线数

  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
  function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
  function scale(p, k) { return { x: p.x * k, y: p.y * k }; }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function dot(ax, ay, bx, by) { return ax * bx + ay * by; }
  function cross(ax, ay, bx, by) { return ax * by - ay * bx; }
  function angleOf(p) { return Math.atan2(p.y, p.x); }

  function pointAt(origin, angle, t) {
    return { x: origin.x + Math.cos(angle) * t, y: origin.y + Math.sin(angle) * t };
  }

  function normAngle(a) {
    while (a < -Math.PI) a += 2 * Math.PI;
    while (a > Math.PI) a -= 2 * Math.PI;
    return a;
  }

  /*
   * 射线 o + t*d 与线段 a-b 求交。
   * 返回 { t, u, point }，t 为射线参数，u 为线段参数(0..1)。
   * 平行/共线一律返回 null（掠射的共线墙不产生遮挡，由贴墙逻辑另行处理）。
   */
  function raySegment(origin, angle, seg) {
    const vx = seg.b.x - seg.a.x;
    const vy = seg.b.y - seg.a.y;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const denom = cross(dx, dy, vx, vy);
    if (Math.abs(denom) < 1e-12) return null;

    const wx = seg.a.x - origin.x;
    const wy = seg.a.y - origin.y;
    const t = cross(wx, wy, vx, vy) / denom;
    const u = cross(wx, wy, dx, dy) / denom;
    if (t < EPS_T) return null;
    if (u < -EPS_U || u > 1 + EPS_U) return null;
    return { t, u: Math.max(0, Math.min(1, u)), point: pointAt(origin, angle, t) };
  }

  /* 点到线段的最近距离与投影参数 u */
  function projectPoint(p, seg) {
    const vx = seg.b.x - seg.a.x;
    const vy = seg.b.y - seg.a.y;
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-12) return { u: 0, dist: dist(p, seg.a) };
    let u = ((p.x - seg.a.x) * vx + (p.y - seg.a.y) * vy) / len2;
    u = Math.max(0, Math.min(1, u));
    const q = { x: seg.a.x + vx * u, y: seg.a.y + vy * u };
    return { u, dist: dist(p, q) };
  }

  function pointOnWall(p, segments, eps) {
    eps = eps || ON_WALL_EPS;
    for (const seg of segments) {
      const pr = projectPoint(p, seg);
      if (pr.dist <= eps) return { seg, u: pr.u, dist: pr.dist };
    }
    return null;
  }

  /*
   * 计算一盏灯的可见多边形（已按灯半径裁剪）。
   *
   * 返回：
   *   polygon: 顶点数组，首顶点为灯自身（扇形中心点），其余按极角排序，
   *            每个顶点带 {x, y, angle, dist, onCircle, segId}
   *   hits:    Map<segId, [{x,y}]>，每条被命中的墙段及其命中点（调试视图用）
   *
   * 边界情况：
   *  - 灯恰好在墙上：t < EPS_T 的交点被过滤，墙两侧仍可照亮，
   *    墙本体由渲染层最后覆盖，调用方可用 pointOnWall 给出贴墙提示。
   *  - 灯恰好压在墙端点上：跳过该端点的退化射线，避免 NaN。
   *  - 半径边缘：交点距离 >= radius 时顶点落到圆周上，
   *    渲染端在连续圆周顶点间用 arc 补圆弧，半径圈不会穿光。
   *  - 场景里没有任何墙端点：用全周均匀兜底射线生成完整圆。
   */
  function computeVisibility(origin, segments, radius) {
    const angles = [];
    for (const seg of segments) {
      for (const endpoint of [seg.a, seg.b]) {
        const v = sub(endpoint, origin);
        if (Math.hypot(v.x, v.y) < 1e-9) continue; // 灯压在端点上
        const base = angleOf(v);
        angles.push(normAngle(base - EPS_ANGLE), base, normAngle(base + EPS_ANGLE));
      }
    }
    // 无论有没有墙都注入全周均匀兜底射线：
    // 保证 2π 每个方向都有采样，可见性判定与渲染圆弧不会出现方向缺口
    for (let i = 0; i < RAY_SEEDS; i++) {
      angles.push(-Math.PI + (2 * Math.PI * i) / RAY_SEEDS);
    }
    angles.sort((a, b) => a - b);

    const unique = [];
    for (const a of angles) {
      if (!unique.length || Math.abs(a - unique[unique.length - 1]) > 1e-12) unique.push(a);
    }

    // 首顶点放灯自身：多边形成为以灯为中心的扇形，灯附近的点也能判为可见
    const polygon = [{
      x: origin.x, y: origin.y, angle: 0, dist: 0, onCircle: false, segId: null, isOrigin: true,
    }];
    const hits = new Map();

    for (const angle of unique) {
      let best = null;
      for (const seg of segments) {
        const hit = raySegment(origin, angle, seg);
        if (!hit) continue;
        if (hit.t > radius + EPS_U) continue;
        if (!best || hit.t < best.t) best = { ...hit, segId: seg.id, wallId: seg.wallId };
      }

      if (best) {
        hits.set(best.segId, (hits.get(best.segId) || []).concat([best.point]));
        if (best.t >= radius - 1e-7) {
          // 交点在半径外或恰好压边：顶点统一落在圆周上，保证圆弧闭合
          polygon.push({
            ...pointAt(origin, angle, radius),
            angle, dist: radius, onCircle: true, segId: best.segId,
          });
        } else {
          polygon.push({
            x: best.point.x, y: best.point.y,
            angle, dist: best.t, onCircle: false, segId: best.segId,
          });
        }
      } else {
        polygon.push({
          ...pointAt(origin, angle, radius),
          angle, dist: radius, onCircle: true, segId: null,
        });
      }
    }
    return { polygon, hits };
  }

  /*
   * 径向可见性判定：点 p 是否落在以灯为中心的可见区域内。
   *
   * 外圈顶点按极角排序（可能跨越 ±π），因此不做首末角度的硬比较，
   * 而是用角度差找到包含查询方向的相邻扇区，在两条边界距离间线性插值，
   * 再与点到灯的距离比较。computeVisibility 总会注入全周兜底射线，
   * 所以 2π 方向上每个角度都有扇区覆盖。
   */
  function isPointVisible(origin, polygon, p) {
    const ring = polygon.filter(v => !v.isOrigin);
    if (ring.length < 3) return false;
    const d = dist(origin, p);
    if (d < 1e-9) return true;
    const a = angleOf(sub(p, origin));

    // 选与查询方向角差最小的顶点 i，再根据前后角差决定它是扇区的左端还是右端
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const diff = Math.abs(angleDiff(ring[i].angle, a));
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    const v = ring[best];
    const prev = ring[(best - 1 + ring.length) % ring.length];
    const next = ring[(best + 1) % ring.length];

    let p1, p2;
    if (angleDiff(v.angle, a) >= 0 && angleDiff(prev.angle, a) <= 0) {
      p1 = prev; p2 = v;
    } else {
      p1 = v; p2 = next;
    }
    const span = angleDiff(p2.angle, p1.angle);
    const t = span < 1e-12 ? 0 : angleDiff(a, p1.angle) / span;
    if (t < -1e-9 || t > 1 + 1e-9) return false; // 查询方向不在任何扇区内
    const boundary = p1.dist + (p2.dist - p1.dist) * Math.max(0, Math.min(1, t));
    return d <= boundary + 1e-7;
  }

  // b - a，结果规范到 (-π, π]
  function angleDiff(b, a) {
    let d = b - a;
    while (d <= -Math.PI) d += 2 * Math.PI;
    while (d > Math.PI) d -= 2 * Math.PI;
    return d;
  }

  /* 通用多边形包含（射线法），保留给外部/测试使用 */
  function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
    return inside;
  }

  /*
   * 地面点受光查询：逐盏灯独立判断。
   * 仅当墙段“身体”横在灯与点之间（u 严格位于线段内部）才算遮挡；
   * 射线恰好擦过墙端点时不遮挡，与可见多边形在拐角处的处理保持一致。
   */
  function queryPoint(point, lights, segments) {
    const results = [];
    for (const light of lights) {
      if (light.on === false) continue;
      const d = dist(light, point);
      if (d > light.radius + EPS_U) continue;

      let blocked = false;
      let blocker = null;
      if (d > 1e-9) {
        const angle = angleOf(sub(point, light));
        for (const seg of segments) {
          const hit = raySegment(light, angle, seg);
          if (hit && hit.t < d - 1e-7 && hit.u > 1e-7 && hit.u < 1 - 1e-7) {
            blocked = true;
            blocker = seg;
            break;
          }
        }
      }
      results.push({
        light,
        distance: d,
        attenuation: Math.max(0, 1 - d / light.radius),
        blocked,
        blocker,
      });
    }
    return results;
  }

  /* 把墙链展开成带 id 的线段数组 */
  function flattenWalls(walls) {
    const segments = [];
    for (const wall of walls) {
      for (let i = 0; i < wall.points.length - 1; i++) {
        segments.push({
          id: wall.id + ':' + i,
          wallId: wall.id,
          index: i,
          a: wall.points[i],
          b: wall.points[i + 1],
        });
      }
    }
    return segments;
  }

  function uid(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 9);
  }

  return {
    EPS_ANGLE, EPS_T, ON_WALL_EPS,
    sub, add, scale, dist, dot, cross, angleOf, pointAt, normAngle,
    raySegment, projectPoint, pointOnWall, pointInPolygon, isPointVisible,
    computeVisibility, queryPoint, flattenWalls, uid,
  };
});
