/* test.js — 核心转换逻辑自测: node test.js */
'use strict';
const C = require('./core.js');

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
const near = (a, b, t = 1e-9) => Math.abs(a - b) <= t * Math.max(1, Math.abs(a), Math.abs(b));
const vnear = (a, b, t) => a.every((x, i) => near(x, b[i], t));

console.log('1. 轴系基矩阵');
{
  const rh = C.basisRows({ up: '+Y', fwd: '+Z', handed: 'RH' });
  const lh = C.basisRows({ up: '+Y', fwd: '+Z', handed: 'LH' });
  ok(near(C.m3det(rh), 1), '右手系 det=+1', C.m3det(rh));
  ok(near(C.m3det(lh), -1), '左手系 det=-1', C.m3det(lh));
  // Z-up +Y前 → 模型的 +Z(上)应映到规范世界 +Y
  const b = C.basisRows({ up: '+Z', fwd: '+Y', handed: 'RH' });
  ok(vnear(C.m3apply(b, [0, 0, 1]), [0, 1, 0]), 'Z-up 模型的 +Z 映到世界 +Y');
  ok(vnear(C.m3apply(b, [0, 1, 0]), [0, 0, 1]), 'Z-up 模型的 +Y(前)映到世界 +Z');
  let threw = false;
  try { C.basisRows({ up: '+Y', fwd: '-Y', handed: 'RH' }); } catch (e) { threw = true; }
  ok(threw, '上/前不垂直时报错');
}

console.log('2. 单位换算与轴系转换');
{
  const src = { up: '+Z', fwd: '+Y', handed: 'RH' };   // Blender/CAD 风
  const dst = { up: '+Y', fwd: '+Z', handed: 'LH' };   // Unity 风
  const T = C.buildTransform({ srcUnit: 'cm', dstUnit: 'm', srcConv: src, dstConv: dst, rot: [0, 0, 0], pivot: [0, 0, 0] });
  ok(near(T.scale, 0.01), '厘米→米 比例 0.01', T.scale);
  ok(T.mirrored, '右手→左手 判定为镜像');
  // 源模型上 100cm 处的"上"方向点 → 目标中 1m 的 +Y
  const p = C.m3apply(T.A, [0, 0, 100]);
  ok(vnear([p[0] + T.t[0], p[1] + T.t[1], p[2] + T.t[2]], [0, 1, 0], 1e-9), '(0,0,100)cm → (0,1,0)m');
}

console.log('3. 镜像时绕序翻转(法线保持朝外)');
{
  const mesh = {
    positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    colors: null, faces: [[0, 1, 2]], facePart: [0], parts: [{ name: 't' }],
  };
  const n0 = C.cross(C.sub(mesh.positions[1], mesh.positions[0]), C.sub(mesh.positions[2], mesh.positions[0]));
  const mirrorT = { A: [[-1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0], mirrored: true };
  const out = C.applyTransform(mesh, mirrorT);
  const n1 = C.cross(C.sub(out.positions[out.faces[0][1]], out.positions[out.faces[0][0]]),
                     C.sub(out.positions[out.faces[0][2]], out.positions[out.faces[0][0]]));
  ok(vnear(n0, n1), '镜像后面法线方向不变(绕序已翻转)', n0 + ' vs ' + n1);
  const noFlip = { A: mirrorT.A, t: [0, 0, 0], mirrored: false };
  const out2 = C.applyTransform(mesh, noFlip);
  const n2 = C.cross(C.sub(out2.positions[1], out2.positions[0]), C.sub(out2.positions[2], out2.positions[0]));
  ok(vnear(n2, [-n0[0], -n0[1], -n0[2]]), '不翻转时法线会反向(对照)');
}

console.log('4. 基准点:旋转绕指定点');
{
  const pivot = [3, -2, 5];
  const T = C.buildTransform({
    srcUnit: 'm', dstUnit: 'm',
    srcConv: { up: '+Y', fwd: '+Z', handed: 'RH' },
    dstConv: { up: '+Y', fwd: '+Z', handed: 'RH' },
    rot: [0, 90, 0], pivot,
  });
  const w = C.m3apply(T.A, pivot);
  const p2 = [w[0] + T.t[0], w[1] + T.t[1], w[2] + T.t[2]];
  ok(vnear(p2, pivot, 1e-9), '旋转 90° 后基准点保持不动', p2);
  // 绕 Y 转 90°:pivot + X 方向偏移 → pivot + (-Z)? 旋转矩阵 Rz? 这里验证相对向量旋转正确
  const q = [pivot[0] + 1, pivot[1], pivot[2]];
  const wq = C.m3apply(T.A, q);
  const q2 = [wq[0] + T.t[0], wq[1] + T.t[1], wq[2] + T.t[2]];
  const rel = C.sub(q2, pivot);
  ok(near(C.vlen(rel), 1, 1e-9), '相对基准点的距离保持不变', rel);
}

console.log('5. 演示模型与多部件');
{
  const demo = C.makeDemoMesh();
  ok(demo.parts.length === 2, '演示模型含 2 个独立部件', demo.parts.length);
  const diag = C.diagnostics(demo);
  ok(diag.every(d => d.zeroArea === 0 && d.nan === 0), '演示模型无零面积面/异常坐标');
  ok(diag[0].faces > 0 && diag[1].faces > 0, '两个部件都有面');
  // 整组转换:部件相对位置保持
  const T = C.buildTransform({
    srcUnit: 'cm', dstUnit: 'm',
    srcConv: { up: '+Z', fwd: '+Y', handed: 'RH' },
    dstConv: { up: '+Y', fwd: '+Z', handed: 'LH' },
    rot: [0, 0, 0], pivot: [0, 0, 0],
  });
  const out = C.applyTransform(demo, T);
  const relBefore = C.sub(C.centroid({ positions: demo.positions.filter((_, i) => partOf(demo, i) === 1) }),
                          C.centroid({ positions: demo.positions.filter((_, i) => partOf(demo, i) === 0) }));
  function partOf(m, vi) { // 找顶点所属部件
    for (let fi = 0; fi < m.faces.length; fi++) if (m.faces[fi].includes(vi)) return m.facePart[fi];
    return -1;
  }
  const relAfter = C.sub(C.centroid({ positions: out.positions.filter((_, i) => partOf(out, i) === 1) }),
                         C.centroid({ positions: out.positions.filter((_, i) => partOf(out, i) === 0) }));
  // 相对向量应等于 同一刚体变换 作用于原相对向量
  const expect = C.m3apply(T.A, relBefore);
  ok(vnear(relAfter, expect, 1e-9), '整组转换后部件相对位置一致', relAfter + ' vs ' + expect);
  // 尺寸换算:轴系交换后各轴尺寸为原尺寸的排列 ×0.01,比较排序后的尺寸
  const bbS = C.bbox(demo), bbD = C.bbox(out);
  const sort3 = a => a.slice().sort((x, y) => x - y);
  ok(vnear(sort3(bbD.size), sort3(bbS.size.map(x => x * 0.01)), 1e-6), '尺寸按 cm→m 换算(轴系已交换)', bbD.size);
}

console.log('6. 导出→重新导入 往返一致');
{
  const demo = C.makeDemoMesh();
  const T = C.buildTransform({
    srcUnit: 'cm', dstUnit: 'm',
    srcConv: { up: '+Z', fwd: '+Y', handed: 'RH' },
    dstConv: { up: '+Y', fwd: '+Z', handed: 'LH' },
    rot: [10, 20, 30], pivot: [0.5, 0.5, 0.5],
  });
  const out = C.applyTransform(demo, T);
  const text = C.toOBJ(out);
  const back = C.parseOBJ(text);
  ok(back.parts.length === 2, 'OBJ 往返:部件数量保持', back.parts.length);
  const bb1 = C.bbox(out), bb2 = C.bbox(back);
  ok(vnear(bb1.size, bb2.size, 1e-6) && vnear(bb1.min, bb2.min, 1e-6), 'OBJ 往返:尺寸与朝向一致');
  ok(vnear(C.centroid(out), C.centroid(back), 1e-6), 'OBJ 往返:质心一致');
  // STL 往返(二进制)。STL 无分组概念,部件按连通壳拆分:
  // 演示模型的“主体”由箭头、上标记锥、侧标记块 3 个不相交壳组成,加独立部件共 4 壳。
  const stl = C.toSTL(out);
  const back2 = C.parseSTL(stl);
  const bb3 = C.bbox(back2);
  ok(vnear(bb1.size, bb3.size, 1e-4), 'STL 往返:尺寸一致(float32 精度)');
  ok(back2.parts.length === 4, 'STL 往返:连通壳数量符合预期(主体 3 壳 + 独立部件)', back2.parts.length);
}

console.log('7. 诊断:零面积面与异常坐标');
{
  const bad = {
    positions: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [NaN, 1, 0], [0, 1, 0], [0, 0, 1]],
    colors: null,
    faces: [[0, 1, 2], [3, 4, 5]], // 第一个退化(共线),第二个含 NaN
    facePart: [0, 1], parts: [{ name: '退化' }, { name: '异常' }],
  };
  const d = C.diagnostics(bad);
  ok(d[0].zeroArea === 1, '检出零面积面', JSON.stringify(d[0]));
  ok(d[1].nan === 1, '检出异常坐标顶点', JSON.stringify(d[1]));
}

console.log('8. 解析器');
{
  const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\ng a\nf 1 2 3\ng b\nf 1 2 4\nf -3 -2 -1\n';
  const m = C.parseOBJ(obj);
  ok(m.parts.length === 2 && m.faces.length === 3, 'OBJ:分组与负索引', m.parts.length + '/' + m.faces.length);
  const ply = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n';
  const p = C.parsePLY(ply);
  ok(p.faces.length === 1 && p.positions.length === 3, 'PLY ascii 解析');
  // ascii STL
  const stlText = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n';
  const s = C.parseSTL(new TextEncoder().encode(stlText).buffer);
  ok(s.faces.length === 1, 'STL ascii 解析');
}

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
