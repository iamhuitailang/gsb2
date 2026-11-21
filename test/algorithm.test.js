/*
 * Node 单元测试：node test/algorithm.test.js
 * 覆盖：最大裁切框、可行区间、冲突检测、最优子集、
 *       海报 A 三尺寸全保留、海报 B 横幅/竖图冲突、带留白有效占比。
 */
'use strict';
const assert = require('assert');
const G = require('../js/geometry');
const C = require('../js/cropper');
const posters = require('../js/posters');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name + '\n    ' + e.message);
    process.exitCode = 1;
  }
}

const IMG_W = 1600;
const IMG_H = 2000;
function px(regions) {
  return C.toPixelRegions(regions, IMG_W, IMG_H);
}

console.log('1) maxFittingCrop 尺寸与宽高比');
test('横幅 1920x800 (2.4:1) 高度拉满', () => {
  const { cw, ch } = C.maxFittingCrop(IMG_W, IMG_H, 1920, 800);
  assert.ok(Math.abs(ch - IMG_H) < 1e-6);
  assert.ok(Math.abs(cw / ch - 1920 / 800) < 1e-9);
  assert.ok(cw <= IMG_W);
});
test('竖图 1080x1920 (9:16) 宽度拉满', () => {
  const { cw, ch } = C.maxFittingCrop(IMG_W, IMG_H, 1080, 1920);
  assert.ok(Math.abs(cw - IMG_W) < 1e-6);
  assert.ok(Math.abs(cw / ch - 1080 / 1920) < 1e-9);
  assert.ok(ch <= IMG_H);
});
test('方图裁切框为正方形且不超出原图', () => {
  const { cw, ch } = C.maxFittingCrop(IMG_W, IMG_H, 1080, 1080);
  assert.ok(Math.abs(cw - ch) < 1e-9);
  assert.ok(cw <= IMG_W && ch <= IMG_H);
});

console.log('2) feasibleRange / 区间交集');
test('左上区域与右下区域在横幅下无共同可行域', () => {
  const regions = px([
    { id: 'r1', x: 0.05, y: 0.04, w: 0.3, h: 0.1, priority: 'required' },
    { id: 'r2', x: 0.65, y: 0.5, w: 0.2, h: 0.1, priority: 'required' },
  ]);
  const { cw, ch } = C.maxFittingCrop(IMG_W, IMG_H, 1920, 800);
  const r1 = C.feasibleRange(regions[0], cw, ch, IMG_W, IMG_H);
  const r2 = C.feasibleRange(regions[1], cw, ch, IMG_W, IMG_H);
  assert.ok(r1 && r2);
  assert.strictEqual(C.intersectRanges([r1, r2]), null);
});
test('比裁切框还大的区域返回 null（oversize）', () => {
  const { cw, ch } = C.maxFittingCrop(IMG_W, IMG_H, 1920, 800);
  const big = { id: 'big', x: 0, y: 0, w: 0.9 * IMG_W, h: 0.5 * IMG_H, priority: 'required' };
  assert.strictEqual(C.feasibleRange(big, cw, ch, IMG_W, IMG_H), null);
});

console.log('3) 海报 A（紧凑构图）三种尺寸全部完整保留');
const specA = posters.specs.find((s) => s.id === 'posterA');
[
  { name: '横幅', w: 1920, h: 800 },
  { name: '方图', w: 1080, h: 1080 },
  { name: '竖图', w: 1080, h: 1920 },
].forEach((t) => {
  test(`海报 A · ${t}：无冲突、两个必须区都在裁切框内`, () => {
    const res = C.autoCrop(IMG_W, IMG_H, px(specA.regions), t.w, t.h);
    assert.strictEqual(res.conflicts.length, 0, '不应有冲突');
    const reqIds = specA.regions.filter((r) => r.priority === 'required').map((r) => r.id);
    assert.deepStrictEqual(res.missingRequired, []);
    assert.deepStrictEqual(res.containedRequired.sort(), reqIds.sort());
    reqIds.forEach((id) => {
      const r = px(specA.regions).find((x) => x.id === id);
      assert.ok(G.containsRect(res.crop, r), id + ' 应完整位于裁切框内');
    });
    assert.ok(res.crop.w <= IMG_W + 1 && res.crop.h <= IMG_H + 1);
    assert.ok(res.crop.x >= -0.01 && res.crop.y >= -0.01);
  });
});

console.log('4) 海报 B（标题/角色过远）冲突报告与策略');
const specB = posters.specs.find((s) => s.id === 'posterB');
test('海报 B · 横幅：报告具体冲突的两个区域，且方案只能保住其一', () => {
  const res = C.autoCrop(IMG_W, IMG_H, px(specB.regions), 1920, 800);
  const pair = res.conflicts.find((c) => c.type === 'pair');
  assert.ok(pair, '应存在 pair 冲突');
  assert.ok(pair.a === 'b-title' && pair.b === 'b-face');
  assert.strictEqual(res.missingRequired.length, 1);
  assert.strictEqual(res.containedRequired.length, 1);
  const kept = res.containedRequired[0];
  const keptRegion = px(specB.regions).find((r) => r.id === kept);
  assert.ok(G.containsRect(res.crop, keptRegion));
});
test('海报 B · 竖图：同样报告 b-title / b-face 冲突', () => {
  const res = C.autoCrop(IMG_W, IMG_H, px(specB.regions), 1080, 1920);
  const pair = res.conflicts.find((c) => c.type === 'pair');
  assert.ok(pair && pair.a === 'b-title' && pair.b === 'b-face');
  assert.strictEqual(res.containedRequired.length + res.missingRequired.length, 2);
});
test('海报 B · 方图：两个必须区可同时保留、无冲突', () => {
  const res = C.autoCrop(IMG_W, IMG_H, px(specB.regions), 1080, 1080);
  assert.strictEqual(res.conflicts.length, 0);
  assert.deepStrictEqual(res.missingRequired, []);
});

console.log('5) 自动裁切选位质量');
test('尽量保留区被完整包含时 preferred.contained=true', () => {
  const regions = px([
    { id: 'r1', x: 0.3, y: 0.3, w: 0.2, h: 0.1, priority: 'required' },
    { id: 'p1', x: 0.35, y: 0.45, w: 0.1, h: 0.1, priority: 'preferred' },
  ]);
  const res = C.autoCrop(IMG_W, IMG_H, regions, 1080, 1080);
  const pInfo = res.preferred.find((p) => p.id === 'p1');
  assert.ok(pInfo.contained);
  assert.ok(Math.abs(pInfo.ratio - 1) < 1e-6);
});
test('裁切框始终保持目标宽高比并落在原图内', () => {
  [
    [1920, 800],
    [1080, 1080],
    [1080, 1920],
    [800, 600],
  ].forEach(([w, h]) => {
    const res = C.autoCrop(IMG_W, IMG_H, px(specB.regions), w, h);
    assert.ok(Math.abs(res.crop.w / res.crop.h - w / h) < 1e-6);
    assert.ok(res.crop.x >= -0.01 && res.crop.y >= -0.01);
    assert.ok(res.crop.x + res.crop.w <= IMG_W + 0.01);
    assert.ok(res.crop.y + res.crop.h <= IMG_H + 0.01);
  });
});

console.log('6) 手动裁切分析');
test('analyzeManual 如实反映手动位置截掉了哪个必须区', () => {
  const regions = px(specB.regions);
  const { cw, ch } = C.maxFittingCrop(IMG_W, IMG_H, 1920, 800);
  const manual = { x: 0, y: 0, w: cw, h: ch }; // 贴左上角：标题在、脸被截
  const res = C.analyzeManual(manual, IMG_W, IMG_H, regions, 1920, 800);
  assert.ok(res.containedRequired.includes('b-title'));
  assert.ok(res.missingRequired.includes('b-face'));
  assert.strictEqual(res.effectiveRatio, 1);
});

console.log('7) 带留白 padLayout 与有效图像占比');
test('横幅 pad：全图完整保留、左右补边，图像宽 640 居中，有效占比 1/3', () => {
  const pad = C.padLayout(IMG_W, IMG_H, 1920, 800);
  assert.strictEqual(pad.mode, 'pad');
  assert.strictEqual(pad.imageRect.w, 640);
  assert.strictEqual(pad.imageRect.h, 800);
  assert.strictEqual(pad.imageRect.x, Math.round((1920 - 640) / 2));
  assert.strictEqual(pad.imageRect.y, 0);
  assert.ok(Math.abs(pad.effectiveRatio - 1 / 3) < 1e-9);
  assert.ok(pad.effectiveRatio < 1);
});
test('竖图 9:16 装 4:5 原图：左右补边，有效占比 <1，补边不算原图内容', () => {
  const pad = C.padLayout(IMG_W, IMG_H, 1080, 1920);
  const expectScale = 1080 / IMG_W;
  assert.ok(Math.abs(pad.scale - expectScale) < 1e-9);
  assert.strictEqual(pad.imageRect.w, 1080);
  assert.strictEqual(pad.imageRect.h, Math.round(IMG_H * expectScale));
  assert.ok(pad.imageRect.x === 0);
  assert.ok(pad.imageRect.y > 0);
  const expectRatio = (pad.imageRect.w * pad.imageRect.h) / (1080 * 1920);
  assert.ok(Math.abs(pad.effectiveRatio - expectRatio) < 1e-9);
  assert.ok(pad.effectiveRatio < 1);
  assert.deepStrictEqual(pad.missingRequired, []);
});
test('pad 模式不报冲突：整张原图内容天然完整保留', () => {
  const pad = C.padLayout(IMG_W, IMG_H, 1080, 1920);
  assert.deepStrictEqual(pad.conflicts, []);
});

console.log('8) 归一化往返与坐标绑定');
test('normalizeRect / denormalizeRect 往返一致', () => {
  const r = { x: 120.5, y: 340.2, w: 560, h: 780 };
  const n = G.normalizeRect(r, IMG_W, IMG_H);
  const back = G.denormalizeRect(n, IMG_W, IMG_H);
  assert.ok(Math.abs(back.x - r.x) < 1e-9);
  assert.ok(Math.abs(back.y - r.y) < 1e-9);
  assert.ok(Math.abs(back.w - r.w) < 1e-9);
  assert.ok(Math.abs(back.h - r.h) < 1e-9);
});
test('关注区归一化后取值都在 0..1', () => {
  posters.specs.forEach((s) => {
    s.regions.forEach((r) => {
      ['x', 'y', 'w', 'h'].forEach((k) => {
        assert.ok(r[k] >= 0 && r[k] <= 1, `${s.id}/${r.id}.${k}=${r[k]}`);
      });
      assert.ok(r.x + r.w <= 1 + 1e-9);
      assert.ok(r.y + r.h <= 1 + 1e-9);
    });
  });
});

console.log(`\n${passed} 项测试通过`);
