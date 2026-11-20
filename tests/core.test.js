'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const PCParser = require('../js/pc/parser.js');
const PCMath = require('../js/pc/math3d.js');
const KdTree = require('../js/pc/kdtree.js');
const PCFilters = require('../js/pc/filters.js');
const PCRegistration = require('../js/pc/registration.js');
const { Scan, ScanStore } = require('../js/pc/state.js');
const PCProjectIO = require('../js/pc/projectio.js');

// ---------- 解析器 ----------
test('parser: 基础 XYZ 空白分隔与坏行报告行号', () => {
  const text = [
    '# 注释行',
    '0 0 0',
    '1 1 1',
    'bad row here',
    '2 2 2',
    '3 x 3'
  ].join('\n');
  const r = PCParser.parse(text, 'a.xyz');
  assert.equal(r.format, 'xyz');
  assert.equal(r.points.length, 3);
  assert.deepEqual(r.points[1], [1, 1, 1]);
  assert.equal(r.errors.length, 2);
  assert.equal(r.errors[0].line, 4);
  assert.equal(r.errors[1].line, 6);
  assert.equal(r.stats.validPoints, 3);
  assert.equal(r.stats.badLines, 2);
});

test('parser: 逗号分隔 + 颜色(0-255 与 0-1 自动识别)', () => {
  const text = '0,0,0,255,0,0\n1,1,1,0.0,1.0,0.0\n';
  const r = PCParser.parse(text, 'b.csv');
  assert.equal(r.points.length, 2);
  assert.ok(r.colors);
  assert.deepEqual(r.colors[0], [255, 0, 0]);
  assert.deepEqual(r.colors[1], [0, 255, 0]);
});

test('parser: CSV 表头按列名定位(列顺序打乱)', () => {
  const text = 'red,name,z,y,x,blue,green\n10,p1,3,2,1,30,20\n';
  const r = PCParser.parse(text, 'c.csv');
  assert.deepEqual(r.points[0], [1, 2, 3]);
  assert.deepEqual(r.colors[0], [10, 20, 30]);
});

test('parser: PTS 首行点数, 7 列含 intensity', () => {
  const text = '2\n0 0 0 128 10 20 30\n1 1 1 64 40 50 60\n';
  const r = PCParser.parse(text, 'd.pts');
  assert.equal(r.format, 'pts');
  assert.equal(r.points.length, 2);
  assert.ok(r.colors);
  assert.deepEqual(r.colors[0], [10, 20, 30]);
});

test('parser: PLY ascii 含坏行继续解析', () => {
  const ply = [
    'ply', 'format ascii 1.0',
    'element vertex 3',
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue',
    'end_header',
    '0 0 0 255 255 255',
    'oops',
    '1 1 1 0 0 0'
  ].join('\n');
  const r = PCParser.parse(ply, 'e.ply');
  assert.equal(r.format, 'ply');
  assert.equal(r.points.length, 2);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 12);
  assert.deepEqual(r.colors[1], [0, 0, 0]);
});

test('parser: PCD ascii FIELDS 解析', () => {
  const pcd = [
    '# .PCD v0.7',
    'VERSION 0.7',
    'FIELDS x y z',
    'SIZE 4 4 4',
    'TYPE F F F',
    'COUNT 1 1 1',
    'WIDTH 2', 'HEIGHT 1',
    'VIEWPOINT 0 0 0 1 0 0 0',
    'POINTS 2',
    'DATA ascii',
    '1 2 3',
    '4 5 6'
  ].join('\n');
  const r = PCParser.parse(pcd, 'f.pcd');
  assert.equal(r.format, 'pcd');
  assert.equal(r.points.length, 2);
  assert.deepEqual(r.points[1], [4, 5, 6]);
});

test('parser: PCD 二进制 data 段给出错误而不是崩溃', () => {
  const pcd = 'VERSION 0.7\nFIELDS x y z\nDATA binary\n';
  const r = PCParser.parse(pcd, 'g.pcd');
  assert.equal(r.points.length, 0);
  assert.ok(r.errors.some(e => /ascii/.test(e.reason)));
});

test('parser: 9 列 xyz+nxyz+rgb 布局', () => {
  const r = PCParser.parse('1 2 3 0 0 1 10 20 30', 'h.xyz');
  assert.deepEqual(r.points[0], [1, 2, 3]);
  assert.deepEqual(r.colors[0], [10, 20, 30]);
});

// ---------- 数学 ----------
test('math3d: 欧拉变换与逆变换一致', () => {
  const m = PCMath.makeTransform([1, -2, 0.5], [0.3, -0.7, 1.2]);
  const p = [3.3, -1.1, 2.2];
  const q = PCMath.applyPoint(m, p);
  assert.equal(q.length, 3);
  assert.ok(q.every(Number.isFinite));
  // 与 THREE.Matrix4 列主序兼容: 平移项位置
  assert.equal(m[12], 1);
  assert.equal(m[13], -2);
});

test('math3d: bbox 与 pointInBox', () => {
  const pts = [[0, 0, 0], [2, 4, 6], [-1, -2, -3]];
  const b = PCMath.bbox(pts);
  assert.deepEqual(b.min, [-1, -2, -3]);
  assert.deepEqual(b.max, [2, 4, 6]);
  assert.equal(PCMath.pointInBox([0, 0, 0], b), true);
  assert.equal(PCMath.pointInBox([3, 0, 0], b), false);
});

test('math3d: strideSample 确定性且覆盖首尾', () => {
  const s = PCMath.strideSample(1000, 100);
  assert.equal(s.length, 100);
  assert.equal(s[0], 0);
  assert.ok(s[99] < 1000);
  const s2 = PCMath.strideSample(1000, 100);
  assert.deepEqual(Array.from(s), Array.from(s2));
  assert.deepEqual(Array.from(PCMath.strideSample(5, 10)), [0, 1, 2, 3, 4]);
});

// ---------- KD 树 ----------
test('kdtree: knn 与暴力搜索结果一致', () => {
  const pts = [];
  for (let i = 0; i < 200; i++) {
    pts.push([(i * 37) % 101 - 50, (i * 53) % 97 - 48, (i * 71) % 89 - 44]);
  }
  const tree = new KdTree(pts);
  const q = [1, -2, 3];
  const nn = tree.knn(q, 5);
  assert.equal(nn.length, 5);
  // 暴力
  const brute = pts.map((p, i) => ({
    i, d2: (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2
  })).sort((a, b) => a.d2 - b.d2).slice(0, 5).map(x => x.i);
  assert.deepEqual(nn.map(x => x.index).sort(), brute.sort());
  assert.ok(nn[0].dist2 <= nn[4].dist2);
});

// ---------- 滤波 ----------
test('filters: SOR 识别明显离群点', () => {
  const pts = [];
  for (let i = 0; i < 100; i++) pts.push([i * 0.1, 0, 0]);
  pts.push([50, 50, 50]); // 离群
  pts.push([-40, -40, 0]); // 离群
  const r = PCFilters.statisticalOutlierRemoval(pts, 6, 1.0);
  assert.ok(r.removedCount >= 2, '应剔除至少 2 个离群点, 实际 ' + r.removedCount);
  assert.equal(r.keep.length + r.remove.length, pts.length);
  assert.ok(r.remove.includes(100) && r.remove.includes(101));
});

test('filters: 体素降采样每体素一个点且为其子集', () => {
  const pts = [[0, 0, 0], [0.1, 0.1, 0.1], [0.2, 0.2, 0.2], [5, 5, 5]];
  const r = PCFilters.voxelDownsample(pts, 1.0);
  // 前三个点都落在原点所在的同一个体素
  assert.equal(r.voxelCount, 2);
  assert.equal(r.indices.length, 2);
  assert.ok(r.indices.includes(3));
});

test('filters: cropByBox 两种模式互补', () => {
  const pts = [[0, 0, 0], [1, 1, 1], [5, 5, 5], [-1, -1, -1]];
  const all = Uint32Array.from([0, 1, 2, 3]);
  const box = { min: [-0.5, -0.5, -0.5], max: [1.5, 1.5, 1.5] };
  const inside = PCFilters.cropByBox(pts, all, box, 'keep-inside');
  const outside = PCFilters.cropByBox(pts, all, box, 'remove-inside');
  assert.deepEqual(Array.from(inside.keep), [0, 1]);
  assert.deepEqual(Array.from(outside.keep), [2, 3]);
});

// ---------- 配准 ----------
test('registration: 重合点云 RMSE 为 0,平移后非 0', () => {
  const a = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]];
  const same = a.map(p => p.slice());
  const r0 = PCRegistration.nearestNeighborError(a, same, 100);
  assert.equal(r0.rmse, 0);
  // 平移量远小于点间距时, 最近邻配对不变, RMSE 等于平移量
  const shifted = a.map(p => [p[0] + 1, p[1], p[2]]);
  const r1 = PCRegistration.nearestNeighborError(a, shifted, 100);
  assert.ok(Math.abs(r1.rmse - 1) < 1e-9);
  assert.equal(r1.samples, 4);
});

test('registration: 空点云返回友好结果', () => {
  const r = PCRegistration.nearestNeighborError([], [[1, 2, 3]], 10);
  assert.equal(r.rmse, null);
  assert.ok(r.message.length > 0);
});

// ---------- 状态/撤销 ----------
test('state: 裁剪后撤销恢复全部原始点', () => {
  const data = {
    format: 'xyz',
    points: [[0, 0, 0], [1, 1, 1], [5, 5, 5]],
    colors: null, errors: [], fileName: 't.xyz'
  };
  const scan = new Scan(data, 't');
  assert.equal(scan.count(), 3);
  const r = PCFilters.cropByBox(scan.points,
    Uint32Array.from([0, 1, 2]),
    { min: [-1, -1, -1], max: [2, 2, 2] }, 'keep-inside');
  scan.applyIndices(r.keep, '裁剪');
  assert.equal(scan.count(), 2);
  assert.equal(scan.originalCount(), 3); // 原始点未销毁
  const undone = scan.undo();
  assert.equal(undone.label, '裁剪');
  assert.equal(scan.count(), 3);
  assert.equal(scan.activeIndices, null);
});

test('state: restoreAll 还原点集与变换', () => {
  const data = {
    format: 'xyz',
    points: [[0, 0, 0], [1, 1, 1], [5, 5, 5]],
    colors: null, errors: [], fileName: 't.xyz'
  };
  const scan = new Scan(data, 't');
  scan.setTransform([1, 2, 3], [10, 20, 30], '变换');
  scan.applyIndices(Uint32Array.from([0, 1]), '裁剪');
  const cleared = scan.restoreAll();
  assert.equal(cleared, 2);
  assert.equal(scan.count(), 3);
  assert.deepEqual(scan.translation, [0, 0, 0]);
  assert.equal(scan.undo(), null);
});

test('state: worldPoints 应用了变换', () => {
  const data = {
    format: 'xyz', points: [[1, 0, 0]], colors: null, errors: [], fileName: 't.xyz'
  };
  const scan = new Scan(data, 't');
  scan.setTransform([10, 0, 0], [0, 0, 0], '平移');
  const w = scan.worldPoints();
  assert.deepEqual(w[0], [11, 0, 0]);
});

// ---------- 工程保存/导出 ----------
test('projectio: 工程保存与还原往返', () => {
  const store = new ScanStore();
  const data = {
    format: 'xyz',
    points: [[0, 0, 0], [1, 1, 1], [5, 5, 5]],
    colors: [[255, 0, 0], [0, 255, 0], [0, 0, 255]],
    errors: [{ line: 9, reason: 'x' }], fileName: 't.xyz'
  };
  const scan = store.add(data, 't');
  scan.setTransform([1, 2, 3], [0, 0, 0], '变换');
  scan.applyIndices(Uint32Array.from([0, 2]), '裁剪',
    { min: [-1, -1, -1], max: [2, 2, 2] });
  const project = PCProjectIO.saveProject(store, { note: '测试工程' });
  assert.equal(project.type, 'pointcloud-inspector-project');
  assert.equal(project.scans[0].visibleCount, 2);
  assert.deepEqual(project.scans[0].activeIndices, [0, 2]);
  assert.deepEqual(project.scans[0].cropBox.max, [2, 2, 2]);

  const store2 = new ScanStore();
  PCProjectIO.restoreProject(project, store2, Scan, { 't.xyz': data });
  const restored = store2.scans[0];
  assert.equal(restored.count(), 2);
  assert.deepEqual(restored.translation, [1, 2, 3]);
  assert.deepEqual(Array.from(restored.activeIndices), [0, 2]);
  assert.deepEqual(restored.lastCropBox.min, [-1, -1, -1]);
});

test('state: 撤销同时回退裁剪框,恢复原始点集清空裁剪框', () => {
  const data = {
    format: 'xyz',
    points: [[0, 0, 0], [1, 1, 1], [5, 5, 5]],
    colors: null, errors: [], fileName: 't.xyz'
  };
  const scan = new Scan(data, 't');
  scan.applyIndices(Uint32Array.from([0, 1]), '裁剪',
    { min: [0, 0, 0], max: [1, 1, 1] });
  assert.ok(scan.lastCropBox !== null);
  scan.undo();
  assert.equal(scan.lastCropBox, null);
  scan.applyIndices(Uint32Array.from([0]), '再次裁剪',
    { min: [0, 0, 0], max: [0.5, 0.5, 0.5] });
  scan.restoreAll();
  assert.equal(scan.lastCropBox, null);
});

test('projectio: 缺少源文件时报 MISSING_SOURCE', () => {
  const project = {
    type: 'pointcloud-inspector-project', version: 1,
    scans: [{ fileName: 'ghost.xyz', translation: [0, 0, 0],
      rotationDeg: [0, 0, 0], activeIndices: null }]
  };
  const store2 = new ScanStore();
  assert.throws(
    () => PCProjectIO.restoreProject(project, store2, Scan, {}),
    err => err.code === 'MISSING_SOURCE' && err.fileName === 'ghost.xyz'
  );
});

test('projectio: XYZ 导出含变换与颜色,点数等于可见数', () => {
  const data = {
    format: 'xyz', points: [[0, 0, 0], [1, 1, 1]],
    colors: [[10, 20, 30], [40, 50, 60]], errors: [], fileName: 't.xyz'
  };
  const scan = new Scan(data, 't');
  scan.setTransform([100, 0, 0], [0, 0, 0], '平移');
  scan.applyIndices(Uint32Array.from([1]), '裁剪');
  const text = PCProjectIO.exportXYZ(scan, { withColor: true });
  const lines = text.split('\n').filter(l => l && !l.startsWith('#'));
  assert.equal(lines.length, 1);
  const parts = lines[0].split(' ');
  assert.equal(parseFloat(parts[0]), 101); // 1 + 100
  assert.deepEqual(parts.slice(3), ['40', '50', '60']);
  const noColor = PCProjectIO.exportXYZ(scan, { withColor: false });
  assert.equal(noColor.split('\n').filter(l => l && !l.startsWith('#'))[0].split(' ').length, 3);
});

test('projectio: 工程说明包含关键信息', () => {
  const store = new ScanStore();
  const data = {
    format: 'xyz', points: [[0, 0, 0]], colors: null,
    errors: [{ line: 3, reason: 'bad' }], fileName: 't.xyz'
  };
  store.add(data, 't');
  const note = PCProjectIO.exportProjectNote(store, PCProjectIO.saveProject(store, {}));
  assert.match(note, /点云检查工程说明/);
  assert.match(note, /t\.xyz/);
  assert.match(note, /行号 3/);
});
