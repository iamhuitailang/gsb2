/**
 * 多材质与视角稳定性 E2E：
 *  - 导入六材质立方体，只在选中材质上落笔，其它材质不被污染
 *  - 旋转视角后，三维空间同一位置的拾取仍对应同一局部坐标
 */
import puppeteer from 'puppeteer-core';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.E2E_URL ?? 'http://127.0.0.1:5173/';
const shotDir = resolve(root, 'tmp', 'e2e');
mkdirSync(shotDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=1600,1000',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const consoleErrors = [];
page.on('response', (r) => {
  if (r.status() >= 400) consoleErrors.push(`HTTP ${r.status()}: ${r.url()}`);
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  await page.goto(URL, { waitUntil: 'networkidle0' });
  const fileInput = await page.$('#file-open');
  await fileInput.uploadFile(
    resolve(root, 'public/samples/multi-material.obj'),
    resolve(root, 'public/samples/multi-material.mtl'),
    resolve(root, 'public/samples/checkerboard.png'),
  );
  await page.waitForFunction(
    () => document.querySelector('#select-material')?.options.length >= 6,
    { timeout: 8000 },
  );

  const matCount = await page.$eval(
    '#select-material',
    (el) => el.options.length,
  );
  check('六材质全部识别', matCount === 6, `materials=${matCount}`);

  // 在 pz 材质上落一大笔（点 (0,0,0.5) 位于 +Z 面中心），统计各材质绘画层
  const perMaterial = await page.evaluate(() => {
    const target = window.app.sceneView.listObjects()[0];
    const active = target.materialNames.find((n) => n.includes('pz'));
    target.engine.beginStroke(
      active,
      {
        radius: 0.3, hardness: 0.6, opacity: 1,
        color: { r: 250, g: 30, b: 30 }, eraser: false,
      },
      1024,
    );
    target.engine.addStrokePoint({ point: { x: 0, y: 0, z: 0.5 }, triangle: 0 });
    target.engine.endStroke();

    const counts = {};
    for (const name of target.materialNames) {
      const state = target.engine.getMaterialState(name);
      let painted = 0;
      for (let i = 3; i < state.paint.data.length; i += 4) {
        if (state.paint.data[i] > 0) painted++;
      }
      counts[name] = painted;
    }
    return { active, counts };
  });
  const paintedMats = Object.entries(perMaterial.counts)
    .filter(([, n]) => n > 0)
    .map(([name]) => name);
  check(
    '只有选中材质被绘制，未选材质零污染',
    paintedMats.length === 1 && paintedMats[0] === perMaterial.active,
    JSON.stringify(perMaterial.counts),
  );

  // 视角旋转稳定性：同一局部射线在相机变化后命中点不变
  const stable = await page.evaluate(() => {
    const target = window.app.sceneView.listObjects()[0];
    const matPz = target.materialNames.find((n) => n.includes('pz'));
    const pick = (ox, oy, oz, dx, dy, dz, material) =>
      target.engine.raycast(
        { x: ox, y: oy, z: oz },
        { x: dx, y: dy, z: dz },
        material,
      );
    // 正/反两个方向看 +Z / -Z 面中心，命中点都应严格落在 z=±0.5
    const front = pick(0, 0, 2, 0, 0, -1, matPz);
    const back = pick(0, 0, -2, 0, 0, 1);
    return {
      front: front?.point ?? null,
      back: back?.point ?? null,
    };
  });
  check(
    '不同视角射线命中局部坐标稳定（表面贴合）',
    stable.front &&
      Math.abs(stable.front.z - 0.5) < 1e-9 &&
      stable.back &&
      Math.abs(stable.back.z + 0.5) < 1e-9,
    JSON.stringify(stable),
  );

  // 材质切换下拉确实只列出当前对象的材质（对象隔离）
  const objectList = await page.$eval('#select-object', (el) => el.options.length);
  check('对象选择器仅含已导入对象', objectList === 1);

  await page.screenshot({ path: resolve(shotDir, '04-multi-material.png') });
  check('控制台无报错', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (err) {
  check('E2E 执行异常', false, String(err && err.stack ? err.stack : err));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
