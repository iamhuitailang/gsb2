// OBJ / MTL 导入导出，以及 .uvproj 项目文件存取。
// OBJ 中一个面顶点写作 v/vt/vn；本工具内部按 corner 存 UV，
// 导出时为每个不同 (顶点,UV) 组合生成独立 v/vt 索引，切缝因此被正确表达。

import { createMesh } from './mesh.js';
import { buildTopology } from './topology.js';

/** 解析 OBJ 文本（支持三角面与四边面，四边面按扇形三角化；支持 v/vt/vn 与组/材质）。 */
export function parseOBJ(text, name = 'imported') {
  const positions = [];
  const srcUVs = [];
  const groups = []; // {name, material, faces:[[vi,ti,ni]...]}
  let current = { name: 'default', material: 'default', faces: [] };
  groups.push(current);
  const materials = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const [cmd, ...rest] = line.split(/\s+/);
    if (cmd === 'v') positions.push(rest.slice(0, 3).map(Number));
    else if (cmd === 'vt') srcUVs.push([Number(rest[0]), Number(rest[1] ?? 0)]);
    else if (cmd === 'g' || cmd === 'o') {
      current = { name: rest.join(' ') || 'group', material: current.material, faces: [] };
      groups.push(current);
    } else if (cmd === 'usemtl') {
      // 同一组内换材质：拆出新组，保证 faceMaterials 粒度到面
      current = { name: current.name, material: rest.join(' ') || 'default', faces: [] };
      groups.push(current);
    } else if (cmd === 'f') {
      const verts = rest.map((token) => {
        const [v, t, n] = token.split('/').map((x) => (x === undefined || x === '' ? -1 : Number(x) - 1));
        return [v, t, n];
      });
      for (let i = 1; i < verts.length - 1; i++) {
        current.faces.push([verts[0], verts[i], verts[i + 1]]);
      }
    }
  }

  const faces = [];
  const faceMaterials = [];
  const cornerUV = []; // 与 faces 平行：每面 3 个 [u,v]
  for (const g of groups) {
    for (const tri of g.faces) {
      faces.push(tri.map(([v]) => v));
      faceMaterials.push(g.material);
      cornerUV.push(
        tri.map(([, t]) => {
          if (t >= 0 && srcUVs[t]) return [srcUVs[t][0], srcUVs[t][1]];
          return [0, 0];
        }),
      );
    }
  }
  for (const m of new Set(faceMaterials)) materials[m] = { diffuse: [0.62, 0.65, 0.7] };

  const mesh = createMesh({ name, positions, faces, faceMaterials, materials, uvSets: [cornerUV] });
  mesh.topology = buildTopology(faces);
  return mesh;
}

/** 极简 MTL 解析，读取漫反射色覆盖默认材质色。 */
export function parseMTL(text) {
  const out = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    if (cmd === 'newmtl') current = rest.join(' ');
    else if (cmd === 'Kd' && current) {
      out[current] = { diffuse: rest.slice(0, 3).map(Number) };
    }
  }
  return out;
}

/**
 * 导出 OBJ + MTL。
 * 顶点按 (位置索引, UV) 去重后输出 v 与 vt；不同岛共享的 3D 顶点若 UV 不同，
 * 会写成不同的 v 索引（游戏引擎 DCC 常见做法），切缝得以保留。
 *
 * @returns {{obj:string, mtl:string, mtlName:string}}
 */
export function exportOBJ(mesh, setIndex = 0, mtlName = 'materials.mtl') {
  const uvs = mesh.uvSets[setIndex];
  const vOut = []; // [x,y,z]
  const vtOut = []; // [u,v]
  const remap = new Map(); // "face_corner" -> 输出顶点序号(1-based)
  const lines = [`# Exported by uv-inspector (UV set ${setIndex + 1})`, `mtllib ${mtlName}`, ''];

  const getOut = (f, k) => {
    const key = `${f}_${k}`;
    if (remap.has(key)) return remap.get(key);
    const vi = mesh.faces[f][k];
    const [u, vv] = uvs[f][k];
    vOut.push(mesh.positions[vi]);
    vtOut.push([u, vv]);
    const idx = vOut.length;
    remap.set(key, idx);
    return idx;
  };

  let lastMat = null;
  for (let f = 0; f < mesh.faces.length; f++) {
    const mat = mesh.faceMaterials[f] ?? 'default';
    if (mat !== lastMat) {
      lines.push(`usemtl ${mat}`);
      lastMat = mat;
    }
    const ids = [0, 1, 2].map((k) => getOut(f, k));
    lines.push(`f ${ids.map((i) => `${i}/${i}`).join(' ')}`);
  }

  const obj = [
    `# Vertices: ${vOut.length}  Faces: ${mesh.faces.length}`,
    ...vOut.map((p) => `v ${p.map((n) => n.toFixed(6)).join(' ')}`),
    ...vtOut.map(([u, v]) => `vt ${u.toFixed(6)} ${v.toFixed(6)}`),
    '',
    ...lines,
  ].join('\n');

  const mtl = Object.entries(mesh.materials)
    .map(([name, m]) => {
      const [r, g, b] = m.diffuse;
      return `newmtl ${name}\nKd ${r} ${g} ${b}\n`;
    })
    .join('\n');

  return { obj, mtl, mtlName };
}

/**
 * 项目文件：完整保存几何、所有 UV 套、切缝、材质，可无损恢复。
 * @param {object} mesh
 * @param {object} [viewState] 相机角度、当前 UV 套等界面状态
 */
export function saveProject(mesh, viewState = {}) {
  return JSON.stringify(
    {
      format: 'uv-inspector-project',
      version: 1,
      savedAt: new Date().toISOString(),
      mesh: {
        name: mesh.name,
        positions: mesh.positions,
        faces: mesh.faces,
        faceMaterials: mesh.faceMaterials,
        materials: mesh.materials,
        uvNames: mesh.uvNames ?? [],
        uvSets: mesh.uvSets,
        seams: [...mesh.seams],
      },
      viewState,
    },
    null,
    2,
  );
}

export function loadProject(text) {
  const data = JSON.parse(text);
  if (data.format !== 'uv-inspector-project') {
    throw new Error('不是有效的 uv-inspector 项目文件');
  }
  const m = data.mesh;
  const mesh = createMesh({
    name: m.name,
    positions: m.positions,
    faces: m.faces,
    faceMaterials: m.faceMaterials,
    materials: m.materials,
    uvSets: m.uvSets,
  });
  mesh.uvNames = m.uvNames?.length ? m.uvNames : mesh.uvNames;
  mesh.seams = new Set(m.seams ?? []);
  return { mesh, viewState: data.viewState ?? {} };
}
