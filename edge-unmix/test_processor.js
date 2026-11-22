/* Node 验证：用 samples/ 里的真实 PNG 检验 processor.js 的正确性。
   运行：node test_processor.js （无第三方依赖） */
"use strict";
const assert = require("assert");
const path = require("path");
const {
  unmixEdges,
  defaultSettings,
  FLAG_CLIPPED,
  FLAG_LOW_ALPHA,
} = require("./processor.js");
const { readPng } = require("./png_codec.js");

const dir = path.join(__dirname, "samples");
const clean = readPng(path.join(dir, "1_icon_clean.png"));
const mixed = readPng(path.join(dir, "2_icon_white_mixed.png"));
const hard = readPng(path.join(dir, "3_no_fix_needed.png"));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("  ✓ " + name);
}

console.log("1) 混白边样本去底色后应还原回干净样本");
{
  // 先关掉邻色填充做纯逆推：高 alpha 像素应精确还原；
  // 低 alpha 像素因量化误差被除法放大，误差随 alpha 减小而增大（不可信的根源）
  const { data, stats } = unmixEdges({
    width: mixed.width,
    height: mixed.height,
    src: mixed.data,
    settings: { ...defaultSettings(), lowAlphaThreshold: 40, lowAlphaMode: "keep" },
  });
  let maxDiffHigh = 0,
    maxDiffLow = 0,
    alphaChanged = 0,
    n = 0,
    boundViolations = 0,
    flaggedLow = 0;
  for (let p = 0; p < data.length / 4; p++) {
    const i = p * 4;
    const a = mixed.data[i + 3];
    if (a !== 255 && a !== 0) n++;
    if (data[i + 3] !== mixed.data[i + 3]) alphaChanged++;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(data[i + c] - clean.data[i + c]);
      if (a >= 96) maxDiffHigh = Math.max(maxDiffHigh, d);
      else if (a > 0) maxDiffLow = Math.max(maxDiffLow, d);
      // 理论边界：混色量化误差 ±0.5，逆推除以 a/255 → |Δ| ≤ 127.5/a
      // 仅约束真正参与逆推的像素（a>=阈值）；低 alpha 像素被刻意保留观测色
      if (a >= 40 && d > Math.ceil(127.5 / a)) boundViolations++;
    }
  }
  test("半透明像素数量与样本一致", () => assert.equal(n, stats.semiTransparent));
  test("所有 alpha 通道保持不变", () => assert.equal(alphaChanged, 0));
  test("alpha≥96 的像素 RGB 误差 ≤ 1（高可信区精确还原）", () => assert.ok(maxDiffHigh <= 1, "maxDiffHigh=" + maxDiffHigh));
  test("低 alpha 像素误差被除法放大（>1，量化误差 / a）", () => assert.ok(maxDiffLow > 1, "maxDiffLow=" + maxDiffLow));
  test("所有像素误差不超理论边界 ceil(127.5/a)", () => assert.equal(boundViolations, 0));
  for (let p = 0; p < data.length / 4; p++) {
    if (mixed.data[p * 4 + 3] < 40 && mixed.data[p * 4 + 3] > 0) flaggedLow++;
  }
  test("低 alpha 像素全部计入低可信统计", () => assert.equal(stats.lowAlphaKept + stats.lowAlphaFilled, flaggedLow));

  // 默认设置（邻色填充）：低可信像素改用高可信邻居的颜色，整体误差回到 ≤1
  const filled = unmixEdges({
    width: mixed.width,
    height: mixed.height,
    src: mixed.data,
    settings: defaultSettings(),
  });
  let maxDiffAll = 0;
  for (let i = 0; i < filled.data.length; i += 4) {
    for (let c = 0; c < 3; c++) maxDiffAll = Math.max(maxDiffAll, Math.abs(filled.data[i + c] - clean.data[i + c]));
  }
  test("邻色填充后全部像素 RGB 误差 ≤ 2（邻居自身舍入误差叠加）", () => assert.ok(maxDiffAll <= 2, "maxDiffAll=" + maxDiffAll));
}

console.log("2) 全不透明硬边图应逐字节原样输出");
{
  const { data, stats } = unmixEdges({
    width: hard.width,
    height: hard.height,
    src: hard.data,
    settings: defaultSettings(),
  });
  test("没有任何半透明像素被处理", () => assert.equal(stats.processed, 0));
  test("输出与输入完全相同", () => assert.deepEqual(Buffer.from(data), Buffer.from(hard.data)));
}

console.log("3) 完全不透明的真实白色高光在任何情况下都不动");
{
  for (const img of [clean, mixed, hard]) {
    const { data } = unmixEdges({
      width: img.width,
      height: img.height,
      src: img.data,
      settings: defaultSettings(),
    });
    let whiteOpaque = 0,
      changed = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (img.data[i + 3] === 255 && img.data[i] === 255 && img.data[i + 1] === 255 && img.data[i + 2] === 255) {
        whiteOpaque++;
        if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255 || data[i + 3] !== 255) changed++;
      }
    }
    test(`${img.width}x${img.height} 图中 ${whiteOpaque} 个不透明白像素全部保留`, () => assert.equal(changed, 0));
  }
}

console.log("4) 全透明像素保持透明");
{
  const { data } = unmixEdges({
    width: mixed.width,
    height: mixed.height,
    src: mixed.data,
    settings: defaultSettings(),
  });
  let bad = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (mixed.data[i + 3] === 0 && data[i + 3] !== 0) bad++;
  }
  test("没有透明像素被填上不透明度", () => assert.equal(bad, 0));
}

console.log("5) 强度 0 等于不处理");
{
  const { data } = unmixEdges({
    width: mixed.width,
    height: mixed.height,
    src: mixed.data,
    settings: { ...defaultSettings(), strength: 0 },
  });
  test("输出与输入逐字节相同", () => assert.deepEqual(Buffer.from(data), Buffer.from(mixed.data)));
}

console.log("6) 保护区像素完全跳过");
{
  const mask = new Uint8Array(mixed.width * mixed.height);
  const protectedIdx = [];
  for (let p = 0; p < mask.length; p++) {
    const a = mixed.data[p * 4 + 3];
    if (a > 0 && a < 255) {
      mask[p] = 255;
      protectedIdx.push(p);
      if (protectedIdx.length >= 10) break;
    }
  }
  const { data, stats } = unmixEdges({
    width: mixed.width,
    height: mixed.height,
    src: mixed.data,
    mask,
    settings: defaultSettings(),
  });
  test("保护区计数正确", () => assert.equal(stats.protectedPixels, protectedIdx.length));
  test("被保护像素与原图完全一致", () => {
    for (const p of protectedIdx) {
      for (let c = 0; c < 4; c++) assert.equal(data[p * 4 + c], mixed.data[p * 4 + c]);
    }
  });
}

console.log("7) 逆推越界时裁剪而非反色，并给出低可信标记");
{
  // 构造：白底混入后观测色为 (100,100,100)，alpha=128
  // 逆推 = (100 - 0.5*255)/0.5 = -55 → 必须裁到 0，不能出现负值/反转
  const src = new Uint8ClampedArray([100, 100, 100, 128]);
  const { data, flags } = unmixEdges({
    width: 1,
    height: 1,
    src,
    settings: { ...defaultSettings(), lowAlphaThreshold: 1 },
  });
  test("逆推负值被裁到 0", () => assert.deepEqual([data[0], data[1], data[2]], [0, 0, 0]));
  test("标记了 FLAG_CLIPPED", () => assert.ok(flags[0] & FLAG_CLIPPED));
  test("alpha 仍为 128", () => assert.equal(data[3], 128));
}

console.log("8) 低透明像素默认用高可信邻居颜色填充并标记低可信");
{
  // 2x1：左边不透明红 (200,30,30,255)；右边 a=8 的白边像素
  const src = new Uint8ClampedArray([200, 30, 30, 255, 240, 240, 240, 8]);
  const { data, flags, stats } = unmixEdges({
    width: 2,
    height: 1,
    src,
    settings: { ...defaultSettings(), lowAlphaThreshold: 40 },
  });
  test("低透明像素被标记 FLAG_LOW_ALPHA", () => assert.ok(flags[1] & FLAG_LOW_ALPHA));
  test("填充计数为 1", () => assert.equal(stats.lowAlphaFilled, 1));
  test("颜色被拉向邻居红色而非保留白边", () => {
    assert.ok(data[4] > 150 && data[5] < 100 && data[6] < 100, `R=${data[4]} G=${data[5]} B=${data[6]}`);
    assert.equal(data[7], 8);
  });
  // keep 模式下像素保持观测色
  const kept = unmixEdges({
    width: 2,
    height: 1,
    src,
    settings: { ...defaultSettings(), lowAlphaThreshold: 40, lowAlphaMode: "keep" },
  });
  test("keep 模式下观测色不变", () =>
    assert.deepEqual([kept.data[4], kept.data[5], kept.data[6]], [240, 240, 240]));
}

console.log("9) 干净图标本身被按白底处理会被改动（说明底色假设要选对）");
{
  const { data } = unmixEdges({
    width: clean.width,
    height: clean.height,
    src: clean.data,
    settings: { ...defaultSettings(), lowAlphaThreshold: 1 },
  });
  let changed = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (clean.data[i + 3] > 0 && clean.data[i + 3] < 255 && data[i] !== clean.data[i]) changed++;
  }
  test("半透明边缘确实发生了改动（错误假设的副作用可见）", () => assert.ok(changed > 0));
}

console.log(`\n全部 ${passed} 项验证通过`);
