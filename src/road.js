/* 道路参数插值 + 路面网格 + 自交检测 + 闭合接缝诊断 + 导出 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./vec3.js'), require('./spline.js'));
  } else root.RoadMesh = factory(root.RoadVec3, root.RoadSpline);
})(typeof self !== 'undefined' ? self : this, function (V, Spline) {
  'use strict';

  /** 段参数：每段独立存储，编辑某段只改该段，其余段保持原值 */
  function defaultSpanParams(width = 8, height = 0, crossfall = 2) {
    return { width, height, crossfall };
  }

  /**
   * 沿里程插值段参数。
   * 段值视为位于各段中点；相邻中点之间线性插值。
   * open: 端点外保持端段值；closed: 中点在环上循环。
   */
  function makeParamSampler(spline, spans) {
    const n = spline.spanCount;
    const closed = spline.closed;
    const mids = [];
    for (let i = 0; i < n; i++) {
      mids.push(spline.arc.length ? midArc(spline, i) : 0);
    }
    function midArc(sp, i) {
      const u0 = i, u1 = i + 1;
      const a = findArc(sp, u0), b = findArc(sp, u1);
      return (a.s + b.s) / 2;
    }
    function findArc(sp, u) {
      const arr = sp.arc;
      let lo = 0, hi = arr.length - 1;
      while (lo < hi - 1) {
        const m = (lo + hi) >> 1;
        if (arr[m].u <= u) lo = m; else hi = m;
      }
      const f = arr[hi].u > arr[lo].u ? (u - arr[lo].u) / (arr[hi].u - arr[lo].u) : 0;
      return { s: arr[lo].s + (arr[hi].s - arr[lo].s) * f };
    }
    function valAt(key, s) {
      if (n === 1) return spans[0][key];
      if (closed) {
        const L = spline.totalLength;
        // 环上找相邻中点
        let idx = 0;
        for (let i = 0; i < n; i++) {
          const next = (i + 1) % n;
          let a = mids[i], b = mids[next];
          if (b <= a) b += L;
          let ss = s;
          if (ss < a) ss += L;
          if (a <= ss && ss <= b) { idx = i; break; }
          if (i === n - 1) idx = i;
        }
        const next = (idx + 1) % n;
        let a = mids[idx], b = mids[next];
        if (b <= a) b += L;
        let ss = s;
        if (ss < a && idx === 0) ss += L;
        const t = Math.max(0, Math.min(1, (ss - a) / Math.max(1e-9, b - a)));
        return spans[idx][key] + (spans[next][key] - spans[idx][key]) * t;
      }
      // open
      if (s <= mids[0]) return spans[0][key];
      if (s >= mids[n - 1]) return spans[n - 1][key];
      for (let i = 0; i < n - 1; i++) {
        if (mids[i] <= s && s <= mids[i + 1]) {
          const t = (s - mids[i]) / (mids[i + 1] - mids[i]);
          return spans[i][key] + (spans[i + 1][key] - spans[i][key]) * t;
        }
      }
      return spans[n - 1][key];
    }
    return {
      at: (s) => ({
        width: valAt('width', s),
        height: valAt('height', s),
        crossfall: valAt('crossfall', s),
      }),
      mids,
    };
  }

  /** 计算一个站点的截面架：T 切向、S 路面内横向（左为正）、N 路面法线 */
  function frameAt(sample, params) {
    const T = sample.tangent;
    // 水平投影切向（用于贴合地形走向，避免竖直段退化）
    const Txy = V.normalize([T[0], T[1], 0]);
    let S0 = [-Txy[1], Txy[0], 0]; // 水平左侧方向
    const N0 = V.normalize(V.cross(T, S0)); // 未加横坡的法线
    // 绕 T 旋转 crossfall（度）：正横坡 = 右侧下沉、左侧抬高
    const ang = (params.crossfall * Math.PI) / 180;
    const S = V.lerp(S0, V.cross(N0, T), 0); // 占位，下面用旋转
    const cos = Math.cos(ang), sin = Math.sin(ang);
    // Rodrigues: 绕单位轴 T 旋转 S0 / N0
    function rot(v) {
      return V.add(V.add(V.scale(v, cos), V.scale(V.cross(T, v), sin)), V.scale(T, V.dot(T, v) * (1 - cos)));
    }
    const Srot = V.normalize(rot(S0));
    const Nrot = V.normalize(rot(N0));
    const center = V.add(sample.pos, [0, 0, params.height]);
    return { T, S: Srot, N: Nrot, center, halfWidth: params.width / 2 };
  }

  /** 截面横向细分点，r ∈ [-1,1]，r=+1 左边缘 */
  function sectionPoint(frame, r, extraOffset = 0) {
    const off = frame.halfWidth * r + extraOffset;
    return V.add(frame.center, V.scale(frame.S, off));
  }

  /**
   * 生成完整路面网格
   * options: {
   *   arcLengthStep, minStep, maxTurnAngleDeg,  // 细度
   *   crossDivs: 4, shoulderWidth: 1.2,
   *   includeShoulders: true
   * }
   */
  function buildRoad(controlPoints, closed, spans, options = {}) {
    const o = Object.assign({
      arcLengthStep: 4,
      minStep: 0.5,
      maxTurnAngleDeg: 4,
      crossDivs: 4,
      shoulderWidth: 1.2,
      includeShoulders: true,
    }, options);

    const spline = Spline.build(controlPoints, closed);
    const sampler = makeParamSampler(spline, spans);
    // sampleStations：开口以 s=L 结束；闭合内部站 < L 且末尾单独补 s=L 收尾环
    const stations = Spline.sampleStations(spline, o);

    const rings = stations.map((st) => {
      const p = sampler.at(st.s >= spline.totalLength ? st.s % spline.totalLength : st.s);
      const fr = frameAt(st, p);
      return { s: st.s, u: st.u, span: st.span, params: p, frame: fr, sample: st };
    });
    // 闭合接缝：末环强制对齐首环几何（位置/架），保证顶点、法线、纹理方向接得上
    if (closed) {
      const first = rings[0], last = rings[rings.length - 1];
      last.frame = {
        T: first.frame.T.slice(), S: first.frame.S.slice(), N: first.frame.N.slice(),
        center: first.frame.center.slice(), halfWidth: first.frame.halfWidth,
      };
      last.params = { ...first.params };
    }

    const CROSS = o.crossDivs;             // 横向分段数
    const vPerRing = CROSS + 1;            // 路面顶点数/环
    const verts = [];                      // 顶点
    const ringIndex = [];                  // 每环路面顶点起始索引
    const allFrames = rings.map((r) => r.frame);

    rings.forEach((ring) => {
      ringIndex.push(verts.length);
      for (let c = 0; c <= CROSS; c++) {
        const r = 1 - (2 * c) / CROSS;    // c=0 左边 → r=1
        verts.push(sectionPoint(ring.frame, r));
      }
    });

    // 路面三角形：相邻环连成条带；闭合路线的末环即 s=L 收尾环，无需环回
    const indices = [];
    const ringCount = rings.length;
    for (let i = 0; i < ringCount - 1; i++) {
      const a = ringIndex[i], b = ringIndex[i + 1];
      for (let c = 0; c < CROSS; c++) {
        const a0 = a + c, a1 = a + c + 1, b0 = b + c, b1 = b + c + 1;
        indices.push(a0, b0, a1, b0, b1, a1);
      }
    }

    // 顶点法线：相邻面累加
    const normals = verts.map(() => [0, 0, 0]);
    for (let f = 0; f < indices.length; f += 3) {
      const ia = indices[f], ib = indices[f + 1], ic = indices[f + 2];
      const n = V.cross(V.sub(verts[ib], verts[ia]), V.sub(verts[ic], verts[ia]));
      [ia, ib, ic].forEach((ii) => { normals[ii][0] += n[0]; normals[ii][1] += n[1]; normals[ii][2] += n[2]; });
    }
    normals.forEach((n, i) => { normals[i] = V.normalize(n); });

    // 路肩：左右各一条带子，独立 group 以便单独显示
    const shoulders = { left: null, right: null };
    if (o.includeShoulders && o.shoulderWidth > 0) {
      ['left', 'right'].forEach((side) => {
        const edgeR = side === 'left' ? 1 : -1;
        const sVerts = [];
        rings.forEach((ring) => {
          sVerts.push(sectionPoint(ring.frame, edgeR));                    // 路面边缘
          sVerts.push(sectionPoint(ring.frame, edgeR, edgeR * o.shoulderWidth)); // 路肩外缘
        });
        const sIdx = [];
        for (let i = 0; i < ringCount - 1; i++) {
          const a = i * 2, b = (i + 1) * 2;
          if (side === 'left') sIdx.push(a, b, a + 1, b, b + 1, a + 1);
          else sIdx.push(a + 1, b + 1, a, b + 1, b, a);
        }
        const sNorm = sVerts.map(() => [0, 0, 0]);
        for (let f = 0; f < sIdx.length; f += 3) {
          const ia = sIdx[f], ib = sIdx[f + 1], ic = sIdx[f + 2];
          const n = V.cross(V.sub(sVerts[ib], sVerts[ia]), V.sub(sVerts[ic], sVerts[ia]));
          [ia, ib, ic].forEach((ii) => { sNorm[ii][0] += n[0]; sNorm[ii][1] += n[1]; sNorm[ii][2] += n[2]; });
        }
        sNorm.forEach((n, i) => { sNorm[i] = V.normalize(n); });
        shoulders[side] = { vertices: sVerts, indices: sIdx, normals: sNorm, width: o.shoulderWidth };
      });
    }

    // 左右边缘折线（顶视图/立体图共用）
    const edges = { left: [], right: [], center: rings.map((r) => r.frame.center.slice()) };
    rings.forEach((ring) => {
      edges.left.push(sectionPoint(ring.frame, 1));
      edges.right.push(sectionPoint(ring.frame, -1));
    });

    return {
      spline, sampler, rings, options: o,
      vertices: verts, indices, normals, ringIndex, vPerRing,
      shoulders, edges,
    };
  }

  /* ---------------- 自交 / 折叠检测 ---------------- */

  /** 二维线段相交，返回交点与参数 t；共线/重合不视为急弯自交（端点接触另由调用方处理） */
  function segIntersect2D(p1, p2, p3, p4) {
    const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
    const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
    const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / den;
    if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) {
      return { t, u, point: [p1[0] + d1x * t, p1[1] + d1y * t, 0] };
    }
    return null;
  }

  /** 中心线平面自交（样条细分段两两检测，跳过相邻段与闭合接缝） */
  function centerlineSelfIntersections(spline) {
    const pts = spline.arc.map((a) => a.pos);
    const issues = [];
    const n = pts.length;
    const segCount = spline.closed ? n : n - 1;
    const end = (j) => (j + 1) % n;
    for (let i = 0; i < segCount; i++) {
      for (let j = i + 2; j < segCount; j++) {
        if (spline.closed && (i === 0 && j === segCount - 1)) continue; // 闭合同一条接缝
        const hit = segIntersect2D(pts[i], pts[i + 1], pts[j], pts[end(j)]);
        if (hit) {
          const s1 = spline.arc[i].s + hit.t * (spline.arc[i + 1].s - spline.arc[i].s);
          const s2 = spline.arc[j].s + hit.u * (spline.arc[Math.min(j + 1, n - 1)].s - spline.arc[j].s);
          issues.push({
            type: 'centerline-crossing',
            stationA: +s1.toFixed(3), stationB: +s2.toFixed(3),
            point: [+hit.point[0].toFixed(3), +hit.point[1].toFixed(3)],
            message: `中心线在里程 ${s1.toFixed(2)}m 与 ${s2.toFixed(2)}m 处平面自交`,
          });
        }
      }
    }
    return issues;
  }

  /**
   * 路面折叠检测：
   * 1) 相邻环：转弯半径 < 半宽（内缘倒行/翻转）
   * 2) 相邻环：横坡过大导致法线 z 分量 <= 0
   * 3) 非相邻环截面在平面上相交（宽度引起的自交），用空间哈希加速
   */
  function foldIssues(road) {
    const issues = [];
    const rings = road.rings;
    const closed = road.spline.closed;
    const n = rings.length;

    rings.forEach((ring) => {
      const hw = ring.frame.halfWidth;
      // 临界半径警告（仅提示，不算硬折叠；硬折叠以下面的内缘倒行为准）
      if (isFinite(ring.sample.radius) && ring.sample.radius < hw * 1.05) {
        issues.push({
          type: 'radius-warning',
          station: +ring.s.toFixed(3),
          radius: +ring.sample.radius.toFixed(3), halfWidth: +hw.toFixed(3),
          point: ring.frame.center.slice(),
          message: `里程 ${ring.s.toFixed(2)}m：转弯半径 ${ring.sample.radius.toFixed(2)}m 接近半幅宽 ${hw.toFixed(2)}m，内缘即将折叠`,
        });
      }
      if (ring.frame.N[2] <= 0.05) {
        issues.push({
          type: 'overslope',
          station: +ring.s.toFixed(3),
          crossfall: ring.params.crossfall,
          point: ring.frame.center.slice(),
          message: `里程 ${ring.s.toFixed(2)}m：横坡 ${ring.params.crossfall.toFixed(1)}° 使路面法线近乎朝下，路面翻覆`,
        });
      }
    });

    // 内缘倒行检测（三个条件同时满足才判硬折叠，避免低曲率处内外侧翻转误报）：
    //  a) 平面曲率符号确定弯心侧（2D 叉积 T_i × T_{i+1} 的 z 分量）
    //  b) 该侧边缘相邻环沿切向位移为负（倒行）
    //  c) 采样曲率半径小于半幅宽（几何上必然折叠）
    for (let i = 0; i < n - 1; i++) {
      const a = rings[i], b = rings[i + 1];
      const ta = a.sample.tangent, tb = b.sample.tangent;
      const crossZ = ta[0] * tb[1] - ta[1] * tb[0];
      if (Math.abs(crossZ) < 1e-5) continue; // 直道无内外侧
      const innerSign = crossZ > 0 ? 1 : -1;
      const ea = sectionPoint(a.frame, innerSign);
      const eb = sectionPoint(b.frame, innerSign);
      const ds = Math.max(1e-9, b.s - a.s);
      const along = V.dot(V.sub(eb, ea), a.frame.T) / ds;
      const radiusOK = !isFinite(a.sample.radius) || a.sample.radius < a.frame.halfWidth;
      if (along < -0.05 && radiusOK) {
        issues.push({
          type: 'inner-edge-fold',
          station: +a.s.toFixed(3),
          point: ea.slice(),
          message: `里程 ${a.s.toFixed(2)}m：内缘路面倒行折叠（半幅宽 ${a.frame.halfWidth.toFixed(2)}m ≥ 转弯半径 ${isFinite(a.sample.radius) ? a.sample.radius.toFixed(2) : '∞'}m）`,
        });
      }
    }

    // 非相邻环：用左右边缘折线做交叉检测，网格分桶
    const cell = Math.max(2, ...rings.map((r) => r.params.width)) * 1.5;
    const buckets = new Map();
    const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    const segs = [];
    const edgePts = [road.edges.left, road.edges.right];
    edgePts.forEach((poly, side) => {
      for (let i = 0; i < poly.length - 1; i++) {
        const seg = { a: poly[i], b: poly[i + 1], i, side: side === 0 ? 'left' : 'right' };
        segs.push(seg);
        const minx = Math.min(seg.a[0], seg.b[0]), maxx = Math.max(seg.a[0], seg.b[0]);
        const miny = Math.min(seg.a[1], seg.b[1]), maxy = Math.max(seg.a[1], seg.b[1]);
        for (let bx = Math.floor(minx / cell); bx <= Math.floor(maxx / cell); bx++) {
          for (let by = Math.floor(miny / cell); by <= Math.floor(maxy / cell); by++) {
            const k = `${bx},${by}`;
            if (!buckets.has(k)) buckets.set(k, []);
            buckets.get(k).push(seg);
          }
        }
      }
    });
    const seen = new Set();
    const segCountPerSide = n - 1;
    // 环绕里程差：闭合时取环上最短距离
    const arcGap = (i, j) => {
      const d = Math.abs(i - j);
      return closed ? Math.min(d, segCountPerSide - d) : d;
    };
    // 同一侧折线中，环绕里程差 ≤3 段的视为接缝/相邻局部（共端点或紧回环），跳过；
    // 左右侧之间只在端头相接，也跳过
    const nearPair = (s1, s2) => {
      if (s1.side !== s2.side) return true;
      return arcGap(s1.i, s2.i) <= 3;
    };
    for (const seg of segs) {
      const minx = Math.min(seg.a[0], seg.b[0]), maxx = Math.max(seg.a[0], seg.b[0]);
      const miny = Math.min(seg.a[1], seg.b[1]), maxy = Math.max(seg.a[1], seg.b[1]);
      const near = new Set();
      for (let bx = Math.floor(minx / cell); bx <= Math.floor(maxx / cell); bx++) {
        for (let by = Math.floor(miny / cell); by <= Math.floor(maxy / cell); by++) {
          (buckets.get(`${bx},${by}`) || []).forEach((s) => near.add(s));
        }
      }
      for (const other of near) {
        if (other === seg || nearPair(seg, other)) continue;
        const pairKey = [seg.side, seg.i, other.side, other.i].sort().join('|');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        const hit = segIntersect2D(seg.a, seg.b, other.a, other.b);
        if (hit) {
          const s1 = rings[seg.i].s + hit.t * (rings[Math.min(seg.i + 1, n - 1)].s - rings[seg.i].s);
          const s2 = rings[other.i].s + hit.u * (rings[Math.min(other.i + 1, n - 1)].s - rings[other.i].s);
          issues.push({
            type: 'surface-self-intersection',
            stationA: +s1.toFixed(3), stationB: +s2.toFixed(3),
            edgeA: seg.side, edgeB: other.side,
            point: [+hit.point[0].toFixed(3), +hit.point[1].toFixed(3)],
            message: `路面在里程 ${s1.toFixed(2)}m（${seg.side}侧）与 ${s2.toFixed(2)}m（${other.side}侧）相交，弯道过急或路面过宽`,
          });
        }
      }
    }
    return issues;
  }

  /** 闭合接缝诊断：首环(s=0)与末环(s=L)的顶点位置、法线、横向量、纹理方向是否接得上 */
  function seamDiagnostics(road) {
    if (!road.spline.closed) return null;
    const n = road.rings.length;
    const first = road.rings[0], last = road.rings[n - 1];
    const posErr = V.dist(
      road.vertices[road.ringIndex[0]],
      road.vertices[road.ringIndex[n - 1]]
    );
    const nErr = V.dist(first.frame.N, last.frame.N);
    const sErr = V.dist(first.frame.S, last.frame.S);
    // 纹理方向：两环切向夹角（闭合环回处应同向）
    const tDot = Math.abs(V.dot(first.frame.T, last.frame.T));
    const uvDrift = Math.acos(Math.max(-1, Math.min(1, tDot)));
    const ok = posErr < 0.05 && nErr < 0.02 && sErr < 0.02 && uvDrift < 0.05;
    return {
      ok,
      positionError: +posErr.toFixed(5),
      normalError: +nErr.toFixed(5),
      sideError: +sErr.toFixed(5),
      textureAngleDeg: +(uvDrift * 180 / Math.PI).toFixed(3),
      message: ok
        ? `闭合接缝接顺：位置误差 ${posErr.toExponential(2)}，法线误差 ${nErr.toExponential(2)}`
        : `闭合接缝存在偏差：位置 ${posErr.toFixed(3)}m / 法线 ${nErr.toFixed(3)} / 横向量 ${sErr.toFixed(3)} / 纹理转角 ${(uvDrift * 180 / Math.PI).toFixed(2)}°`,
    };
  }

  function analyze(controlPoints, closed, spans, options) {
    const road = buildRoad(controlPoints, closed, spans, options);
    const centerIssues = centerlineSelfIntersections(road.spline);
    const folds = foldIssues(road);
    const seam = seamDiagnostics(road);
    return { road, issues: centerIssues.concat(folds), seam };
  }

  /* ---------------- 导出 ---------------- */

  /** OBJ 网格：标准单行三角面 f v//vn，路面与左右路肩分组，坐标对应里程表 */
  function toOBJ(road) {
    const lines = [
      '# road-tool export',
      `# total_length=${road.spline.totalLength.toFixed(4)}`,
      '# 顶点按 (环, 横向) 排列，里程/控制点对应关系见旁侧 road-meta.json',
    ];

    function writeGroup(name, vertices, normals, indices, offset) {
      lines.push(`g ${name}`);
      vertices.forEach((v) => lines.push(`v ${v[0].toFixed(4)} ${v[1].toFixed(4)} ${v[2].toFixed(4)}`));
      normals.forEach((n) => lines.push(`vn ${n[0].toFixed(4)} ${n[1].toFixed(4)} ${n[2].toFixed(4)}`));
      for (let f = 0; f < indices.length; f += 3) {
        const face = indices.slice(f, f + 3).map((idx) => {
          const a = idx + 1 + offset; // OBJ 索引从 1 开始，offset 为前面组的顶点数
          return `${a}//${a}`;
        });
        lines.push('f ' + face.join(' '));
      }
      return vertices.length;
    }

    // OBJ 索引全局唯一，后续组需加上前面组累计的顶点/法线偏移
    let off = 0;
    off += writeGroup('pavement', road.vertices, road.normals, road.indices, off);
    ['left', 'right'].forEach((side) => {
      const sh = road.shoulders[side];
      if (!sh) return;
      off += writeGroup(`shoulder_${side}`, sh.vertices, sh.normals, sh.indices, off);
    });
    return lines.join('\n') + '\n';
  }

  /** 导出元数据：控制点、里程表、每环参数，保证坐标能对应控制点与里程 */
  function exportMeta(road, controlPoints, closed) {
    return {
      format: 'road-tool-meta/1',
      closed,
      totalLength: +road.spline.totalLength.toFixed(4),
      controlPoints: controlPoints.map((p, i) => ({ index: i, x: +p[0].toFixed(4), y: +p[1].toFixed(4), z: +p[2].toFixed(4) })),
      stations: road.rings.map((r) => ({
        station: +r.s.toFixed(4),
        span: r.span,
        width: +r.params.width.toFixed(4),
        height: +r.params.height.toFixed(4),
        crossfall: +r.params.crossfall.toFixed(4),
        center: r.frame.center.map((x) => +x.toFixed(4)),
        normal: r.frame.N.map((x) => +x.toFixed(4)),
        side: r.frame.S.map((x) => +x.toFixed(4)),
      })),
    };
  }

  return {
    defaultSpanParams,
    makeParamSampler,
    frameAt,
    sectionPoint,
    buildRoad,
    centerlineSelfIntersections,
    foldIssues,
    seamDiagnostics,
    analyze,
    toOBJ,
    exportMeta,
  };
});
