// 冒烟测试：直接加载编译产物 dist/app.js（命名空间挂在 globalThis.SamplerLab）
// 用法：npm run build && node tools/smoke.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 最小 DOM/Canvas 垫片，仅满足类型存在；冒烟测试不触碰渲染层
global.HTMLCanvasElement = class {};
global.HTMLElement = class {};
global.ImageData = class {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
};
// App 只在 DOMContentLoaded 时实例化，垫片吞掉监听即可
global.window = { addEventListener: () => undefined };

const code = fs.readFileSync(path.join(__dirname, '..', 'dist', 'app.js'), 'utf8');
vm.runInThisContext(code);
const S = globalThis.SamplerLab;

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

// ---------- 1. 共享边：任何采样点不重不漏 ----------
{
  console.log('[共享边] 两个 CCW 三角形共用 x=5.5 竖边');
  const scene = S.PRESETS.find((p) => p.id === 'shared').build();
  const out = S.rasterize(scene);
  let holes = 0;
  let doubles = 0;
  for (const row of out.pixels) {
    for (const px of row) {
      for (const s of px.samples) {
        if (s.candidates.length === 0 && s.winnerId !== null) holes++;
        if (s.candidates.length > 1) doubles++;
      }
    }
  }
  check('无采样点被多个面同时覆盖', doubles === 0, `doubles=${doubles}`);
  check('无空洞（背景点 winner 也是背景）', holes === 0, `holes=${holes}`);
  check('检测到 1 条共享边且方向相反', out.sharedEdges.length >= 1 && out.sharedEdges.every((e) => e.oppositeDirection));
  // 边界像素 x=5：靠近竖边的点应归右侧蓝三角或左侧红三角，且两边都有非背景像素
  const leftHas = out.pixels.some((row) => row[5].coveredCount > 0);
  check('边界列存在覆盖像素', leftHas);
}

// ---------- 2. 反向顶点顺序会被归一化，覆盖结果与正向一致 ----------
{
  console.log('[绕序] CW 输入自动归一化');
  const a = S.PRESETS.find((p) => p.id === 'overlap').build();
  const b = S.cloneScene(a);
  // 交换第一个三角形的两个顶点 -> CW
  const t = b.triangles[0];
  [t.v[1], t.v[2]] = [t.v[2], t.v[1]];
  const oa = S.rasterize(a);
  const ob = S.rasterize(b);
  check('CW 被标记为 reversed-winding', ob.diagnoses.get(b.triangles[0].id).kind === 'reversed-winding');
  let same = true;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      for (let i = 0; i < 4; i++) {
        if (oa.pixels[y][x].samples[i].winnerId !== ob.pixels[y][x].samples[i].winnerId) same = false;
      }
    }
  }
  check('CW 归一化后逐采样点胜者与 CCW 完全一致', same);
}

// ---------- 3. 退化 / 重复顶点 ----------
{
  console.log('[退化] 零面积与重复顶点被剔除');
  const scene = S.PRESETS.find((p) => p.id === 'thin').build();
  scene.triangles[0].v = [S.v2(1, 1), S.v2(1, 1), S.v2(4, 4)];
  let out = S.rasterize(scene);
  check('重复顶点诊断为 duplicate-vertex', out.diagnoses.get(scene.triangles[0].id).kind === 'duplicate-vertex');
  scene.triangles[0].v = [S.v2(1, 1), S.v2(2, 2), S.v2(3, 3.0000000001)];
  out = S.rasterize(scene);
  check('近零面积诊断为 degenerate-area', out.diagnoses.get(scene.triangles[0].id).kind === 'degenerate-area');
  const covered = out.pixels.flat().filter((p) => p.samples.some((s) => s.winnerId === scene.triangles[0].id)).length;
  check('退化三角形不产生任何覆盖', covered === 0);
}

// ---------- 4. 深度测试 ----------
{
  console.log('[深度] 交换深度后斜边像素胜者翻转');
  const scene = S.PRESETS.find((p) => p.id === 'overlap').build();
  const before = S.rasterize(scene);
  const [t0, t1] = scene.triangles;
  const overlapPx = before.pixels
    .flat()
    .find((p) => p.samples.some((s) => s.candidates.length >= 2));
  check('存在双候选交叠采样点', !!overlapPx);
  if (overlapPx) {
    const sample = overlapPx.samples.find((s) => s.candidates.length >= 2);
    check('初始胜者为 depth 更小的红三角', sample.winnerId === t0.id);
    const d0 = t0.depth;
    t0.depth = t1.depth + 0.2;
    t1.depth = d0 - 0.1;
    const after = S.rasterize(scene);
    const s2 = after.pixels[overlapPx.py][overlapPx.px].samples[sample.index];
    check('交换深度后胜者翻转为青三角', s2.winnerId === t1.id);
  }
}

// ---------- 5. 两种混合在深背景上确实不同 ----------
{
  console.log('[混合] 存储值混合 vs 线性混合');
  const scene = S.PRESETS.find((p) => p.id === 'thin').build();
  scene.sampleMode = 'msaa4';
  const out = S.rasterize(scene);
  const edge = out.pixels
    .flat()
    .find((p) => p.coveredCount > 0 && p.coveredCount < 4);
  check('存在部分覆盖的边缘像素', !!edge);
  if (edge) {
    const d = S.channelDelta(edge.blendedStored, edge.blendedLinear);
    const mag = Math.abs(d.dr) + Math.abs(d.dg) + Math.abs(d.db);
    check('两种混合结果存在可量化差异', mag > 0, `delta=${JSON.stringify(d)}`);
    // sRGB 编码为凹函数，Jensen 不等式：线性空间平均后再编码 >= 编码值直接平均
    // 即暗背景上线性混合的相对亮度严格更高（边缘不会像直接平均那样被压暗发灰）
    const lumStore = S.relativeLuminance(edge.blendedStored);
    const lumLin = S.relativeLuminance(edge.blendedLinear);
    check('线性混合结果相对亮度高于存储值混合（凹函数 Jensen 方向）', lumLin > lumStore, `${lumLin} vs ${lumStore}`);
  }
}

// ---------- 6. 中心采样 vs MSAA 覆盖率 ----------
{
  console.log('[采样模式] 薄三角在 MSAA 下覆盖像素更多');
  const scene = S.PRESETS.find((p) => p.id === 'thin').build();
  scene.sampleMode = 'center';
  const center = S.rasterize(scene);
  scene.sampleMode = 'msaa4';
  const msaa = S.rasterize(scene);
  const count = (o) => o.pixels.flat().filter((p) => p.coveredCount > 0).length;
  check('MSAA 命中像素数不少于中心采样', count(msaa) >= count(center), `${count(msaa)} vs ${count(center)}`);
}

// ---------- 7. 重放确定性 ----------
{
  console.log('[重放] 录制-回放与逐次平移结果一致');
  const scene = S.PRESETS.find((p) => p.id === 'thin').build();
  S.beginTrack(scene);
  for (let i = 0; i < 7; i++) S.recordMove(scene, scene.triangles[0].id, 0.13, -0.07);
  const expected = JSON.stringify(scene.triangles[0].v);
  S.replayToFrame(scene, 0);
  check('回到第 0 帧等于基底', JSON.stringify(scene.triangles[0].v) === JSON.stringify(scene.track.base[0].v));
  S.replayToFrame(scene, 7);
  check('回放 7 步后顶点与录制结束态一致', JSON.stringify(scene.triangles[0].v) === expected);
  S.replayToFrame(scene, 3);
  const at3 = JSON.stringify(scene.triangles[0].v);
  S.replayToFrame(scene, 7);
  S.replayToFrame(scene, 3);
  check('随机跳转后再回放结果稳定', JSON.stringify(scene.triangles[0].v) === at3);
}

// ---------- 8. 记录保存与复现 ----------
{
  console.log('[记录] 序列化 -> 复现校验全通过');
  const scene = S.PRESETS.find((p) => p.id === 'overlap').build();
  const out = S.rasterize(scene);
  const rec = S.buildPixelRecord(scene, out, 4, 4);
  const report = S.reproduce(S.validateRecord(JSON.parse(JSON.stringify(rec))));
  check('记录复现零差异', report.ok, report.mismatches.join('; '));
  let threw = false;
  try {
    S.validateRecord({ format: 'wrong' });
  } catch {
    threw = true;
  }
  check('非法记录被拒绝', threw);
}

console.log(failures === 0 ? '\n全部冒烟测试通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
