/* 程序化生成相接的几块三角网格：
   - A 大块（粗网格 1m），B 窄条（细网格 0.1m，与 A 约 6:1 的尺寸差）
   - A/B 接边上有一条浮雕（正弦起伏），两块共用同一高度函数 => 原始坐标完全重合
   - C 小块与 B 在 x=1 相接（T 型接边，网格密度不同）
   - D 独立悬浮块，不与任何块接边（用于展示"接缝对齐"不会平白拉大范围）
   - A、B 内部各有一条 UV 贴图边界：位置相同的顶点为 UV 被复制成两份，
     用于验证"贴图边界不被误报为裂缝"。 */
(function (global) {
  const MPC = global.MPC;
  const { makeValueNoise2D, f32 } = MPC.util;

  function createHeightField(seed) {
    const noiseLo = makeValueNoise2D(seed + 101);
    const noiseHi = makeValueNoise2D(seed + 202);
    // 浮雕只作用在 A/B 接边 x=0 附近，沿 z 方向起伏
    function relief(x, z) {
      const w = Math.exp(-Math.pow(x / 0.8, 2));
      const r = 0.10 * Math.sin(2 * Math.PI * 1.5 * z) +
                0.04 * Math.sin(2 * Math.PI * 4.0 * z + 1.3);
      return w * r;
    }
    return function heightAt(x, z) {
      const base = 0.4 * noiseLo(x * 0.35 + 10, z * 0.35)
                 + 0.15 * noiseHi(x * 1.1, z * 1.1)
                 - 0.15 * x + 0.08 * z;
      return f32(base + relief(x, z));
    };
  }

  /* 构建一块规则网格。opts.uvSplitX: 若给定 x 坐标，该列顶点复制为两份（UV 接缝）。 */
  function buildGrid(opts) {
    const { id, name, x0, x1, z0, z1, nx, nz, heightAt, uvSplitX } = opts;
    const dx = (x1 - x0) / nx, dz = (z1 - z0) / nz;

    const positions = [];
    const uvs = [];
    const uvSeams = [];
    // idAt[gz][gx] => 普通顶点 id；接缝列返回 {left, right}
    const idAt = [];

    function pushVertex(x, z, u, v) {
      const y = heightAt(x, z);
      const id = positions.length / 3;
      positions.push(f32(x), y, f32(z));
      uvs.push(u, v);
      return id;
    }

    for (let gz = 0; gz <= nz; gz++) {
      idAt[gz] = [];
      const z = f32(z0 + gz * dz);
      const v = gz / nz;
      for (let gx = 0; gx <= nx; gx++) {
        const x = f32(x0 + gx * dx);
        const u = gx / nx;
        if (uvSplitX != null && Math.abs(x - f32(uvSplitX)) < 1e-6) {
          const left = pushVertex(x, z, u, v);            // 左侧三角形使用
          const right = pushVertex(x, z, 1 + u, v);      // 右侧三角形使用，u 跳到另一张纹理
          uvSeams.push({ a: left, b: right, x, y: positions[left * 3 + 1], z });
          idAt[gz][gx] = { left, right };
        } else {
          idAt[gz][gx] = pushVertex(x, z, u, v);
        }
      }
    }

    function cornerId(gz, gx, side) {
      const c = idAt[gz][gx];
      if (typeof c === 'number') return c;
      // side: 该单元格位于接缝列的哪一侧。gx 为接缝列时，
      // cell(gx-1) 在左、cell(gx) 在右。
      return side === 'left' ? c.left : c.right;
    }

    const indices = [];
    const splitGx = uvSplitX == null ? -1
      : Math.round((f32(uvSplitX) - x0) / dx);
    for (let gz = 0; gz < nz; gz++) {
      for (let gx = 0; gx < nx; gx++) {
        const leftOf = (gxCol) => (gxCol === splitGx ? (gx < splitGx ? 'left' : 'right') : 'any');
        const p00 = cornerId(gz, gx, leftOf(gx));
        const p10 = cornerId(gz, gx + 1, leftOf(gx + 1));
        const p11 = cornerId(gz + 1, gx + 1, leftOf(gx + 1));
        const p01 = cornerId(gz + 1, gx, leftOf(gx));
        indices.push(p00, p10, p11, p00, p11, p01);
      }
    }

    return {
      id, name, x0, x1, z0, z1, nx, nz,
      positions: Float32Array.from(positions),
      uvs: Float32Array.from(uvs),
      indices: Uint32Array.from(indices),
      uvSeams,
    };
  }

  // 在规则网格边上按 (x,z) 找顶点 id（用于登记块间接缝）
  function findVertex(block, x, z) {
    // 与 buildGrid 内部布局一致：逐列顺序 push，接缝列占两个 id
    let id = 0;
    for (let iz = 0; iz <= block.nz; iz++) {
      for (let ix = 0; ix <= block.nx; ix++) {
        const px = block.positions[id * 3], pz = block.positions[id * 3 + 2];
        if (Math.abs(px - x) < 1e-5 && Math.abs(pz - z) < 1e-5) return id;
        id++;
        // 跳过接缝列的第二个副本
        if (block.uvSeams.some(s => s.a === id - 1)) id++;
      }
    }
    return -1;
  }

  function pairAt(seam, blockA, blockB, x, z) {
    const va = findVertex(blockA, x, z);
    const vb = findVertex(blockB, x, z);
    if (va < 0 || vb < 0) throw new Error('接缝顶点查找失败: ' + x + ',' + z);
    const y = blockA.positions[va * 3 + 1];
    seam.pairs.push({ va, vb, x: f32(x), y, z: f32(z) });
  }

  function generateScene(seed) {
    seed = seed >>> 0;
    const heightAt = createHeightField(seed);

    // A: 6m × 6m 粗块；B: 1m × 6m 细条（宽度 6:1）；C: 1m × 1m 小块；D: 1.5m 独立块
    const A = buildGrid({ id: 0, name: 'A 粗块', x0: -6, x1: 0, z0: 0, z1: 6, nx: 6, nz: 6, heightAt, uvSplitX: -3 });
    const B = buildGrid({ id: 1, name: 'B 细条', x0: 0, x1: 1, z0: 0, z1: 6, nx: 10, nz: 60, heightAt, uvSplitX: 0.5 });
    const C = buildGrid({ id: 2, name: 'C 小块', x0: 1, x1: 2, z0: 0, z1: 1, nx: 5, nz: 5, heightAt });
    const D = buildGrid({ id: 3, name: 'D 独立块', x0: 3, x1: 4.5, z0: 2, z1: 3.5, nx: 8, nz: 8, heightAt });
    const blocks = [A, B, C, D];

    const seams = [];

    // 接缝 AB：x=0，z=0..6，A 间距 1m（7 点），B 间距 0.1m（61 点，含 T 接）
    const ab = { id: 'seam-AB', name: 'A/B 浮雕接边', blockA: 0, blockB: 1, axis: 'x=0', pairs: [], extraVertices: [] };
    for (let i = 0; i <= 6; i++) pairAt(ab, A, B, 0, i);
    for (let gz = 0; gz <= 60; gz++) {
      const z = f32(gz * 0.1);
      if (Math.abs(z - Math.round(z)) > 1e-5) ab.extraVertices.push({ block: 1, vertex: findVertex(B, 0, z), z });
    }
    seams.push(ab);

    // 接缝 BC：x=1，z=0..1，B 间距 0.1m（11 点），C 间距 0.2m（6 点）
    const bc = { id: 'seam-BC', name: 'B/C T 型接边', blockA: 1, blockB: 2, axis: 'x=1', pairs: [], extraVertices: [] };
    for (let j = 0; j <= 5; j++) pairAt(bc, B, C, 1, f32(j * 0.2));
    for (let gz = 0; gz <= 10; gz++) {
      const z = f32(gz * 0.1);
      if (Math.abs(z - Math.round(z * 5) / 5) > 1e-5) bc.extraVertices.push({ block: 1, vertex: findVertex(B, 1, z), z });
    }
    seams.push(bc);

    return {
      version: 1,
      seed,
      blocks,
      seams,
      // 真实几何接边（用于裂缝判定）；UV 接缝保存在各 block.uvSeams 中，二者严格分开
      generatedBy: 'mesh-precision-compare',
    };
  }

  MPC.meshgen = { generateScene, createHeightField, buildGrid, findVertex };
  if (typeof module !== 'undefined' && module.exports) module.exports = MPC;
})(typeof globalThis !== 'undefined' ? globalThis : this);
