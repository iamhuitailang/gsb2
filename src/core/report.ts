import { type Vec3, v3 } from './math.ts';
import { type MeshData, effectiveFrame } from './geometry.ts';
import type { AppState } from './state.ts';
import { type WorldMesh, type WorldFace, shadePoint, type ShadingResult } from './world.ts';
import type { NormalTextureData } from './textures.ts';
import type { GreenConvention } from './tangent.ts';

export interface SideInfo {
  faceId: number;
  half: 'normalUV' | 'mirrorUV';
  uv: [number, number];
  T: Vec3;
  B: Vec3;
  N: Vec3;
  handedness: 1 | -1;
  shading: ShadingResult;
}

export interface SeamReport {
  generatedAt: string;
  preset: string;
  presetNote: string;
  convention: GreenConvention;
  textureKind: string;
  lightDir: Vec3;
  edgeKind: 'fold' | 'mirror';
  sharedPosition: Vec3;  sides: SideInfo[];
  highlightFlip: boolean;
  notes: string[];
}

const fmt = (n: number) => (Object.is(n, -0) ? 0 : Number(n.toFixed(4)));
const fv = (v: Vec3): Vec3 => [fmt(v[0]), fmt(v[1]), fmt(v[2])];

export function lightDirection(yawDeg: number, pitchDeg: number): Vec3 {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  return v3.normalize([
    Math.cos(p) * Math.sin(y),
    Math.sin(p),
    Math.cos(p) * Math.cos(y),
  ]);
}

/**
 * 为一条接缝/折痕两侧生成对照报告：记录各自贴图方向（T/B/N、手性）
 * 与同一盏灯下的着色结果（Lambert、高光、最终颜色）。
 */
export function buildSeamReport(
  mesh: MeshData,
  world: WorldMesh,
  texture: NormalTextureData,
  state: AppState,
  edgeKey?: string,
): SeamReport | null {
  const edge = edgeKey
    ? mesh.edges.find((e) => e.key === edgeKey)
    : mesh.edges.find((e) => e.kind === 'mirror') ?? mesh.edges.find((e) => e.kind === 'fold');
  if (!edge || edge.faceIds.length < 2 || edge.kind === 'free') return null;

  const lightDir = lightDirection(state.light.yawDeg, state.light.pitchDeg);
  const viewDir: Vec3 = [0, 0, 1]; // 报告使用固定观察方向，保证可复现
  const sides: SideInfo[] = [];
  const notes: string[] = [];

  for (const fid of edge.faceIds.slice(0, 2)) {
    const face: WorldFace = world.faces[fid];
    // 取该面在共享端点上的 UV（边的 a 端点对应面内哪个顶点）
    const local = faceVertexUvAt(face, mesh, edge.a);
    const src = effectiveFrame(mesh.faces[fid]);
    const shading = shadePoint({
      face,
      uv: local,
      texture,
      convention: state.convention,
      lightDir,
      viewDir,
      diffuse: state.diffuseIntensity,
      specular: state.specularIntensity,
      shininess: state.shininess,
    });
    sides.push({
      faceId: fid,
      half: face.half,
      uv: [fmt(local[0]), fmt(local[1])],
      T: fv(face.frame.T),
      B: fv(face.frame.B),
      N: fv(face.frame.N),
      handedness: src.handedness,
      shading,
    });
  }

  const invalidFaces = world.faces.filter((f) => !f.valid);
  if (invalidFaces.length > 0) {
    notes.push(
      `存在 ${invalidFaces.length} 个无法决定贴图方向的面：` +
        invalidFaces.map((f) => `#${f.id}（${f.reason}）`).join('、'),
    );
  }
  const [s1, s2] = sides;
  const highlightFlip =
    s1 !== undefined && s2 !== undefined && Math.abs(s1.shading.spec - s2.shading.spec) > 0.02;
  if (edge.kind === 'mirror') {
    notes.push(
      `镜像接缝两侧手性：${s1.handedness} vs ${s2.handedness}。` +
        `左手系一侧的 B 与普通半相反，若管线未按 UV 有向面积修正，法线图 Y 分量会被反向解释。`,
    );
  }
  if (highlightFlip) {
    notes.push(
      `两侧高光强度差 ${fmt(Math.abs(s1.shading.spec - s2.shading.spec))}，` +
        `亮边在其中一侧翻为暗边 —— 这正是本调试台要暴露的现象。`,
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    preset: mesh.preset,
    presetNote: mesh.presetNote,
    convention: state.convention,
    textureKind: state.textureKind,
    lightDir: fv(lightDir),
    edgeKind: edge.kind,
    sharedPosition: fv(edge.a),
    sides,
    highlightFlip,
    notes,
  };
}

function faceVertexUvAt(face: WorldFace, mesh: MeshData, targetPos: Vec3): [number, number] {
  const faceRecord = mesh.faces[face.id];
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < 3; i++) {
    const p = mesh.vertices[faceRecord.verts[i]].pos;
    const d = v3.len(v3.sub(p, targetPos));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return face.uvs[best];
}

export function reportToText(r: SeamReport): string {
  const line = '─'.repeat(68);
  const sideText = (s: SideInfo) =>
    [
      `  面 #${s.faceId}（${s.half === 'normalUV' ? '普通 UV 半' : '镜像 UV 半'}）  UV=(${s.uv.join(', ')})`,
      `    T(沿 u)=(${s.T.join(', ')})  B(沿 v)=(${s.B.join(', ')})`,
      `    N      =(${s.N.join(', ')})  手性=${s.handedness}`,
      `    原始字节 RGBA=(${s.shading.rawRGBA.join(', ')})`,
      `    贴图法线(切线空间)=(${s.shading.tangentNormal.map(fmt).join(', ')})`,
      `    世界法线=(${s.shading.worldNormal.map(fmt).join(', ')})`,
      `    Lambert=${fmt(s.shading.lambert)}  高光=${fmt(s.shading.spec)}  颜色=(${s.shading.color.map(fmt).join(', ')})`,
    ].join('\n');
  return [
    line,
    `法线贴图接缝对照报告  ${r.generatedAt}`,
    line,
    `预设: ${r.preset} —— ${r.presetNote}`,
    `法线图: ${r.textureKind}    绿通道约定: ${r.convention === 'opengl' ? 'OpenGL (+Y 向上)' : 'DirectX (+Y 向下，已翻绿)'}`,
    `灯光方向(指向光源): (${r.lightDir.join(', ')})`,
    `接缝类型: ${r.edgeKind === 'mirror' ? '镜像接缝' : '折痕硬边'}    共享空间顶点: (${r.sharedPosition.join(', ')})`,
    '',
    '相邻两侧纹理方向与着色：',
    sideText(r.sides[0]),
    sideText(r.sides[1]),
    '',
    `高光翻向: ${r.highlightFlip ? '是 ⚠' : '否'}`,
    ...r.notes.map((n) => `· ${n}`),
    line,
  ].join('\n');
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  triggerDownload(filename, URL.createObjectURL(blob));
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  triggerDownload(filename, URL.createObjectURL(blob));
}

function triggerDownload(filename: string, url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
