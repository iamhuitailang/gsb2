import { pruneInfluences } from './weights.js';
import { deformProject, maxPositionDifference } from './skinning.js';

export function buildPrunedSet(project, maxInfluences, options = {}) {
  const overrides = new Map();
  const reports = new Map();
  const boneOrder = project.skeleton.map((b) => b.index);
  for (const vertex of project.mesh.vertices) {
    const locks = options.useLocks === false ? {} : vertex.locks ?? {};
    const report = pruneInfluences(vertex.influences, maxInfluences, {
      boneOrder,
      boneCount: project.skeleton.length,
      locks,
    });
    reports.set(vertex.id, report);
    overrides.set(
      vertex.id,
      report.retained.map((r) => ({ bone: r.bone, weight: r.afterWeight })),
    );
  }
  return { overrides, reports };
}

export function compareCapsAtPoses(project, poseKeys = ['rest', 'slight', 'strong'], options = {}) {
  const cap2 = buildPrunedSet(project, 2, options);
  const cap4 = buildPrunedSet(project, 4, options);
  const poses = {};

  for (const poseKey of poseKeys) {
    const p2 = deformProject(project, poseKey, { influenceOverrides: cap2.overrides });
    const p4 = deformProject(project, poseKey, { influenceOverrides: cap4.overrides });
    const original = deformProject(project, poseKey);
    poses[poseKey] = {
      cap2VsCap4: maxPositionDifference(p2.positions, p4.positions),
      cap2VsOriginal: maxPositionDifference(p2.positions, original.positions),
      cap4VsOriginal: maxPositionDifference(p4.positions, original.positions),
    };
  }

  return { cap2, cap4, poses };
}

export function selectedVertexCapReport(project, vertexId, maxInfluences, options = {}) {
  const vertex = project.mesh.vertices[vertexId];
  if (!vertex) return null;
  const boneOrder = project.skeleton.map((b) => b.index);
  return pruneInfluences(vertex.influences, maxInfluences, {
    boneOrder,
    boneCount: project.skeleton.length,
    locks: options.useLocks === false ? {} : vertex.locks ?? {},
  });
}
