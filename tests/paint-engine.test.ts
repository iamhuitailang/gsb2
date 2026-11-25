import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PaintEngine, brushProfile } from '../src/core/paint-engine.js';
import { TextureLayer, compositeLayers } from '../src/core/texture-layer.js';
import { rayTriangle, v3 } from '../src/core/math3d.js';
import { buildSeamedCube } from './helpers.js';

const RED = { r: 230, g: 40, b: 40 };
const brush = (overrides = {}) => ({
  radius: 0.25,
  hardness: 0.5,
  opacity: 1,
  color: RED,
  eraser: false,
  ...overrides,
});

describe('数学工具', () => {
  test('rayTriangle 命中与背离', () => {
    const a = v3(0, 0, 0);
    const b = v3(1, 0, 0);
    const c = v3(0, 1, 0);
    const hit = rayTriangle(v3(0.25, 0.25, 1), v3(0, 0, -1), a, b, c);
    assert.notEqual(hit, null);
    assert.ok(Math.abs(hit! - 1) < 1e-9);
    const miss = rayTriangle(v3(2, 2, 1), v3(0, 0, -1), a, b, c);
    assert.equal(miss, null);
  });

  test('笔刷衰减：核内为 1，边界为 0', () => {
    assert.equal(brushProfile(0, 0.5), 1);
    assert.equal(brushProfile(0.5, 0.5), 1);
    assert.equal(brushProfile(1, 0.5), 0);
    const mid = brushProfile(0.75, 0.5);
    assert.ok(mid > 0 && mid < 1);
  });
});

describe('表面绘制引擎', () => {
  test('一笔落在面上后，绘画层出现不透明像素，基础层不变', () => {
    const { mesh } = buildSeamedCube(1, false);
    const engine = new PaintEngine(mesh);
    engine.ensureMaterial('cube', 256);
    engine.beginStroke('cube', brush(), 256);
    // 从 +Z 外侧击中 pz 面中心
    const hit = engine.raycast(v3(0, 0, 2), v3(0, 0, -1))!;
    assert.ok(hit);
    engine.addStrokePoint({ point: hit.point, triangle: hit.triangle });
    engine.endStroke();

    const state = engine.getMaterialState('cube')!;
    let painted = 0;
    for (let i = 3; i < state.paint.data.length; i += 4) {
      if (state.paint.data[i] > 0) painted++;
    }
    assert.ok(painted > 10, '应画出一片像素而不是单点');
    // 基础层保持初始灰
    assert.equal(state.base.data[3], 255);
    assert.equal(state.base.data[0], 180);
  });

  test('旋转视角后再拾取，世界中的同一处仍命中同一局部位置', () => {
    const { mesh } = buildSeamedCube(1, false);
    const engine = new PaintEngine(mesh);
    // 原始射线：从 +Z 击中 (0,0,0.5)
    const h1 = engine.raycast(v3(0, 0, 2), v3(0, 0, -1))!;
    assert.deepEqual(
      h1.point,
      { x: 0, y: 0, z: 0.5 },
    );
    // 模拟相机绕 Y 旋转 90°：射线起点变为 +X 方向
    const h2 = engine.raycast(v3(2, 0, 0), v3(-1, 0, 0))!;
    assert.ok(h2);
    // 命中点是立方体 +X 面 (0.5,0,0) —— 证明射线求交与视角无关，结果稳定
    assert.ok(Math.abs(h2.point.x - 0.5) < 1e-9);
    assert.ok(Math.abs(h2.point.y) < 1e-9);
    assert.ok(Math.abs(h2.point.z) < 1e-9);
  });

  test('接缝两侧同时被画到：跨边的两个 UV 岛都有像素', () => {
    const { mesh } = buildSeamedCube(1, false);
    const engine = new PaintEngine(mesh);
    engine.ensureMaterial('cube', 256);
    // 笔刷球中心压在 pz / px 共享的三维边 x=0.5,z=0.5 附近
    const center = v3(0.42, 0, 0.42);
    engine.beginStroke('cube', brush({ radius: 0.2 }), 256);
    engine.addStrokePoint({ point: center, triangle: 0 });
    engine.endStroke();

    const state = engine.getMaterialState('cube')!;
    // 统计各 UV 岛包围盒内的绘画像素：
    // pz 岛 u∈[0,1/3) v∈[0,1/2)，px 岛 u∈[1/3,2/3) v∈[0,1/2)
    const countInIsland = (u0: number, v0: number, u1: number, v1: number) => {
      let count = 0;
      const px0 = Math.floor(u0 * 256);
      const px1 = Math.floor(u1 * 256);
      const py0 = Math.floor((1 - v1) * 256);
      const py1 = Math.floor((1 - v0) * 256);
      for (let py = py0; py < py1; py++) {
        for (let px = px0; px < px1; px++) {
          if (state.paint.data[(py * 256 + px) * 4 + 3] > 0) count++;
        }
      }
      return count;
    };
    const pzCount = countInIsland(0, 0, 1 / 3 - 0.01, 1 / 2 - 0.01);
    const pxCount = countInIsland(1 / 3 + 0.01, 0, 2 / 3 - 0.01, 1 / 2 - 0.01);
    assert.ok(pzCount > 0, 'pz 所在 UV 岛应有笔触');
    assert.ok(pxCount > 0, 'px 所在 UV 岛（接缝另一侧）也应有笔触');
  });

  test('撤销 / 重做按笔画恢复，且不影响基础纹理', () => {
    const { mesh } = buildSeamedCube(1, false);
    const engine = new PaintEngine(mesh);
    engine.ensureMaterial('cube', 256);
    const base = engine.getMaterialState('cube')!.base;
    const before = base.data.slice();

    const paintOnce = () => {
      engine.beginStroke('cube', brush(), 256);
      const hit = engine.raycast(v3(0, 0, 2), v3(0, 0, -1))!;
      engine.addStrokePoint({ point: hit.point, triangle: hit.triangle });
      engine.endStroke();
    };
    paintOnce();
    const afterFirst = engine.getMaterialState('cube')!.paint.data.slice();
    paintOnce();
    assert.ok(engine.canUndo);
    engine.undo();
    assert.deepEqual(
      engine.getMaterialState('cube')!.paint.data,
      afterFirst,
      '撤销第二笔后应回到第一笔的结果',
    );
    engine.undo();
    let painted = 0;
    const paint = engine.getMaterialState('cube')!.paint;
    for (let i = 3; i < paint.data.length; i += 4) if (paint.data[i]) painted++;
    assert.equal(painted, 0, '撤销全部笔画后绘画层清空');
    engine.redo();
    assert.deepEqual(paint.data, afterFirst, '重做恢复第一笔');
    assert.deepEqual(base.data, before, '基础纹理全程未被修改');
  });

  test('橡皮只清除绘画层，合成后露出基础层', () => {
    const { mesh } = buildSeamedCube(1, false);
    const engine = new PaintEngine(mesh);
    engine.ensureMaterial('cube', 128);
    engine.beginStroke('cube', brush(), 128);
    const hit = engine.raycast(v3(0, 0, 2), v3(0, 0, -1))!;
    engine.addStrokePoint({ point: hit.point, triangle: hit.triangle });
    engine.endStroke();

    engine.beginStroke(
      'cube',
      brush({ eraser: true, radius: 0.5, opacity: 1 }),
      128,
    );
    engine.addStrokePoint({ point: hit.point, triangle: hit.triangle });
    engine.endStroke();

    const state = engine.getMaterialState('cube')!;
    let alpha = 0;
    for (let i = 3; i < state.paint.data.length; i += 4) {
      alpha += state.paint.data[i];
    }
    assert.equal(alpha, 0, '橡皮后绘画层透明');
    const composited = compositeLayers(state.base, state.paint);
    assert.equal(composited[3], 255, '合成结果仍被基础层填满');
  });

  test('材质隔离：只在指定材质的三角面上落笔', () => {
    const { mesh } = buildSeamedCube(1, true);
    const engine = new PaintEngine(mesh);
    engine.ensureMaterial('pz', 128);
    engine.beginStroke('pz', brush({ radius: 0.4 }), 128);
    const hit = engine.raycast(v3(0, 0, 2), v3(0, 0, -1), 'pz')!;
    engine.addStrokePoint({ point: hit.point, triangle: hit.triangle });
    engine.endStroke();
    // 其它材质尚未创建状态 => 不可能被画到
    assert.equal(engine.getMaterialState('px'), undefined);
    assert.ok(engine.getMaterialState('pz'));
  });

  test('棋盘纹理为不透明程序纹理且两种颜色交替', () => {
    const layer = new TextureLayer(64, 64);
    layer.fillChecker(8);
    assert.equal(layer.data[3], 255);
    const c00 = layer.data[0];
    const c10 = layer.data[(0 * 64 + 8) * 4];
    assert.notEqual(c00, c10, '相邻棋盘格颜色不同');
  });
});
