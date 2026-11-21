import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { raycastVoxel } from '../src/picking.js';

function newWorld() {
  return new World([
    { id: 'a', name: 'a', color: '#ff0000' },
    { id: 'b', name: 'b', color: '#00ff00' },
  ]);
}

test('射线命中最前面的体素, 返回进入面法线', () => {
  const w = newWorld();
  w.setVoxel(2, 0, 0, w.materialId(0));
  w.setVoxel(5, 0, 0, w.materialId(0)); // 更远的同线体素不应被选中
  const hit = raycastVoxel(
    { x: 0.5, y: 0.5, z: 0.5 },
    { x: 1, y: 0, z: 0 },
    w
  );
  assert.deepEqual(hit.voxel, [2, 0, 0]);
  assert.deepEqual(hit.normal, [-1, 0, 0]);
});

test('反方向射线: 命中并给出对应法线', () => {
  const w = newWorld();
  w.setVoxel(2, 0, 0, w.materialId(0));
  const hit = raycastVoxel(
    { x: 5.5, y: 0.5, z: 0.5 },
    { x: -1, y: 0, z: 0 },
    w
  );
  assert.deepEqual(hit.voxel, [2, 0, 0]);
  assert.deepEqual(hit.normal, [1, 0, 0]);
});

test('斜向射线穿过空格后命中, 法线轴正确', () => {
  const w = newWorld();
  w.setVoxel(3, 3, 3, w.materialId(0));
  const len = Math.sqrt(3);
  const hit = raycastVoxel(
    { x: 0.5, y: 0.5, z: 0.5 },
    { x: 1 / len, y: 1 / len, z: 1 / len },
    w
  );
  assert.deepEqual(hit.voxel, [3, 3, 3]);
  const normalAxes = hit.normal.filter((n) => n !== 0);
  assert.equal(normalAxes.length, 1); // 单面法线, 不是角点
  assert.equal(normalAxes[0], -1);
});

test('没有命中返回 null', () => {
  const w = newWorld();
  w.setVoxel(50, 50, 50, w.materialId(0));
  const hit = raycastVoxel(
    { x: 0.5, y: 0.5, z: 0.5 },
    { x: 1, y: 0, z: 0 },
    w
  );
  assert.equal(hit, null);
});

test('跨区块射线: 只选最前格, 删除后选中下一格', () => {
  const w = newWorld();
  w.setVoxel(7, 0, 0, w.materialId(0)); // 区块 0 边缘
  w.setVoxel(8, 0, 0, w.materialId(0)); // 区块 1 边缘
  const origin = { x: 0.5, y: 0.5, z: 0.5 };
  const dir = { x: 1, y: 0, z: 0 };
  assert.deepEqual(raycastVoxel(origin, dir, w).voxel, [7, 0, 0]);
  w.setVoxel(7, 0, 0, 0);
  assert.deepEqual(raycastVoxel(origin, dir, w).voxel, [8, 0, 0]);
});

test('起点在实心格内: 命中自身, 零法线', () => {
  const w = newWorld();
  w.setVoxel(0, 0, 0, w.materialId(0));
  const hit = raycastVoxel(
    { x: 0.2, y: 0.2, z: 0.2 },
    { x: 1, y: 0, z: 0 },
    w
  );
  assert.deepEqual(hit.voxel, [0, 0, 0]);
  assert.deepEqual(hit.normal, [0, 0, 0]);
});

test('负坐标区域同样可拾取', () => {
  const w = newWorld();
  w.setVoxel(-3, -1, -2, w.materialId(0));
  const hit = raycastVoxel(
    { x: 0.5, y: -0.5, z: -1.5 },
    { x: -1, y: 0, z: 0 },
    w
  );
  assert.deepEqual(hit.voxel, [-3, -1, -2]);
  assert.deepEqual(hit.normal, [1, 0, 0]);
});
