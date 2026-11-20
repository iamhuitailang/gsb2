// 场景构建：把解析后的 OBJ 语法树展开为可渲染的节点树
// - 索引解析（正/负索引、越界校验）、多边形扇面三角化、缺失法线自动计算
// - 每个 group 内按材质拆分为 SubMesh
// - 节点使用与名字无关的稳定 ID，并对重名展示名做序号消歧

import type {
  MtlMaterial,
  ParseWarning,
  ParsedMtl,
  ParsedObj,
  SceneModel,
  SceneNode,
  SubMesh,
} from './types';
import { bbox, v3, type BBox, type Vec3 } from './math';

const DEFAULT_MATERIAL = '__default__';

class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];
  private bbox: BBox = bbox.empty();

  addVertex(p: Vec3, n: Vec3, uv: [number, number]): number {
    const idx = this.positions.length / 3;
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    this.uvs.push(uv[0], uv[1]);
    bbox.expandPoint(this.bbox, p);
    return idx;
  }

  addTriangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  build(materialName: string): SubMesh {
    return {
      materialName,
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices: new Uint32Array(this.indices),
      vertexCount: this.positions.length / 3,
      triangleCount: this.indices.length / 3,
      bbox: this.bbox,
    };
  }
}

function faceNormal(p0: Vec3, p1: Vec3, p2: Vec3): Vec3 {
  const n = v3.cross(v3.sub(p1, p0), v3.sub(p2, p0));
  const len = v3.length(n);
  return len > 1e-12 ? v3.scale(n, 1 / len) : [0, 1, 0];
}

/** 把 1 基（可能为负）的 OBJ 索引解析为 0 基数组索引，越界返回 null */
function resolveIndex(raw: number, count: number): number | null {
  if (raw === 0) return null;
  const idx = raw > 0 ? raw - 1 : count + raw;
  return idx >= 0 && idx < count ? idx : null;
}

/** 兄弟节点展示名消歧：重名时追加 #2、#3… */
function uniqueLabels(nodes: { rawName: string | null }[]): string[] {
  const used = new Map<string, number>();
  return nodes.map((n) => {
    const base = n.rawName ?? '(未命名)';
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base} #${seen + 1}`;
  });
}

export interface BuildInput {
  parsed: ParsedObj;
  mtls: ParsedMtl[];
  /** 当前可用的贴图文件名（basename 集合） */
  availableTextures: Set<string>;
  objFileName: string;
}

export function buildScene(input: BuildInput): SceneModel {
  const { parsed, mtls, availableTextures, objFileName } = input;
  const warnings: ParseWarning[] = [...parsed.warnings];
  for (const m of mtls) warnings.push(...m.warnings);

  // 合并所有 mtl 的材质表，同名以后加载者覆盖并提示
  const materials = new Map<string, MtlMaterial>();
  const materialSourceFile = new Map<string, string>();
  for (const mtl of mtls) {
    for (const [name, mat] of mtl.materials) {
      if (materials.has(name)) {
        warnings.push({
          level: 'warn',
          code: 'MTL_NAME_COLLISION',
          message: `材质 "${name}" 在多个材质库中出现，使用 "${mtl.file}" 中的定义`,
          file: mtl.file,
          line: null,
        });
      }
      materials.set(name, mat);
      materialSourceFile.set(name, mtl.file);
    }
  }

  const missingMaterialsSet = new Set<string>();
  const warnedMissingMaterial = new Set<string>();
  const ensureDefaultMaterial = (): void => {
    if (!materials.has(DEFAULT_MATERIAL)) {
      materials.set(DEFAULT_MATERIAL, {
        name: DEFAULT_MATERIAL,
        diffuse: { r: 0.75, g: 0.75, b: 0.75 },
        ambient: { r: 0.2, g: 0.2, b: 0.2 },
        specular: { r: 0.1, g: 0.1, b: 0.1 },
        shininess: 16,
        opacity: 1,
        diffuseMap: null,
        normalMap: null,
      });
    }
  };

  const { vertices, texcoords, normals, faces, objects } = parsed;

  const objectNodes: SceneNode[] = [];
  const rootBBox = bbox.empty();
  let rootVertices = 0;
  let rootFaces = 0;

  for (let oi = 0; oi < objects.length; oi++) {
    const rawObj = objects[oi];
    const groupNodes: SceneNode[] = [];

    for (let gi = 0; gi < rawObj.groups.length; gi++) {
      const rawGroup = rawObj.groups[gi];
      // 跳过 g 声明之前残留的空默认组
      if (rawGroup.faceIndices.length === 0) continue;
      const builders = new Map<string, MeshBuilder>();
      const groupBBox = bbox.empty();
      let groupVerts = 0;
      let groupTris = 0;

      const getBuilder = (matName: string): MeshBuilder => {
        let b = builders.get(matName);
        if (!b) {
          b = new MeshBuilder();
          builders.set(matName, b);
        }
        return b;
      };

      for (const faceIndex of rawGroup.faceIndices) {
        const face = faces[faceIndex];
        if (face.invalid) continue; // 解析阶段已记录警告

        // 逐顶点校验索引
        let badRef: { token: string; reason: string } | null = null;
        const resolved: { vi: number; ti: number | null; ni: number | null }[] = [];
        for (const ref of face.vertices) {
          const vi = resolveIndex(ref.v, vertices.length);
          if (vi === null) {
            badRef = {
              token: String(ref.v),
              reason: `顶点索引 ${ref.v} 越界（文件共 ${vertices.length} 个顶点）`,
            };
            break;
          }
          let ti: number | null = null;
          if (ref.vt !== 0) {
            ti = resolveIndex(ref.vt, texcoords.length);
            if (ti === null) {
              badRef = {
                token: String(ref.vt),
                reason: `纹理坐标索引 ${ref.vt} 越界（文件共 ${texcoords.length} 个纹理坐标）`,
              };
              break;
            }
          }
          let ni: number | null = null;
          if (ref.vn !== 0) {
            ni = resolveIndex(ref.vn, normals.length);
            if (ni === null) {
              badRef = {
                token: String(ref.vn),
                reason: `法线索引 ${ref.vn} 越界（文件共 ${normals.length} 条法线）`,
              };
              break;
            }
          }
          resolved.push({ vi, ti, ni });
        }

        if (badRef) {
          warnings.push({
            level: 'warn',
            code: 'OBJ_FACE_INDEX_OUT_OF_RANGE',
            message: `第 ${face.line} 行的面存在${badRef.reason}，该面已跳过，其余内容仍可查看`,
            file: objFileName,
            line: face.line,
          });
          continue;
        }

        // 材质解析
        let matName = face.material;
        if (matName === null) {
          matName = DEFAULT_MATERIAL;
          ensureDefaultMaterial();
        } else if (!materials.has(matName)) {
          missingMaterialsSet.add(matName);
          if (!warnedMissingMaterial.has(matName)) {
            warnedMissingMaterial.add(matName);
            warnings.push({
              level: 'warn',
              code: 'MTL_MATERIAL_NOT_FOUND',
              message:
                `材质 "${matName}" 被 OBJ 引用但在所有 mtllib 中都找不到定义，` +
                `相关面改用默认灰色材质（首次引用于第 ${face.line} 行）`,
              file: objFileName,
              line: face.line,
            });
          }
          ensureDefaultMaterial();
          matName = DEFAULT_MATERIAL;
        }

        const builder = getBuilder(matName);
        const hasNormals = resolved.every((r) => r.ni !== null);
        const triCount = resolved.length - 2;
        const emitted: number[] = [];

        for (const r of resolved) {
          const p = vertices[r.vi];
          const n = r.ni !== null ? normals[r.ni] : [0, 0, 0] as Vec3;
          const uv: [number, number] = r.ti !== null ? texcoords[r.ti] : [0, 0];
          emitted.push(builder.addVertex(p, n, uv));
          bbox.expandPoint(groupBBox, p);
          groupVerts++;
        }

        if (!hasNormals) {
          // 整个面都没有法线：按三角形扇面计算几何法线并回填
          for (let t = 0; t < triCount; t++) {
            const i0 = emitted[0];
            const i1 = emitted[t + 1];
            const i2 = emitted[t + 2];
            const fn = faceNormal(
              vertices[resolved[0].vi],
              vertices[resolved[t + 1].vi],
              vertices[resolved[t + 2].vi],
            );
            builder.normals[i0 * 3] = fn[0];
            builder.normals[i0 * 3 + 1] = fn[1];
            builder.normals[i0 * 3 + 2] = fn[2];
            builder.normals[i1 * 3] = fn[0];
            builder.normals[i1 * 3 + 1] = fn[1];
            builder.normals[i1 * 3 + 2] = fn[2];
            builder.normals[i2 * 3] = fn[0];
            builder.normals[i2 * 3 + 1] = fn[1];
            builder.normals[i2 * 3 + 2] = fn[2];
          }
        }

        // 扇面三角化（适用于凸多边形；凹多边形的视觉偏差由 OBJ 格式本身的通用约定承担）
        for (let t = 0; t < triCount; t++) {
          builder.addTriangle(emitted[0], emitted[t + 1], emitted[t + 2]);
        }
        groupTris += triCount;
      }

      const submeshes = [...builders.entries()].map(([matName, b]) => b.build(matName));
      const groupId = `o:${oi}/g:${gi}`;
      groupNodes.push({
        id: groupId,
        kind: 'group',
        label: rawGroup.name ?? '(默认组)',
        rawName: rawGroup.name,
        objectIndex: oi,
        groupIndex: gi,
        children: [],
        submeshes,
        bbox: groupBBox,
        vertexCount: groupVerts,
        faceCount: groupTris,
        hidden: false,
        colorOverride: null,
      });

      rootVertices += groupVerts;
      rootFaces += groupTris;
    }

    // 对象级包围盒与统计由组聚合
    let objBBox = bbox.empty();
    let objVerts = 0;
    let objFaces = 0;
    for (const g of groupNodes) {
      objBBox = bbox.union(objBBox, g.bbox);
      objVerts += g.vertexCount;
      objFaces += g.faceCount;
    }

    const labels = uniqueLabels(objects.map((o) => ({ rawName: o.name })));
    objectNodes.push({
      id: `o:${oi}`,
      kind: 'object',
      label: labels[oi],
      rawName: rawObj.name,
      objectIndex: oi,
      groupIndex: null,
      children: groupNodes,
      submeshes: [],
      bbox: objBBox,
      vertexCount: objVerts,
      faceCount: objFaces,
      hidden: false,
      colorOverride: null,
    });
    Object.assign(rootBBox, bbox.union(rootBBox, objBBox));
  }

  // 根节点
  const root: SceneNode = {
    id: 'root',
    kind: 'object',
    label: '场景根节点',
    rawName: null,
    objectIndex: -1,
    groupIndex: null,
    children: objectNodes,
    submeshes: [],
    bbox: rootBBox,
    vertexCount: rootVertices,
    faceCount: rootFaces,
    hidden: false,
    colorOverride: null,
  };

  // 贴图缺失检查（按材质去重报告，行号定位到 map_Kd 声明）
  const missingTextures = new Map<string, string[]>();
  for (const [name, mat] of materials) {
    if (name === DEFAULT_MATERIAL) continue;
    const missing: string[] = [];
    const checkRef = (ref: { path: string; line: number } | null): void => {
      if (!ref) return;
      const base = ref.path.split(/[\\/]/).pop() ?? ref.path;
      if (!availableTextures.has(base)) {
        missing.push(ref.path);
        warnings.push({
          level: 'warn',
          code: 'TEXTURE_FILE_MISSING',
          message:
            `材质 "${name}" 声明的贴图 "${ref.path}" 未在已载入文件中找到，` +
            `该材质将使用棋盘格占位贴图`,
          file: materialSourceFile.get(name) ?? objFileName,
          line: ref.line,
        });
      }
    };
    checkRef(mat.diffuseMap);
    checkRef(mat.normalMap);
    if (missing.length > 0) missingTextures.set(name, missing);
  }

  return {
    root,
    objects: objectNodes,
    materials,
    missingTextures,
    missingMaterials: [...missingMaterialsSet],
    warnings,
    objFileName,
    mtlFileNames: mtls.map((m) => m.file),
  };
}

/** 收集节点树全部节点（含根），扁平 Map 便于按稳定 ID 查找 */
export function flattenNodes(root: SceneNode): Map<string, SceneNode> {
  const map = new Map<string, SceneNode>();
  const walk = (node: SceneNode): void => {
    map.set(node.id, node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return map;
}
