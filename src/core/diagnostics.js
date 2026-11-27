import { planNormalization } from './weights.js';

export function distanceToSegment(point, start, end) {
  const px = point[0];
  const py = point[1];
  const pz = point[2] ?? 0;
  const ax = start[0];
  const ay = start[1];
  const az = start[2] ?? 0;
  const bx = end[0];
  const by = end[1];
  const bz = end[2] ?? 0;

  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const lengthSq = abx * abx + aby * aby + abz * abz;
  let t = lengthSq > 1e-12 ? (apx * abx + apy * aby + apz * abz) / lengthSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const cz = az + abz * t;
  return Math.hypot(px - cx, py - cy, pz - cz);
}

export function boneDistance(project, boneIndex, position) {
  const bone = project.skeleton[boneIndex];
  if (!bone) return Number.POSITIVE_INFINITY;
  return distanceToSegment(position, bone.restStart ?? bone.pivot, bone.restEnd ?? bone.pivot);
}

export function findDiagnostics(project, options = {}) {
  const threshold = options.farDistanceThreshold ?? project.meta?.farDistanceThreshold ?? 0.72;
  const farWeight = options.farWeight ?? 0.15;
  const diagnostics = [];
  const boneCount = project.skeleton.length;

  for (const vertex of project.mesh.vertices) {
    const position = project.mesh.restPositions[vertex.id] ?? vertex.position;
    const influences = Array.isArray(vertex.influences) ? vertex.influences : [];
    let validWeightSum = 0;
    let hasInvalid = false;

    for (const inf of influences) {
      const boneIndex = Number(inf?.bone);
      const weight = Number(inf?.weight);
      const weightValue = Number.isFinite(weight) ? weight : 0;
      const boneValid = Number.isInteger(boneIndex) && boneIndex >= 0 && boneIndex < boneCount;

      if (!boneValid) {
        hasInvalid = true;
        diagnostics.push({
          id: `invalid-${vertex.id}-${inf?.bone ?? 'nan'}`,
          vertexId: vertex.id,
          category: 'invalid',
          severity: 'critical',
          boneIndex,
          message: `顶点 V${String(vertex.id).padStart(3, '0')} 引用了失效骨骼编号 ${String(inf?.bone)}（权重 ${weightValue.toFixed(2)}）。`,
        });
      } else if (weightValue > 0) {
        validWeightSum += weightValue;
        const distance = boneDistance(project, boneIndex, position);
        if (weightValue >= farWeight && distance > threshold) {
          diagnostics.push({
            id: `far-${vertex.id}-${boneIndex}`,
            vertexId: vertex.id,
            category: 'far',
            severity: 'warning',
            boneIndex,
            distance,
            message: `V${String(vertex.id).padStart(3, '0')} 受 ${project.skeleton[boneIndex].nameZh ?? project.skeleton[boneIndex].name} 影响 ${weightValue.toFixed(2)}，但静止距离有 ${distance.toFixed(2)}。`,
          });
        }
      }
    }

    if (validWeightSum <= 1e-6) {
      diagnostics.push({
        id: `zero-${vertex.id}`,
        vertexId: vertex.id,
        category: 'zero',
        severity: hasInvalid ? 'warning' : 'critical',
        message: `顶点 V${String(vertex.id).padStart(3, '0')} 没有有效正权重，变形时会停在静止位置。`,
      });
    }
  }

  return diagnostics;
}

export function groupDiagnostics(diagnostics) {
  return {
    zero: diagnostics.filter((d) => d.category === 'zero'),
    invalid: diagnostics.filter((d) => d.category === 'invalid'),
    far: diagnostics.filter((d) => d.category === 'far'),
  };
}

export function coLocatedGroups(project, precision = 5) {
  const map = new Map();
  for (const vertex of project.mesh.vertices) {
    const p = project.mesh.restPositions[vertex.id] ?? vertex.position;
    const key = p.map((n) => Number(n).toFixed(precision)).join(',');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(vertex.id);
  }
  return [...map.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, position: key.split(',').map(Number), ids }));
}

export function coLocatedIds(project, vertexId, precision = 4) {
  const vertex = project.mesh.vertices[vertexId];
  if (!vertex) return [vertexId];
  const p = project.mesh.restPositions[vertexId] ?? vertex.position;
  const key = p.map((n) => Number(n).toFixed(precision)).join(',');
  return project.mesh.vertices
    .filter((v) => {
      const q = project.mesh.restPositions[v.id] ?? v.position;
      return q.map((n) => Number(n).toFixed(precision)).join(',') === key;
    })
    .map((v) => v.id);
}

function nearestBone(project, position) {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  project.skeleton.forEach((bone, index) => {
    const d = distanceToSegment(position, bone.restStart ?? bone.pivot, bone.restEnd ?? bone.pivot);
    if (d < bestDistance) {
      bestDistance = d;
      best = index;
    }
  });
  return { boneIndex: best, distance: bestDistance };
}

/**
 * Build a suggested repair for exactly one vertex. The caller is responsible
 * for putting it back into state keyed by this vertex id.
 */
export function buildSingleVertexFix(project, vertexId) {
  const vertex = project.mesh.vertices[vertexId];
  if (!vertex) return { ok: false, actions: ['找不到顶点'] };
  const position = project.mesh.restPositions[vertexId] ?? vertex.position;
  const threshold = project.meta?.farDistanceThreshold ?? 0.72;
  const actions = [];
  const locks = { ...(vertex.locks ?? {}) };

  let influences = (vertex.influences ?? []).filter((inf) => {
    const boneIndex = Number(inf?.bone);
    const boneValid = Number.isInteger(boneIndex) && boneIndex >= 0 && boneIndex < project.skeleton.length;
    if (!boneValid) {
      actions.push(`删除失效骨骼 ${String(inf?.bone)}`);
      return false;
    }
    return true;
  });

  influences = influences.filter((inf) => {
    const boneIndex = Number(inf.bone);
    const weight = Number(inf.weight) || 0;
    const locked = Object.prototype.hasOwnProperty.call(locks, String(boneIndex));
    const distance = boneDistance(project, boneIndex, position);
    if (!locked && weight >= 0.15 && distance > threshold) {
      actions.push(`移除过远影响 ${project.skeleton[boneIndex]?.name ?? boneIndex}`);
      return false;
    }
    return true;
  });

  const positiveSum = influences.reduce((s, inf) => s + Math.max(0, Number(inf.weight) || 0), 0);
  if (positiveSum <= 1e-6) {
    const nearest = nearestBone(project, position);
    influences = [{ bone: nearest.boneIndex, weight: 1 }];
    actions.push(`零权重改绑最近骨骼 ${project.skeleton[nearest.boneIndex]?.name ?? nearest.boneIndex}`);
  }

  const plan = planNormalization(influences, locks);
  if (!plan.ok) {
    return { ok: false, actions: [plan.message], influences: vertex.influences, locks: vertex.locks };
  }

  if (!actions.some((a) => a.includes('归一'))) actions.push('归一化剩余权重');
  return {
    ok: true,
    actions,
    influences: plan.values.map((v) => ({ bone: v.bone, weight: Number(v.weight.toFixed(6)) })),
    locks,
    plan,
  };
}

/** Pure project update. Only the matching vertex object is replaced. */
export function fixOnlyVertex(project, vertexId) {
  const fix = buildSingleVertexFix(project, vertexId);
  if (!fix.ok) return { ok: false, project, fix };
  const vertices = project.mesh.vertices.map((vertex) =>
    vertex.id === vertexId ? { ...vertex, influences: fix.influences, locks: fix.locks } : vertex,
  );
  return {
    ok: true,
    fix,
    project: {
      ...project,
      mesh: { ...project.mesh, vertices },
    },
  };
}
