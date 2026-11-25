/*
 * Procedural terrain core: deterministic height field, chunk LOD policy,
 * seam diagnostics and CPU mesh construction.
 *
 * The file is intentionally UMD-shaped so the page works from file:// with
 * ordinary <script> tags and the same pure logic can be tested in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Terrain = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SEED = 16304;

  const CHUNK_SIZE = 20;
  const CHUNKS_X = 11;
  const CHUNKS_Z = 12;

  // x: -110..110, z: -150..90. The opening camera is near z ~= 40 and
  // looks toward negative z, where the seeded hillside rises.
  const WORLD = {
    minX: -(CHUNKS_X * CHUNK_SIZE) / 2,
    maxX: (CHUNKS_X * CHUNK_SIZE) / 2,
    minZ: -150,
    maxZ: -150 + CHUNKS_Z * CHUNK_SIZE,
  };

  const RESOLUTIONS = [32, 64, 128];
  const DEFAULT_RESOLUTION = 64;
  const LOD_COUNT = 4;
  const LOD_LABELS = ['LOD0 最近 / 密', 'LOD1 中近', 'LOD2 中远', 'LOD3 远景 / 疏'];
  // Horizontal chunk-nearest-point distances at which a level boundary sits.
  const LOD_THRESHOLDS = [40, 82, 132];
  const HYSTERESIS = 5.5;
  const DWELL_MS = 180;

  const EDGE_SAMPLES = 129;

  // Fixed world-space checks. These coordinates are never derived from mesh
  // resolution, so their heights/hashes survive resolution changes.
  const DIAGNOSTIC_POINTS = [
    { id: 'D0', name: '近景台地', x: 18, z: 42 },
    { id: 'D1', name: '跨块边界 z=-30', x: 0, z: -30 },
    { id: 'D2', name: '尖脊检查点', x: -42, z: -72 },
    { id: 'D3', name: '阶台踩面', x: 44, z: -8 },
    { id: 'D4', name: '三档拐角', x: -10, z: -50 },
    { id: 'D5', name: '远处外轮廓', x: 8, z: -142 },
  ];

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function fnv1a(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function hash2(ix, iz) {
    let h = (SEED | 0) ^ Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function valueNoise(x, z) {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    // Quintic interpolation removes visible lattice derivatives.
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);

    const a = hash2(ix, iz);
    const b = hash2(ix + 1, iz);
    const c = hash2(ix, iz + 1);
    const d = hash2(ix + 1, iz + 1);
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uz);
  }

  function fbm(x, z, octaves) {
    octaves = octaves || 5;
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * valueNoise(x * freq, z * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;
  }

  function ridgedNoise(x, z, octaves) {
    octaves = octaves || 4;
    let amp = 0.55;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = valueNoise(x * freq, z * freq) * 2 - 1;
      let r = 1 - Math.abs(n);
      r = r * r;
      sum += r * amp;
      norm += amp;
      amp *= 0.52;
      freq *= 2.11;
    }
    return sum / norm;
  }

  // World-space height field. Mesh density and canvas resolution are deliberately
  // absent from this function; all fixed diagnostic values derive from here.
  function heightAt(x, z) {
    const rise = clamp((72 - z) / 232, 0, 1);

    // Main near-to-far slope, convex enough to read as a hillside.
    let h = 1.5 + rise * 5.0 + rise * rise * 27.0;

    // Broad irregular slopes.
    const broad = fbm(x * 0.011 + 17.3, z * 0.011 - 91.7, 5);
    h += (broad - 0.5) * 21.0;

    // Narrow sharp ridges, masked into only part of the hillside.
    const ridgeMask = smoothstep(0.38, 0.72, fbm(x * 0.006 - 40.0, z * 0.006 + 23.0, 3));
    const ridge = ridgedNoise(x * 0.026 + 7.7, z * 0.021 - 3.1, 4);
    h += Math.pow(ridge, 2.35) * 20.0 * ridgeMask;

    // Continuous terraces: broad flat treads followed by short steep risers.
    const terraceMask = smoothstep(0.34, 0.72, fbm(x * 0.017 + 101.0, z * 0.017 - 44.0, 3));
    const step = 2.65;
    const scaled = h / step;
    const cell = Math.floor(scaled);
    const f = scaled - cell;
    const riser = smoothstep(0.61, 0.965, f);
    const terraced = (cell + riser) * step;
    h = lerp(h, terraced, 0.8 * terraceMask);

    return h;
  }

  function chunkCount() {
    return CHUNKS_X * CHUNKS_Z;
  }

  function chunkId(cx, cz) {
    return cx + ',' + cz;
  }

  function parseChunkId(id) {
    const p = String(id).split(',');
    return { cx: Number(p[0]), cz: Number(p[1]) };
  }

  function inChunkRange(cx, cz) {
    return cx >= 0 && cx < CHUNKS_X && cz >= 0 && cz < CHUNKS_Z;
  }

  function chunkBounds(cx, cz) {
    return {
      cx,
      cz,
      x0: WORLD.minX + cx * CHUNK_SIZE,
      x1: WORLD.minX + (cx + 1) * CHUNK_SIZE,
      z0: WORLD.minZ + cz * CHUNK_SIZE,
      z1: WORLD.minZ + (cz + 1) * CHUNK_SIZE,
    };
  }

  function allChunkCoords() {
    const out = [];
    for (let cz = 0; cz < CHUNKS_Z; cz++) {
      for (let cx = 0; cx < CHUNKS_X; cx++) out.push({ cx, cz, id: chunkId(cx, cz) });
    }
    return out;
  }

  function chunkCenter(cx, cz) {
    const b = chunkBounds(cx, cz);
    return { x: (b.x0 + b.x1) * 0.5, z: (b.z0 + b.z1) * 0.5, y: heightAt((b.x0 + b.x1) * 0.5, (b.z0 + b.z1) * 0.5) };
  }

  function distanceToChunkXZ(x, z, cx, cz) {
    const b = chunkBounds(cx, cz);
    const dx = Math.max(b.x0 - x, 0, x - b.x1);
    const dz = Math.max(b.z0 - z, 0, z - b.z1);
    return Math.hypot(dx, dz);
  }

  function segmentsForLod(lod, resolution) {
    const base = RESOLUTIONS.includes(resolution) ? resolution : DEFAULT_RESOLUTION;
    const divisor = Math.pow(2, clamp(lod | 0, 0, LOD_COUNT - 1));
    return Math.max(4, Math.round(base / divisor));
  }

  function rawLodForDistance(d) {
    if (d < LOD_THRESHOLDS[0]) return 0;
    if (d < LOD_THRESHOLDS[1]) return 1;
    if (d < LOD_THRESHOLDS[2]) return 2;
    return 3;
  }

  // Hysteresis keeps a chunk in its old band until the camera has crossed a
  // widened boundary. Optional dwell prevents rapid forced overrides from
  // producing one-frame state churn.
  function stabilizeLod(d, currentLod, now, lastChange, opts) {
    opts = opts || {};
    const hysteresis = opts.hysteresis == null ? HYSTERESIS : opts.hysteresis;
    const dwellMs = opts.dwellMs == null ? DWELL_MS : opts.dwellMs;
    if (currentLod == null) return rawLodForDistance(d);

    let next = clamp(currentLod | 0, 0, LOD_COUNT - 1);
    while (next < LOD_COUNT - 1 && d > LOD_THRESHOLDS[next] + hysteresis) next++;
    while (next > 0 && d < LOD_THRESHOLDS[next - 1] - hysteresis) next--;

    if (next !== currentLod && now != null && lastChange != null && now - lastChange < dwellMs) {
      return currentLod;
    }
    return next;
  }

  function updateLodStates(states, camera, now, opts) {
    opts = opts || {};
    const changed = [];
    for (const c of allChunkCoords()) {
      const id = c.id;
      if (opts.frozen && !(opts.overrides && opts.overrides[id] != null)) {
        if (!states.has(id)) states.set(id, { lod: rawLodForDistance(distanceToChunkXZ(camera.x, camera.z, c.cx, c.cz)), since: now || 0 });
        continue;
      }

      const forced = opts.overrides ? opts.overrides[id] : null;
      const dist = distanceToChunkXZ(camera.x, camera.z, c.cx, c.cz);
      let st = states.get(id);
      if (!st) {
        st = { lod: forced != null ? forced : rawLodForDistance(dist), since: now || 0 };
        states.set(id, st);
        changed.push({ id, lod: st.lod, reason: 'new' });
        continue;
      }

      if (forced != null) {
        if (st.lod !== forced) {
          st.lod = forced;
          st.since = now || 0;
          changed.push({ id, lod: st.lod, reason: 'override' });
        }
        continue;
      }

      if (opts.frozen) continue;

      const next = stabilizeLod(dist, st.lod, now, st.since, opts);
      if (next !== st.lod) {
        st.lod = next;
        st.since = now || 0;
        changed.push({ id, lod: next, distance: dist, reason: 'camera' });
      }
    }
    return changed;
  }

  function neighborLods(cx, cz, states, overrides) {
    function lodAt(x, z) {
      if (!inChunkRange(x, z)) return null;
      const id = chunkId(x, z);
      if (overrides && overrides[id] != null) return overrides[id];
      const st = states && states.get(id);
      return st ? st.lod : rawLodForDistance(0);
    }
    return {
      west: lodAt(cx - 1, cz),
      east: lodAt(cx + 1, cz),
      north: lodAt(cx, cz - 1),
      south: lodAt(cx, cz + 1),
    };
  }

  // Native piecewise-linear edge evaluation at parameter t in [0,1].
  // orientation 'v': x fixed, z moves z0 -> z1. 'h': z fixed, x moves x0 -> x1.
  function nativeEdgeHeight(orientation, fixed, from, length, segments, t) {
    const scaled = clamp(t, 0, 1) * segments;
    let k = Math.floor(scaled);
    if (k >= segments) k = segments - 1;
    const u = scaled - k;

    function sample(q) {
      if (orientation === 'v') {
        const z = from + (q / segments) * length;
        return heightAt(fixed, z);
      }
      const x = from + (q / segments) * length;
      return heightAt(x, fixed);
    }

    return lerp(sample(k), sample(k + 1), u);
  }

  function edgeDescriptor(edgeId) {
    const parts = String(edgeId).split(':');
    const kind = parts[0];
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    if (kind === 'v') {
      // West chunk (a,b), east chunk (a+1,b).
      const w = chunkBounds(a, b);
      return {
        id: edgeId,
        kind,
        cA: { cx: a, cz: b },
        cB: { cx: a + 1, cz: b },
        orientation: 'v',
        fixed: w.x1,
        from: w.z0,
        length: CHUNK_SIZE,
        x: w.x1,
        z0: w.z0,
        z1: w.z1,
      };
    }
    // Horizontal: north/lower-z chunk (a,b), south chunk (a,b+1).
    const n = chunkBounds(a, b);
    return {
      id: edgeId,
      kind,
      cA: { cx: a, cz: b },
      cB: { cx: a, cz: b + 1 },
      orientation: 'h',
      fixed: n.z1,
      from: n.x0,
      length: CHUNK_SIZE,
      z: n.z1,
      x0: n.x0,
      x1: n.x1,
    };
  }

  function allInternalEdges() {
    const out = [];
    for (let cz = 0; cz < CHUNKS_Z; cz++) {
      for (let cx = 0; cx < CHUNKS_X - 1; cx++) out.push('v:' + cx + ':' + cz);
    }
    for (let cz = 0; cz < CHUNKS_Z - 1; cz++) {
      for (let cx = 0; cx < CHUNKS_X; cx++) out.push('h:' + cx + ':' + cz);
    }
    return out;
  }

  function edgeWorldPoint(desc, t) {
    if (desc.orientation === 'v') {
      return { x: desc.fixed, z: desc.from + t * desc.length };
    }
    return { x: desc.from + t * desc.length, z: desc.fixed };
  }

  function effectiveLod(id, states, overrides) {
    if (overrides && overrides[id] != null) return overrides[id];
    const st = states && states.get(id);
    return st ? st.lod : 3;
  }

  function edgeKPoint(d, k, segments) {
    const t = segments === 0 ? 0 : k / segments;
    return edgeWorldPoint(d, t);
  }

  function sampleEdgeK(d, k, segments) {
    const p = edgeKPoint(d, k, segments);
    return heightAt(p.x, p.z);
  }

  function interpCachedEdge(heights, segments, t) {
    const scaled = clamp(t, 0, 1) * segments;
    let k = Math.floor(scaled);
    if (k >= segments) k = segments - 1;
    const u = scaled - k;
    return lerp(heights[k], heights[k + 1], u);
  }

  function diagnoseEdge(edgeId, states, resolution, overrides) {
    const d = edgeDescriptor(edgeId);
    const idA = chunkId(d.cA.cx, d.cA.cz);
    const idB = chunkId(d.cB.cx, d.cB.cz);
    const lodA = effectiveLod(idA, states, overrides);
    const lodB = effectiveLod(idB, states, overrides);
    const nA = segmentsForLod(lodA, resolution);
    const nB = segmentsForLod(lodB, resolution);
    const commonN = Math.min(nA, nB);

    // Cache every native polyline control height once. Diagnostics then spend
    // their time on the fixed dense truth samples, not repeated heightAt calls.
    const hA = new Array(nA + 1);
    const hB = new Array(nB + 1);
    const hCommon = new Array(commonN + 1);
    for (let k = 0; k <= nA; k++) hA[k] = sampleEdgeK(d, k, nA);
    for (let k = 0; k <= nB; k++) hB[k] = sampleEdgeK(d, k, nB);
    for (let k = 0; k <= commonN; k++) hCommon[k] = sampleEdgeK(d, k, commonN);

    let nativeMax = -1;
    let nativeAt = null;
    let lockedMax = -1;
    let lockedAt = null;

    for (let i = 0; i <= EDGE_SAMPLES; i++) {
      const t = i / EDGE_SAMPLES;
      const p = edgeWorldPoint(d, t);
      const yTrue = heightAt(p.x, p.z);
      const yA = interpCachedEdge(hA, nA, t);
      const yB = interpCachedEdge(hB, nB, t);
      const yCommon = interpCachedEdge(hCommon, commonN, t);
      const nativeDiff = Math.abs(yA - yB);
      const lockedDiff = Math.abs(yTrue - yCommon);

      if (nativeDiff > nativeMax) {
        nativeMax = nativeDiff;
        nativeAt = { x: p.x, z: p.z, t, yA, yB, yTrue };
      }
      if (lockedDiff > lockedMax) {
        lockedMax = lockedDiff;
        lockedAt = { x: p.x, z: p.z, t, yCommon, yTrue };
      }
    }

    return {
      edgeId,
      desc: d,
      idA,
      idB,
      lodA,
      lodB,
      nA,
      nB,
      commonN,
      locked: true,
      renderedGap: 0,
      nativeMismatch: nativeMax,
      nativeMismatchPoint: nativeAt,
      seamError: lockedMax,
      seamErrorPoint: lockedAt,
    };
  }

  function diagnoseAllEdges(states, resolution, overrides) {
    return allInternalEdges().map((id) => diagnoseEdge(id, states, resolution, overrides));
  }

  function worstEdge(states, resolution, overrides, predicate) {
    let worst = null;
    for (const id of allInternalEdges()) {
      const info = diagnoseEdge(id, states, resolution, overrides);
      if (predicate && !predicate(info)) continue;
      if (!worst || info.nativeMismatch > worst.nativeMismatch) worst = info;
    }
    return worst;
  }

  function snappedEdgeY(x, z, edge, ownSegments, neighborLod, resolution) {
    if (neighborLod == null) return heightAt(x, z);
    const neighborSegments = segmentsForLod(neighborLod, resolution);
    const commonN = Math.min(ownSegments, neighborSegments);
    if (ownSegments <= commonN) return heightAt(x, z);

    const d = edgeDescriptor(edge);
    let t;
    if (d.orientation === 'v') t = (z - d.from) / d.length;
    else t = (x - d.from) / d.length;
    return nativeEdgeHeight(d.orientation, d.fixed, d.from, d.length, commonN, clamp(t, 0, 1));
  }

  function buildChunkMesh(cx, cz, options) {
    options = options || {};
    const resolution = options.resolution || DEFAULT_RESOLUTION;
    const lod = clamp(options.lod | 0, 0, LOD_COUNT - 1);
    const n = segmentsForLod(lod, resolution);
    const b = chunkBounds(cx, cz);
    const neighbors = options.neighbors || {};
    const snap = options.snap !== false;

    const positions = [];
    const indices = [];
    const lineIndices = [];

    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = lerp(b.x0, b.x1, i / n);
        const z = lerp(b.z0, b.z1, j / n);
        let y = heightAt(x, z);

        if (snap) {
          if (i === 0 && neighbors.west != null) {
            y = snappedEdgeY(x, z, 'v:' + (cx - 1) + ':' + cz, n, neighbors.west, resolution);
          } else if (i === n && neighbors.east != null) {
            y = snappedEdgeY(x, z, 'v:' + cx + ':' + cz, n, neighbors.east, resolution);
          }
          if (j === 0 && neighbors.north != null) {
            y = snappedEdgeY(x, z, 'h:' + cx + ':' + (cz - 1), n, neighbors.north, resolution);
          } else if (j === n && neighbors.south != null) {
            y = snappedEdgeY(x, z, 'h:' + cx + ':' + cz, n, neighbors.south, resolution);
          }
        }

        positions.push(x, y, z);
      }
    }

    const row = n + 1;
    const vi = (i, j) => j * row + i;

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = vi(i, j);
        const bb = vi(i + 1, j);
        const c = vi(i, j + 1);
        const d = vi(i + 1, j + 1);
        // Winding gives upward normals in x/z plane.
        indices.push(a, c, bb, bb, c, d);
      }
    }

    // All grid edges for wireframe/crack inspection.
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i < n; i++) {
        lineIndices.push(vi(i, j), vi(i + 1, j));
      }
    }
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j < n; j++) {
        lineIndices.push(vi(i, j), vi(i, j + 1));
      }
    }

    const normals = computeNormals(positions, indices);

    return {
      cx,
      cz,
      id: chunkId(cx, cz),
      lod,
      resolution,
      segments: n,
      positions: new Float32Array(positions),
      normals,
      indices: new Uint16Array(indices),
      lineIndices: new Uint16Array(lineIndices),
      triangleCount: indices.length / 3,
      lineCount: lineIndices.length / 2,
    };
  }

  function computeNormals(positions, indices) {
    const normals = new Float32Array(positions.length);
    for (let k = 0; k < indices.length; k += 3) {
      const ia = indices[k] * 3;
      const ib = indices[k + 1] * 3;
      const ic = indices[k + 2] * 3;

      const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
      const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
      const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];

      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;

      normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
      normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
      normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
    }

    for (let i = 0; i < normals.length; i += 3) {
      const x = normals[i], y = normals[i + 1], z = normals[i + 2];
      const len = Math.hypot(x, y, z) || 1;
      normals[i] = x / len;
      normals[i + 1] = y / len;
      normals[i + 2] = z / len;
    }
    return normals;
  }

  function totalTriangles(meshes) {
    let sum = 0;
    if (meshes instanceof Map) {
      for (const m of meshes.values()) sum += m.triangleCount;
    } else {
      for (const m of meshes) sum += m.triangleCount;
    }
    return sum;
  }

  function diagnosticBaseline() {
    const points = DIAGNOSTIC_POINTS.map((p) => ({ ...p, y: heightAt(p.x, p.z) }));

    // Fixed perimeter/profile samples make the outer contour hash-checkable.
    const profile = [];
    const profileSteps = 48;
    for (let i = 0; i <= profileSteps; i++) {
      const t = i / profileSteps;
      // Skyline-ish section through the middle, plus the far and near rims.
      profile.push({ where: 'center-z', x: lerp(WORLD.minX, WORLD.maxX, t), z: -50 });
    }
    for (let i = 0; i <= profileSteps; i++) {
      const t = i / profileSteps;
      profile.push({ where: 'far-rim', x: lerp(WORLD.minX, WORLD.maxX, t), z: WORLD.minZ + 1 });
    }
    const values = profile.map((p) => {
      p.y = heightAt(p.x, p.z);
      return p;
    });

    const pointText = points.map((p) => p.id + ':' + p.x + ',' + p.z + '=' + p.y.toFixed(6)).join('|');
    const profileText = values.map((p) => p.y.toFixed(6)).join(',');
    return {
      seed: SEED,
      points,
      profile: values,
      pointHash: fnv1a(pointText),
      contourHash: fnv1a(profileText),
    };
  }

  // Deterministic camera tours used by both the UI and Node-side audits.
  const TOURS = {
    cross: {
      name: '镜头 A：走过块边界 z=-30',
      durationMs: 9000,
      sampleAt(t) {
        const z = lerp(-6, -54, t);
        const x = 1.5 * Math.sin(t * Math.PI);
        const y = heightAt(x, z) + 7.2;
        const tz = z - 15;
        const tx = x + 1.0;
        return {
          eye: { x, y, z },
          target: { x: tx, y: heightAt(tx, tz) + 4.8, z: tz },
        };
      },
    },
    edge: {
      name: '镜头 B：沿三档拐角所在块边平移',
      durationMs: 10000,
      sampleAt(t) {
        // Runs parallel to the horizontal edge z=-50, close enough to inspect.
        const x = lerp(-58, 38, t);
        const z = -43.5 + Math.sin(t * Math.PI * 2) * 0.8;
        const y = heightAt(x, z) + 6.4;
        const tz = -50;
        const tx = x + 2;
        return {
          eye: { x, y, z },
          target: { x: tx, y: heightAt(tx, tz) + 2.2, z: tz },
        };
      },
    },
  };

  // Sample a full tour without WebGL. This backs the on-page peak/error report.
  function auditTour(tourKey, options) {
    options = options || {};
    const tour = TOURS[tourKey];
    const resolution = options.resolution || DEFAULT_RESOLUTION;
    const samples = options.samples || 181;
    const states = new Map();
    const overrides = options.overrides || {};
    let peakTriangles = 0;
    let peakAt = 0;
    let worst = null;
    const lodHistories = new Set();
    let lastLodSignature = '';

    for (let i = 0; i < samples; i++) {
      const t = i / (samples - 1);
      const frame = tour.sampleAt(t);
      const now = Math.round(t * tour.durationMs);
      updateLodStates(states, frame.eye, now, {
        frozen: options.frozen,
        overrides,
        hysteresis: options.hysteresis,
        dwellMs: options.dwellMs,
      });

      let triangles = 0;
      const signatureParts = [];
      for (const c of allChunkCoords()) {
        const st = states.get(c.id);
        const lod = st ? st.lod : 3;
        const n = segmentsForLod(lod, resolution);
        triangles += n * n * 2;
        lodHistories.add(c.id + ':' + lod);
        signatureParts.push(lod);
      }
      if (triangles > peakTriangles) {
        peakTriangles = triangles;
        peakAt = t;
      }

      // Edge diagnostics depend on the LOD configuration, not camera position
      // directly. Recompute the expensive all-edge pass only when that changes.
      const signature = signatureParts.join('');
      if (signature !== lastLodSignature) {
        lastLodSignature = signature;
        for (const edgeId of allInternalEdges()) {
          const info = diagnoseEdge(edgeId, states, resolution, overrides);
          if (!worst || info.nativeMismatch > worst.nativeMismatch) {
            worst = { ...info, tourT: t };
          }
        }
      }
    }

    return {
      tourKey,
      name: tour.name,
      peakTriangles,
      peakAt,
      worst,
      lodStateCount: lodHistories.size,
    };
  }

  return {
    SEED,
    WORLD,
    CHUNK_SIZE,
    CHUNKS_X,
    CHUNKS_Z,
    RESOLUTIONS,
    DEFAULT_RESOLUTION,
    LOD_COUNT,
    LOD_LABELS,
    LOD_THRESHOLDS,
    HYSTERESIS,
    DIAGNOSTIC_POINTS,
    EDGE_SAMPLES,
    TOURS,
    clamp,
    lerp,
    smoothstep,
    fnv1a,
    heightAt,
    chunkId,
    parseChunkId,
    inChunkRange,
    chunkBounds,
    allChunkCoords,
    chunkCenter,
    distanceToChunkXZ,
    segmentsForLod,
    rawLodForDistance,
    stabilizeLod,
    updateLodStates,
    neighborLods,
    edgeDescriptor,
    allInternalEdges,
    edgeWorldPoint,
    nativeEdgeHeight,
    diagnoseEdge,
    diagnoseAllEdges,
    worstEdge,
    buildChunkMesh,
    computeNormals,
    totalTriangles,
    diagnosticBaseline,
    auditTour,
  };
});
