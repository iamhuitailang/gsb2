// 浏览器端到端冒烟测试：由 headless Chrome 加载，
// 在真实 DOM + Three.js 环境中跑完整工作流，结果写入 document.title 与 body。
import { parseOBJ, parseMTL, exportOBJ, saveProject, loadProject } from '../src/core/objio.js';
import { unwrapFaces } from '../src/core/unwrap.js';
import { packIslands } from '../src/core/islands.js';
import { inspectUV } from '../src/core/inspect.js';
import { findIslands, toggleSeam } from '../src/core/topology.js';
import { addUvSet } from '../src/core/mesh.js';

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
};

try {
  const base = import.meta.env.BASE_URL;
  const objText = await fetch(`${base}sample_grooved_block.obj`).then((r) => r.text());
  const mtlText = await fetch(`${base}sample_grooved_block.mtl`).then((r) => r.text());
  const mesh = parseOBJ(objText, 'sample');
  Object.assign(mesh.materials, parseMTL(mtlText));
  check('解析示例网格', mesh.faces.length === 340, `${mesh.faces.length} 面`);
  check('4 种材质', new Set(mesh.faceMaterials).size === 4);

  // 初始 UV（OBJ 无 vt，占位坐标）-> 整体等距展开（保留真实尺寸比例）
  unwrapFaces(mesh, null, 0);
  const rRaw = inspectUV(mesh, 0);
  check('展开后产生多个岛', rRaw.islandCount >= 2, `${rRaw.islandCount} 岛`);
  // 真实尺寸可能超出单位框，打包后才要求全部回到 [0,1]
  const rawPack = packIslands(mesh, 0, 0.02);
  const r1 = inspectUV(mesh, 0);
  check('打包后无越界', r1.outOfBounds.length === 0);
  check('打包后无重叠', r1.overlaps.length === 0);
  check('打包岛数一致', rawPack.islandCount === r1.islandCount);

  // 标记切缝后重新展开，岛数应增加
  const before = findIslands(mesh).islands.length;
  let marked = 0;
  for (const [key, c] of mesh.topology.halfedges) {
    const [a, b] = key.split('_').map(Number);
    if (mesh.topology.opposite[c] >= 0 && marked < 6) {
      toggleSeam(mesh.seams, mesh.topology, a, b);
      marked++;
    }
  }
  unwrapFaces(mesh, null, 0);
  const after = findIslands(mesh).islands.length;
  check('切缝后岛数增加', after > before, `${before} -> ${after}`);

  // 切缝重排后再次自动排布，确认仍可消除重叠与越界
  const pack = packIslands(mesh, 0, 0.02);
  const r2 = inspectUV(mesh, 0);
  check('二次排布后无重叠', r2.overlaps.length === 0, `${r2.overlaps.length} 重叠`);
  check('二次排布后无越界', r2.outOfBounds.length === 0);
  check('二次排布岛数一致', pack.islandCount === r2.islandCount);

  // 多套 UV 隔离
  const set1 = addUvSet(mesh);
  const snap = JSON.stringify(mesh.uvSets[0]);
  unwrapFaces(mesh, null, set1, { mode: 'planar' });
  packIslands(mesh, set1, 0.05);
  check('编辑第 2 套不覆盖第 1 套', JSON.stringify(mesh.uvSets[0]) === snap);
  check('共 2 套 UV', mesh.uvSets.length === 2);

  // 项目存取往返
  const json = saveProject(mesh, { activeSet: 1 });
  const restored = loadProject(json);
  check('项目恢复切缝', restored.mesh.seams.size === mesh.seams.size);
  check('项目恢复 UV 套数', restored.mesh.uvSets.length === 2);
  check('项目恢复面数', restored.mesh.faces.length === 340);
  check('视图状态恢复', restored.viewState.activeSet === 1);

  // OBJ 导出
  const { obj, mtl } = exportOBJ(mesh, 0);
  const re = parseOBJ(obj);
  check('OBJ 往返面数', re.faces.length === 340);
  check('OBJ 含 vt', obj.includes('vt '));
  check('OBJ 含 usemtl', obj.includes('usemtl'));
  check('MTL 含 4 材质', (mtl.match(/newmtl/g) || []).length === 4);

  // 检查报告的健康/异常两条路径
  const bad = inspectUV(mesh, set1);
  check('检查器返回结构', typeof bad.healthy === 'boolean' && Array.isArray(bad.tinyIslands));
} catch (err) {
  check('运行无异常', false, err.stack || String(err));
}

const passed = results.filter((r) => r.ok).length;
document.title = `SMOKE ${passed}/${results.length}`;
document.body.innerHTML =
  `<pre style="font:14px monospace;padding:16px;background:#111;color:#eee">` +
  results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`).join('\n') +
  `\n\n${passed}/${results.length} passed</pre>`;
console.log('SMOKE_RESULT', JSON.stringify(results));
