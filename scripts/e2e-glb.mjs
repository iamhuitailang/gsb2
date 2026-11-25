/**
 * GLB 链路 E2E：导入内嵌贴图的 GLB -> 材质识别 -> 表面绘制 -> 接缝检测。
 */
import puppeteer from 'puppeteer-core';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.E2E_URL ?? 'http://127.0.0.1:5173/';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errors = [];
page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()}: ${r.url()}`));
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await (await page.$('#file-open')).uploadFile(
    resolve(root, 'public/samples/seamed-cube.glb'),
  );
  await page.waitForFunction(
    () => document.querySelector('#select-object')?.options.length > 0,
    { timeout: 8000 },
  );

  const info = await page.evaluate(() => {
    const target = window.app.sceneView.listObjects()[0];
    const mat = target.materialNames[0];
    // 内嵌棋盘贴图是否进入基础层（角点颜色有明暗差）
    const state = target.engine.getMaterialState(mat);
    const res = state.resolution;
    const cell = res / 8;
    const c00 = state.base.data[0];
    const c10 = state.base.data[Math.floor(cell) * 4];
    // 表面绘制
    target.engine.beginStroke(
      mat,
      { radius: 0.2, hardness: 0.5, opacity: 1, color: { r: 20, g: 120, b: 240 }, eraser: false },
      1024,
    );
    target.engine.addStrokePoint({ point: { x: 0, y: 0, z: 0.5 }, triangle: 0 });
    target.engine.endStroke();
    let painted = 0;
    for (let i = 3; i < state.paint.data.length; i += 4) {
      if (state.paint.data[i] > 0) painted++;
    }
    const seamEdges = target.paintMesh.detectSeam3DEdges().length;
    const seamUv = target.paintMesh.detectSeamUvSegments().length;
    return {
      name: target.name,
      format: target.format,
      material: mat,
      baseChecker: Math.abs(c00 - c10) > 50,
      painted,
      seamEdges,
      seamUv,
    };
  });
  check('GLB 导入并识别为 glb 格式', info.format === 'glb', info.format);
  check('材质名从 GLB 恢复', info.material === 'glb_surface', info.material);
  check('内嵌棋盘贴图进入基础纹理层', info.baseChecker === true);
  check('GLB 表面可绘制', info.painted > 50, `painted=${info.painted}`);
  check(
    '接缝被检测到（三维边与 UV 线段）',
    info.seamEdges >= 12 && info.seamUv >= 12,
    `edges=${info.seamEdges} uvSegs=${info.seamUv}`,
  );
  check('控制台无报错', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('E2E 执行异常', false, String(err && err.stack ? err.stack : err));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
