// 生成 samples/ 下的对照示例 OBJ：
//   cube-subdivided.obj —— 规则模型（细分立方体，带重复顶点可演示清理）
//   icosphere-detail.obj —— 细节模型（fbm 噪声位移球，高面数）
// 用法：node tools/generate-samples.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { subdividedCube, detailedIcosphere } from '../js/core/samples.js';
import { writeOBJ } from '../js/core/obj.js';
import { inspectMesh } from '../js/core/mesh.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'samples');

const cube = subdividedCube(16, 2);
const cubeReport = inspectMesh(cube);
writeFileSync(join(out, 'cube-subdivided.obj'), writeOBJ(cube, {
  模型类型: '规则模型-细分立方体',
  说明: '面间顶点不共享，含重复顶点，用于体检/焊接演示',
  面数: cube.faceCount,
  顶点数: cube.vertexCount,
  重复顶点数: cubeReport.duplicateVertexCount,
}));
console.log(`cube-subdivided.obj: ${cube.faceCount} 面 / ${cube.vertexCount} 点 / 重复点 ${cubeReport.duplicateVertexCount}`);

const sphere = detailedIcosphere(4, 1.4, 0.22, 11);
writeFileSync(join(out, 'icosphere-detail.obj'), writeOBJ(sphere, {
  模型类型: '细节模型-fbm噪声位移球',
  说明: 'icosphere 4 次细分 + 4 倍频 value noise 位移',
  面数: sphere.faceCount,
  顶点数: sphere.vertexCount,
}));
console.log(`icosphere-detail.obj: ${sphere.faceCount} 面 / ${sphere.vertexCount} 点`);
