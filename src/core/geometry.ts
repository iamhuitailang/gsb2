import { type Vec2, type Vec3, v3 } from './math.ts';
import {
  type FaceFrame,
  type HalfSide,
  computeFaceFrame,
} from './tangent.ts';

export interface RawVertex {
  pos: Vec3;
  uv: Vec2;
}

export type SeamKind = 'fold' | 'mirror' | 'free';

export interface FaceRecord {
  id: number;
  half: HalfSide;
  panelId: number;
  /** 3 个顶点索引（本面自己的一份，相邻面不共享 —— 模拟硬边/接缝拆点） */
  verts: [number, number, number];
  frame: FaceFrame;
  /** 预设注入的“错误/退化”帧；渲染与报告统一以 effectiveFrame 为准 */
  override?: Partial<FaceFrame>;
}

export interface EdgeRecord {
  key: string;
  kind: SeamKind;
  faceIds: number[];
  /** 端点（世界无关的物体空间） */
  a: Vec3;
  b: Vec3;
}

export interface CoincidentGroup {
  /** 量化位置键 */
  key: string;
  pos: Vec3;
  vertexIds: number[];
  faceIds: number[];
  /** 这些重合顶点是否带着不同的贴图方向（T 或 B 不一致） */
  directionConflict: boolean;
}

export interface MeshData {
  vertices: RawVertex[];
  faces: FaceRecord[];
  edges: EdgeRecord[];
  coincident: CoincidentGroup[];
  preset: MeshPresetId;
  presetNote: string;
}

export type MeshPresetId = 'correct' | 'broken-seam' | 'degenerate';

const PANEL_COUNT_PER_HALF = 4;
const PANEL_W = 1; // 每块折面沿 x 的宽度
const Y0 = -1;
const Y1 = 1;
/**
 * 折痕高度按“到中心缝的距离 d=0..4”索引，两半共用同一序列，
 * 保证 x=0 的镜像接缝在空间上严格重合（只是 UV 方向相反）。
 */
const H_BY_DISTANCE = [0, 0.75, -0.55, 0.35, -0.15];

function quantize(p: Vec3): string {
  const q = (n: number) => Math.round(n * 1e6) / 1e6;
  return `${q(p[0])},${q(p[1])},${q(p[2])}`;
}

interface PanelCorners {
  positions: [Vec3, Vec3, Vec3, Vec3]; // 左下、右下、右上、左上
  uvs: [Vec2, Vec2, Vec2, Vec2];
}

function panelCorners(half: HalfSide, panel: number): PanelCorners {
  let xL: number;
  let xR: number;
  let zL: number;
  let zR: number;
  if (half === 'normalUV') {
    // 左半面板 panel 跨度 x=-(4-panel) → -(3-panel)，离缝距离 4-panel → 3-panel
    xL = -PANEL_W * (PANEL_COUNT_PER_HALF - panel);
    xR = -PANEL_W * (PANEL_COUNT_PER_HALF - panel - 1);
    zL = H_BY_DISTANCE[PANEL_COUNT_PER_HALF - panel];
    zR = H_BY_DISTANCE[PANEL_COUNT_PER_HALF - panel - 1];
  } else {
    // 右半面板 panel 跨度 x=panel → panel+1，离缝距离 panel → panel+1
    xL = PANEL_W * panel;
    xR = PANEL_W * (panel + 1);
    zL = H_BY_DISTANCE[panel];
    zR = H_BY_DISTANCE[panel + 1];
  }
  const positions: [Vec3, Vec3, Vec3, Vec3] = [
    [xL, Y0, zL],
    [xR, Y0, zR],
    [xR, Y1, zR],
    [xL, Y1, zL],
  ];
  // 左半：普通 UV，u 随 +x 递增；右半：镜像 UV 岛，u 随 +x 递减。
  // 两半采样同一张图的同一片区域 (0..1, 0..1)，方便直接对照高光翻向。
  let uvs: [Vec2, Vec2, Vec2, Vec2];
  if (half === 'normalUV') {
    uvs = [
      [panel / PANEL_COUNT_PER_HALF, 0],
      [(panel + 1) / PANEL_COUNT_PER_HALF, 0],
      [(panel + 1) / PANEL_COUNT_PER_HALF, 1],
      [panel / PANEL_COUNT_PER_HALF, 1],
    ];
  } else {
    uvs = [
      [(panel + 1) / PANEL_COUNT_PER_HALF, 0],
      [panel / PANEL_COUNT_PER_HALF, 0],
      [panel / PANEL_COUNT_PER_HALF, 1],
      [(panel + 1) / PANEL_COUNT_PER_HALF, 1],
    ];
  }
  return { positions, uvs };
}

export function effectiveFrame(face: FaceRecord): FaceFrame {
  return face.override ? { ...face.frame, ...face.override } : face.frame;
}

/** 构造折面网格。三块预设共享几何，区别在注入的帧/退化面。 */
export function buildMesh(preset: MeshPresetId): MeshData {
  const vertices: RawVertex[] = [];
  const faces: FaceRecord[] = [];

  const addTriangle = (
    half: HalfSide,
    panelId: number,
    pos: [Vec3, Vec3, Vec3],
    uv: [Vec2, Vec2, Vec2],
  ): number => {
    const base = vertices.length;
    for (let i = 0; i < 3; i++) vertices.push({ pos: pos[i], uv: uv[i] });
    const id = faces.length;
    const frame = computeFaceFrame(id, half, panelId, pos, uv);
    faces.push({ id, half, panelId, verts: [base, base + 1, base + 2], frame });
    return id;
  };

  for (const half of ['normalUV', 'mirrorUV'] as HalfSide[]) {
    for (let p = 0; p < PANEL_COUNT_PER_HALF; p++) {
      const c = panelCorners(half, p);
      const panelId = half === 'normalUV' ? p : PANEL_COUNT_PER_HALF + p;
      // 三角形 0：左下-右下-右上
      addTriangle(
        half,
        panelId,
        [c.positions[0], c.positions[1], c.positions[2]],
        [c.uvs[0], c.uvs[1], c.uvs[2]],
      );
      // 三角形 1：左下-右上-左上
      addTriangle(
        half,
        panelId,
        [c.positions[0], c.positions[2], c.positions[3]],
        [c.uvs[0], c.uvs[2], c.uvs[3]],
      );
    }
  }

  if (preset === 'broken-seam') {
    // 刻意设错：镜像半的 B（沿 v 的贴图方向）被整体翻向。
    // 等价于管线没有处理 UV 镜像就复用了普通半的切线基 ——
    // 法线图的 Y 分量被解释到反方向，亮边在镜像半翻成暗边。
    for (const f of faces) {
      if (f.half === 'mirrorUV') {
        const bad = effectiveFrame(f);
        f.override = {
          ...bad,
          B: v3.neg(bad.B),
          handedness: (bad.handedness * -1) as 1 | -1,
        };
      }
    }
  }

  if (preset === 'degenerate') {
    // 额外挂一条“无法决定方向”的三角带：UV 三点重合，有向面积为 0。
    // 几何上接在最左端折面外侧，渲染时必须被标红列出。
    const anchor = panelCorners('normalUV', 0).positions;
    const a: Vec3 = anchor[0]; // (-4,-1,z)
    const b: Vec3 = anchor[3]; // (-4, 1,z)
    const c: Vec3 = [a[0] - 0.9, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + 0.4];
    const badUV: Vec2 = [0.125, 0.5];
    const id = addTriangle(
      'normalUV',
      99,
      [a, b, c],
      [badUV, badUV, badUV],
    );
    void id;
  }

  const edges = collectEdges(faces, vertices);
  const coincident = collectCoincident(faces, vertices);
  const notes: Record<MeshPresetId, string> = {
    correct:
      '基线预设：镜像半按 UV 有向面积取左手系，同一张法线图在两半的凹凸体感一致。',
    'broken-seam':
      '刻意设错：镜像半的 v 向贴图轴 (B) 被翻向，模拟未处理镜像的切线基 —— 同一张图的亮边在镜像半变成暗边。',
    degenerate:
      '退化预设：左侧额外挂了一片 UV 三点重合的三角面，贴图方向无法决定，应被标红并在报告中列出。',
  };
  return { vertices, faces, edges, coincident, preset, presetNote: notes[preset] };
}

function edgeKey(p1: Vec3, p2: Vec3): string {
  const k1 = quantize(p1);
  const k2 = quantize(p2);
  return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
}

function collectEdges(faces: FaceRecord[], vertices: RawVertex[]): EdgeRecord[] {
  const map = new Map<string, EdgeRecord>();
  for (const f of faces) {
    for (let e = 0; e < 3; e++) {
      const va = f.verts[e];
      const vb = f.verts[(e + 1) % 3];
      const pa = vertices[va].pos;
      const pb = vertices[vb].pos;
      const key = edgeKey(pa, pb);
      let rec = map.get(key);
      if (!rec) {
        rec = { key, kind: 'free', faceIds: [], a: pa, b: pb };
        map.set(key, rec);
      }
      if (!rec.faceIds.includes(f.id)) rec.faceIds.push(f.id);
    }
  }
  for (const rec of map.values()) {
    if (rec.faceIds.length < 2) {
      rec.kind = 'free';
      continue;
    }
    const halves = new Set(rec.faceIds.map((id) => faces[id].half));
    if (halves.size > 1) {
      rec.kind = 'mirror';
    } else {
      const panels = new Set(rec.faceIds.map((id) => faces[id].panelId));
      rec.kind = panels.size > 1 ? 'fold' : 'free';
    }
  }
  return [...map.values()];
}

function collectCoincident(faces: FaceRecord[], vertices: RawVertex[]): CoincidentGroup[] {
  const groups = new Map<string, CoincidentGroup>();
  for (const f of faces) {
    for (const vi of f.verts) {
      const key = quantize(vertices[vi].pos);
      let g = groups.get(key);
      if (!g) {
        g = { key, pos: vertices[vi].pos, vertexIds: [], faceIds: [], directionConflict: false };
        groups.set(key, g);
      }
      if (!g.vertexIds.includes(vi)) g.vertexIds.push(vi);
      if (!g.faceIds.includes(f.id)) g.faceIds.push(f.id);
    }
  }
  for (const g of groups.values()) {
    if (g.faceIds.length < 2) continue;
    // 重合顶点是否携带不同贴图方向：比较各面 effectiveFrame 的 T/B
    const sig = new Set<string>();
    for (const fid of g.faceIds) {
      const fr = effectiveFrame(faces[fid]);
      sig.add(
        `${fr.T.map((n) => n.toFixed(3)).join(',')}|${fr.B.map((n) => n.toFixed(3)).join(',')}`,
      );
    }
    g.directionConflict = sig.size > 1;
  }
  return [...groups.values()];
}
