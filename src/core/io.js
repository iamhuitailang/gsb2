import { PROJECT_FORMAT } from './modelFactory.js';
import { deformProject, maxPositionDifference } from './skinning.js';

export function serializeProject(project) {
  return JSON.stringify(
    {
      ...project,
      exportedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}

export function parseProject(textOrObject) {
  const data = typeof textOrObject === 'string' ? JSON.parse(textOrObject) : textOrObject;
  const errors = validateProject(data);
  if (errors.length) {
    const error = new Error(`导入文件结构不正确：${errors.join('；')}`);
    error.validationErrors = errors;
    throw error;
  }

  // Preserve invalid bone numbers on purpose; the diagnostics panel explains
  // them. Only fill optional UI fields.
  const vertices = data.mesh.vertices.map((raw, arrayIndex) => ({
    id: Number.isInteger(raw.id) ? raw.id : arrayIndex,
    position: Array.isArray(raw.position) ? raw.position.map(Number) : data.mesh.restPositions?.[arrayIndex],
    influences: Array.isArray(raw.influences)
      ? raw.influences.map((inf) => ({
          bone: inf?.bone,
          weight: Number(inf?.weight) || 0,
        }))
      : [],
    locks: raw.locks && typeof raw.locks === 'object' ? raw.locks : {},
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    note: typeof raw.note === 'string' ? raw.note : '',
  }));

  const restPositions =
    Array.isArray(data.mesh.restPositions) && data.mesh.restPositions.length === vertices.length
      ? data.mesh.restPositions.map((p) => p.map(Number))
      : vertices.map((v) => [...v.position]);

  return {
    format: data.format || PROJECT_FORMAT,
    exportedAt: data.exportedAt,
    meta: {
      farDistanceThreshold: 0.72,
      ...(data.meta ?? {}),
      poses: data.meta?.poses ?? {
        rest: { label: '静止', angles: {} },
        slight: { label: '轻微弯曲', angles: {} },
        strong: { label: '明显弯曲', angles: {} },
      },
    },
    skeleton: data.skeleton.map((bone, index) => ({
      index: Number.isInteger(bone.index) ? bone.index : index,
      name: String(bone.name ?? `Bone_${index}`),
      nameZh: bone.nameZh ? String(bone.nameZh) : '',
      parentIndex: Number.isInteger(bone.parentIndex) ? bone.parentIndex : null,
      restStart: bone.restStart?.map(Number) ?? bone.pivot?.map(Number) ?? [0, 0, 0],
      restEnd: bone.restEnd?.map(Number) ?? bone.restStart?.map(Number) ?? [0, 0, 0],
      pivot: bone.pivot?.map(Number) ?? bone.restStart?.map(Number) ?? [0, 0, 0],
    })),
    mesh: {
      restPositions,
      indices: Array.isArray(data.mesh.indices) ? data.mesh.indices.map(Number) : [],
      vertices,
      namedVertices: data.mesh.namedVertices ?? {},
    },
    config: { ...(data.config ?? {}) },
  };
}

export function validateProject(data) {
  const errors = [];
  if (!data || typeof data !== 'object') errors.push('不是 JSON 对象');
  if (!Array.isArray(data?.skeleton) || data.skeleton.length === 0) errors.push('缺少 skeleton 数组');
  if (!data?.mesh || typeof data.mesh !== 'object') errors.push('缺少 mesh 对象');
  if (!Array.isArray(data?.mesh?.vertices) || data.mesh.vertices.length === 0) {
    errors.push('缺少 mesh.vertices 数组');
  }
  if (Array.isArray(data?.mesh?.vertices)) {
    data.mesh.vertices.forEach((v, i) => {
      if (!Array.isArray(v?.position) || v.position.length !== 3 || v.position.some((n) => !Number.isFinite(Number(n)))) {
        errors.push(`顶点 ${i} 的 position 无效`);
      }
      if (!Array.isArray(v?.influences)) errors.push(`顶点 ${i} 缺少 influences`);
    });
  }
  return errors;
}

/**
 * Serialize -> parse -> deform and compare. This is the explicit read-back
 * check for rest and the representative strong bend.
 */
export function verifyRoundtrip(project) {
  const json = serializeProject(project);
  const restored = parseProject(json);

  const restOriginal = deformProject(project, 'rest');
  const restRestored = deformProject(restored, 'rest');
  const strongOriginal = deformProject(project, 'strong');
  const strongRestored = deformProject(restored, 'strong');
  const slightOriginal = deformProject(project, 'slight');
  const slightRestored = deformProject(restored, 'slight');

  const result = {
    ok: true,
    vertexCount: restored.mesh.vertices.length,
    boneCount: restored.skeleton.length,
    rest: maxPositionDifference(restOriginal.positions, restRestored.positions),
    slight: maxPositionDifference(slightOriginal.positions, slightRestored.positions),
    strong: maxPositionDifference(strongOriginal.positions, strongRestored.positions),
    bytes: new TextEncoder().encode(json).length,
  };
  result.ok = result.rest.max < 1e-10 && result.slight.max < 1e-8 && result.strong.max < 1e-8;
  return { ...result, restored, json };
}
