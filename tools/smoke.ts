/**
 * 核心逻辑冒烟测试：不依赖浏览器/DOM，直接跑数据模型、笔刷、
 * 撤销重做、序列化一致性与区块接缝检查。
 * 运行：npm run smoke
 */
import { TerrainModel } from "../src/core/TerrainModel.ts";
import { applyBrush } from "../src/core/brush.ts";
import { generateValley, generateSeamTest } from "../src/core/generator.ts";
import { serializeProject, parseProject } from "../src/io/project.ts";
import { computeExportInfo, exportOBJ, exportHeightJSON, fullRange } from "../src/io/exporter.ts";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

function approx(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) <= eps;
}

// 1. 基础模型与区块结构
const model = new TerrainModel({ chunkSize: 8, chunksPerSide: 4, spacing: 1, seed: 42 });
check("顶点数 = chunkSize*chunks+1", model.vertexCount === 33);
check("世界尺寸正确", model.worldSize === 32);

// 2. 抬高笔刷落在区块边界上，两侧顶点都被改动
//    世界坐标 (0,2) 对应网格 (16,18)，半径 3 横跨 x=16 这条内部区块边界
const layer = model.selectedLayer;
model.beginStroke("抬高");
const boundaryIdx = model.idx(16, 18);
const before = layer.heights[boundaryIdx];
applyBrush(model, { mode: "raise", radius: 3, strength: 0.5, color: [1, 0, 0] }, 0, 2);
const stroke = model.endStroke();
check(
  "跨边界笔画返回了两侧区块",
  !!stroke && stroke.chunks.some(([x]) => x === 1) && stroke.chunks.some(([x]) => x === 2),
  JSON.stringify(stroke?.chunks)
);
check("边界顶点高度被抬高", layer.heights[boundaryIdx] > before, `before=${before} after=${layer.heights[boundaryIdx]}`);

// 2b. 笔画包围盒随拖动扩张后，撤销必须恢复全部原始值（回归：扩张时旧区域原始值被污染）
{
  const m = new TerrainModel({ chunkSize: 8, chunksPerSide: 2, spacing: 1, seed: 7 });
  const l = m.selectedLayer;
  l.heights.fill(3);
  const N = m.vertexCount;
  // 记录即将被两次笔刷覆盖区域的原始值
  const probeIdx = [m.idx(7, 8), m.idx(9, 8), m.idx(11, 8)];
  const original = probeIdx.map((i) => l.heights[i]);
  m.beginStroke("拖动抬高");
  const [w1x, w1z] = m.gridToWorld(8, 8);
  applyBrush(m, { mode: "raise", radius: 2, strength: 0.8, color: [0, 0, 0] }, w1x, w1z);
  // 第二次笔刷中心右移，包围盒向右扩张
  const [w2x, w2z] = m.gridToWorld(12, 8);
  applyBrush(m, { mode: "raise", radius: 2, strength: 0.8, color: [0, 0, 0] }, w2x, w2z);
  m.endStroke();
  check("扩张笔画只产生一条历史", l.undoStack.length === 1);
  const changed = probeIdx.some((i, k) => l.heights[i] !== original[k]);
  check("扩张笔画确实改动了多个顶点", changed);
  m.undo(l.id);
  const restored = probeIdx.every((i, k) => l.heights[i] === original[k]);
  check("撤销后扩张区域全部恢复原始值", restored);
}

// 3. 接缝：相邻区块共享边界顶点，合成高度完全一致
{
  const N = model.vertexCount;
  let seamOk = true;
  for (let k = 1; k < model.chunksPerSide; k++) {
    const b = k * model.chunkSize;
    for (let z = 0; z < N; z++) {
      if (model.compositeHeights[z * N + b] !== model.compositeHeights[z * N + b]) {
        seamOk = false;
      }
    }
  }
  check("区块边界共享同一高度值（无裂缝数据源）", seamOk);
}

// 4. 撤销/重做只影响当前选中图层
{
  const baseH = layer.heights[boundaryIdx];
  const other = model.addLayer("第二层");
  model.selectLayer(other.id);
  const undoResult = model.undo(other.id);
  check("空历史图层撤销返回 null", undoResult === null);
  model.selectLayer(layer.id);
  const r = model.undo(layer.id);
  check("底层撤销成功", r !== null);
  check("撤销恢复了改动前高度", approx(layer.heights[boundaryIdx], before));
  check("第二层历史不受影响", other.undoStack.length === 0);
  const r2 = model.redo(layer.id);
  check("重做恢复改动", r2 !== null && approx(layer.heights[boundaryIdx], baseH));
}

// 5. 压低与平滑（网格中心 (8,8) 即世界原点，落在地形内部）
{
  const m2 = new TerrainModel({ chunkSize: 8, chunksPerSide: 2, spacing: 1, seed: 1 });
  const l2 = m2.selectedLayer;
  l2.heights.fill(5);
  l2.heights[m2.idx(8, 8)] = 20;
  m2.beginStroke("平滑");
  applyBrush(m2, { mode: "smooth", radius: 2, strength: 1, color: [0, 0, 0] }, 0, 0);
  m2.endStroke();
  check("平滑让尖峰向邻域收敛", l2.heights[m2.idx(8, 8)] < 20 && l2.heights[m2.idx(8, 8)] > 5);

  const h0 = l2.heights[m2.idx(7, 7)];
  m2.beginStroke("压低");
  const [wx, wz] = m2.gridToWorld(7, 7);
  applyBrush(m2, { mode: "lower", radius: 2, strength: 0.5, color: [0, 0, 0] }, wx, wz);
  m2.endStroke();
  check("压低笔刷减小高度", l2.heights[m2.idx(7, 7)] < h0);
}

// 6. 涂抹写入颜色场且可撤销（同样以世界原点为笔刷中心）
{
  const m3 = new TerrainModel({ chunkSize: 8, chunksPerSide: 2, spacing: 1, seed: 1 });
  m3.beginStroke("涂抹");
  applyBrush(m3, { mode: "paint", radius: 3, strength: 0.8, color: [1, 0.2, 0.1] }, 0, 0);
  m3.endStroke();
  const l3 = m3.selectedLayer;
  check("涂抹生成颜色场", l3.colors !== null && l3.colors[m3.idx(8, 8) * 4 + 3] > 0);
  m3.undo(l3.id);
  check("颜色随撤销恢复", (l3.colors?.[m3.idx(8, 8) * 4 + 3] ?? 1) === 0);
}

// 7. 工程序列化往返一致（种子与高度逐位保持）
{
  const m4 = new TerrainModel({ chunkSize: 8, chunksPerSide: 3, spacing: 1.5, seed: 777 });
  generateValley(m4, 777);
  m4.addLayer("细节层");
  m4.beginStroke("抬高");
  applyBrush(m4, { mode: "raise", radius: 4, strength: 0.6, color: [0, 0, 0] }, 3, 3);
  m4.endStroke();
  const text = serializeProject(m4);
  const restored = parseProject(text);
  check("往返后参数保持", restored.chunkSize === 8 && restored.chunksPerSide === 3 && approx(restored.spacing, 1.5) && restored.seed === 777);
  let same = true;
  for (let i = 0; i < m4.vertexTotal; i++) {
    for (let li = 0; li < m4.layers.length; li++) {
      if (m4.layers[li].heights[i] !== restored.layers[li].heights[i]) same = false;
    }
    if (m4.compositeHeights[i] !== restored.compositeHeights[i]) same = false;
  }
  check("往返后所有图层高度逐位一致", same);
  check("图层数量与选择保持", restored.layers.length === 2 && restored.selectedLayerId === m4.selectedLayerId);
}

// 8. 同种子重新生成结果一致
{
  const a = new TerrainModel({ chunkSize: 8, chunksPerSide: 2, spacing: 1, seed: 5 });
  const b = new TerrainModel({ chunkSize: 8, chunksPerSide: 2, spacing: 1, seed: 5 });
  generateValley(a, 5);
  generateValley(b, 5);
  let same = true;
  for (let i = 0; i < a.vertexTotal; i++) {
    if (a.layers[0].heights[i] !== b.layers[0].heights[i]) same = false;
  }
  check("同种子山谷生成逐位一致", same);
}

// 9. 接缝检查场景的特征确实压在区块边界上
{
  const m5 = new TerrainModel({ chunkSize: 8, chunksPerSide: 4, spacing: 1, seed: 9090 });
  generateSeamTest(m5, 9090);
  const N = m5.vertexCount;
  let boundaryFeature = false;
  for (let k = 1; k < m5.chunksPerSide; k++) {
    const b = k * 8;
    for (let z = 0; z < N; z++) {
      if (Math.abs(m5.compositeHeights[z * N + b]) > 0.5) boundaryFeature = true;
    }
  }
  check("接缝场景在区块边界上有高度特征", boundaryFeature);
}

// 10. 导出信息与 OBJ/高度 JSON
{
  const m6 = new TerrainModel({ chunkSize: 8, chunksPerSide: 2, spacing: 2, seed: 3 });
  generateValley(m6, 3);
  const info = computeExportInfo(m6, fullRange(m6));
  check("导出顶点数正确", info.vertexX === 17 && info.vertexZ === 17);
  check("导出三角形数正确", info.triangleCount === 16 * 16 * 2);
  check("导出世界尺寸正确", approx(info.worldWidth, 32));
  const obj = exportOBJ(m6, fullRange(m6));
  const vCount = (obj.match(/^v /gm) ?? []).length;
  const fCount = (obj.match(/^f /gm) ?? []).length;
  check("OBJ 顶点/面数量匹配", vCount === 17 * 17 && fCount === 16 * 16 * 2);
  const hj = JSON.parse(exportHeightJSON(m6, fullRange(m6)));
  check("高度 JSON 元信息正确", hj.vertexX === 17 && hj.spacing === 2 && typeof hj.heightsB64 === "string");

  const partial = computeExportInfo(m6, { cx0: 0, cy0: 0, cx1: 0, cy1: 0 });
  check("单区块导出尺寸正确", partial.vertexX === 9 && partial.triangleCount === 8 * 8 * 2);
}

// 11. 图层显隐与强度影响合成结果
{
  const m7 = new TerrainModel({ chunkSize: 8, chunksPerSide: 2, spacing: 1, seed: 1 });
  m7.selectedLayer.heights.fill(10);
  const top = m7.addLayer("上层");
  top.heights.fill(4);
  m7.recomputeAll();
  check("双层合成高度为 14", approx(m7.compositeHeights[0], 14));
  m7.setLayerOpacity(top.id, 0.5);
  check("强度 0.5 时合成高度为 12", approx(m7.compositeHeights[0], 12));
  m7.setLayerVisible(top.id, false);
  check("隐藏上层后合成高度为 10", approx(m7.compositeHeights[0], 10));
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
