/* 核心逻辑测试: node test/run_tests.js */
const fs = require('fs');
const path = require('path');
const MC = require('../js/mesh-core.js');

const EX = path.join(__dirname, '..', 'examples');
let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failures++;
}
function load(name) {
  return MC.parseOBJ(fs.readFileSync(path.join(EX, name), 'utf8'));
}

// ---- 1. 朝外闭合块: 无需修复 ----
{
  const mesh = load('block_outward.obj');
  const an = MC.analyze(mesh);
  check('block_outward: 单连通块', an.components.length === 1);
  const c = an.components[0];
  check('block_outward: 闭合且朝外', c.closed && c.orientation === 'outward',
    `closed=${c.closed} orient=${c.orientation} vol=${c.volume.toFixed(3)}`);
  const r = MC.unifyComponent(mesh, an, 0, null);
  check('block_outward: 无需翻转', r.flips.length === 0 && !r.needsReference);
}

// ---- 2. 朝里闭合块: 全部翻成朝外 ----
{
  const mesh = load('block_inward.obj');
  const an = MC.analyze(mesh);
  const c = an.components[0];
  check('block_inward: 闭合且朝里', c.closed && c.orientation === 'inward');
  const r = MC.unifyComponent(mesh, an, 0, null);
  check('block_inward: 翻转全部 12 面', r.flips.length === 12, `flips=${r.flips.length}`);
  const fixed = MC.applyFlips(mesh, r.flips);
  const an2 = MC.analyze(fixed);
  check('block_inward: 修复后朝外',
    an2.components[0].orientation === 'outward' && an2.components[0].volume > 0);
}

// ---- 3. 薄开口片: 需参考面, 统一后所有公共边方向相反 ----
{
  const mesh = load('open_sheet.obj');
  const an = MC.analyze(mesh);
  check('open_sheet: 单连通块', an.components.length === 1);
  const c = an.components[0];
  check('open_sheet: 是开口片', !c.closed && c.orientation === 'open');
  const r0 = MC.unifyComponent(mesh, an, 0, null);
  check('open_sheet: 无参考面时要求用户选择', r0.needsReference);
  const r1 = MC.unifyComponent(mesh, an, 0, 0);
  check('open_sheet: 有参考面可统一', r1.flips.length > 0 && r1.unreached.length === 0,
    `flips=${r1.flips.length}`);
  const fixed = MC.applyFlips(mesh, r1.flips);
  const an2 = MC.analyze(fixed);
  let inconsistent = 0;
  for (const e of an2.edges)
    if (e.faces.length === 2 && e.faces[0].dir === e.faces[1].dir) inconsistent++;
  check('open_sheet: 修复后公共边全部反向', inconsistent === 0, `inconsistent=${inconsistent}`);
  check('open_sheet: 参考面保持原朝向', !r1.flips.includes(0));
}

// ---- 4. 非法连接网格: 问题单独列出, 可判定块照常修复 ----
{
  const mesh = load('illegal_mesh.obj');
  const an = MC.analyze(mesh);
  check('illegal: 检出三面共边', an.nonManifoldEdges.length === 1,
    `nm=${an.nonManifoldEdges.length}`);
  check('illegal: 检出零面积面', an.zeroAreaFaces.length === 1,
    `zero=${an.zeroAreaFaces.length}`);
  check('illegal: 检出重合未连接顶点', an.coincidentVertices.length === 1,
    `coincident=${an.coincidentVertices.length}`);
  check('illegal: 开口边存在', an.boundaryEdges.length > 0);
  const closedComp = an.components.find((c) => c.closed);
  check('illegal: 闭合小块可判定(朝里)', !!closedComp && closedComp.orientation === 'inward');
  const r = MC.unifyComponent(mesh, an, closedComp.id, null);
  check('illegal: 闭合块可修复', r.flips.length === 12 && !r.needsReference);
  const fixed = MC.applyFlips(mesh, r.flips);
  const an2 = MC.analyze(fixed);
  check('illegal: 修复后闭合块朝外',
    an2.components.find((c) => c.closed).orientation === 'outward');
  check('illegal: 问题保留供检查',
    an2.nonManifoldEdges.length === 1 && an2.zeroAreaFaces.length === 1 &&
    an2.coincidentVertices.length === 1);
}

// ---- 5. 导出读回: 面数/顶点/UV对应/问题边与报告一致 ----
{
  const mesh = load('demo_all.obj');
  const an = MC.analyze(mesh);
  check('demo_all: 至少 4 个连通块', an.components.length >= 4,
    `comps=${an.components.length}`);
  // 修所有闭合块
  let flips = [];
  for (const c of an.components) {
    if (!c.closed) continue;
    flips = flips.concat(MC.unifyComponent(mesh, an, c.id, null).flips);
  }
  const fixed = MC.applyFlips(mesh, flips);
  const anFixed = MC.analyze(fixed);
  const report = MC.makeReport(fixed, anFixed, { flippedFaces: flips });
  const text = MC.serializeOBJ(fixed);
  const reparsed = MC.parseOBJ(text);
  const results = MC.verifyAgainstReport(reparsed, report);
  for (const r of results) check('roundtrip: ' + r.name, r.pass, r.detail);
  // UV 数值保留
  let uvOk = true;
  for (let i = 0; i < fixed.uvs.length; i++)
    for (let k = 0; k < 2; k++)
      if (Math.abs(reparsed.uvs[i][k] - fixed.uvs[i][k]) > 1e-9) uvOk = false;
  check('roundtrip: UV 数值不变', uvOk);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
