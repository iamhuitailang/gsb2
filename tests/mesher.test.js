import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, CHUNK, chunkKey, worldToChunk } from '../src/world.js';
import { buildChunkMesh, FACES } from '../src/mesher.js';

const PALETTE = [
  { id: 'a', name: 'a', color: '#ff0000' },
  { id: 'b', name: 'b', color: '#00ff00' },
  { id: 'c', name: 'c', color: '#0000ff' },
];

function newWorld() {
  return new World(PALETTE.map((p) => ({ ...p })));
}

test('单格体素: 6 个可见面 -> 6 个四边形 -> 12 个三角形', () => {
  const w = newWorld();
  w.setVoxel(0, 0, 0, w.materialId(0));
  const chunk = w.getChunk(0, 0, 0);
  const mesh = buildChunkMesh(chunk, w);
  assert.equal(mesh.rawFaceCount, 6);
  assert.equal(mesh.quadCount, 6);
  assert.equal(mesh.indices.length, 36);
  assert.equal(mesh.positions.length / 3, 24); // 每面 4 顶点, 未跨面合并
  assert.equal(mesh.gridPositions.length / 3 / 2, 12); // 立方体 12 条边
});

test('相邻两个同材质体素: 贴合面被剔除, 剩 10 个面', () => {
  const w = newWorld();
  w.setVoxel(0, 0, 0, w.materialId(0));
  w.setVoxel(1, 0, 0, w.materialId(0));
  const mesh = buildChunkMesh(w.getChunk(0, 0, 0), w);
  assert.equal(mesh.rawFaceCount, 10);
  // 中间 x=1 处的 -x 面与 x=0 处的 +x 面都被剔除
});

test('填满整个区块的实心块: 内部面全部剔除, 6 个大外表面', () => {
  const w = newWorld();
  for (let x = 0; x < CHUNK; x++)
    for (let y = 0; y < CHUNK; y++)
      for (let z = 0; z < CHUNK; z++) w.setVoxel(x, y, z, w.materialId(0));
  const mesh = buildChunkMesh(w.getChunk(0, 0, 0), w);
  // 每个外朝向 8x8=64 个小面, 共 384; 内部贴合面全部剔除
  assert.equal(mesh.rawFaceCount, 6 * CHUNK * CHUNK);
  // 贪婪合并后只剩 6 个大四边形(每面 4 顶点, 不跨面焊接)
  assert.equal(mesh.quadCount, 6);
  assert.equal(mesh.positions.length / 3, 24);
  // 网格轮廓: 立方体 12 条边
  assert.equal(mesh.gridPositions.length / 3 / 2, 12);
});

test('同材质共面合并: 4x1 一排 -> 一个大四边形, 颜色不跨材质合并', () => {
  const w = newWorld();
  // y=0 一排 4 格同材质, 顶面应合并成 1 个四边形
  for (let x = 0; x < 4; x++) w.setVoxel(x, 0, 0, w.materialId(0));
  let mesh = buildChunkMesh(w.getChunk(0, 0, 0), w);
  const topFacesBefore = mesh.rawFaceCount;
  assert.ok(topFacesBefore > 0);
  // 顶面 4 个小面 + 底面 4 + 侧面... 直接验证 quad 数 < 小面数
  assert.ok(mesh.quadCount < mesh.rawFaceCount);

  // 其中第 3 格换成别的材质: 顶面不能再整体合并, 且该格颜色不同
  w.setVoxel(2, 0, 0, w.materialId(1));
  mesh = buildChunkMesh(w.getChunk(0, 0, 0), w);
  const colors = new Set();
  for (let i = 0; i < mesh.colors.length; i += 3) {
    colors.add(`${mesh.colors[i]},${mesh.colors[i + 1]},${mesh.colors[i + 2]}`);
  }
  // 红绿两种顶点色都应存在
  assert.ok(colors.size >= 2);
});

test('跨区块贴合: 边缘体素的跨区块面被正确剔除', () => {
  const w = newWorld();
  // 区块 (0,0,0) 的最右格 和 区块 (1,0,0) 的最左格贴在一起
  w.setVoxel(CHUNK - 1, 0, 0, w.materialId(0));
  w.setVoxel(CHUNK, 0, 0, w.materialId(0));
  const meshA = buildChunkMesh(w.getChunk(0, 0, 0), w);
  const meshB = buildChunkMesh(w.getChunk(1, 0, 0), w);
  // 各自是单格, 贴合面被剔除 -> 各 5 个可见面
  assert.equal(meshA.rawFaceCount, 5);
  assert.equal(meshB.rawFaceCount, 5);

  // 删掉右边格: 左区块的 +x 面重新暴露 -> 6 面
  w.setVoxel(CHUNK, 0, 0, 0);
  assert.equal(w.getChunk(1, 0, 0), undefined); // 空区块数据被移除
  const meshA2 = buildChunkMesh(w.getChunk(0, 0, 0), w);
  assert.equal(meshA2.rawFaceCount, 6);
});

test('边缘编辑返回两侧区块 key, 删除整区块不残留数据', () => {
  const w = newWorld();
  w.setVoxel(CHUNK - 1, 0, 0, w.materialId(0));
  w.setVoxel(CHUNK, 0, 0, w.materialId(0));
  const affected = w.setVoxel(CHUNK, 0, 0, 0);
  assert.ok(affected.has(chunkKey(0, 0, 0)));
  assert.ok(affected.has(chunkKey(1, 0, 0)));
  assert.equal(w.chunks.size, 1);
});

test('不同材质相邻: 两个面都保留(颜色交界正确)', () => {
  const w = newWorld();
  w.setVoxel(0, 0, 0, w.materialId(0));
  w.setVoxel(1, 0, 0, w.materialId(1));
  const mesh = buildChunkMesh(w.getChunk(0, 0, 0), w);
  // 两个单格, 中间交界两面都保留 -> 各 6 面, 共 12
  assert.equal(mesh.rawFaceCount, 12);
});

test('挖空实心块内部: 新增内表面', () => {
  const w = newWorld();
  for (let x = 0; x < CHUNK; x++)
    for (let y = 0; y < CHUNK; y++)
      for (let z = 0; z < CHUNK; z++) w.setVoxel(x, y, z, w.materialId(0));
  const before = buildChunkMesh(w.getChunk(0, 0, 0), w).rawFaceCount;
  assert.equal(before, 6 * CHUNK * CHUNK);
  w.setVoxel(3, 3, 3, 0);
  const mesh = buildChunkMesh(w.getChunk(0, 0, 0), w);
  // 挖掉 1 格 -> 周围 6 个新内表面
  assert.equal(mesh.rawFaceCount, before + 6);
});

test('负坐标: 世界坐标与区块/局部坐标换算正确', () => {
  const c = worldToChunk(-1, -CHUNK, -CHUNK - 1);
  assert.deepEqual([c.cx, c.cy, c.cz], [-1, -1, -2]);
  assert.deepEqual([c.lx, c.ly, c.lz], [CHUNK - 1, 0, CHUNK - 1]);

  const w = newWorld();
  w.setVoxel(-1, 0, 0, w.materialId(2));
  assert.equal(w.getVoxel(-1, 0, 0), w.materialId(2));
  const mesh = buildChunkMesh(w.getChunk(-1, 0, 0), w);
  assert.equal(mesh.rawFaceCount, 6);
});

test('工程序列化往返: 体素位置与材质保持一致', () => {
  const w = newWorld();
  w.setVoxel(-2, 5, 7, w.materialId(1));
  w.setVoxel(CHUNK, CHUNK + 1, 0, w.materialId(2));
  const json = w.serialize();
  const restored = World.deserialize(json);
  assert.equal(restored.getVoxel(-2, 5, 7), w.materialId(1));
  assert.equal(restored.getVoxel(CHUNK, CHUNK + 1, 0), w.materialId(2));
  assert.equal(restored.getVoxel(0, 0, 0), 0);
  assert.equal(restored.voxelCount(), 2);
});

test('合并后四边形顶点颜色逐顶点正确', () => {
  const w = newWorld();
  w.setVoxel(0, 0, 0, w.materialId(1)); // 绿色
  const mesh = buildChunkMesh(w.getChunk(0, 0, 0), w);
  // 所有顶点颜色应一致为绿色 (0,1,0)
  for (let i = 0; i < mesh.colors.length; i += 3) {
    assert.equal(mesh.colors[i], 0);
    assert.equal(mesh.colors[i + 1], 1);
    assert.equal(mesh.colors[i + 2], 0);
  }
});

test('所有面 winding 朝外(叉积法线与面法线同向, 不会被背面剔除)', () => {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const face of FACES) {
    const [c0, c1, c2] = face.corners;
    const n = cross(sub(c1, c0), sub(c2, c0));
    assert.ok(
      dot(n, face.dir) > 0,
      `面 ${face.dir} winding 反向: 叉积=${n}`
    );
  }
});

test('生成几何体的三角形法线与面方向一致', () => {
  const w = newWorld();
  w.setVoxel(0, 0, 0, w.materialId(0));
  const mesh = buildChunkMesh(w.getChunk(0, 0, 0), w);
  const normals = new Set();
  for (let i = 0; i < mesh.normals.length; i += 3) {
    normals.add(`${mesh.normals[i]},${mesh.normals[i + 1]},${mesh.normals[i + 2]}`);
  }
  // 6 个朝向各出现一次
  assert.equal(normals.size, 6);
  for (const face of FACES) {
    assert.ok(normals.has(face.dir.join(',')));
  }
});
