import { WEIGHT_EPS } from './weights.js';

/**
 * Tiny column-major rigid 4x4 matrix helpers. Keeping the core free of Three
 * means the seam sample and logic tests run directly in Node after `npm install`
 * only for the browser viewer.
 */

export function identityMatrix() {
  const m = new Float64Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

function translationMatrix(x, y, z) {
  const m = identityMatrix();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

function rotationZMatrix(angle) {
  const m = identityMatrix();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

export function multiplyMatrices(a, b) {
  const out = new Float64Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] =
        a[row] * b[column * 4] +
        a[4 + row] * b[column * 4 + 1] +
        a[8 + row] * b[column * 4 + 2] +
        a[12 + row] * b[column * 4 + 3];
    }
  }
  return out;
}

function composeTranslationRotationZ(position, angle) {
  return multiplyMatrices(
    translationMatrix(position[0], position[1], position[2] ?? 0),
    rotationZMatrix(angle),
  );
}

function transformPoint(m, p) {
  const x = p[0];
  const y = p[1];
  const z = p[2] ?? 0;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Rigid-body inverse. All generated bone matrices are TR rigid matrices. */
function invertRigidMatrix(m) {
  const out = identityMatrix();
  out[0] = m[0];
  out[1] = m[4];
  out[2] = m[8];
  out[4] = m[1];
  out[5] = m[5];
  out[6] = m[9];
  out[8] = m[2];
  out[9] = m[6];
  out[10] = m[10];

  const tx = m[12];
  const ty = m[13];
  const tz = m[14];
  out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
  out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
  out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
  return out;
}

function localRestPosition(bone, parent) {
  const start = bone.restStart ?? bone.pivot ?? [0, 0, 0];
  if (!parent) return [...start];
  const parentStart = parent.restStart ?? parent.pivot ?? [0, 0, 0];
  return [start[0] - parentStart[0], start[1] - parentStart[1], (start[2] ?? 0) - (parentStart[2] ?? 0)];
}

/**
 * Build LBS matrices poseWorld * inverseRestWorld.
 * The generated rig has parents before children in index order and all rest
 * bones run along +X, so a Z Euler angle is sufficient for elbow bending.
 */
export function buildSkinMatrices(skeleton, angles = {}) {
  /** @type {Float64Array[]} */
  const restWorld = new Array(skeleton.length);
  /** @type {Float64Array[]} */
  const poseWorld = new Array(skeleton.length);
  /** @type {Float64Array[]} */
  const skin = new Array(skeleton.length);

  for (let i = 0; i < skeleton.length; i += 1) {
    const bone = skeleton[i];
    const parent = Number.isInteger(bone.parentIndex) ? skeleton[bone.parentIndex] : null;
    const parentRest = parent ? restWorld[bone.parentIndex] : identityMatrix();
    const parentPose = parent ? poseWorld[bone.parentIndex] : identityMatrix();
    const localPosition = localRestPosition(bone, parent);

    const restLocal = composeTranslationRotationZ(localPosition, 0);
    restWorld[i] = multiplyMatrices(parentRest, restLocal);

    const angle = Number(angles[i] ?? angles[String(i)] ?? 0);
    const poseLocal = composeTranslationRotationZ(localPosition, angle);
    poseWorld[i] = multiplyMatrices(parentPose, poseLocal);

    skin[i] = multiplyMatrices(poseWorld[i], invertRigidMatrix(restWorld[i]));
  }
  return skin;
}

export function getPoseAngles(project, poseKey) {
  return project?.meta?.poses?.[poseKey]?.angles ?? {};
}

function validInfluences(vertex, skeletonLength, overrideInfluences) {
  const source = overrideInfluences ?? vertex?.influences ?? [];
  const out = [];
  for (const inf of source) {
    const bone = Number(inf?.bone);
    const weight = Number(inf?.weight);
    if (
      Number.isInteger(bone) &&
      bone >= 0 &&
      bone < skeletonLength &&
      Number.isFinite(weight) &&
      weight > WEIGHT_EPS
    ) {
      out.push({ bone, weight });
    }
  }
  return out;
}

/**
 * Linear blend skinning on the CPU. Low-poly counts make this fast enough and
 * keep rest/posed position comparison exact in application state.
 *
 * `influenceOverrides` may be either a Map<vertexId, influences[]> or an
 * array indexed by vertex id.
 */
export function deformProject(project, poseKeyOrAngles, options = {}) {
  const angles =
    typeof poseKeyOrAngles === 'string' ? getPoseAngles(project, poseKeyOrAngles) : poseKeyOrAngles ?? {};
  const matrices = options.matrices ?? buildSkinMatrices(project.skeleton, angles);
  const vertices = project.mesh.vertices;
  const count = vertices.length;
  const positions = new Float64Array(count * 3);
  const statuses = new Array(count);

  const override = options.influenceOverrides ?? null;
  const getOverride = (id) => {
    if (!override) return undefined;
    if (override instanceof Map) return override.get(id);
    return override[id];
  };

  for (const vertex of vertices) {
    const id = vertex.id;
    const rest = project.mesh.restPositions[id] ?? vertex.position;
    const influences = validInfluences(vertex, project.skeleton.length, getOverride(id));
    const sum = influences.reduce((s, inf) => s + inf.weight, 0);

    positions[id * 3] = rest[0];
    positions[id * 3 + 1] = rest[1];
    positions[id * 3 + 2] = rest[2] ?? 0;

    if (sum <= WEIGHT_EPS) {
      statuses[id] = 'zero-or-invalid';
      continue;
    }

    let x = 0;
    let y = 0;
    let z = 0;
    for (const inf of influences) {
      const posed = transformPoint(matrices[inf.bone], rest);
      const w = inf.weight / sum;
      x += posed[0] * w;
      y += posed[1] * w;
      z += posed[2] * w;
    }
    positions[id * 3] = x;
    positions[id * 3 + 1] = y;
    positions[id * 3 + 2] = z;
    statuses[id] = 'ok';
  }

  return { positions, statuses, matrices };
}

export function evaluateVertex(project, vertexId, poseKey) {
  const rest = project.mesh.restPositions[vertexId] ?? project.mesh.vertices[vertexId]?.position;
  const deformed = deformProject(project, poseKey);
  const i = vertexId * 3;
  const posed = [deformed.positions[i], deformed.positions[i + 1], deformed.positions[i + 2]];
  const delta = [posed[0] - rest[0], posed[1] - rest[1], posed[2] - rest[2]];
  return {
    vertexId,
    poseKey,
    rest: [...rest],
    posed,
    delta,
    distance: Math.hypot(delta[0], delta[1], delta[2]),
    status: deformed.statuses[vertexId],
  };
}

export function positionAt(positions, id) {
  return [positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]];
}

export function maxPositionDifference(a, b) {
  const count = Math.min(a.length, b.length) / 3;
  let max = 0;
  let sum = 0;
  let changed = 0;
  let maxVertexId = -1;
  for (let id = 0; id < count; id += 1) {
    const dx = a[id * 3] - b[id * 3];
    const dy = a[id * 3 + 1] - b[id * 3 + 1];
    const dz = a[id * 3 + 2] - b[id * 3 + 2];
    const d = Math.hypot(dx, dy, dz);
    sum += d;
    if (d > 1e-5) changed += 1;
    if (d > max) {
      max = d;
      maxVertexId = id;
    }
  }
  return { max, mean: count ? sum / count : 0, changed, count, maxVertexId };
}
