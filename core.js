/* core.js — 网格转换核心:数学、解析、导出、诊断。浏览器与 Node 通用。 */
(function (root, factory) {
  const M = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.MeshCore = M;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const UNITS = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 };
const UNIT_NAMES = { mm: '毫米', cm: '厘米', m: '米', in: '英寸', ft: '英尺' };
const AXES = {
  '+X': [1, 0, 0], '-X': [-1, 0, 0],
  '+Y': [0, 1, 0], '-Y': [0, -1, 0],
  '+Z': [0, 0, 1], '-Z': [0, 0, -1],
};

/* ---------- 向量 / 3x3 矩阵(行主序,行向量数组) ---------- */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vlen = a => Math.hypot(a[0], a[1], a[2]);
const vnorm = a => { const l = vlen(a); return (l > 0 && isFinite(l)) ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };

const m3apply = (m, v) => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
function m3mul(a, b) {
  const c = [[b[0][0], b[1][0], b[2][0]], [b[0][1], b[1][1], b[2][1]], [b[0][2], b[1][2], b[2][2]]];
  return a.map(r => [dot(r, c[0]), dot(r, c[1]), dot(r, c[2])]);
}
const m3T = m => [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
const m3det = m => dot(m[0], cross(m[1], m[2]));
const m3scale = (m, s) => m.map(r => [r[0] * s, r[1] * s, r[2] * s]);

/* ---------- 轴向约定 ----------
 * conv = { up:'+Y', fwd:'+Z', handed:'RH'|'LH' }
 * basisRows 返回 3x3(行 = r,u,f),把模型坐标映到规范世界(上=+Y,前=+Z)。
 * 右手系: r × u = f;左手系: r × u = -f。det = ±1。 */
function basisRows(conv) {
  const u = AXES[conv.up], f = AXES[conv.fwd];
  if (!u || !f) throw new Error('未知轴向: ' + JSON.stringify(conv));
  if (dot(u, f) !== 0) throw new Error('“上”轴与“前”轴必须互相垂直');
  const r = conv.handed === 'LH' ? cross(f, u) : cross(u, f);
  return [r, u, f];
}

function conversionMatrix(srcConv, dstConv) {
  return m3mul(m3T(basisRows(dstConv)), basisRows(srcConv));
}

function rotMatrix(deg) {
  const [rx, ry, rz] = (deg || [0, 0, 0]).map(d => d * Math.PI / 180);
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  return m3mul(Rz, m3mul(Ry, Rx)); // 先 X 后 Y 后 Z
}

/* 构建完整变换: v' = A·v + t,其中先单位缩放、再轴系转换,最后绕基准点 pivot 旋转。
 * 返回 { A, t, det, mirrored, scale }。mirrored 表示含镜像(需翻转绕序)。 */
function buildTransform(o) {
  const s = UNITS[o.srcUnit] / UNITS[o.dstUnit];
  const C = conversionMatrix(o.srcConv, o.dstConv);
  const MS = m3scale(C, s);
  const R = rotMatrix(o.rot);
  const p = o.pivot || [0, 0, 0];
  const pT = m3apply(MS, p);          // 基准点随模型一起变换
  const RpT = m3apply(R, pT);
  const A = m3mul(R, MS);
  const t = [pT[0] - RpT[0], pT[1] - RpT[1], pT[2] - RpT[2]];
  const det = m3det(C);               // s>0、det(R)=1,符号由轴系转换决定
  return { A, t, det, mirrored: det < 0, scale: s };
}

/* 应用变换;镜像时翻转三角形绕序,避免面朝内消失/发黑。 */
function applyTransform(mesh, T) {
  const positions = mesh.positions.map(v => {
    const w = m3apply(T.A, v);
    return [w[0] + T.t[0], w[1] + T.t[1], w[2] + T.t[2]];
  });
  const faces = T.mirrored ? mesh.faces.map(f => [f[0], f[2], f[1]]) : mesh.faces.map(f => f.slice());
  return {
    positions,
    colors: mesh.colors ? mesh.colors.map(c => c.slice()) : null,
    faces,
    facePart: mesh.facePart.slice(),
    parts: mesh.parts.map(p => ({ name: p.name })),
  };
}

/* ---------- 网格工具 ---------- */
function bbox(mesh) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.positions) {
    for (let i = 0; i < 3; i++) {
      const x = v[i];
      if (!isFinite(x)) continue;
      if (x < mn[i]) mn[i] = x;
      if (x > mx[i]) mx[i] = x;
    }
  }
  if (mn[0] === Infinity) return null;
  return {
    min: mn, max: mx,
    size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]],
    center: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2],
  };
}

function centroid(mesh) {
  const c = [0, 0, 0]; let n = 0;
  for (const v of mesh.positions) {
    if (!v.every(isFinite)) continue;
    c[0] += v[0]; c[1] += v[1]; c[2] += v[2]; n++;
  }
  return n ? [c[0] / n, c[1] / n, c[2] / n] : [0, 0, 0];
}

/* 顶点焊接(按量化坐标),返回新 positions 与重映射 faces。非有限坐标保留原值。 */
function weld(positions, faces, eps) {
  const map = new Map(), out = [], remap = [];
  for (let i = 0; i < positions.length; i++) {
    const v = positions[i];
    const key = v.map(x => isFinite(x) ? Math.round(x / eps) : String(x)).join(',');
    let idx = map.get(key);
    if (idx === undefined) { idx = out.length; out.push(v.slice()); map.set(key, idx); }
    remap[i] = idx;
  }
  return { positions: out, faces: faces.map(f => f.map(i => remap[i])) };
}

/* 按连通性拆分独立部件(共享焊接顶点即相连)。 */
function splitByConnectivity(mesh) {
  const n = mesh.positions.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (const f of mesh.faces) { uni(f[0], f[1]); uni(f[1], f[2]); }
  const rootToPart = new Map(), parts = [], facePart = new Array(mesh.faces.length);
  mesh.faces.forEach((f, fi) => {
    const r = find(f[0]);
    let pi = rootToPart.get(r);
    if (pi === undefined) { pi = parts.length; parts.push({ name: 'part_' + (pi + 1) }); rootToPart.set(r, pi); }
    facePart[fi] = pi;
  });
  return { positions: mesh.positions, colors: mesh.colors, faces: mesh.faces, facePart, parts };
}

/* 诊断:逐部件统计顶点/面/包围盒/零面积面/异常坐标。 */
function diagnostics(mesh) {
  const bb = bbox(mesh);
  const diagLen = bb ? Math.max(vlen(bb.size), 1e-30) : 1;
  const areaEps = 1e-12 * diagLen * diagLen;
  const per = mesh.parts.map(p => ({
    name: p.name, verts: new Set(), faces: 0, zeroArea: 0,
    nanVerts: new Set(), min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
  }));
  mesh.faces.forEach((f, fi) => {
    const d = per[mesh.facePart[fi]];
    d.faces++;
    for (const i of f) {
      d.verts.add(i);
      const v = mesh.positions[i];
      if (!v.every(isFinite)) { d.nanVerts.add(i); continue; }
      for (let k = 0; k < 3; k++) {
        if (v[k] < d.min[k]) d.min[k] = v[k];
        if (v[k] > d.max[k]) d.max[k] = v[k];
      }
    }
    const a = mesh.positions[f[0]], b = mesh.positions[f[1]], c = mesh.positions[f[2]];
    const area = 0.5 * vlen(cross(sub(b, a), sub(c, a)));
    if (!(area > areaEps)) d.zeroArea++; // NaN 面积也计入
  });
  return per.map(d => ({
    name: d.name, verts: d.verts.size, faces: d.faces,
    zeroArea: d.zeroArea, nan: d.nanVerts.size,
    size: d.min[0] === Infinity ? null : [d.max[0] - d.min[0], d.max[1] - d.min[1], d.max[2] - d.min[2]],
  }));
}

/* ---------- 解析器 ---------- */
function parseOBJ(text) {
  const positions = [], colors = [], faces = [], facePart = [], parts = [];
  let cur = -1, hasColor = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const tok = line.split(/\s+/);
    if (tok[0] === 'v') {
      positions.push([+tok[1], +tok[2], +tok[3]]);
      if (tok.length >= 7) { hasColor = true; colors.push([+tok[4], +tok[5], +tok[6]]); }
      else if (hasColor) colors.push([0.8, 0.8, 0.8]);
    } else if (tok[0] === 'g' || tok[0] === 'o') {
      const name = tok.slice(1).join(' ') || ('part_' + (parts.length + 1));
      cur = parts.findIndex(p => p.name === name);
      if (cur < 0) { parts.push({ name }); cur = parts.length - 1; }
    } else if (tok[0] === 'f') {
      const idx = tok.slice(1).map(t => {
        const n = parseInt(t.split('/')[0], 10);
        return n < 0 ? positions.length + n : n - 1;
      }).filter(i => i >= 0 && i < positions.length);
      for (let k = 1; k + 1 < idx.length; k++) {
        faces.push([idx[0], idx[k], idx[k + 1]]);
        facePart.push(Math.max(cur, 0));
      }
    }
  }
  if (parts.length === 0) parts.push({ name: 'default' });
  return { positions, colors: hasColor ? colors : null, faces, facePart, parts };
}

function parseSTL(buf) {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  const positions = [], faces = [];
  let binary = false;
  if (bytes.length >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === bytes.length) binary = true;
  }
  if (binary) {
    const n = dv.getUint32(80, true);
    let off = 84;
    for (let i = 0; i < n; i++) {
      off += 12; // 跳过法线
      const base = positions.length;
      for (let k = 0; k < 3; k++) {
        positions.push([dv.getFloat32(off, true), dv.getFloat32(off + 4, true), dv.getFloat32(off + 8, true)]);
        off += 12;
      }
      faces.push([base, base + 1, base + 2]);
      off += 2;
    }
  } else {
    const text = new TextDecoder().decode(bytes);
    const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    let m; const tri = [];
    while ((m = re.exec(text))) {
      tri.push([+m[1], +m[2], +m[3]]);
      if (tri.length === 3) {
        const b = positions.length;
        positions.push(tri[0], tri[1], tri[2]);
        faces.push([b, b + 1, b + 2]);
        tri.length = 0;
      }
    }
    if (faces.length === 0) throw new Error('无法解析 STL 文件');
  }
  const bb = bbox({ positions });
  const eps = 1e-6 * Math.max(bb ? vlen(bb.size) : 1, 1e-30);
  const w = weld(positions, faces, eps);
  return splitByConnectivity({
    positions: w.positions, colors: null, faces: w.faces,
    facePart: new Array(w.faces.length).fill(0), parts: [{ name: 'stl' }],
  });
}

function parsePLY(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== 'ply') throw new Error('不是 PLY 文件');
  let i = 1, nv = 0, nf = 0;
  const vprops = [];
  let inVertex = false, inFace = false;
  for (; i < lines.length; i++) {
    const t = lines[i].trim().split(/\s+/);
    if (t[0] === 'format' && t[1] !== 'ascii') throw new Error('暂不支持二进制 PLY');
    if (t[0] === 'element') {
      inVertex = t[1] === 'vertex'; inFace = t[1] === 'face';
      if (inVertex) nv = +t[2];
      if (inFace) nf = +t[2];
    } else if (t[0] === 'property' && inVertex) {
      vprops.push(t[t.length - 1]);
    } else if (t[0] === 'end_header') { i++; break; }
  }
  const ix = vprops.indexOf('x'), iy = vprops.indexOf('y'), iz = vprops.indexOf('z');
  const ir = vprops.indexOf('red'), ig = vprops.indexOf('green'), ib = vprops.indexOf('blue');
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('PLY 缺少 x/y/z 属性');
  const positions = [], colors = [];
  for (let k = 0; k < nv; k++, i++) {
    const t = lines[i].trim().split(/\s+/).map(Number);
    positions.push([t[ix], t[iy], t[iz]]);
    if (ir >= 0 && ig >= 0 && ib >= 0) colors.push([t[ir] / 255, t[ig] / 255, t[ib] / 255]);
  }
  const faces = [];
  for (let k = 0; k < nf; k++, i++) {
    const t = lines[i].trim().split(/\s+/).map(Number);
    const n = t[0];
    for (let j = 2; j + 1 <= n && j + 1 < t.length; j++) faces.push([t[1], t[j], t[j + 1]]);
  }
  const mesh = {
    positions, colors: colors.length === nv ? colors : null, faces,
    facePart: new Array(faces.length).fill(0), parts: [{ name: 'ply' }],
  };
  const bb = bbox(mesh);
  const eps = 1e-6 * Math.max(bb ? vlen(bb.size) : 1, 1e-30);
  const w = weld(mesh.positions, mesh.faces, eps);
  // 焊接后顶点重排,颜色映射从简:丢弃颜色(几何检查器以几何为准)
  return splitByConnectivity({
    positions: w.positions, colors: null, faces: w.faces,
    facePart: new Array(w.faces.length).fill(0), parts: [{ name: 'ply' }],
  });
}

/* ---------- 导出 ---------- */
function toOBJ(mesh) {
  const fmt = x => String(Number(x.toPrecision(10)));
  const out = ['# MeshConverter export', '# parts: ' + mesh.parts.length];
  for (const v of mesh.positions) out.push('v ' + fmt(v[0]) + ' ' + fmt(v[1]) + ' ' + fmt(v[2]));
  mesh.parts.forEach((p, pi) => {
    out.push('g ' + (p.name || ('part_' + (pi + 1))));
    mesh.faces.forEach((f, fi) => {
      if (mesh.facePart[fi] !== pi) return;
      out.push('f ' + (f[0] + 1) + ' ' + (f[1] + 1) + ' ' + (f[2] + 1));
    });
  });
  return out.join('\n') + '\n';
}

function toSTL(mesh) {
  const n = mesh.faces.length;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  let off = 84;
  mesh.faces.forEach(f => {
    const a = mesh.positions[f[0]], b = mesh.positions[f[1]], c = mesh.positions[f[2]];
    const nor = vnorm(cross(sub(b, a), sub(c, a)));
    for (const x of nor) { dv.setFloat32(off, x, true); off += 4; }
    for (const v of [a, b, c]) for (const x of v) { dv.setFloat32(off, x, true); off += 4; }
    dv.setUint16(off, 0, true); off += 2;
  });
  return buf;
}

/* ---------- 演示模型 ----------
 * 在“Z-up、+Y 前、右手”约定下建模:
 * 部件1“主体”:指向 +Y 的箭头 + 顶部绿色锥(标记上)+ +X 侧红色块(标记侧向),整体不对称;
 * 部件2“独立部件”:分离的蓝色八面体。 */
function makeDemoMesh() {
  const positions = [], colors = [], faces = [], facePart = [];
  const parts = [{ name: '主体_带方向标记' }, { name: '独立部件' }];
  let cur = 0;
  const V = (p, c) => { positions.push(p); colors.push(c); return positions.length - 1; };
  const T = (a, b, c) => { faces.push([a, b, c]); facePart.push(cur); };
  function box(cx, cy, cz, h, col) {
    const v = [];
    for (const dz of [-h, h]) for (const dy of [-h, h]) for (const dx of [-h, h])
      v.push(V([cx + dx, cy + dy, cz + dz], col));
    // v: 0:(-,-,-) 1:(+,-,-) 2:(-,+,-) 3:(+,+,-) 4:(-,-,+) 5:(+,-,+) 6:(-,+,+) 7:(+,+,+)
    const q = [[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]];
    for (const [a, b, c, d] of q) { T(v[a], v[b], v[c]); T(v[a], v[c], v[d]); }
  }
  function pyramid(base, apex, col) { // base: 4 角(顺序),apex: 顶点
    const b = base.map(p => V(p, col));
    const a = V(apex, col);
    T(b[0], b[1], a); T(b[1], b[2], a); T(b[2], b[3], a); T(b[3], b[0], a);
    T(b[0], b[3], b[2]); T(b[0], b[2], b[1]); // 底面
  }

  cur = 0;
  const ORANGE = [0.85, 0.55, 0.15];
  // 箭头主体:尾部矩形 → 头部尖点(指向 +Y,即“前”)
  pyramid(
    [[-0.6, -1.0, 0.0], [0.6, -1.0, 0.0], [0.6, -1.0, 0.6], [-0.6, -1.0, 0.6]],
    [0, 1.6, 0.3], ORANGE);
  // 上标记:绿色锥,尖朝 +Z(“上”)
  pyramid(
    [[-0.18, 0.02, 0.6], [0.18, 0.02, 0.6], [0.18, 0.38, 0.6], [-0.18, 0.38, 0.6]],
    [0, 0.2, 1.15], [0.1, 0.8, 0.2]);
  // +X 侧标记:红色小块(不对称,镜像时 visibly 换边)
  box(0.95, 0.1, 0.3, 0.16, [0.9, 0.1, 0.1]);

  cur = 1;
  const BLUE = [0.2, 0.4, 0.95];
  const c = [2.3, 0.4, 0.45], r = 0.45;
  const px = V([c[0] + r, c[1], c[2]], BLUE), nx = V([c[0] - r, c[1], c[2]], BLUE);
  const py = V([c[0], c[1] + r, c[2]], BLUE), ny = V([c[0], c[1] - r, c[2]], BLUE);
  const pz = V([c[0], c[1], c[2] + r], BLUE), nz = V([c[0], c[1], c[2] - r], BLUE);
  T(px, py, pz); T(py, nx, pz); T(nx, ny, pz); T(ny, px, pz);
  T(py, px, nz); T(nx, py, nz); T(ny, nx, nz); T(px, ny, nz);

  return { positions, colors, faces, facePart, parts };
}

return {
  UNITS, UNIT_NAMES, AXES,
  sub, cross, dot, vlen, vnorm,
  m3apply, m3mul, m3T, m3det,
  basisRows, conversionMatrix, rotMatrix, buildTransform, applyTransform,
  bbox, centroid, weld, splitByConnectivity, diagnostics,
  parseOBJ, parseSTL, parsePLY, toOBJ, toSTL,
  makeDemoMesh,
};
});
