const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../js/terrain.js');

function boundary(mesh, side) {
  const n = mesh.segments;
  const row = n + 1;
  const out = [];
  const get = (i, j) => {
    const k = (j * row + i) * 3;
    return { x: mesh.positions[k], y: mesh.positions[k + 1], z: mesh.positions[k + 2] };
  };
  for (let q = 0; q <= n; q++) {
    if (side === 'west') out.push(get(0, q));
    if (side === 'east') out.push(get(n, q));
    if (side === 'north') out.push(get(q, 0));
    if (side === 'south') out.push(get(q, n));
  }
  return out;
}

function tOnEdge(p, desc) {
  return desc.orientation === 'v'
    ? (p.z - desc.from) / desc.length
    : (p.x - desc.from) / desc.length;
}

function yAtT(points, ts, t) {
  const zipped = points
    .map((p, i) => ({ p, t: ts[i] }))
    .sort((a, b) => a.t - b.t);
  if (t <= zipped[0].t) return zipped[0].p.y;
  if (t >= zipped[zipped.length - 1].t) return zipped[zipped.length - 1].p.y;
  for (let i = 1; i < zipped.length; i++) {
    if (t <= zipped[i].t) {
      const a = zipped[i - 1];
      const b = zipped[i];
      const u = (t - a.t) / (b.t - a.t || 1);
      return T.lerp(a.p.y, b.p.y, u);
    }
  }
  return zipped[zipped.length - 1].p.y;
}

function assertEdgesMeet(meshA, sideA, meshB, sideB, edgeId) {
  const desc = T.edgeDescriptor(edgeId);
  const a = boundary(meshA, sideA);
  const b = boundary(meshB, sideB);
  const ta = a.map((p) => tOnEdge(p, desc));
  const tb = b.map((p) => tOnEdge(p, desc));

  let maxErr = 0;
  for (let i = 0; i < a.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(a[i].y - yAtT(b, tb, ta[i])));
  }
  for (let i = 0; i < b.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(b[i].y - yAtT(a, ta, tb[i])));
  }
  assert.ok(maxErr < 1e-5, `${edgeId} seam mismatch ${maxErr}`);
}

test('same seed gives stable diagnostic baseline across calls', () => {
  const a = T.diagnosticBaseline();
  const b = T.diagnosticBaseline();
  assert.equal(a.seed, 16304);
  assert.equal(a.pointHash, b.pointHash);
  assert.equal(a.contourHash, b.contourHash);
  assert.equal(a.points.length, T.DIAGNOSTIC_POINTS.length);
  for (const p of a.points) assert.ok(Number.isFinite(p.y));
});

test('mesh resolution changes density but not world outer bounds or corner heights', () => {
  const cx = 5;
  const cz = 5;
  const bounds = T.chunkBounds(cx, cz);
  const cornerHeight = T.heightAt(bounds.x0, bounds.z0);

  for (const resolution of T.RESOLUTIONS) {
    const mesh = T.buildChunkMesh(cx, cz, { lod: 0, resolution });
    assert.equal(mesh.segments, resolution);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      minX = Math.min(minX, mesh.positions[i]);
      maxX = Math.max(maxX, mesh.positions[i]);
      minZ = Math.min(minZ, mesh.positions[i + 2]);
      maxZ = Math.max(maxZ, mesh.positions[i + 2]);
    }
    assert.ok(Math.abs(minX - bounds.x0) < 1e-6);
    assert.ok(Math.abs(maxX - bounds.x1) < 1e-6);
    assert.ok(Math.abs(minZ - bounds.z0) < 1e-6);
    assert.ok(Math.abs(maxZ - bounds.z1) < 1e-6);
    assert.ok(Math.abs(mesh.positions[1] - cornerHeight) < 1e-6);
  }
});

test('every vertical/horizontal LOD pair is watertight after edge locking', () => {
  for (let la = 0; la < 4; la++) {
    for (let lb = 0; lb < 4; lb++) {
      const verticalA = T.buildChunkMesh(5, 5, {
        lod: la,
        neighbors: { east: lb },
      });
      const verticalB = T.buildChunkMesh(6, 5, {
        lod: lb,
        neighbors: { west: la },
      });
      assertEdgesMeet(verticalA, 'east', verticalB, 'west', 'v:5:5');

      const horizontalA = T.buildChunkMesh(5, 5, {
        lod: la,
        neighbors: { south: lb },
      });
      const horizontalB = T.buildChunkMesh(5, 6, {
        lod: lb,
        neighbors: { north: la },
      });
      assertEdgesMeet(horizontalA, 'south', horizontalB, 'north', 'h:5:5');
    }
  }
});

test('all 256 four-LOD corner combinations have no pairwise seam gap', () => {
  const corner = { cx: 5, cz: 5 };
  for (let code = 0; code < 256; code++) {
    const levels = [code & 3, (code >> 2) & 3, (code >> 4) & 3, (code >> 6) & 3];
    const [nw, ne, sw, se] = levels;

    const mNW = T.buildChunkMesh(corner.cx, corner.cz, {
      lod: nw,
      neighbors: { east: ne, south: sw },
    });
    const mNE = T.buildChunkMesh(corner.cx + 1, corner.cz, {
      lod: ne,
      neighbors: { west: nw, south: se },
    });
    const mSW = T.buildChunkMesh(corner.cx, corner.cz + 1, {
      lod: sw,
      neighbors: { north: nw, east: se },
    });
    const mSE = T.buildChunkMesh(corner.cx + 1, corner.cz + 1, {
      lod: se,
      neighbors: { north: ne, west: sw },
    });

    assertEdgesMeet(mNW, 'east', mNE, 'west', 'v:5:5');
    assertEdgesMeet(mSW, 'east', mSE, 'west', 'v:5:6');
    assertEdgesMeet(mNW, 'south', mSW, 'north', 'h:5:5');
    assertEdgesMeet(mNE, 'south', mSE, 'north', 'h:6:5');
  }
});

test('hysteresis prevents per-frame LOD toggling around one threshold', () => {
  // A chunk already coarse and a chunk already fine can disagree in the band,
  // but neither changes while distance oscillates narrowly around threshold 40.
  for (let frame = 0; frame < 20; frame++) {
    const d = frame % 2 === 0 ? 39 : 41;
    assert.equal(T.stabilizeLod(d, 0, 1000 + frame * 50, 0), 0);
    assert.equal(T.stabilizeLod(d, 1, 1000 + frame * 50, 0), 1);
  }

  // Widely crossing the hysteresis offsets changes state only at separated points.
  const sequence = [30, 44, 46, 47, 45, 40, 35, 34, 33, 30];
  let lod = 0;
  const transitions = [];
  sequence.forEach((d, i) => {
    const next = T.stabilizeLod(d, lod, 1000 + i * 100, 0, { dwellMs: 0 });
    if (next !== lod) transitions.push({ i, from: lod, to: next, d });
    lod = next;
  });
  assert.deepEqual(transitions.map((x) => `${x.from}->${x.to}`), ['0->1', '1->0']);
});

test('dwell time blocks rapid immediate churn', () => {
  const now = 1000;
  assert.equal(T.stabilizeLod(200, 0, now + 50, now, { dwellMs: 180 }), 0);
  assert.equal(T.stabilizeLod(200, 0, now + 181, now, { dwellMs: 180 }), 3);
});

test('fixed tours audit to finite peak face and seam diagnostics', () => {
  for (const key of ['cross', 'edge']) {
    const result = T.auditTour(key, { resolution: 64, samples: 91 });
    assert.ok(result.peakTriangles > 100000);
    assert.ok(Number.isFinite(result.peakAt));
    assert.ok(result.worst);
    assert.ok(Number.isFinite(result.worst.nativeMismatch));
    assert.ok(Number.isFinite(result.worst.seamError));
    assert.ok(result.worst.nativeMismatchPoint.x > T.WORLD.minX);
    assert.ok(result.worst.nativeMismatchPoint.x < T.WORLD.maxX);
  }
});
