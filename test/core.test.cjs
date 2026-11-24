/* Node 测试：node test/core.test.cjs
   覆盖网格生成接缝一致性、三种范围模式、UV 边界不被误报、
   二进制往返复现、截断/坏版本/CSS 错误的具体提示。 */
const assert = require('assert');
require('../js/util.js');
require('../js/meshgen.js');
require('../js/quantize.js');
require('../js/binary.js');
const MPC = global.MPC;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.stack); process.exitCode = 1; }
}
const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);

const scene = MPC.meshgen.generateScene(20261125);

test('生成 4 块网格且尺寸差别明显（A 宽 6m，B 宽 1m，6:1）', () => {
  assert.strictEqual(scene.blocks.length, 4);
  const A = scene.blocks[0], B = scene.blocks[1];
  assert.strictEqual(A.x1 - A.x0, 6);
  assert.strictEqual(B.x1 - B.x0, 1);
  // 大块网格粗（7×7），细条网格密（11×61）：尺寸与密度反差
  assert.strictEqual(A.nx, 6);
  assert.strictEqual(B.nx, 10);
  assert.ok(B.positions.length > A.positions.length);
});

test('接缝两侧原始位置完全重合（浮雕边与 T 型边）', () => {
  for (const seam of scene.seams) {
    const A = scene.blocks[seam.blockA], B = scene.blocks[seam.blockB];
    for (const p of seam.pairs) {
      for (let a = 0; a < 3; a++) {
        assert.strictEqual(A.positions[p.va * 3 + a], B.positions[p.vb * 3 + a]);
      }
    }
  }
});

test('同种子重新生成逐字节一致（确定性）', () => {
  const again = MPC.meshgen.generateScene(20261125);
  for (let i = 0; i < scene.blocks.length; i++) {
    assert.ok(scene.blocks[i].positions.every((v, k) => v === again.blocks[i].positions[k]));
  }
});

test('不同种子产生不同几何', () => {
  const other = MPC.meshgen.generateScene(42);
  // x/z 是规则网格坐标与种子无关，高度 y 来自噪声 => 比 y
  assert.notStrictEqual(scene.blocks[0].positions[1], other.blocks[0].positions[1]);
});

test('UV 贴图边界：复制顶点位置相同、UV 不同', () => {
  const A = scene.blocks[0];
  assert.ok(A.uvSeams.length > 0);
  for (const s of A.uvSeams) {
    for (let a = 0; a < 3; a++) assert.strictEqual(A.positions[s.a * 3 + a], A.positions[s.b * 3 + a]);
    assert.notStrictEqual(A.uvs[s.a * 2], A.uvs[s.b * 2]);
  }
});

test('接缝分析与 UV 边界严格分开：UV 复制顶点不进入任何几何接缝表', () => {
  const pack = MPC.quantize.packScene(scene, 'perBlock', 8, 0.01);
  // 几何接缝只引用块间顶点对；UV 边界保存在 block.uvSeams，分析结果单独成表
  assert.strictEqual(pack.seamReport.uvChecks.length, 4);
  assert.strictEqual(pack.seamReport.seams.length, scene.seams.length);
  // uvChecks 独立存在，且量化不改变同位顶点（同块同范围同坐标 => 同码）
  for (const u of pack.seamReport.uvChecks) {
    assert.strictEqual(u.maxCopyDistance, 0, 'UV 复制顶点位置差必须为 0');
  }
  // 有 UV 接缝的块（A、B）确实包含复制顶点对，证明该检查覆盖了贴图边界
  const uvBlockCounts = pack.seamReport.uvChecks.filter(u => u.count > 0).map(u => u.blockId);
  assert.deepStrictEqual(uvBlockCounts, [0, 1]);
});

test('整组统一范围：所有块共用一个范围，接边可能错位', () => {
  const pack = MPC.quantize.packScene(scene, 'global', 8, 0.01);
  assert.strictEqual(pack.ranges.length, 1);
  assert.ok(new Set(pack.blockRangeId).size === 1);
});

test('各块单独范围：8 位时浮雕接边出现非零错位（裂缝被检出）', () => {
  const pack = MPC.quantize.packScene(scene, 'perBlock', 8, 0.01);
  assert.strictEqual(pack.ranges.length, 4);
  const maxGap = pack.seamReport.globalMaxGap;
  assert.ok(maxGap > 0, '逐块 8 位应当产生裂缝，实际最大错位 ' + maxGap);
  const ab = pack.seamReport.seams.find(s => s.id === 'seam-AB');
  assert.ok(ab.maxGap > 0);
});

test('保持接缝对齐：共享顶点错位恒为 0，独立块 D 保持独立范围', () => {
  const pack = MPC.quantize.packScene(scene, 'aligned', 8, 0.01);
  // 接缝上成对存在的共享顶点：同坐标同范围同码 => 错位严格为 0
  for (const s of pack.seamReport.seams) assert.strictEqual(s.maxGap, 0, s.id + ' 共享顶点必须零错位');
  // T 接顶点在另一侧没有对应顶点（落在两点之间），只能量到插值距离，单独统计
  assert.ok(pack.seamReport.seams.every(s => typeof s.maxTGap === 'number'));
  // A,B,C 同分量共用范围；D 独立
  assert.strictEqual(pack.ranges.length, 2);
  assert.strictEqual(pack.blockRangeId[3], 1);
  assert.notStrictEqual(pack.blockRangeId[0], pack.blockRangeId[3]);
  // 对齐模式与 global 不同：D 用自身小范围，精度更好
  const errAlignedD = pack.errors[3].max;
  const packG = MPC.quantize.packScene(scene, 'global', 8, 0.01);
  assert.ok(errAlignedD <= packG.errors[3].max);
});

test('对齐模式 T 接：曲率基线与量化增量分开，增量与逐块模式同量级', () => {
  const a = MPC.quantize.packScene(scene, 'aligned', 8, 0.01);
  const p = MPC.quantize.packScene(scene, 'perBlock', 8, 0.01);
  const g = MPC.quantize.packScene(scene, 'global', 8, 0.01);
  for (let i = 0; i < a.seamReport.seams.length; i++) {
    const sa = a.seamReport.seams[i], sp = p.seamReport.seams[i];
    // 原始地形是曲面，T 接点到粗网格弦线本就有非零基线距离
    assert.ok(sa.worstT.baseline > 0);
    // 量化增量 = 还原后弦距 - 原始弦距，应远小于总弦距（说明大头是几何曲率不是量化）
    assert.ok(sa.maxTGapDelta < sa.maxTGap);
    // 共享量化网格不会把 T 接增量恶化到另一个数量级（2 倍 + 一个步长余量）
    assert.ok(sa.maxTGapDelta <= sp.maxTGapDelta * 2 + 0.02,
      `aligned ${sa.maxTGapDelta} vs perBlock ${sp.maxTGapDelta}`);
  }
  // 三种模式报告的 T 接总距离都以同一条原始基线为底
  assert.ok(Math.abs(a.seamReport.seams[0].worstT.baseline -
    p.seamReport.seams[0].worstT.baseline) < 1e-12);
  // global 与 aligned 共享顶点都是 0，但 aligned 的独立块 D 误差更小（前面已验证范围分离）
  assert.strictEqual(g.seamReport.sharedMaxGap, 0);
});

test('16 位时 T 接量化增量很小，只剩几何曲率基线；8 位增量明显更大', () => {
  const p16 = MPC.quantize.packScene(scene, 'perBlock', 16, 0.01);
  const p8 = MPC.quantize.packScene(scene, 'perBlock', 8, 0.01);
  for (let i = 0; i < p16.seamReport.seams.length; i++) {
    const s16 = p16.seamReport.seams[i], s8 = p8.seamReport.seams[i];
    // 16 位步长约 1e-4~1e-5，T 接增量应小于 1e-3
    assert.ok(s16.maxTGapDelta < 1e-3, '16 位 T 接量化增量应很小，实际 ' + s16.maxTGapDelta);
    assert.ok(s16.maxTGap >= s16.worstT.baseline - 1e-6);
    // 8 位比 16 位粗 256 倍，增量必须显著放大
    assert.ok(s8.maxTGapDelta > s16.maxTGapDelta * 10);
  }
});

test('位数越高误差越小（逐块模式 8 vs 16）', () => {
  const p8 = MPC.quantize.packScene(scene, 'perBlock', 8, 0.01);
  const p16 = MPC.quantize.packScene(scene, 'perBlock', 16, 0.01);
  assert.ok(p16.overall.max < p8.overall.max);
});

test('字节核算：10/12 位紧凑打包确实比 f32 省，且数值为整数', () => {
  for (const bits of [8, 10, 12, 16]) {
    const pack = MPC.quantize.packScene(scene, 'perBlock', bits, 0.01);
    const acc = MPC.binary.byteAccounting(scene, pack);
    assert.ok(acc.total > 0 && Number.isInteger(acc.total));
    assert.strictEqual(acc.codeBytes, Math.ceil(acc.totalVerts * 3 * bits / 8));
    if (bits < 32) assert.ok(acc.codeBytes < acc.f32PosOnly);
  }
});

test('二进制导出→读回：场景、量化码、范围、接缝全部复现', () => {
  const pack = MPC.quantize.packScene(scene, 'perBlock', 10, 0.01);
  const bytes = MPC.binary.encode(scene, pack, { threshold: 0.01 });
  const dec = MPC.binary.decode(bytes);
  assert.strictEqual(dec.bits, 10);
  assert.strictEqual(dec.mode, 'perBlock');
  assert.strictEqual(dec.scene.blocks.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.ok(dec.scene.blocks[i].positions.every((v, k) => v === scene.blocks[i].positions[k]));
    assert.ok(dec.codesPerBlock[i].every((v, k) => v === pack.qBlocks[i].codes[k]));
  }
  assert.strictEqual(dec.scene.seams.length, 2);
  assert.deepStrictEqual(dec.ranges, pack.ranges);
  assert.ok(dec.warnings.length === 0);
});

test('读回后按文件参数重新打包：接缝最大错位与导出前一致', () => {
  const pack = MPC.quantize.packScene(scene, 'perBlock', 8, 0.01);
  const bytes = MPC.binary.encode(scene, pack, { threshold: 0.01 });
  const dec = MPC.binary.decode(bytes);
  const repack = MPC.quantize.packScene(dec.scene, 'perBlock', 8, 0.01);
  approx(repack.seamReport.globalMaxGap, pack.seamReport.globalMaxGap, 1e-9);
});

test('CRC32 已知向量', () => {
  assert.strictEqual(MPC.util.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('截断文件：报具体不完整提示且带偏移，不抛裸异常', () => {
  const pack = MPC.quantize.packScene(scene, 'global', 12, 0.01);
  const bytes = MPC.binary.encode(scene, pack, { threshold: 0.01 });
  const cut = bytes.subarray(0, Math.floor(bytes.length * 0.6));
  assert.throws(() => MPC.binary.decode(cut), (e) => {
    return e.name === 'DecodeError' && /不完整|截断|MEND/.test(e.message) && e.offset != null;
  });
});

test('过短文件：给出文件头都放不下的提示', () => {
  assert.throws(() => MPC.binary.decode(new Uint8Array([1, 2, 3])), /文件头/);
});

test('魔数错误：提示不是本工具文件', () => {
  const bad = new Uint8Array(64);
  assert.throws(() => MPC.binary.decode(bad), /魔数/);
});

test('不支持的版本号：报版本并指明支持范围', () => {
  const pack = MPC.quantize.packScene(scene, 'global', 12, 0.01);
  const bytes = MPC.binary.encode(scene, pack, { threshold: 0.01 });
  const dv = new DataView(bytes.buffer);
  dv.setUint16(4, 99, true); // 魔数之后是版本
  assert.throws(() => MPC.binary.decode(bytes), /v99[\s\S]*v1/);
});

test('CRC 损坏但结构完整：返回数据并带校验警告，预览数据仍可用', () => {
  const pack = MPC.quantize.packScene(scene, 'aligned', 12, 0.01);
  const bytes = MPC.binary.encode(scene, pack, { threshold: 0.01 });
  bytes[20] ^= 0xff; // 破坏主体一字节，MEND 仍在
  const dec = MPC.binary.decode(bytes);
  assert.ok(dec.warnings.some(w => /CRC/.test(w)));
  assert.strictEqual(dec.scene.blocks.length, 4); // 数据仍可取用
});

test('紧凑位打包往返：10 位/12 位码经 BitWriter/BitReader 位级还原', () => {
  for (const bits of [8, 10, 12, 16]) {
    const bw = new MPC.binary.BitWriter();
    const max = (1 << bits) - 1;
    const vals = [0, 1, 2, max, max >> 1, 7, max - 3];
    for (const v of vals) bw.write(v, bits);
    const packed = bw.finish();
    const br = new MPC.binary.BitReader(packed);
    for (const v of vals) assert.strictEqual(br.read(bits), v);
  }
});

test('T 接顶点被登记且数量正确（AB: 54，BC: 5）', () => {
  const ab = scene.seams.find(s => s.id === 'seam-AB');
  const bc = scene.seams.find(s => s.id === 'seam-BC');
  assert.strictEqual(ab.extraVertices.length, 54);
  assert.strictEqual(bc.extraVertices.length, 5);
});

console.log(`\n${passed} 项测试通过`);
if (process.exitCode) console.error('存在失败用例');
