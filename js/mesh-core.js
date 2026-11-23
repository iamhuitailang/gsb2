/*
 * mesh-core.js — 三角网格朝向检查与修复的核心逻辑（无 DOM 依赖，浏览器 / node 共用）
 *
 * 网格数据结构:
 *   mesh = {
 *     positions: [[x,y,z], ...],        // OBJ 的 v
 *     uvs:       [[u,v], ...],          // OBJ 的 vt
 *     faces:     [{ v:[i,j,k], vt:[a,b,c] }, ...]   // 0 基索引, vt 可为 -1 表示无 UV
 *   }
 */
(function (root, factory) {
  const M = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.MeshCore = M;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 基础向量 ----------
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.sqrt(dot(a, a));

  // ---------- OBJ 解析 ----------
  function parseOBJ(text) {
    const positions = [];
    const uvs = [];
    const faces = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split(/\s+/);
      const kw = parts[0];
      if (kw === 'v') {
        positions.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
      } else if (kw === 'vt') {
        uvs.push([Number(parts[1]), Number(parts[2])]);
      } else if (kw === 'f') {
        const idx = parts.slice(1).map((tok) => {
          const seg = tok.split('/');
          let vi = parseInt(seg[0], 10);
          if (vi < 0) vi = positions.length + vi + 1;
          let ti = -1;
          if (seg.length > 1 && seg[1] !== '') {
            ti = parseInt(seg[1], 10);
            if (ti < 0) ti = uvs.length + ti + 1;
          }
          return { v: vi - 1, vt: ti === -1 ? -1 : ti - 1 };
        });
        // 多边形扇形三角化
        for (let i = 1; i + 1 < idx.length; i++) {
          faces.push({
            v: [idx[0].v, idx[i].v, idx[i + 1].v],
            vt: [idx[0].vt, idx[i].vt, idx[i + 1].vt],
          });
        }
      }
      // o/g/s/usemtl/mtllib/vn 等忽略
    }
    return { positions, uvs, faces };
  }

  function fmtNum(x) {
    if (!isFinite(x)) return '0';
    const s = Number(x.toPrecision(9));
    return String(s);
  }

  // ---------- OBJ 导出（保留每个面角对应的 UV） ----------
  function serializeOBJ(mesh) {
    const hasUV =
      mesh.uvs.length > 0 && mesh.faces.every((f) => f.vt.every((t) => t >= 0));
    const out = ['# exported by orientation-fixer'];
    for (const p of mesh.positions) out.push('v ' + p.map(fmtNum).join(' '));
    for (const t of mesh.uvs) out.push('vt ' + t.map(fmtNum).join(' '));
    for (const f of mesh.faces) {
      if (hasUV) {
        out.push(
          'f ' + f.v.map((vi, k) => `${vi + 1}/${f.vt[k] + 1}`).join(' ')
        );
      } else {
        out.push('f ' + f.v.map((vi) => vi + 1).join(' '));
      }
    }
    return out.join('\n') + '\n';
  }

  // ---------- 拓扑与朝向分析 ----------
  function analyze(mesh) {
    const P = mesh.positions;
    const F = mesh.faces;

    // 包围盒，用于相对容差
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (const p of P)
      for (let i = 0; i < 3; i++) {
        mn[i] = Math.min(mn[i], p[i]);
        mx[i] = Math.max(mx[i], p[i]);
      }
    const diag = Math.max(len(sub(mx, mn)), 1e-12);
    const posEps = diag * 1e-7;
    const areaEps = Math.pow(diag * 1e-6, 2);
    const volEps = Math.pow(diag, 3) * 1e-9;

    // 面积 / 法线 / 零面积面
    const faceNormal = [];
    const faceArea = [];
    const zeroAreaFaces = [];
    F.forEach((f, i) => {
      const [a, b, c] = f.v.map((vi) => P[vi]);
      const n = cross(sub(b, a), sub(c, a));
      const a2 = len(n);
      faceNormal.push(a2 > 0 ? [n[0] / a2, n[1] / a2, n[2] / a2] : [0, 0, 0]);
      faceArea.push(a2 / 2);
      const dupIdx =
        f.v[0] === f.v[1] || f.v[1] === f.v[2] || f.v[0] === f.v[2];
      if (dupIdx || a2 / 2 < areaEps) zeroAreaFaces.push(i);
    });

    // 边表: key -> {a, b, faces:[{f, dir}]}  dir=+1 表示该面沿 a->b 方向经过此边
    const edgeMap = new Map();
    F.forEach((f, i) => {
      for (let k = 0; k < 3; k++) {
        const a = f.v[k];
        const b = f.v[(k + 1) % 3];
        if (a === b) continue; // 退化边
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const key = lo + '_' + hi;
        if (!edgeMap.has(key)) edgeMap.set(key, { a: lo, b: hi, faces: [] });
        edgeMap.get(key).faces.push({ f: i, dir: a < b ? 1 : -1 });
      }
    });
    const edges = [...edgeMap.values()];
    const boundaryEdges = edges.filter((e) => e.faces.length === 1);
    const nonManifoldEdges = edges.filter((e) => e.faces.length >= 3);

    // 连通块（面通过共用边连接）
    const parent = F.map((_, i) => i);
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    for (const e of edges) {
      const fs = e.faces.map((x) => x.f);
      for (let i = 1; i < fs.length; i++) parent[find(fs[0])] = find(fs[i]);
    }
    const compMap = new Map();
    F.forEach((_, i) => {
      const r = find(i);
      if (!compMap.has(r)) compMap.set(r, []);
      compMap.get(r).push(i);
    });

    const zeroSet = new Set(zeroAreaFaces);
    const components = [];
    for (const faceIds of compMap.values()) {
      const set = new Set(faceIds);
      const bEdges = [];
      const nmEdges = [];
      for (const e of edges) {
        if (!set.has(e.faces[0].f)) continue;
        if (e.faces.length === 1) bEdges.push(e);
        else if (e.faces.length >= 3) nmEdges.push(e);
      }
      const zFaces = faceIds.filter((f) => zeroSet.has(f));
      const closed = bEdges.length === 0 && nmEdges.length === 0;
      const volume = signedVolume(mesh, faceIds, null);
      components.push({
        id: components.length,
        faceIds,
        faceCount: faceIds.length,
        closed,
        volume,
        orientation: closed ? (volume > 0 ? 'outward' : 'inward') : 'open',
        boundaryEdges: bEdges.map(edgeKey),
        nonManifoldEdges: nmEdges.map(edgeKey),
        zeroAreaFaces: zFaces,
      });
    }
    components.sort((a, b) => b.faceCount - a.faceCount);
    components.forEach((c, i) => (c.id = i));

    // 重合但未连接的顶点
    const weldMap = new Map();
    P.forEach((p, i) => {
      const key = p.map((x) => Math.round(x / posEps)).join(',');
      if (!weldMap.has(key)) weldMap.set(key, []);
      weldMap.get(key).push(i);
    });
    const coincidentVertices = [];
    for (const idxs of weldMap.values()) {
      if (idxs.length > 1)
        coincidentVertices.push({ position: P[idxs[0]].slice(), indices: idxs });
    }

    return {
      diag,
      posEps,
      faceNormal,
      faceArea,
      edges,
      boundaryEdges,
      nonManifoldEdges,
      zeroAreaFaces,
      coincidentVertices,
      components,
    };
  }

  function edgeKey(e) {
    return e.a + '_' + e.b;
  }

  // 有向体积；isFlipped(faceIdx)->bool 表示该面按反绕向计算
  function signedVolume(mesh, faceIds, isFlipped) {
    const P = mesh.positions;
    let v = 0;
    for (const fi of faceIds) {
      const f = mesh.faces[fi];
      const flip = isFlipped && isFlipped(fi);
      const a = P[f.v[0]];
      const b = P[flip ? f.v[2] : f.v[1]];
      const c = P[flip ? f.v[1] : f.v[2]];
      v += dot(a, cross(b, c)) / 6;
    }
    return v;
  }

  /*
   * 统一一个连通块内可判定的朝向。
   *   referenceFaceId != null: 以该面当前朝向为准（用于无法判断外侧的开口片）
   *   否则闭合块自动统一为整体朝外；开口片返回 needsReference
   * 返回 { flips:[faceId], needsReference, unreached:[faceId], skippedZeroArea:[faceId], status }
   */
  function unifyComponent(mesh, analysis, compId, referenceFaceId) {
    const comp = analysis.components[compId];
    const faceSet = new Set(comp.faceIds);
    const zeroSet = new Set(analysis.zeroAreaFaces);

    // 邻接约束：只通过"恰好两个面共用"的边传播；非流形边不传播
    const adj = new Map();
    const addAdj = (a, b, mustDiffer) => {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push({ other: b, mustDiffer });
    };
    for (const e of analysis.edges) {
      if (e.faces.length !== 2) continue;
      const [x, y] = e.faces;
      if (!faceSet.has(x.f) || !faceSet.has(y.f)) continue;
      if (zeroSet.has(x.f) || zeroSet.has(y.f)) continue;
      const mustDiffer = x.dir === y.dir; // 同向经过公共边 => 必须翻转其一
      addAdj(x.f, y.f, mustDiffer);
      addAdj(y.f, x.f, mustDiffer);
    }

    const seed =
      referenceFaceId != null
        ? referenceFaceId
        : comp.faceIds.find((f) => !zeroSet.has(f));
    const result = {
      flips: [],
      needsReference: false,
      unreached: [],
      skippedZeroArea: comp.faceIds.filter((f) => zeroSet.has(f)),
      status: 'ok',
    };
    if (seed == null) {
      result.status = 'noOrientableFace';
      result.unreached = comp.faceIds.slice();
      return result;
    }

    // BFS 分配翻转状态
    const flip = new Map([[seed, 0]]);
    const queue = [seed];
    while (queue.length) {
      const cur = queue.shift();
      for (const { other, mustDiffer } of adj.get(cur) || []) {
        const want = flip.get(cur) ^ (mustDiffer ? 1 : 0);
        if (!flip.has(other)) {
          flip.set(other, want);
          queue.push(other);
        }
        // 已赋值不一致 => 不可定向面（如莫比乌斯带），保持首次赋值并继续
      }
    }
    result.unreached = comp.faceIds.filter((f) => !flip.has(f) && !zeroSet.has(f));

    // 全局取向
    let invert = false;
    if (referenceFaceId != null) {
      // 参考面保持当前朝向（seed 状态为 0），无需反转
    } else if (comp.closed) {
      const vol = signedVolume(mesh, comp.faceIds, (f) => flip.get(f) === 1);
      if (vol < 0) invert = true;
      else if (Math.abs(vol) < Math.pow(analysis.diag, 3) * 1e-9)
        result.status = 'ambiguousVolume';
    } else {
      result.needsReference = true;
      result.flips = [];
      return result;
    }

    for (const [f, s] of flip) if ((s === 1) !== invert) result.flips.push(f);
    return result;
  }

  // 应用翻转：反转面角顺序，UV 跟随面角一起反转（角-UV 对应保持不变）
  function applyFlips(mesh, flipSet) {
    const set = flipSet instanceof Set ? flipSet : new Set(flipSet);
    return {
      positions: mesh.positions.map((p) => p.slice()),
      uvs: mesh.uvs.map((t) => t.slice()),
      faces: mesh.faces.map((f, i) =>
        set.has(i)
          ? { v: [f.v[0], f.v[2], f.v[1]], vt: [f.vt[0], f.vt[2], f.vt[1]] }
          : { v: f.v.slice(), vt: f.vt.slice() }
      ),
    };
  }

  // ---------- 报告 ----------
  function makeReport(mesh, analysis, extra) {
    return Object.assign(
      {
        generator: 'orientation-fixer',
        counts: {
          vertices: mesh.positions.length,
          uvs: mesh.uvs.length,
          faces: mesh.faces.length,
        },
        // 每个面角的 (顶点, UV) 对，供读回校验
        faceCorners: mesh.faces.map((f) => f.v.map((vi, k) => [vi, f.vt[k]])),
        components: analysis.components.map((c) => ({
          id: c.id,
          faceCount: c.faceCount,
          closed: c.closed,
          orientation: c.orientation,
          volume: c.volume,
          boundaryEdges: c.boundaryEdges,
          nonManifoldEdges: c.nonManifoldEdges,
          zeroAreaFaces: c.zeroAreaFaces,
        })),
        issues: {
          boundaryEdges: analysis.boundaryEdges.map(edgeKey),
          nonManifoldEdges: analysis.nonManifoldEdges.map((e) => ({
            edge: edgeKey(e),
            faces: e.faces.map((x) => x.f),
          })),
          zeroAreaFaces: analysis.zeroAreaFaces.slice(),
          coincidentVertices: analysis.coincidentVertices,
        },
      },
      extra || {}
    );
  }

  // ---------- 读回校验：把重新解析的网格与报告对比 ----------
  function verifyAgainstReport(mesh, report) {
    const results = [];
    const check = (name, pass, detail) =>
      results.push({ name, pass: !!pass, detail: detail || '' });

    check('面数一致', mesh.faces.length === report.counts.faces,
      `${mesh.faces.length} vs ${report.counts.faces}`);
    check('顶点数一致', mesh.positions.length === report.counts.vertices,
      `${mesh.positions.length} vs ${report.counts.vertices}`);
    check('UV数一致', mesh.uvs.length === report.counts.uvs,
      `${mesh.uvs.length} vs ${report.counts.uvs}`);

    // 每个面角的 (v, vt) 对应
    let cornerOk = mesh.faces.length === report.faceCorners.length;
    let badFace = -1;
    if (cornerOk) {
      for (let i = 0; i < mesh.faces.length; i++) {
        const f = mesh.faces[i];
        const rc = report.faceCorners[i];
        for (let k = 0; k < 3; k++) {
          if (f.v[k] !== rc[k][0] || f.vt[k] !== rc[k][1]) {
            cornerOk = false;
            badFace = i;
            break;
          }
        }
        if (!cornerOk) break;
      }
    }
    check('面角-UV对应一致', cornerOk, badFace >= 0 ? `面 #${badFace} 不匹配` : '');

    // 问题边集合
    const an = analyze(mesh);
    const keySet = (arr) => new Set(arr);
    const bRep = keySet(report.issues.boundaryEdges);
    const bAct = keySet(an.boundaryEdges.map(edgeKey));
    check('开口边一致', setEq(bRep, bAct),
      `报告 ${bRep.size} 条, 实际 ${bAct.size} 条`);
    const nRep = keySet(report.issues.nonManifoldEdges.map((e) => e.edge));
    const nAct = keySet(an.nonManifoldEdges.map(edgeKey));
    check('非流形边一致', setEq(nRep, nAct),
      `报告 ${nRep.size} 条, 实际 ${nAct.size} 条`);
    const zRep = keySet(report.issues.zeroAreaFaces);
    const zAct = keySet(an.zeroAreaFaces);
    check('零面积面一致', setEq(zRep, zAct),
      `报告 ${zRep.size} 个, 实际 ${zAct.size} 个`);
    check('重合顶点组数一致',
      an.coincidentVertices.length === report.issues.coincidentVertices.length,
      `报告 ${report.issues.coincidentVertices.length} 组, 实际 ${an.coincidentVertices.length} 组`);

    return results;
  }

  function setEq(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }

  return {
    parseOBJ,
    serializeOBJ,
    analyze,
    unifyComponent,
    applyFlips,
    signedVolume,
    makeReport,
    verifyAgainstReport,
    edgeKey,
  };
});
