import { type Mat4, type Vec2, type Vec3, buildModelMatrix, transformPoint, v3 } from './math.ts';
import {
  type FaceFrame,
  type GreenConvention,
  type HalfSide,
  type WorldFrame,
  applyNormalMap,
  transformFrame,
} from './tangent.ts';
import {
  type EdgeRecord,
  type FaceRecord,
  type MeshData,
  effectiveFrame,
} from './geometry.ts';
import { type ModelState, signedScale } from './state.ts';
import { type NormalTextureData, sampleRaw, rawToTangentVector, applyConvention } from './textures.ts';

export interface WorldFace {
  id: number;
  half: HalfSide;
  panelId: number;
  positions: [Vec3, Vec3, Vec3];
  uvs: [Vec2, Vec2, Vec2];
  frame: WorldFrame;
  source: FaceFrame;
  valid: boolean;
  reason?: string;
}

export interface WorldEdge {
  kind: 'fold' | 'mirror' | 'free';
  a: Vec3;
  b: Vec3;
  faceIds: number[];
}

export interface WorldMesh {
  modelMatrix: Mat4;
  faces: WorldFace[];
  edges: WorldEdge[];
}

export function buildWorldMesh(mesh: MeshData, model: ModelState): WorldMesh {
  const m = buildModelMatrix(
    [0, 0, 0],
    model.rotationDeg.map((d) => (d * Math.PI) / 180) as Vec3,
    signedScale(model),
  );
  const faces: WorldFace[] = mesh.faces.map((f: FaceRecord) => {
    const src = effectiveFrame(f);
    const positions = f.verts.map((vi) => transformPoint(m, mesh.vertices[vi].pos)) as [Vec3, Vec3, Vec3];
    const uvs = f.verts.map((vi) => mesh.vertices[vi].uv) as [Vec2, Vec2, Vec2];
    return {
      id: f.id,
      half: f.half,
      panelId: f.panelId,
      positions,
      uvs,
      frame: transformFrame(src, m),
      source: src,
      valid: src.valid,
      reason: src.reason,
    };
  });
  const edges: WorldEdge[] = mesh.edges.map((e: EdgeRecord) => ({
    kind: e.kind,
    a: transformPoint(m, e.a),
    b: transformPoint(m, e.b),
    faceIds: e.faceIds,
  }));
  return { modelMatrix: m, faces, edges };
}

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

export interface PickResult {
  face: WorldFace;
  point: Vec3;
  /** 重心坐标 */
  bary: [number, number, number];
  /** 重心插值得到的 UV */
  uv: Vec2;
  t: number;
}

/** Möller–Trumbore 射线/三角形求交 */
export function rayCast(ray: Ray, faces: WorldFace[]): PickResult | null {
  let best: PickResult | null = null;
  for (const face of faces) {
    const [a, b, c] = face.positions;
    const e1 = v3.sub(b, a);
    const e2 = v3.sub(c, a);
    const p = v3.cross(ray.dir, e2);
    const det = v3.dot(e1, p);
    if (Math.abs(det) < 1e-12) continue;
    const invDet = 1 / det;
    const s = v3.sub(ray.origin, a);
    const u = v3.dot(s, p) * invDet;
    if (u < -1e-7 || u > 1 + 1e-7) continue;
    const q = v3.cross(s, e1);
    const w = v3.dot(ray.dir, q) * invDet;
    if (w < -1e-7 || u + w > 1 + 1e-7) continue;
    const t = v3.dot(e2, q) * invDet;
    if (t < 0) continue;
    if (best && t >= best.t) continue;
    const baryW = 1 - u - w;
    const uv: Vec2 = [
      baryW * face.uvs[0][0] + u * face.uvs[1][0] + w * face.uvs[2][0],
      baryW * face.uvs[0][1] + u * face.uvs[1][1] + w * face.uvs[2][1],
    ];
    best = {
      face,
      point: v3.add(ray.origin, v3.scale(ray.dir, t)),
      bary: [baryW, u, w],
      uv,
      t,
    };
  }
  return best;
}

export interface ShadingInput {
  face: WorldFace;
  uv: Vec2;
  texture: NormalTextureData;
  convention: GreenConvention;
  lightDir: Vec3; // 指向光源的单位向量
  viewDir: Vec3; // 指向相机的单位向量
  diffuse: number;
  specular: number;
  shininess: number;
}

export interface ShadingResult {
  rawRGBA: [number, number, number, number];
  tangentNormalRaw: [number, number, number];
  tangentNormal: [number, number, number];
  worldNormal: Vec3;
  geometricNormal: Vec3;
  lambert: number;
  spec: number;
  color: [number, number, number];
}

/**
 * CPU 侧着色，公式与 fragment shader 完全一致，报告里记录的数值与画面同源。
 * 退化面不采样法线图，直接按几何法线着色。
 */
export function shadePoint(input: ShadingInput): ShadingResult {
  const { face, uv, texture, convention, lightDir, viewDir, diffuse, specular, shininess } = input;
  const rawRGBA = sampleRaw(texture, uv[0], uv[1]);
  const rawVec = rawToTangentVector(rawRGBA);
  // 纹理始终按 OpenGL 约定存储；切到 DirectX 时绿通道在这里翻一次，
  // 与 fragment shader 里的 uFlipG 分支严格同源。
  const tn = v3.normalize(applyConvention(rawVec, convention));
  const worldNormal = face.valid
    ? applyNormalMap(face.frame, tn)
    : v3.normalize(face.frame.N);
  const N = v3.normalize(worldNormal);
  const L = v3.normalize(lightDir);
  const V = v3.normalize(viewDir);
  const lambert = Math.max(0, v3.dot(N, L));
  const H = v3.normalize(v3.add(L, V));
  const spec = Math.pow(Math.max(0, v3.dot(N, H)), shininess) * (lambert > 0 ? 1 : 0);
  const base = 0.12;
  const r = base + diffuse * lambert * 0.9 + specular * spec;
  const g = base + diffuse * lambert * 0.85 + specular * spec;
  const b = base + diffuse * lambert * 0.75 + specular * spec;
  const clamp8 = (x: number) => Math.min(1, Math.max(0, x));
  return {
    rawRGBA,
    tangentNormalRaw: rawVec,
    tangentNormal: tn,
    worldNormal: N,
    geometricNormal: v3.normalize(face.frame.N),
    lambert,
    spec,
    color: [clamp8(r), clamp8(g), clamp8(b)],
  };
}
