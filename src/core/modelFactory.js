/**
 * Deterministic low-poly arm rig.
 * Coordinates are in arbitrary local units; the arm rests along +X and bends
 * around +Z at the elbow located at the world origin.
 */

export const PROJECT_FORMAT = 'arm-weight-inspector/v1';

const RADIAL_SEGMENTS = 10;

function bone(index, name, nameZh, parentIndex, start, end, extra = {}) {
  return {
    index,
    name,
    nameZh,
    parentIndex,
    restStart: start,
    restEnd: end,
    pivot: start,
    ...extra,
  };
}

export function createSkeleton() {
  return [
    bone(0, 'Root', '根骨骼', null, [-1.72, 0, 0], [-1.48, 0, 0]),
    bone(1, 'UpperArm', '上臂', 0, [-1.5, 0, 0], [0, 0, 0]),
    bone(2, 'Forearm', '前臂 / 旁边那根', 1, [0, 0, 0], [1.22, 0, 0]),
    bone(3, 'Hand', '手掌', 2, [1.22, 0, 0], [1.72, 0, 0]),
  ];
}

function weights(...pairs) {
  return pairs.map(([boneIndex, weight]) => ({ bone: boneIndex, weight }));
}

export function createArmProject() {
  const skeleton = createSkeleton();
  /** @type {Array<any>} */
  const vertices = [];
  /** @type {number[]} */
  const indices = [];
  const rings = {};
  const namedVertices = {};

  function addVertex(position, influences, options = {}) {
    const id = vertices.length;
    vertices.push({
      id,
      position: position.map((n) => Number(n.toFixed(5))),
      influences: influences.map((inf) => ({ ...inf })),
      locks: options.locks ? { ...options.locks } : {},
      tags: options.tags ? [...options.tags] : [],
      note: options.note ?? '',
    });
    if (options.name) namedVertices[options.name] = id;
    return id;
  }

  function addRing(name, x, radius, weightFn, options = {}) {
    const ids = [];
    for (let j = 0; j < RADIAL_SEGMENTS; j += 1) {
      const angle = (j / RADIAL_SEGMENTS) * Math.PI * 2;
      // Slightly flatten depth so the low-poly arm reads as stylized rather
      // than a perfectly round pipe.
      const y = radius * Math.cos(angle);
      const z = radius * 0.82 * Math.sin(angle);
      const inf = weightFn({ j, angle, x, radius });
      const id = addVertex([x, y, z], inf, {
        name: options.nameVertex ? `${name}-${j}` : undefined,
        tags: options.tags ? [...options.tags] : [],
      });
      ids.push(id);
      namedVertices[`${name}-${j}`] = id;
    }
    rings[name] = { name, x, radius, ids };
    return ids;
  }

  function connectRings(aIds, bIds) {
    const n = aIds.length;
    for (let j = 0; j < n; j += 1) {
      const nxt = (j + 1) % n;
      const a = aIds[j];
      const b = aIds[nxt];
      const c = bIds[j];
      const d = bIds[nxt];
      indices.push(a, c, b, b, c, d);
    }
  }

  function addCap(ringIds, x, radius, influences, direction = -1) {
    const center = addVertex([x, 0, 0], influences, { tags: ['cap'] });
    const n = ringIds.length;
    for (let j = 0; j < n; j += 1) {
      const nxt = (j + 1) % n;
      if (direction < 0) indices.push(center, ringIds[nxt], ringIds[j]);
      else indices.push(center, ringIds[j], ringIds[nxt]);
    }
    return center;
  }

  // Upper arm. The final upper ring and first forearm ring share exact rest
  // positions, but have separate vertex IDs.
  addRing('shoulder', -1.42, 0.31, () => weights([0, 0.12], [1, 0.88]), {
    nameVertices: true,
  });
  addRing('upper0', -1.16, 0.3, () => weights([1, 1]));
  addRing('upper1', -0.84, 0.285, () => weights([1, 0.92], [2, 0.08]));
  addRing('upper2', -0.5, 0.265, () => weights([1, 0.74], [2, 0.26]));
  addRing('upper3', -0.19, 0.245, () => weights([1, 0.58], [2, 0.42]));
  addRing(
    'elbowUpper',
    0,
    0.235,
    ({ j }) => {
      // Planted elbow complaints: three consecutive upper-shell vertices have
      // been over-assigned to Forearm, the neighbouring bone.
      if ([1, 2, 3].includes(j)) return weights([1, 0.14], [2, 0.86]);
      if (j === 7) return weights([1, 0.25], [2, 0.25], [3, 0.25], [0, 0.25]);
      return weights([1, 0.55], [2, 0.45]);
    },
    { nameVertices: true, tags: ['seam-upper'] },
  );

  // Forearm starts with a duplicate elbow ring. Same coordinates, new IDs.
  addRing(
    'elbowForearm',
    0,
    0.235,
    ({ j }) => {
      if ([1, 2, 3].includes(j)) return weights([1, 0.52], [2, 0.48]);
      if (j === 7) return weights([1, 0.2], [2, 0.55], [3, 0.25]);
      return weights([1, 0.12], [2, 0.88]);
    },
    { nameVertices: true, tags: ['seam-lower'] },
  );
  addRing('fore0', 0.18, 0.225, () => weights([1, 0.05], [2, 0.95]));
  addRing('fore1', 0.43, 0.205, () => weights([2, 1]));
  addRing('fore2', 0.7, 0.185, () => weights([2, 1]));
  addRing('fore3', 0.96, 0.165, () => weights([2, 0.82], [3, 0.18]));
  addRing('wrist', 1.22, 0.145, () => weights([2, 0.58], [3, 0.42]));
  addRing('palm0', 1.38, 0.17, () => weights([2, 0.2], [3, 0.8]));
  addRing('palm1', 1.57, 0.158, () => weights([3, 1]));
  addRing('handTip', 1.72, 0.105, () => weights([3, 1]));

  const ringOrder = [
    'shoulder',
    'upper0',
    'upper1',
    'upper2',
    'upper3',
    'elbowUpper',
    'elbowForearm',
    'fore0',
    'fore1',
    'fore2',
    'fore3',
    'wrist',
    'palm0',
    'palm1',
    'handTip',
  ];
  for (let i = 0; i < ringOrder.length - 1; i += 1) {
    // Deliberately do NOT connect elbowUpper to elbowForearm: they are a
    // duplicated seam and must remain independently editable.
    if (ringOrder[i] === 'elbowUpper' && ringOrder[i + 1] === 'elbowForearm') continue;
    connectRings(rings[ringOrder[i]].ids, rings[ringOrder[i + 1]].ids);
  }

  addCap(rings.shoulder.ids, -1.52, 0.31, weights([0, 0.55], [1, 0.45]), -1);
  addCap(rings.handTip.ids, 1.84, 0.09, weights([3, 1]), 1);

  // Stable named seam pair for tests and the sample panel.
  namedVertices.seamBadUpper = namedVertices['elbowUpper-2'];
  namedVertices.seamPairForearm = namedVertices['elbowForearm-2'];
  namedVertices.tieBoundary = namedVertices['elbowUpper-7'];

  // Plant representative data-quality issues. These are intentionally local
  // and can be repaired one vertex at a time.
  const zeroId = namedVertices['fore1-4'];
  vertices[zeroId].influences = weights([2, 0], [3, 0]);
  vertices[zeroId].tags.push('qa-zero');
  vertices[zeroId].note = '故意保留的零权重点：弯曲时会停在静止位置。';
  namedVertices.qaZero = zeroId;

  const invalidId = namedVertices['upper2-8'];
  vertices[invalidId].influences = weights([1, 0.55], [99, 0.45]);
  vertices[invalidId].tags.push('qa-invalid');
  vertices[invalidId].note = '故意保留的失效骨骼编号 99。';
  namedVertices.qaInvalid = invalidId;

  const farId = namedVertices['shoulder-5'];
  vertices[farId].influences = weights([1, 0.58], [3, 0.42]);
  vertices[farId].tags.push('qa-far');
  vertices[farId].note = '肩部顶点却被远处手掌骨骼影响。';
  namedVertices.qaFar = farId;

  // A previously adjusted neighbour, used to make single-point isolation
  // explicit in tests/demo.
  const adjustedNeighbor = namedVertices['elbowUpper-1'];
  vertices[adjustedNeighbor].locks = { 2: 0.86 };
  vertices[adjustedNeighbor].tags.push('already-adjusted');

  return {
    format: PROJECT_FORMAT,
    meta: {
      name: '程序化低面数手臂权重检查器',
      createdAt: '2026-11-27T00:00:00.000Z',
      radialSegments: RADIAL_SEGMENTS,
      farDistanceThreshold: 0.72,
      tieRule: [
        '权重高者优先',
        '并列时锁定骨骼优先',
        '再按骨骼表顺序 / 较小骨骼编号',
        '最后按影响槽位顺序',
      ],
      poses: {
        rest: { label: '静止', angles: { 0: 0, 1: 0, 2: 0, 3: 0 } },
        slight: { label: '轻微弯曲 38°', angles: { 0: 0, 1: 0, 2: Math.PI * 0.2111, 3: 0.05 } },
        strong: { label: '明显弯曲 82°', angles: { 0: 0, 1: 0, 2: Math.PI * 0.4556, 3: 0.16 } },
      },
    },
    skeleton,
    mesh: {
      restPositions: vertices.map((v) => [...v.position]),
      indices,
      vertices,
      namedVertices,
    },
    config: {
      pose: 'strong',
      selectedVertexId: namedVertices.seamBadUpper,
      selectedBoneIndex: 2,
      maxInfluences: 4,
      compareMaxInfluences: 2,
      showRestMarkers: true,
      showSkeleton: true,
      weightOverlay: 'selectedBone',
    },
  };
}

/**
 * Tiny importable seam reproduction. Two independent vertices share one rest
 * position but have opposite bone weights. This is the smallest useful case
 * for proving that coincident vertices are not treated as one datum.
 */
export function createSeamReproProject() {
  const skeleton = [
    bone(0, 'UpperArm', '上臂', null, [-1, 0, 0], [0, 0, 0]),
    bone(1, 'Forearm', '前臂', 0, [0, 0, 0], [1, 0, 0]),
  ];
  const shared = [0, 0.24, 0];
  const vertices = [
    {
      id: 0,
      position: [...shared],
      influences: weights([0, 0.12], [1, 0.88]),
      locks: {},
      tags: ['seam-a-bad-neighbour-bone'],
      note: 'A：同一位置的独立网格顶点，被前臂骨带走。',
    },
    {
      id: 1,
      position: [...shared],
      influences: weights([0, 0.88], [1, 0.12]),
      locks: {},
      tags: ['seam-b-reference'],
      note: 'B：另一个独立网格顶点，主要留在上臂骨。',
    },
    {
      id: 2,
      position: [-0.18, 0.245, 0],
      influences: weights([0, 0.58], [1, 0.42]),
      locks: {},
      tags: ['upper-neighbour'],
      note: '相邻上臂环，用来观察几个点被带跑后的局部拉扯。',
    },
  ];
  return {
    format: PROJECT_FORMAT,
    meta: {
      name: '肘部接缝最小复现',
      createdAt: '2026-11-27T00:00:00.000Z',
      farDistanceThreshold: 0.72,
      tieRule: ['weight desc', 'locked first on tie', 'skeleton order', 'slot'],
      poses: {
        rest: { label: '静止', angles: { 0: 0, 1: 0 } },
        slight: { label: '轻微弯曲 38°', angles: { 0: 0, 1: Math.PI * 0.2111 } },
        strong: { label: '明显弯曲 82°', angles: { 0: 0, 1: Math.PI * 0.4556 } },
      },
    },
    skeleton,
    mesh: { restPositions: vertices.map((v) => [...v.position]), indices: [], vertices, namedVertices: { A: 0, B: 1, neighbor: 2 } },
    config: { pose: 'strong', selectedVertexId: 0, selectedBoneIndex: 1, maxInfluences: 4, compareMaxInfluences: 2 },
  };
}
