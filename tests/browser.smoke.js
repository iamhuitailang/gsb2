/*
 * 无头浏览器冒烟测试（需要本机装有 Chrome/Chromium）：
 *   node tests/browser.smoke.js
 *
 * 不引入任何 npm 依赖，直接用 child_process 调 Chrome 的 --headless --dump-dom
 * 与 --screenshot 能力；DOM 交互通过注入的测试页脚本完成，
 * 结果写到 document.title 与控制台，Node 侧解析退出码。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.log('跳过：未找到 Chrome/Chromium');
  process.exit(0);
}

// 生成一个测试专用 HTML：加载真实脚本后执行断言，并把结果写进 #testresult
const harness = `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="css/style.css"></head>
<body>
<div id="testresult" data-ok="0">running</div>
<script src="js/geometry.js"></script>
<script src="js/lighting.js"></script>
<script src="js/scene.js"></script>
<script src="js/store.js"></script>
<script>
window.addEventListener('error', e => {
  document.getElementById('testresult').textContent = 'PAGE_ERROR: ' + e.message;
});
window.addEventListener('load', () => setTimeout(run, 300));
function run() {
  const log = [];
  try {
    const G = window.Geometry, L = window.Lighting, S = window.Scene;
    const scene = S.createDefaultScene();
    S.validateScene(JSON.parse(JSON.stringify(scene))); // 序列化往返
    const segs = G.flattenWalls(scene.walls);
    assert(segs.length > 5, '墙链应展开为多段线段');
    assert(scene.lights.length === 3, '内置场景应有 3 盏灯');
    assert(scene.markers.length === 2, '应有 M1/M2 两个标记');

    // 每盏灯都能算出闭合可见多边形且不越半径
    for (const light of scene.lights) {
      const { polygon, hits } = G.computeVisibility(light, segs, light.radius);
      const ring = polygon.filter(v => !v.isOrigin);
      assert(ring.length >= 12, light.name + ' 外圈顶点不足');
      for (const v of ring) assert(v.dist <= light.radius + 1e-6, light.name + ' 顶点越界');
      assert(hits.size >= 1, light.name + ' 应至少命中一堵墙');
    }

    // 窄缝对照：M1 透光、M2 被挡
    const below = { x: 534, y: 560 };
    const m1 = { x: 534, y: 430 }, m2 = { x: 564, y: 430 };
    const r1 = G.queryPoint(below, [{ ...m1, radius: 300, on: true }], segs);
    const r2 = G.queryPoint({ x: 564, y: 560 }, [{ ...m2, radius: 300, on: true }], segs);
    assert(r1[0] && r1[0].blocked === false, 'M1 应透过窄缝');
    assert(r2[0] && r2[0].blocked === true, 'M2 应被实墙挡住');

    // 灯光路径构建（需要 2d canvas 上下文）
    const canvas = document.createElement('canvas');
    canvas.width = 1000; canvas.height = 700;
    const ctx = canvas.getContext('2d');
    const light = scene.lights[0];
    const { polygon } = G.computeVisibility(light, segs, light.radius);
    const layer = L.renderLightLayer(light, polygon, 1000, 700);
    assert(layer.width === 1000, '离屏灯层尺寸错误');
    const ok = L.buildLightPath(ctx, light, polygon);
    assert(ok === true, 'buildLightPath 应成功构建路径');

    // 混合方式齐全
    assert(['additive', 'lighten', 'normal'].every(m => L.COMPOSITE_OPS[m]), '三种混合方式应齐全');

    // 贴墙检测
    const onWallLight = { x: segs[0].a.x, y: segs[0].a.y };
    assert(G.pointOnWall(onWallLight, segs), '压在墙端点上的灯应被判定贴墙');

    // 空白场景与校验失败路径
    const empty = S.createEmptyScene();
    assert(empty.walls.length >= 1 && empty.lights.length === 1, '空白场景结构错误');
    let threw = false;
    try { S.validateScene({ walls: 'nope', lights: [] }); } catch (e) { threw = true; }
    assert(threw, '非法场景应抛错');

    log.push('ALL_OK');
    document.getElementById('testresult').dataset.ok = '1';
    document.getElementById('testresult').textContent = log.join(';');
  } catch (e) {
    document.getElementById('testresult').textContent = 'ASSERT_FAIL: ' + e.message;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
</script>
</body></html>`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightlab-smoke-'));
const harnessPath = path.join(dir, 'smoke.html');
fs.writeFileSync(harnessPath, harness);

// 把项目资源软链进临时目录，保证相对路径可用
for (const name of ['js', 'css']) {
  fs.symlinkSync(path.join(ROOT, name), path.join(dir, name), 'dir');
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lightlab-chrome-'));
const out = execFileSync(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--user-data-dir=' + profile,
  '--virtual-time-budget=3000',
  '--dump-dom',
  'file://' + harnessPath,
], { encoding: 'utf8' });

const m = out.match(/<div id="testresult"[^>]*data-ok="(\d)"[^>]*>([^<]*)<\/div>/);
if (!m) {
  console.error('未能读取测试结果，DOM 输出片段：\n' + out.slice(0, 500));
  process.exit(1);
}
const [, ok, msg] = m;
if (ok === '1') {
  console.log('浏览器冒烟测试通过：' + msg);
  process.exit(0);
} else {
  console.error('浏览器冒烟测试失败：' + msg);
  process.exit(1);
}
