/*
 * 无头测试（Node 直接运行，不依赖浏览器）：
 *   node tests/headless-test.js
 * 覆盖：预算分配的优先级降级、锁定重分配、硬约束诊断、ZIP/CRC32 正确性。
 * 浏览器专用 API（Canvas、Blob）在这里以最小桩件替代，被测算法代码不改动。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✕ ' + name + '\n    ' + e.message);
    process.exitCode = 1;
  }
}

/* ---------------- 加载浏览器脚本到共享沙箱 ---------------- */
function makeSandbox() {
  const sandbox = {
    console,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    Blob: class Blob {
      constructor(parts) { this.parts = parts; this.size = parts.reduce((s, p) => s + p.length, 0); }
    },
    TextEncoder, TextDecoder,
    setTimeout, clearTimeout
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ['js/util.js', 'js/zip.js', 'js/allocation.js', 'js/encoding.js'].forEach((rel) => {
    const code = fs.readFileSync(path.join(root, rel), 'utf8');
    vm.runInContext(code, sandbox, { filename: rel });
  });
  return sandbox;
}

/* ---------------- 构造候选夹具 ---------------- */
function makeCandidate(item, idx, scale, bytes, opts = {}) {
  return {
    id: item.id + '__c' + idx,
    label: (opts.format || 'WebP') + ' s' + scale,
    format: opts.format || 'WebP',
    quality: opts.quality === undefined ? 0.7 : opts.quality,
    scale,
    width: Math.round(item.width * scale),
    height: Math.round(item.height * scale),
    flattened: !!opts.flattened,
    hasOutputAlpha: item.hasAlpha && !opts.flattened,
    status: opts.status || 'ok',
    bytes: opts.status === 'fail' ? null : bytes,
    blob: opts.status === 'fail' ? null : { size: bytes },
    psnr: opts.psnr === undefined ? 40 - (1 - scale) * 20 : opts.psnr,
    violations: [],
    failReason: opts.status === 'fail' ? 'fail' : undefined
  };
}

function makeItem(spec) {
  const item = {
    id: spec.id,
    name: spec.name || spec.id,
    width: spec.width || 100,
    height: spec.height || 100,
    hasAlpha: !!spec.hasAlpha,
    priority: spec.priority || 'mid',
    keepAlpha: !!spec.keepAlpha,
    minW: spec.minW || 1,
    minH: spec.minH || 1,
    lockedPickId: null,
    candidates: []
  };
  // 5 个档位，字节随尺寸递增
  const scales = [0.25, 0.35, 0.5, 0.75, 1];
  scales.forEach((s, i) => {
    const bytes = Math.round(spec.unitBytes * s);
    item.candidates.push(makeCandidate(item, i, s, bytes,
      { format: i === scales.length - 1 ? 'PNG' : 'WebP', psnr: 30 + i * 6 }));
  });
  // 标记违规
  item.candidates.forEach((c) => {
    const v = [];
    if (c.width < item.minW || c.height < item.minH) v.push('低于最小尺寸');
    if (item.keepAlpha && c.flattened) v.push('透明通道被移除');
    c.violations = v;
  });
  return item;
}

/* =====================================================================
 * 分配算法测试
 * ===================================================================== */
const sbx = makeSandbox();
const { Allocator } = sbx;

console.log('分配算法：');

test('预算充足时每张图取最优可行候选', () => {
  const items = [
    makeItem({ id: 'a', name: 'A', unitBytes: 1000, priority: 'high' }),
    makeItem({ id: 'b', name: 'B', unitBytes: 800, priority: 'low' })
  ];
  const plan = Allocator.allocate(items, 100000);
  assert.strictEqual(plan.feasible, true);
  assert.strictEqual(plan.picks.get('a').scale, 1);
  assert.strictEqual(plan.picks.get('b').scale, 1);
});

test('超预算时先牺牲低优先级图片', () => {
  const items = [
    makeItem({ id: 'hi', name: '关键图', unitBytes: 1000, priority: 'high' }),
    makeItem({ id: 'lo', name: '背景图', unitBytes: 1000, priority: 'low' })
  ];
  // 最优档合计 2000，预算 1600：低优先级先降
  const plan = Allocator.allocate(items, 1600);
  assert.strictEqual(plan.feasible, true);
  assert.strictEqual(plan.picks.get('hi').scale, 1, '高优先级保持最优档');
  assert.ok(plan.picks.get('lo').scale < 1, '低优先级被降级');
  assert.ok(plan.total <= 1600);
});

test('低优先级压到底仍不够时才动高优先级', () => {
  const items = [
    makeItem({ id: 'hi', name: '关键图', unitBytes: 1000, priority: 'high' }),
    makeItem({ id: 'lo', name: '背景图', unitBytes: 1000, priority: 'low' })
  ];
  // 低档压到最低（250）后，再压高档一档（750）即可满足
  const plan = Allocator.allocate(items, 1050);
  assert.strictEqual(plan.feasible, true);
  assert.strictEqual(plan.picks.get('lo').scale, 0.25, '低优先级先被压到最低档');
  assert.ok(plan.picks.get('hi').scale < 1, '低优先级榨干后高优先级才开始降级');
  assert.ok(plan.total <= 1050);
});

test('锁定项不参与降级，并在诊断中说明多占空间', () => {
  const items = [
    makeItem({ id: 'a', name: 'A', unitBytes: 1000, priority: 'mid' }),
    makeItem({ id: 'b', name: 'B', unitBytes: 1000, priority: 'mid' })
  ];
  const midCand = items[0].candidates.find((c) => c.scale === 0.5);
  items[0].lockedPickId = midCand.id;
  const plan = Allocator.allocate(items, 1200);
  assert.strictEqual(plan.picks.get('a').id, midCand.id, '锁定候选保持不变');
  const diagA = plan.diagnosis.find((d) => d.itemId === 'a');
  assert.ok(diagA.locked && diagA.extra > 0, '诊断标注锁定多占字节');
  assert.ok(plan.total <= 1200 || !plan.feasible);
});

test('全部降到最低档仍超预算时给出不可行诊断与理论最低值', () => {
  const items = [
    makeItem({ id: 'a', name: 'A', unitBytes: 1000, priority: 'high' }),
    makeItem({ id: 'b', name: 'B', unitBytes: 1000, priority: 'low' })
  ];
  const plan = Allocator.allocate(items, 100); // 最低合计 500
  assert.strictEqual(plan.feasible, false);
  assert.strictEqual(plan.floorTotal, 500);
  assert.ok(plan.overrun > 0);
  assert.ok(plan.steps.some((s) => s.includes('最低可行档')));
});

test('最小尺寸约束使部分候选不可行，降级不会越过约束', () => {
  const item = makeItem({ id: 'a', name: 'A', unitBytes: 1000, minW: 60, minH: 60 });
  const plan = Allocator.allocate([item], 400);
  // 0.25/0.35/0.5 档（25/35/50px）违规，最低可行是 0.75 档（75px, 750B）
  assert.strictEqual(plan.feasible, false);
  assert.strictEqual(plan.picks.get('a').scale, 0.75);
  const diag = plan.diagnosis.find((d) => d.itemId === 'a');
  assert.strictEqual(diag.minBytes, 750);
});

test('要求保留透明时，flatten 候选被禁止', () => {
  const item = makeItem({ id: 'a', name: '图标', unitBytes: 500, hasAlpha: true, keepAlpha: true });
  item.candidates.forEach((c) => { c.flattened = true; c.hasOutputAlpha = false; c.violations = ['透明通道被移除']; });
  const plan = Allocator.allocate([item], 10000);
  assert.strictEqual(plan.feasible, false);
  const diag = plan.diagnosis[0];
  assert.ok(diag.reasons.some((r) => r.includes('透明')));
});

test('编码失败候选（null 字节）不会被选为方案', () => {
  const item = makeItem({ id: 'a', name: 'A', unitBytes: 1000 });
  item.candidates[0].status = 'fail';
  item.candidates[0].bytes = null;
  item.candidates[0].blob = null;
  const plan = Allocator.allocate([item], 300);
  // 最低档失败，次低档（350B）也超 300 → 不可行，但选中的绝不是失败档
  assert.strictEqual(plan.feasible, false);
  assert.notStrictEqual(plan.picks.get('a').status, 'fail');
  assert.ok(plan.picks.get('a').bytes > 0);
});

test('全部候选编码失败时明确报错而不是零字节成功', () => {
  const item = makeItem({ id: 'a', name: 'A', unitBytes: 1000 });
  item.candidates.forEach((c) => { c.status = 'fail'; c.bytes = null; c.blob = null; });
  const plan = Allocator.allocate([item], 999999);
  assert.strictEqual(plan.feasible, false);
  assert.ok(plan.blockers.length === 1);
  assert.ok(plan.diagnosis[0].reasons.some((r) => r.includes('编码失败')));
});

test('sacrificeInfo 能指出哪些图为腾空间被压糊', () => {
  const items = [
    makeItem({ id: 'hi', name: '关键', unitBytes: 1000, priority: 'high' }),
    makeItem({ id: 'lo', name: '背景', unitBytes: 1000, priority: 'low' })
  ];
  const plan = Allocator.allocate(items, 1500);
  const loSac = Allocator.sacrificeInfo(items[1], plan.picks.get('lo'));
  const hiSac = Allocator.sacrificeInfo(items[0], plan.picks.get('hi'));
  assert.ok(loSac && loSac.bytesSaved > 0, '低档图被标记为牺牲');
  assert.strictEqual(hiSac, null, '保持最优档的图不算牺牲');
});

/* =====================================================================
 * ZIP / CRC32 测试
 * ===================================================================== */
console.log('ZIP 打包：');

const { ZipWriter } = sbx;

test('CRC32 与 zlib 参考实现一致', () => {
  const samples = [Buffer.alloc(0), Buffer.from('hello'), Buffer.from('游戏更新包 image budget'),
    Buffer.alloc(1000, 0x7a)];
  samples.forEach((buf) => {
    const expected = zlib.crc32 ? zlib.crc32(buf) >>> 0 : null;
    if (expected !== null) {
      assert.strictEqual(ZipWriter.crc32(new Uint8Array(buf)), expected);
    }
  });
  // 固定向量兜底（不依赖 Node 版本是否暴露 zlib.crc32）
  assert.strictEqual(ZipWriter.crc32(new Uint8Array(Buffer.from('123456789'))), 0xcbf43926);
  assert.strictEqual(ZipWriter.crc32(new Uint8Array(0)), 0x00000000);
});

test('生成的 ZIP 可被系统 unzip 正确解包且字节一致', () => {
  const os = require('os');
  const { execFileSync } = require('child_process');
  // 与应用导出一致：ZIP 条目名 ASCII 安全，原始名保留在清单中
  const asciiSafe = (name) => name.replace(/[^A-Za-z0-9._-]/g, (ch) =>
    '_u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  const rawFiles = [
    { name: 'a.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]) },
    { name: '中文目录/b.webp', bytes: new Uint8Array(Array.from({ length: 300 }, (_, i) => i % 256)) },
    { name: '清单.csv', bytes: new TextEncoder().encode('名称,大小\r\nx,300') }
  ];
  const files = rawFiles.map((f) => ({ name: asciiSafe(f.name), bytes: f.bytes }));
  const blob = ZipWriter.buildZip(files);
  const parts = blob.parts.map((p) => Buffer.from(p));
  const zipBuf = Buffer.concat(parts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-test-'));
  const zipPath = path.join(dir, 'out.zip');
  fs.writeFileSync(zipPath, zipBuf);
  execFileSync('/usr/bin/unzip', ['-q', zipPath, '-d', dir]);
  files.forEach((f) => {
    const out = fs.readFileSync(path.join(dir, f.name));
    assert.deepStrictEqual(new Uint8Array(out), f.bytes, f.name + ' 解包内容一致');
  });
});

test('ASCII 安全转写可逆且避免条目名冲突', () => {
  const asciiSafe = (name) => name.replace(/[^A-Za-z0-9._-]/g, (ch) =>
    '_u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  assert.strictEqual(asciiSafe('icon-gem.png'), 'icon-gem.png');
  assert.strictEqual(asciiSafe('标题图.png'), '_u6807_u9898_u56fe.png');
  assert.ok(/^[A-Za-z0-9._/-]+$/.test(asciiSafe('中文目录/b.webp')));
  // 两个不同中文名不会转写成同一条目名
  assert.notStrictEqual(asciiSafe('图一.png'), asciiSafe('图二.png'));
});

test('ZIP 中央目录偏移与文件大小自洽', () => {
  const files = [{ name: 'x.bin', bytes: new Uint8Array(123).fill(7) }];
  const blob = ZipWriter.buildZip(files);
  const buf = Buffer.concat(blob.parts.map((p) => Buffer.from(p)));
  // EOCD 签名在尾部
  assert.strictEqual(buf.readUInt32LE(buf.length - 22), 0x06054b50);
  const totalEntries = buf.readUInt16LE(buf.length - 22 + 10);
  assert.strictEqual(totalEntries, 1);
  const cdSize = buf.readUInt32LE(buf.length - 22 + 12);
  const cdOffset = buf.readUInt32LE(buf.length - 22 + 16);
  assert.strictEqual(cdOffset + cdSize, buf.length - 22);
});

console.log('\n通过 ' + passed + ' 项测试' + (process.exitCode ? '，存在失败' : ''));
