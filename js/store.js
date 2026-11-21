// 工程序列化 / 反序列化：保留物体变换与贴花 -> 对象的依附关系
export const STORAGE_KEY = 'decal-previewer-project-v1';

export function serializeProject(objects, decals) {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    objects: objects.map((o) => ({
      id: o.id,
      name: o.name,
      type: o.type,
      params: o.params,
      receivesDecal: o.receivesDecal,
      position: o.mesh.position.toArray(),
      rotation: [o.mesh.rotation.x, o.mesh.rotation.y, o.mesh.rotation.z],
      scale: o.mesh.scale.toArray(),
    })),
    decals: decals.map((d) => ({
      id: d.id,
      name: d.name,
      targetId: d.targetId,          // 依附关系
      pattern: d.pattern,
      text: d.text,
      width: d.width,
      height: d.height,
      depth: d.depth,
      roll: d.roll,
      maxAngle: d.maxAngle,
      order: d.order,
      projPos: [...d.projPos],
      projQuat: [...d.projQuat],
    })),
  };
}

export function deserializeProject(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || data.version !== 1 || !Array.isArray(data.objects) || !Array.isArray(data.decals)) {
    throw new Error('无法识别的工程文件格式');
  }
  return data;
}
