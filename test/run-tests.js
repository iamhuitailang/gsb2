/*
 * Node 自测：解析器 / LZW 往返 / 合成器处置方式 / 随机跳帧一致性 / 截断容错 / 时间清单。
 * 运行：node test/run-tests.js
 */
'use strict';
const GifCore = require('../js/gif.js');
const GifEncoder = require('../js/encoder.js');

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
function px(buf, W, x, y) {
  const o = (y * W + x) * 4;
  return [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]];
}
function eqPx(a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]; }

// ---------- 1. LZW 往返 ----------
console.log('\n[1] LZW 编码/解码往返');
{
  // 用足够长且多变的索引序列触发字典增长与升位
  const n = 5000;
  const src = new Uint8Array(n);
  let s = 7;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; src[i] = s % 8; }
  const enc = GifEncoder.lzwEncode(3, src);
  // 通过完整 GIF 往返验证（lzwDecode 未导出）
  const gif = GifEncoder.encodeGif({
    width: 100, height: 50, palette: [[0,0,0],[1,1,1],[2,2,2],[3,3,3],[4,4,4],[5,5,5],[6,6,6],[7,7,7]],
    loop: null,
    frames: [{ left: 0, top: 0, width: 100, height: 50, indices: src, delayCs: 1, disposal: 0, transparentIndex: null }],
  });
  const parsed = GifCore.parseGif(gif);
  ok(parsed.frames.length === 1, '单帧解析');
  let same = parsed.frames[0].pixels.length === src.length;
  if (same) for (let i = 0; i < n; i++) if (parsed.frames[0].pixels[i] !== src[i]) { same = false; break; }
  ok(same, '5000 像素索引往返一致');
  ok(parsed.frames[0].decodeComplete, '解码完整');
}

// ---------- 2. 样例结构解析 ----------
console.log('\n[2] 样例1结构解析');
const sample1 = GifEncoder.buildSampleDisposalMix();
const p1 = GifCore.parseGif(sample1.bytes);
{
  ok(p1.frames.length === 6, '6 帧', '实际 ' + p1.frames.length);
  ok(p1.width === 64 && p1.height === 64, '画布 64x64');
  ok(p1.loopCount === 0, '无限循环 (loop=0)');
  ok(!p1.truncated, '未截断');
  const f = p1.frames;
  ok(f[1].left === 8 && f[1].top === 8 && f[1].width === 16, '帧1区域 (8,8,16,16)');
  ok(f[1].transparentFlag && f[1].transparentIndex === 7, '帧1透明色索引 7');
  ok(f[2].disposal === 2, '帧2处置=恢复背景');
  ok(f[3].disposal === 3, '帧3处置=恢复此前画面');
  ok(f[4].delayCs === 0, '帧4零时长');
  ok(f[5].disposal === 2 && f[5].width === 64, '帧5全帧+恢复背景');
}

// ---------- 3. 合成器：处置方式语义 ----------
console.log('\n[3] 合成器处置方式语义');
{
  const comp = GifCore.createCompositor(p1);
  const W = 64;
  const out1 = comp.renderFrame(1);
  // 帧1中心是绿色不透明
  ok(eqPx(px(out1, W, 16, 16), [46, 204, 113, 255]), '帧1中心绿色合成');
  // 帧1角落是透明色 -> 露出帧0底图（底图 (8,8) 处 (x+y)%16==0 为白色）
  ok(eqPx(px(out1, W, 8, 8), [255, 255, 255, 255]), '帧1透明圆角露出底图');

  const out3 = comp.renderFrame(3);
  // 帧1是“保留”：绿块在帧3时仍在
  ok(eqPx(px(out3, W, 16, 16), [46, 204, 113, 255]), '帧1(保留)绿块在帧3时仍可见');
  // 帧2自身是“恢复背景”：它自己的红块区域在帧3前被清为透明（帧2用了透明色）
  ok(px(out3, W, 44, 20)[3] === 0, '帧2(恢复背景)自身区域已清为透明');

  const out4 = comp.renderFrame(4);
  // 帧3是“恢复为此前画面”：帧4时黄块消失，回到帧3绘制前（即帧0底图，(28+46)%16!=0 为深色）
  ok(eqPx(px(out4, W, 28, 46), [32, 36, 44, 255]), '帧3(恢复此前)后，黄块区域复原为底图');
  // 帧4紫块可见
  ok(eqPx(px(out4, W, 48, 48), [155, 89, 182, 255]), '帧4紫块可见');
}

// ---------- 4. 随机跳帧 == 顺序播放 ----------
console.log('\n[4] 随机跳帧与顺序播放一致');
{
  // 顺序播放
  const seq = GifCore.createCompositor(p1);
  const seqOut = [];
  for (let i = 0; i < p1.frames.length; i++) seqOut.push(seq.renderFrame(i).slice());
  // 随机访问：每个帧都用全新合成器直接跳
  let allSame = true;
  const order = [5, 0, 3, 1, 4, 2, 5, 3, 0];
  const rnd = GifCore.createCompositor(p1);
  const byIndex = new Map();
  for (const n of order) if (!byIndex.has(n)) byIndex.set(n, rnd.renderFrame(n).slice());
  for (let i = 0; i < p1.frames.length; i++) {
    const a = seqOut[i], b = byIndex.get(i);
    if (!b || a.length !== b.length) { allSame = false; break; }
    for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) { allSame = false; break; }
    if (!allSame) break;
  }
  ok(allSame, '乱序跳转结果与顺序播放逐字节一致');

  // 样例2（恢复链）也验证一遍
  const p2 = GifCore.parseGif(GifEncoder.buildSampleRestoreChain().bytes);
  const s2 = GifCore.createCompositor(p2);
  const seq2 = [];
  for (let i = 0; i < p2.frames.length; i++) seq2.push(s2.renderFrame(i).slice());
  const r2 = GifCore.createCompositor(p2);
  let same2 = true;
  for (const n of [3, 1, 2, 0, 3]) {
    const b = r2.renderFrame(n);
    const a = seq2[n];
    for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) { same2 = false; break; }
    if (!same2) break;
  }
  ok(same2, '样例2（恢复链）乱序一致');
}

// ---------- 5. 截断文件容错 ----------
console.log('\n[5] 截断文件容错');
{
  const t = GifEncoder.buildSampleTruncated();
  const pt = GifCore.parseGif(t.bytes);
  ok(pt.truncated, '标记为截断');
  ok(pt.frames.length >= 2, '保留截断前已读出的帧', '实际 ' + pt.frames.length);
  ok(pt.warnings.length > 0, '产生警告');
  let renders = true;
  try {
    const c = GifCore.createCompositor(pt);
    for (let i = 0; i < pt.frames.length; i++) c.renderFrame(i);
  } catch (e) { renders = false; console.error(e); }
  ok(renders, '截断文件的所有已解析帧可正常合成');
}

// ---------- 6. 时间轴与清单 ----------
console.log('\n[6] 时间轴与导出清单');
{
  const tl = GifCore.buildTimeline(p1);
  ok(tl.hasLoopSeam, '存在循环接缝（无限循环）');
  ok(tl.frames[4].zeroDelay, '零时长帧已标记');
  ok(tl.frames[4].playMs === 100, '零时长帧预览按 100ms 播放');
  ok(tl.frames[4].delayMsRaw === 0, '清单保留原始 0ms');
  ok(tl.totalPlayMs === 50*10 + 20*10*3 + 100 + 40*10, '预览总时长正确', '实际 ' + tl.totalPlayMs);
  const m = GifCore.buildTimingManifest(p1, 'sample1.gif');
  ok(m.frames[4].delayCs === 0 && m.frames[4].previewPlayMs === 100, '清单同时保留原始与归一化时长');
  const csv = GifCore.manifestToCSV(m);
  ok(csv.split('\n').length === 6 + 2, 'CSV 行数正确');
  const tl2 = GifCore.buildTimeline(GifCore.parseGif(GifEncoder.buildSampleRestoreChain().bytes));
  ok(tl2.loops === 2 && tl2.hasLoopSeam, '有限循环次数=2 且有接缝');
}

// ---------- 7. 本帧局部数据 ----------
console.log('\n[7] 本帧局部数据（未合成）');
{
  const comp = GifCore.createCompositor(p1);
  const raw = comp.rawFrameRGBA(1);
  ok(raw.length === 16 * 16 * 4, '局部帧尺寸 16x16');
  // 中心绿、角落透明
  const c = (16 * 8 + 8) * 4;
  ok(raw[c] === 46 && raw[c + 3] === 255, '局部帧中心绿色不透明');
  ok(raw[3] === 0, '局部帧角落透明（alpha=0）');
}

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
