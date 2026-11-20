import { describe, it, expect } from 'vitest';
import { createMesh } from '../src/core/mesh.js';
import { buildTopology, findIslands, toggleSeam, isSeam } from '../src/core/topology.js';
import { unwrapFaces } from '../src/core/unwrap.js';
import { packIslands, islandBounds, translateIsland, scaleIsland } from '../src/core/islands.js';
import { inspectUV } from '../src/core/inspect.js';
import { exportOBJ, parseOBJ, saveProject, loadProject } from '../src/core/objio.js';

// 两个共边三角形组成的平面四边形：(0,0,0)-(1,0,0)-(1,1,0)-(0,1,0)
function quadMesh() {
  const positions = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  ];
  const faces = [[0, 1, 2], [0, 2, 3]];
  return createMesh({ name: 'quad', positions, faces, faceMaterials: ['a', 'b'],
    materials: { a: { diffuse: [1, 0, 0] }, b: { diffuse: [0, 1, 0] } } });
}

// 立方体（12 三角形，8 顶点）
function cubeMesh() {
  const p = [];
  for (const z of [0, 1]) for (const y of [0, 1]) for (const x of [0, 1]) {
    p.push([x, y, z]);
  }
  // 顶点序号: 0(000) 1(100) 2(110) 3(010) 4(001) 5(101) 6(111) 7(011)
  const faces = [
    [0, 2, 1], [0, 3, 2], // z=0
    [4, 5, 6], [4, 6, 7], // z=1
    [0, 1, 5], [0, 5, 4], // y=0
    [2, 3, 7], [2, 7, 6], // y=1
    [0, 4, 7], [0, 7, 3], // x=0
    [1, 2, 6], [1, 6, 5], // x=1
  ];
  return createMesh({ name: 'cube', positions: p, faces });
}

describe('topology', () => {
  it('构建半边邻接与边界边', () => {
    const m = quadMesh();
    // 两个三角形共享边 0-2：f0 的 2->0 是 corner2，f1 的 0->2 是 corner3
    expect(m.topology.opposite[2]).toBe(3);
    expect(m.topology.opposite[3]).toBe(2);
    // 外轮廓边是边界，opposite 为 -1
    expect(m.topology.opposite[0]).toBe(-1);
    expect(m.topology.opposite[4]).toBe(-1);
    const boundaryCount = m.topology.boundaryEdges.length;
    expect(boundaryCount).toBe(4); // 四边形外轮廓 4 条边界边
  });

  it('切缝标记可切换，边界恒为缝', () => {
    const m = quadMesh();
    expect(isSeam(m.seams, m.topology, 0, 2)).toBe(false);
    expect(toggleSeam(m.seams, m.topology, 0, 2)).toBe(true);
    expect(isSeam(m.seams, m.topology, 0, 2)).toBe(true);
    toggleSeam(m.seams, m.topology, 0, 2);
    expect(isSeam(m.seams, m.topology, 0, 2)).toBe(false);
    // 边界边
    expect(isSeam(m.seams, m.topology, 0, 1)).toBe(true);
    expect(toggleSeam(m.seams, m.topology, 0, 1)).toBe(false);
  });

  it('切缝把一个岛切成两个', () => {
    const m = quadMesh();
    unwrapFaces(m, null, 0); // 先展开得到共享 UV
    expect(findIslands(m).islands.length).toBe(1);
    toggleSeam(m.seams, m.topology, 0, 2);
    expect(findIslands(m).islands.length).toBe(2);
  });
});

describe('unwrap 等距展开', () => {
  it('平面四边形展开后保持边长与面积', () => {
    const m = quadMesh();
    unwrapFaces(m, null, 0);
    const u = m.uvSets[0];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    // 边 0-1 原长 1；归一化后整体缩放，检查两组对边等长即可
    const l01 = dist(u[0][0], u[0][1]);
    const l12 = dist(u[0][1], u[0][2]);
    expect(l01).toBeCloseTo(l12); // 正方形两边等长
    // 总面积（两个三角形）与单三角形两倍关系
    const a1 = Math.abs((u[0][1][0] - u[0][0][0]) * (u[0][2][1] - u[0][0][1]) -
      (u[0][2][0] - u[0][0][0]) * (u[0][1][1] - u[0][0][1])) / 2;
    const a2 = Math.abs((u[1][1][0] - u[1][0][0]) * (u[1][2][1] - u[1][0][1]) -
      (u[1][2][0] - u[1][0][0]) * (u[1][1][1] - u[1][0][1])) / 2;
    expect(a1).toBeCloseTo(a2, 6);
  });

  it('立方体全切缝后每个面独立成岛，共 12 个', () => {
    const m = cubeMesh();
    // 标记所有内部边为切缝
    const internal = new Set();
    for (const [key, c] of m.topology.halfedges) {
      const [a, b] = key.split('_').map(Number);
      if (m.topology.opposite[c] >= 0) internal.add(`${Math.min(a, b)}_${Math.max(a, b)}`);
    }
    m.seams = internal;
    unwrapFaces(m, null, 0);
    const { islands } = findIslands(m);
    expect(islands.length).toBe(12);
  });

  it('整体展开保留真实比例，打包后所有 UV 落在单位方框内', () => {
    const m = cubeMesh();
    unwrapFaces(m, null, 0);
    // 真实尺寸坐标可以超出 [0,1]
    const anyOutside = m.uvSets[0].some((tri) =>
      tri.some(([u, v]) => u < 0 || v < 0 || u > 1 || v > 1));
    expect(anyOutside).toBe(true);
    // 打包后统一缩放回单位方框
    packIslands(m, 0, 0.02);
    for (const tri of m.uvSets[0]) for (const [u, v] of tri) {
      expect(u).toBeGreaterThanOrEqual(-1e-9);
      expect(u).toBeLessThanOrEqual(1 + 1e-9);
      expect(v).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('局部展开（选中面）归一化进单位方框', () => {
    const m = cubeMesh();
    unwrapFaces(m, new Set([0, 1]), 0);
    for (const f of [0, 1]) for (const [u, v] of m.uvSets[0][f]) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('平面投影模式可运行且坐标有限', () => {
    const m = quadMesh();
    unwrapFaces(m, null, 0, { mode: 'planar' });
    for (const tri of m.uvSets[0]) for (const [u, v] of tri) {
      expect(Number.isFinite(u)).toBe(true);
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('岛变换与打包', () => {
  it('平移/缩放保持岛成员不变', () => {
    const m = quadMesh();
    const before = findIslands(m).islands.length;
    translateIsland(m, 0, 0.3, -0.2);
    scaleIsland(m, 0, 2, 2);
    expect(findIslands(m).islands.length).toBe(before);
    const b = islandBounds(m, findIslands(m).islands[0]);
    expect(b.width).toBeGreaterThan(0.5);
  });

  it('自动排布后全部岛在 [0,1] 内且互不重叠', () => {
    const m = cubeMesh();
    const internal = new Set();
    for (const [key, c] of m.topology.halfedges) {
      const [a, b] = key.split('_').map(Number);
      if (m.topology.opposite[c] >= 0) internal.add(`${Math.min(a, b)}_${Math.max(a, b)}`);
    }
    m.seams = internal;
    unwrapFaces(m, null, 0);
    const result = packIslands(m, 0, 0.03);
    expect(result.islandCount).toBe(12);
    const report = inspectUV(m, 0);
    expect(report.overlaps.length).toBe(0);
    expect(report.outOfBounds.length).toBe(0);
  });
});

describe('检查', () => {
  it('能检测到人为制造的岛重叠', () => {
    const m = quadMesh();
    toggleSeam(m.seams, m.topology, 0, 2);
    unwrapFaces(m, null, 0);
    // 两个岛都在 [0.05,0.95] 附近，切缝后各自归一化 -> 必然重叠
    const report = inspectUV(m, 0);
    expect(report.overlaps.length).toBeGreaterThan(0);
  });

  it('能检测越界', () => {
    const m = quadMesh();
    translateIsland(m, 0, 5, 0);
    const report = inspectUV(m, 0);
    expect(report.outOfBounds.length).toBe(1);
  });

  it('能检测过小岛', () => {
    const m = cubeMesh();
    const internal = new Set();
    for (const [key, c] of m.topology.halfedges) {
      const [a, b] = key.split('_').map(Number);
      if (m.topology.opposite[c] >= 0) internal.add(`${Math.min(a, b)}_${Math.max(a, b)}`);
    }
    m.seams = internal;
    unwrapFaces(m, null, 0);
    // 把一个岛缩到极小
    scaleIsland(m, 3, 0.001, 0.001);
    const report = inspectUV(m, 0, { minArea: 0.0008 });
    expect(report.tinyIslands.some((t) => t.island === 3)).toBe(true);
  });
});

describe('多套 UV 隔离', () => {
  it('修改一套 UV 不影响另一套', () => {
    const m = cubeMesh();
    const set1 = addSet(m);
    const snapshot = JSON.stringify(m.uvSets[0]);
    unwrapFaces(m, null, set1);
    translateIsland(m, 0, 0.4, 0.4, set1);
    expect(JSON.stringify(m.uvSets[0])).toBe(snapshot);
  });
});

function addSet(m) {
  // 避免循环依赖，直接内联 addUvSet 行为
  const src = m.uvSets[0];
  m.uvSets.push(src.map((t) => t.map(([u, v]) => [u, v])));
  m.uvNames.push(`UVSet ${m.uvSets.length}`);
  return m.uvSets.length - 1;
}

describe('项目与 OBJ 往返', () => {
  it('项目保存/加载保留切缝与所有 UV 套', () => {
    const m = cubeMesh();
    toggleSeam(m.seams, m.topology, 0, 1) === false; // 边界，忽略
    toggleSeam(m.seams, m.topology, 0, 3);
    addSet(m);
    unwrapFaces(m, null, 1);
    const json = saveProject(m, { camera: { azimuth: 1 } });
    const { mesh: m2, viewState } = loadProject(json);
    expect(m2.seams.has('0_3')).toBe(true);
    expect(m2.uvSets.length).toBe(2);
    expect(m2.faces.length).toBe(m.faces.length);
    expect(viewState.camera.azimuth).toBe(1);
  });

  it('OBJ 导出后重新解析，面数与材质保留', () => {
    const m = quadMesh();
    const { obj } = exportOBJ(m, 0);
    const re = parseOBJ(obj);
    expect(re.faces.length).toBe(2);
    expect(new Set(re.faceMaterials)).toEqual(new Set(['a', 'b']));
  });

  it('OBJ 导出包含 vt 纹理坐标且数量与输出顶点一致', () => {
    const m = cubeMesh();
    const { obj } = exportOBJ(m, 0);
    const vtCount = obj.split('\n').filter((l) => l.startsWith('vt ')).length;
    const vCount = obj.split('\n').filter((l) => l.startsWith('v ')).length;
    expect(vtCount).toBe(vCount);
    expect(obj).toContain('usemtl');
  });
});
