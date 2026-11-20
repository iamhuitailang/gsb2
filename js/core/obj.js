// 轻量 OBJ 读写器。
// 读取：v / vn / f（支持 v、v//vn、v/vt、v/vt/vn 与负索引、多边形扇面三角化）、o/g。
// 写入：仅顶点与三角面（+ vn），文件头写入简化比例与面数等元数据。
// 不支持的特性（材质 MTL、自由曲线、N 边形导出）在 README 中说明。

import { Mesh } from './mesh.js';

/**
 * 解析 OBJ 文本。
 * @returns {{meshes:Mesh[], warnings:string[]}}
 * 不同 o/g 段分别成网；没有分段时返回单个网格。
 */
export function parseOBJ(text) {
  const warnings = [];
  const positions = [];
  const normals = [];
  const groups = [];
  let current = { name: 'object', indices: [], normalIndex: [] };
  groups.push(current);

  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo].trim();
    if (!line || line.startsWith('#')) continue;
    const sp = line.indexOf(/\s/.exec(line)?.[0] ?? '');
    const tag = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? '' : line.slice(sp + 1).trim();
    const tokens = rest.length ? rest.split(/\s+/) : [];

    if (tag === 'v') {
      if (tokens.length < 3) { warnings.push(`第 ${lineNo + 1} 行 v 顶点数据不足，已跳过`); continue; }
      positions.push(Number(tokens[0]), Number(tokens[1]), Number(tokens[2]));
    } else if (tag === 'vn') {
      if (tokens.length < 3) continue;
      normals.push(Number(tokens[0]), Number(tokens[1]), Number(tokens[2]));
    } else if (tag === 'o' || tag === 'g') {
      if (current.indices.length || groups.length > 1 || current.name !== 'object') {
        current = { name: tokens[0] || `${tag}_${groups.length}`, indices: [], normalIndex: [] };
        groups.push(current);
      } else {
        current.name = tokens[0] || 'object';
      }
    } else if (tag === 'f') {
      if (tokens.length < 3) { warnings.push(`第 ${lineNo + 1} 行面顶点不足，已跳过`); continue; }
      const verts = tokens.map((tok) => {
        const parts = tok.split('/');
        let vi = Number(parts[0]);
        // OBJ 负索引：-1 表示当前最后一个元素（位置数组长度/3）
        if (vi < 0) vi = positions.length / 3 + vi + 1;
        let ni = parts[2] !== undefined && parts[2] !== '' ? Number(parts[2]) : null;
        if (ni !== null && ni < 0) ni = normals.length / 3 + ni + 1;
        return { vi: vi - 1, ni: ni === null ? null : ni - 1 };
      });
      // 扇面三角化
      for (let i = 1; i < verts.length - 1; i++) {
        for (const v of [verts[0], verts[i], verts[i + 1]]) {
          current.indices.push(v.vi);
          current.normalIndex.push(v.ni);
        }
      }
      if (tokens.length > 4 && warnings.length < 20) {
        warnings.push(`第 ${lineNo + 1} 行 ${tokens.length} 边形已做扇面三角化`);
      }
    }
    // vt / mtllib / usemtl / s 等忽略
  }

  const meshes = groups
    .filter((g) => g.indices.length > 0)
    .map((g) => {
      const maxIdx = g.indices.reduce((m, i) => Math.max(m, i), 0);
      if (maxIdx * 3 + 3 > positions.length) {
        warnings.push(`组 ${g.name} 存在越界面索引，越界部分将产生零坐标顶点`);
      }
      const hasNormal = g.normalIndex.some((i) => i !== null) && normals.length;
      const outNormals = hasNormal ? new Float32Array((positions.length / 3) * 3) : null;
      if (hasNormal) {
        for (let k = 0; k < g.normalIndex.length; k++) {
          const ni = g.normalIndex[k];
          if (ni === null || ni * 3 + 2 >= normals.length) continue;
          const vi = g.indices[k];
          outNormals[vi * 3] = normals[ni * 3];
          outNormals[vi * 3 + 1] = normals[ni * 3 + 1];
          outNormals[vi * 3 + 2] = normals[ni * 3 + 2];
        }
      }
      return new Mesh({
        positions: Float32Array.from(positions),
        indices: Uint32Array.from(g.indices),
        normals: outNormals,
        name: g.name,
      });
    });

  if (meshes.length === 0) throw new Error('OBJ 中未解析到任何面');
  return { meshes, warnings };
}

/**
 * 序列化为 OBJ 文本。
 * @param {Mesh|Mesh[]} input
 * @param {object} [meta] 写入文件头注释的元数据
 */
export function writeOBJ(input, meta = null) {
  const meshes = Array.isArray(input) ? input : [input];
  const lines = [];
  lines.push('# 由网格简化对比工具导出');
  lines.push(`# 导出时间 ${new Date().toISOString()}`);
  if (meta) {
    lines.push('# --- 简化元数据 ---');
    for (const [k, v] of Object.entries(meta)) lines.push(`# ${k}: ${v}`);
  }
  let vertexOffset = 0;
  let normalOffset = 0;
  for (const mesh of meshes) {
    lines.push(`o ${mesh.name || 'mesh'}`);
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      lines.push(`v ${fmt(p[i])} ${fmt(p[i + 1])} ${fmt(p[i + 2])}`);
    }
    if (mesh.normals) {
      const nm = mesh.normals;
      for (let i = 0; i < nm.length; i += 3) {
        lines.push(`vn ${fmt(nm[i])} ${fmt(nm[i + 1])} ${fmt(nm[i + 2])}`);
      }
    }
    const idx = mesh.indices;
    for (let f = 0; f < idx.length; f += 3) {
      const a = idx[f] + 1 + vertexOffset;
      const b = idx[f + 1] + 1 + vertexOffset;
      const c = idx[f + 2] + 1 + vertexOffset;
      if (mesh.normals) {
        const na = idx[f] + 1 + normalOffset;
        const nb = idx[f + 1] + 1 + normalOffset;
        const nc = idx[f + 2] + 1 + normalOffset;
        lines.push(`f ${a}//${na} ${b}//${nb} ${c}//${nc}`);
      } else {
        lines.push(`f ${a} ${b} ${c}`);
      }
    }
    vertexOffset += mesh.vertexCount;
    normalOffset += mesh.normals ? mesh.vertexCount : 0;
  }
  return lines.join('\n') + '\n';
}

function fmt(v) {
  if (!Number.isFinite(v)) return '0';
  // 6 位有效小数足够几何用途，显著减小文件体积
  return Number(v.toFixed(6)).toString();
}
