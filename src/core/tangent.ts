import { type Vec3, type Vec2, v3, transformDir, normalMatrix3, type Mat4 } from './math.ts';

/** 绿通道约定：OpenGL(+Y 朝上，常见 glTF) 与 DirectX(+Y 朝下，常见引擎烘焙) */
export type GreenConvention = 'opengl' | 'directx';

/** 一半走普通 UV，另一半走镜像 UV */
export type HalfSide = 'normalUV' | 'mirrorUV';

export interface MeshVertex {
  pos: Vec3;
  uv: Vec2;
}

export interface FaceFrame {
  faceId: number;
  half: HalfSide;
  panelId: number;
  /** 物体空间单位向量 */
  T: Vec3;
  B: Vec3;
  N: Vec3;
  /** UV 三角形有向面积的符号：+1 普通朝向，-1 镜像（翻转），0 退化 */
  uvAreaSign: 1 | -1 | 0;
  uvArea: number;
  /** [T B N] 行列式的符号（右手系为 +1） */
  handedness: 1 | -1;
  valid: boolean;
  reason?: string;
}

export const EPS_UV_AREA = 1e-10;
export const EPS_LEN = 1e-10;

/**
 * 由一个三角面的位置与 UV 计算切线基（物体空间）。
 * 公式（标准 MikkTSpace 思路的逐面版本）：
 *   dp1 = p1-p0, dp2 = p2-p0
 *   det = du1*dv2 - du2*dv1
 *   T = (dp1*dv2 - dp2*dv1) / det
 *   B = (dp2*du1 - dp1*du2) / det
 * 镜像 UV 的三角形 det < 0，得到的 [T B N] 是左手系 —— 这正是“同一张贴图
 * 贴到对称另一半，亮边变暗边”的数学根因。
 */
export function computeFaceFrame(
  faceId: number,
  half: HalfSide,
  panelId: number,
  p: [Vec3, Vec3, Vec3],
  uv: [Vec2, Vec2, Vec2],
): FaceFrame {
  const [p0, p1, p2] = p;
  const [uv0, uv1, uv2] = uv;
  const dp1 = v3.sub(p1, p0);
  const dp2 = v3.sub(p2, p0);
  const du1 = uv1[0] - uv0[0];
  const dv1 = uv1[1] - uv0[1];
  const du2 = uv2[0] - uv0[0];
  const dv2 = uv2[1] - uv0[1];
  const det = du1 * dv2 - du2 * dv1;
  const uvArea = det * 0.5;

  const geomN = v3.normalize(v3.cross(dp1, dp2));
  const base: FaceFrame = {
    faceId,
    half,
    panelId,
    T: [1, 0, 0],
    B: [0, 1, 0],
    N: geomN,
    uvAreaSign: det > 0 ? 1 : det < 0 ? -1 : 0,
    uvArea,
    handedness: 1,
    valid: true,
  };

  if (Math.abs(det) < EPS_UV_AREA) {
    return {
      ...base,
      valid: false,
      reason: 'UV 三角形退化（有向面积≈0），无法决定贴图方向',
    };
  }
  if (v3.len(geomN) < EPS_LEN) {
    return {
      ...base,
      valid: false,
      reason: '几何三角形退化（三点共线），没有面法线',
    };
  }

  const invDet = 1 / det;
  const T = v3.scale(v3.sub(v3.scale(dp1, dv2), v3.scale(dp2, dv1)), invDet);
  const B = v3.scale(v3.sub(v3.scale(dp2, du1), v3.scale(dp1, du2)), invDet);
  const Tn = v3.normalize(T);
  const Bn = v3.normalize(B);
  if (v3.len(Tn) < EPS_LEN || v3.len(Bn) < EPS_LEN) {
    return { ...base, valid: false, reason: '切向量长度≈0，贴图方向无法决定' };
  }
  const handedness: 1 | -1 = v3.dot(v3.cross(Tn, Bn), geomN) >= 0 ? 1 : -1;
  return { ...base, T: Tn, B: Bn, handedness };
}

export interface WorldFrame {
  T: Vec3;
  B: Vec3;
  N: Vec3;
  handedness: 1 | -1;
}

/**
 * 用 normalMatrix = inverse(transpose(M)) 变换切向基，仅做归一化、不重新正交化。
 * 各轴缩放不同、甚至某一轴被翻转（负缩放）时，普通方向矩阵会给出错误的法线，
 * 法线矩阵则保证结果垂直于“变换后的切平面”；重新正交化反而会破坏该不变量。
 * 手性（镜像 UV 的左手系）由物体空间帧的 handedness 原样保留。
 */
export function transformFrame(frame: FaceFrame, model: Mat4): WorldFrame {
  const nm = normalMatrix3(model);
  const T = v3.normalize(transformDir(nm, frame.T));
  const B = v3.normalize(transformDir(nm, frame.B));
  const N = v3.normalize(transformDir(nm, frame.N));
  return { T, B, N, handedness: frame.handedness };
}

/** 法线图采样值解码：同一张纹理在两种约定下解释出不同的 Y */
export function decodeNormal(raw: Vec3, convention: GreenConvention): Vec3 {
  // 纹理按 OpenGL 约定存储（+Y 向上）；切到 DirectX 时取反绿通道
  const y = convention === 'opengl' ? raw[1] : -raw[1];
  return v3.normalize([raw[0], y, raw[2]]);
}

/** 用世界空间切线基把贴图法线转到世界空间 */
export function applyNormalMap(frame: WorldFrame, tangentNormal: Vec3): Vec3 {
  const n = v3.add(
    v3.add(
      v3.scale(frame.T, tangentNormal[0]),
      v3.scale(frame.B, tangentNormal[1]),
    ),
    v3.scale(frame.N, tangentNormal[2]),
  );
  return v3.normalize(n);
}
