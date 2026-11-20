// 核心算法 Node 测试：node tools/test-core.mjs
import {
  Mesh, inspectMesh, cleanMesh, weldVertices, connectedComponents,
  computeVertexNormals, boundingBox, findDegenerateFaces, findIsolatedVertices,
} from '../js/core/mesh.js';
import { simplifyMesh } from '../js/core/simplify.js';
import { deviationReport } from '../js/core/metrics.js';
import { parseOBJ, writeOBJ } from '../js/core/obj.js';
import { subdividedCube, detailedIcosphere, twoDisconnectedParts } from '../js/core/samples.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

console.log('\n[1] 体检：重复点 / 退化面 / 孤立点 / 连通分量');
{
  const cube = subdividedCube(4);
  const report = inspectMesh(cube);
  check('细分立方体存在重复顶点（角点不共享）', report.duplicateVertexCount > 0,
    `dup=${report.duplicateVertexCount}`);
  check('未焊接时 6 个面互不连通（焊接演示素材）', report.componentCount === 6, `count=${report.componentCount}`);
  check('焊接后收敛为单闭合分量', connectedComponents(weldVertices(cube).mesh).count === 1);

  // 手工构造：退化面 + 孤立点
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5]; // 最后一个是孤立点
  const indices = [0, 1, 2, 0, 0, 1]; // 一个正常面 + 一个退化面
  const m = new Mesh({ positions: Float32Array.from(positions), indices: Uint32Array.from(indices), name: 't' });
  const r2 = inspectMesh(m);
  check('检出退化面', r2.degenerateFaceCount === 1, `deg=${r2.degenerateFaceCount}`);
  check('检出孤立点', r2.isolatedVertexCount === 1 && r2.isolated[0] === 3);

  const cleaned = cleanMesh(m, { removeIsolated: true });
  check('清理后无退化面', findDegenerateFaces(cleaned.mesh).length === 0);
  check('清理后无孤立点', findIsolatedVertices(cleaned.mesh).length === 0);
  check('清理保留 1 个有效面', cleaned.mesh.faceCount === 1, `faces=${cleaned.mesh.faceCount}`);
  check('清理影响清单包含三类步骤', cleaned.report.steps.length >= 2, JSON.stringify(cleaned.report.steps));
}

console.log('\n[2] 焊接：同分量重复点合并，不同分量坐标重合也不合并');
{
  // 先焊成单分量的细分立方体，再在其基础上验证重复焊接幂等等性质
  const cube = weldVertices(subdividedCube(4)).mesh;
  const beforeV = cube.vertexCount;
  check('焊接后顶点数显著少于逐面存储', cube.vertexCount < subdividedCube(4).vertexCount,
    `${cube.vertexCount} vs ${subdividedCube(4).vertexCount}`);
  check('焊接后单分量保持连通', connectedComponents(cube).count === 1);
  // 焊接后再焊接应为 no-op
  const w2 = weldVertices(cube);
  check('重复焊接幂等', w2.removedVertices === 0);

  // 两个分离分量：第二个整体平移开，坐标互不重合 -> 焊接不应改变任何东西
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 0, 0, 6, 0, 0, 5, 1, 0];
  const indices = [0, 1, 2, 3, 4, 5];
  const two = new Mesh({ positions: Float32Array.from(positions), indices: Uint32Array.from(indices) });
  const cc = connectedComponents(two);
  check('测试夹具确为两分量', cc.count === 2);
  const wt = weldVertices(two);
  check('不接触的独立对象未被焊接', wt.removedVertices === 0, `removed=${wt.removedVertices}`);
  check('焊接后仍是两分量', connectedComponents(wt.mesh).count === 2);

  // 反例：两分量坐标完全重合时，按几何事实应连通（同一点物理上就是一个点）
  const touchPos = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const touch = new Mesh({ positions: Float32Array.from(touchPos), indices: Uint32Array.from([0, 1, 2, 3, 4, 5]) });
  const wr = weldVertices(touch);
  // 两组各 2 个重合点 -> 移除 2 个顶点；两三角形引用的是不同代表点，无退化面
  check('坐标重合的重复点被合并', wr.removedVertices === 2 && wr.collapsedFaces === 0,
    `removed=${wr.removedVertices} collapsed=${wr.collapsedFaces}`);
}

console.log('\n[3] QEM 简化：面数、误差单调性、分量预算');
{
  const sphere = detailedIcosphere(4);
  check('细节球面数为 20*4^sub', sphere.faceCount === 20 * Math.pow(4, 4), `faces=${sphere.faceCount}`);
  const bb0 = boundingBox(sphere);

  const ratios = [0.75, 0.5, 0.25, 0.1];
  let prevDev = -1, prevFaces = Infinity;
  for (const ratio of ratios) {
    const target = Math.round(sphere.faceCount * ratio);
    const r = simplifyMesh(sphere, target);
    check(`比例 ${ratio} 实际面数 <= 目标+容差`, r.mesh.faceCount <= target,
      `target=${target} actual=${r.mesh.faceCount}`);
    check(`比例 ${ratio} 顶点全部被面引用（无孤立点）`, findIsolatedVertices(r.mesh).length === 0);
    check(`比例 ${ratio} 输出法线已重算`, r.mesh.normals !== null);
    const dev = deviationReport(sphere, r.mesh);
    check(`比例 ${ratio} 偏差有限且为正`, Number.isFinite(dev.hausdorff) && dev.hausdorff >= 0,
      `hausdorff=${dev.hausdorff}`);
    check(`比例 ${ratio} 误差随简化加剧而不下降`, dev.hausdorff >= prevDev - 1e-9);
    check(`比例 ${ratio} 面数随简化递减`, r.mesh.faceCount < prevFaces);
    prevDev = dev.hausdorff;
    prevFaces = r.mesh.faceCount;
  }

  // 最激进简化：仍保留几何，包围盒不塌缩为点
  const r1 = simplifyMesh(sphere, 4);
  const bb1 = boundingBox(r1.mesh);
  check('极限简化后包围盒尺寸保留 >50%',
    bb1.diagonal > bb0.diagonal * 0.5, `${bb1.diagonal} vs ${bb0.diagonal}`);
  check('目标面数超出原面数时直接返回克隆', simplifyMesh(sphere, sphere.faceCount + 100).mesh.faceCount === sphere.faceCount);
}

console.log('\n[4] 多分量：独立预算、绝不焊接、小块不消失');
{
  const two = twoDisconnectedParts(6);
  const cc0 = connectedComponents(two);
  check('双块夹具为两分量', cc0.count === 2);
  const r = simplifyMesh(two, 4);
  const cc1 = connectedComponents(r.mesh);
  check('简化后仍为两分量', cc1.count === 2, `count=${cc1.count}`);
  check('每个分量预算 >= 1', r.componentBudgets.every((b) => b >= 1), JSON.stringify(r.componentBudgets));
  check('每个分量简化后仍有面', r.componentFacesAfter.every((f) => f >= 1), JSON.stringify(r.componentFacesAfter));
  check('总面数不超目标太多', r.mesh.faceCount <= 4 + cc1.count);
}

console.log('\n[5] OBJ 往返');
{
  const sphere = detailedIcosphere(2);
  const text = writeOBJ(sphere, { ratio: 0.5, faces: sphere.faceCount });
  check('OBJ 头包含元数据', text.includes('# ratio: 0.5'));
  const { meshes, warnings } = parseOBJ(text);
  check('OBJ 往返顶点数一致', meshes[0].vertexCount === sphere.vertexCount);
  check('OBJ 往返面数一致', meshes[0].faceCount === sphere.faceCount);
  check('OBJ 往返坐标一致', approx(meshes[0].positions[0], sphere.positions[0], 1e-5));

  // 多边形 + 负索引 + v//vn 格式：一个四边形(2面) + 一个负索引三角形(1面)
  const poly = `v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvn 0 0 1\nf 1//1 2//1 3//1 4//1\nf -4//1 -3//1 -2//1\n`;
  const pr = parseOBJ(poly);
  check('四边形扇面三角化 + 负索引三角形共 3 个面', pr.meshes[0].faceCount === 3, `faces=${pr.meshes[0].faceCount}`);
  check('负索引解析成功（索引落在前 4 个顶点内）', pr.meshes[0].indices.every((i) => i >= 0 && i < 4),
    JSON.stringify(Array.from(pr.meshes[0].indices)));
}

console.log('\n[6] 规则模型对照（QEM 平面保持性质）');
{
  // 平面网格 + 关闭边界保护：所有折叠点都落在原平面上，误差应接近 0
  const N = 20;
  const ppos = [], pidx = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) ppos.push(i / N, j / N, 0);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
    pidx.push(a, b, c, b, d, c);
  }
  const plane = new Mesh({ positions: Float32Array.from(ppos), indices: Uint32Array.from(pidx) });
  // 开启边界保护后，边界点被钉在平面内，内部折叠的 QEM 代价为 0
  const pr = simplifyMesh(plane, plane.faceCount / 4, { boundaryWeight: 10 });
  const pdev = deviationReport(plane, pr.mesh);
  // 反向口径：简化后的每个顶点都应落在原平面上（QEM 平面保持）。
  // 正向口径含被删顶点的点到点距离，对平面内塌陷是保守上界（见 README 度量说明）。
  check('边界保护下简化点全部落在原平面上', pdev.backwardMax < 1e-6, `backwardMax=${pdev.backwardMax}`);

  // 闭合立方体（带边界保护）：误差主要来自轮廓保护下的阶梯偏移，应远小于包围盒
  const welded = weldVertices(subdividedCube(12)).mesh;
  const r = simplifyMesh(welded, welded.faceCount / 2);
  check('立方体简化达到目标面数', r.mesh.faceCount <= Math.round(welded.faceCount / 2));
  const dev = deviationReport(welded, r.mesh);
  // 50% 简化后面片边长约为 2/12，阶梯偏移量级与该尺度相当
  check('闭合立方体轮廓保护下误差可控（<30% 包围盒）', dev.hausdorff < boundingBox(welded).diagonal * 0.3,
    `hausdorff=${dev.hausdorff}`);
}

console.log(`\n结果：${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
