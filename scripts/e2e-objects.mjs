/**
 * 多对象隔离 E2E：导入两个对象，绘制只作用于选中对象，
 * 切换选中后原对象纹理保持不变，未选中对象无法被误涂。
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
  // 第一次导入：单材质 OBJ
  await (await page.$('#file-open')).uploadFile(
    resolve(root, 'public/samples/seamed-cube.obj'),
    resolve(root, 'public/samples/seamed-cube.mtl'),
    resolve(root, 'public/samples/checkerboard.png'),
  );
  await page.waitForFunction(
    () => document.querySelector('#select-object')?.options.length === 1,
  );
  // 第二次导入：GLB（第二个对象）
  await (await page.$('#file-open')).uploadFile(
    resolve(root, 'public/samples/seamed-cube.glb'),
  );
  await page.waitForFunction(
    () => document.querySelector('#select-object')?.options.length === 2,
  );

  const summary = await page.evaluate(() => {
    const objs = window.app.sceneView.listObjects();
    const selected = window.app.selectedObject;
    const other = objs.find((o) => o.id !== selected.id);
    const mat = selected.materialNames[0];
    selected.engine.beginStroke(
      mat,
      { radius: 0.25, hardness: 0.5, opacity: 1, color: { r: 10, g: 200, b: 80 }, eraser: false },
      1024,
    );
    selected.engine.addStrokePoint({ point: { x: 0, y: 0, z: 0.5 }, triangle: 0 });
    selected.engine.endStroke();

    const count = (t) => {
      const s = t.engine.getMaterialState(t.materialNames[0]);
      let n = 0;
      for (let i = 3; i < s.paint.data.length; i += 4) {
        if (s.paint.data[i] > 0) n++;
      }
      return n;
    };
    return {
      objectCount: objs.length,
      selectedName: selected.name,
      otherName: other.name,
      paintedOnSelected: count(selected),
      paintedOnOther: count(other),
      firstName: objs[0].name,
    };
  });
  check('两个对象同时存在于场景', summary.objectCount === 2);
  check('选中对象被绘制', summary.paintedOnSelected > 50, `n=${summary.paintedOnSelected}`);
  check(
    '未选中对象完全没有被误涂',
    summary.paintedOnOther === 0,
    `other=${summary.paintedOnOther}`,
  );

  // 通过真实下拉切换到第一个对象
  const firstValue = await page.$eval(
    '#select-object',
    (el) => el.options[0].value,
  );
  await page.select('#select-object', firstValue);
  await new Promise((r) => setTimeout(r, 200));
  const afterSwitch = await page.evaluate(() => {
    const target = window.app.selectedObject;
    const s = target.engine.getMaterialState(target.materialNames[0]);
    let n = 0;
    for (let i = 3; i < s.paint.data.length; i += 4) {
      if (s.paint.data[i] > 0) n++;
    }
    return { selected: target.name, painted: n };
  });
  check('切换对象后选中项跟随下拉', afterSwitch.selected === summary.firstName);
  check('切到未绘制对象后其绘画层仍为空', afterSwitch.painted === 0);
  check('控制台无报错', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('E2E 执行异常', false, String(err && err.stack ? err.stack : err));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
