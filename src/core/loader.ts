import type { CameraData, GeometryKind, NodeData, SceneFile, Vec3 } from './types';

/**
 * 场景文件加载器。
 *
 * 关键保证：校验与解析全部在新对象上完成，任何一项失败都抛出带中文原因的错误，
 * 调用方在成功前不得触碰当前文档 —— 因此无效数据不可能部分覆盖当前场景。
 */

const GEOMETRY_KINDS: ReadonlySet<GeometryKind> = new Set([
  'box',
  'sphere',
  'cylinder',
  'cone',
  'torus',
  'plane',
]);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function asVec3(v: unknown, path: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) {
    throw new Error(`场景数据无效：${path} 必须是长度为 3 的数字数组`);
  }
  if (!v.every(isFiniteNumber)) {
    throw new Error(`场景数据无效：${path} 含有非数字或无穷值`);
  }
  return [v[0], v[1], v[2]];
}

function asOptionalColor(v: unknown, path: string): number | undefined {
  if (v === undefined) return undefined;
  if (!isFiniteNumber(v) || v < 0 || v > 0xffffff || !Number.isInteger(v)) {
    throw new Error(`场景数据无效：${path} 必须是 0~16777215 的整数颜色值`);
  }
  return v;
}

/**
 * 解析并完整校验 JSON 文本 / 对象。通过则返回可直接交给文档的数据，失败则抛错。
 */
export function parseSceneFile(input: unknown): SceneFile {
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch (e) {
      throw new Error(`场景文件不是合法 JSON：${(e as Error).message}`);
    }
  }
  const raw = input as Record<string, unknown>;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('场景数据无效：顶层必须是对象');
  }
  if (raw.formatVersion !== 1) {
    throw new Error(
      `场景数据无效：不支持的格式版本 ${String(raw.formatVersion)}（本编辑器支持版本 1）`,
    );
  }
  if (!Array.isArray(raw.nodes)) {
    throw new Error('场景数据无效：nodes 必须是数组');
  }

  const nodes: NodeData[] = [];
  const ids = new Set<string>();

  raw.nodes.forEach((item, i) => {
    const path = `nodes[${i}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`场景数据无效：${path} 必须是对象`);
    }
    const n = item as Record<string, unknown>;

    if (typeof n.id !== 'string' || n.id.length === 0) {
      throw new Error(`场景数据无效：${path}.id 必须是非空字符串`);
    }
    if (ids.has(n.id)) {
      throw new Error(`场景数据无效：节点 id 重复：${n.id}`);
    }
    if (typeof n.name !== 'string' || n.name.length === 0) {
      throw new Error(`场景数据无效：${path}.name 必须是非空字符串`);
    }
    if (n.parentId !== null && typeof n.parentId !== 'string') {
      throw new Error(`场景数据无效：${path}.parentId 必须是字符串或 null`);
    }
    if (typeof n.parentId === 'string' && n.parentId === n.id) {
      throw new Error(`场景数据无效：节点 ${n.id} 的父节点是它自己，存在循环`);
    }

    const node: NodeData = {
      id: n.id,
      name: n.name,
      parentId: (n.parentId ?? null) as string | null,
      position: asVec3(n.position, `${path}.position`),
      rotation: asVec3(n.rotation, `${path}.rotation`),
      scale: asVec3(n.scale, `${path}.scale`),
      visible: typeof n.visible === 'boolean' ? n.visible : true,
    };
    ids.add(n.id);

    if (n.geometry !== undefined) {
      if (n.geometry === null || typeof n.geometry !== 'object') {
        throw new Error(`场景数据无效：${path}.geometry 必须是对象`);
      }
      const g = n.geometry as Record<string, unknown>;
      if (typeof g.kind !== 'string' || !GEOMETRY_KINDS.has(g.kind as GeometryKind)) {
        throw new Error(
          `场景数据无效：${path}.geometry.kind 取值非法（支持 ${[...GEOMETRY_KINDS].join(
            '、',
          )}）`,
        );
      }
      if (g.params !== undefined) {
        if (!Array.isArray(g.params) || !g.params.every(isFiniteNumber)) {
          throw new Error(`场景数据无效：${path}.geometry.params 必须是数字数组`);
        }
      }
      node.geometry = {
        kind: g.kind as GeometryKind,
        params: g.params as number[] | undefined,
      };
    }

    if (n.material !== undefined) {
      if (n.material === null || typeof n.material !== 'object') {
        throw new Error(`场景数据无效：${path}.material 必须是对象`);
      }
      const m = n.material as Record<string, unknown>;
      const color = asOptionalColor(m.color, `${path}.material.color`);
      if (color === undefined) {
        throw new Error(`场景数据无效：${path}.material.color 缺失`);
      }
      const material = { color } as NodeData['material'] & object;
      if (m.opacity !== undefined) {
        if (!isFiniteNumber(m.opacity) || m.opacity <= 0 || m.opacity > 1) {
          throw new Error(`场景数据无效：${path}.material.opacity 必须在 (0,1] 内`);
        }
        material.opacity = m.opacity;
      }
      if (m.metalness !== undefined) {
        if (!isFiniteNumber(m.metalness) || m.metalness < 0 || m.metalness > 1) {
          throw new Error(`场景数据无效：${path}.material.metalness 必须在 [0,1] 内`);
        }
        material.metalness = m.metalness;
      }
      if (m.roughness !== undefined) {
        if (!isFiniteNumber(m.roughness) || m.roughness < 0 || m.roughness > 1) {
          throw new Error(`场景数据无效：${path}.material.roughness 必须在 [0,1] 内`);
        }
        material.roughness = m.roughness;
      }
      node.material = material;
    }

    // 缩放为 0 会导致矩阵不可逆，重挂接/世界反推全部失效，提前拒绝
    if (node.scale.some((s) => s === 0)) {
      throw new Error(`场景数据无效：${path}.scale 不能包含 0（矩阵将不可逆）`);
    }
    nodes.push(node);
  });

  // 父引用完整性 + 环检测
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (n.parentId !== null && !byId.has(n.parentId)) {
      throw new Error(`场景数据无效：节点 ${n.id} 引用了不存在的父节点 ${n.parentId}`);
    }
  }
  for (const n of nodes) {
    const seen = new Set<string>();
    let cur: NodeData | undefined = n;
    while (cur && cur.parentId !== null) {
      if (seen.has(cur.id)) {
        throw new Error(`场景数据无效：层级中存在循环（涉及节点 ${cur.id}）`);
      }
      seen.add(cur.id);
      cur = byId.get(cur.parentId);
    }
  }

  const camera = parseCamera(raw.camera);
  return { formatVersion: 1, nodes, camera };
}

function parseCamera(raw: unknown): CameraData {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('场景数据无效：camera 必须是对象');
  }
  const c = raw as Record<string, unknown>;
  const camera: CameraData = {
    position: asVec3(c.position, 'camera.position'),
    target: asVec3(c.target, 'camera.target'),
    up: asVec3(c.up, 'camera.up'),
    fov: 50,
    near: 0.1,
    far: 1000,
  };
  if (c.fov !== undefined) {
    if (!isFiniteNumber(c.fov) || c.fov <= 0 || c.fov >= 180) {
      throw new Error('场景数据无效：camera.fov 必须在 (0,180) 内');
    }
    camera.fov = c.fov;
  }
  if (c.near !== undefined) {
    if (!isFiniteNumber(c.near) || c.near <= 0) {
      throw new Error('场景数据无效：camera.near 必须为正数');
    }
    camera.near = c.near;
  }
  if (c.far !== undefined) {
    if (!isFiniteNumber(c.far) || c.far <= camera.near) {
      throw new Error('场景数据无效：camera.far 必须大于 near');
    }
    camera.far = c.far;
  }
  if (camera.up.every((v) => v === 0)) {
    throw new Error('场景数据无效：camera.up 不能是零向量');
  }
  return camera;
}
