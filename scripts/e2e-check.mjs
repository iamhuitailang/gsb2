/**
 * 浏览器端到端验证（不纳入 npm test，需 dev server 与系统 Chrome）：
 *   node scripts/e2e-check.mjs
 *
 * 覆盖：导入带接缝 OBJ -> 表面绘制 -> UV 画布出现同一笔触 ->
 * 接缝两侧 UV 岛都有像素 -> 撤销/重做 -> 工程保存/恢复 -> 纹理导出。
 */
import puppeteer from 'puppeteer-core';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';

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
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('requestfailed', (r) =>
  consoleErrors.push(`REQUEST FAILED: ${r.url()} ${r.failure()?.errorText ?? ''}`),
);
page.on('response', (r) => {
  if (r.status() >= 400) consoleErrors.push(`HTTP ${r.status()}: ${r.url()}`);
});

try {
  await page.goto(URL, { waitUntil: 'networkidle0' });

  // 1. 导入示例 OBJ + MTL + 棋盘贴图
  const fileInput = await page.$('#file-open');
  await fileInput.uploadFile(
    resolve(root, 'public/samples/seamed-cube.obj'),
    resolve(root, 'public/samples/seamed-cube.mtl'),
    resolve(root, 'public/samples/checkerboard.png'),
  );
  await page.waitForFunction(
    () => document.querySelector('#select-object')?.options.length > 0,
    { timeout: 8000 },
  );
  const objectName = await page.$eval('#select-object', (el) => el.options[0].textContent);
  check('导入 OBJ 后对象出现在列表', objectName.includes('seamed-cube'), objectName);

  await page.waitForFunction(
    () => document.querySelector('#select-material')?.options.length > 0,
  );
  const matName = await page.$eval('#select-material', (el) => el.options[0].value);
  check('材质槽已识别', !!matName, matName);

  // 等待一帧渲染
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: resolve(shotDir, '01-loaded.png') });

  // 2. 在模型表面拖一笔（视口中心区域多点拖动）
  const box = await page.$eval('#viewport', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = box.x + box.w * 0.52;
  const cy = box.y + box.h * 0.5;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'left' });
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(cx + i * 8, cy + Math.sin(i / 2) * 6, { steps: 1 });
  }
  await page.mouse.up({ button: 'left' });
  await new Promise((r) => setTimeout(r, 300));

  // 3. 通过引擎读取绘画层像素统计
  const stats = await page.evaluate(() => {
    const app = window.app;
    const target = app.sceneView.listObjects()[0];
    const mat = target.materialNames[0];
    const state = target.engine.getMaterialState(mat);
    let painted = 0;
    for (let i = 3; i < state.paint.data.length; i += 4) {
      if (state.paint.data[i] > 0) painted++;
    }
    // 接缝两侧：立方体每面一个 UV 岛，统计各岛 alpha>0 像素
    const res = state.resolution;
    const islandCount = new Array(6).fill(0);
    const layout = [
      [0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1],
    ];
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const a = state.paint.data[(y * res + x) * 4 + 3];
        if (!a) continue;
        const u = x / res;
        const v = 1 - y / res;
        const ix = Math.min(2, Math.floor(u * 3));
        const iy = Math.min(1, Math.floor(v * 2));
        const idx = layout.findIndex(([lx, ly]) => lx === ix && ly === iy);
        if (idx >= 0) islandCount[idx]++;
      }
    }
    return {
      painted,
      islandCount,
      islandsWithPaint: islandCount.filter((n) => n > 0).length,
      canUndo: target.engine.canUndo,
    };
  });
  check('绘画层出现成片像素', stats.painted > 50, `painted=${stats.painted}`);
  check('笔画进入撤销栈', stats.canUndo === true);

  // 4. UV 预览画布非空（与模型同源）
  const uvNonEmpty = await page.evaluate(() => {
    const c = document.querySelector('#uv-preview');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (!(d[i] === 38 && d[i + 1] === 42 && d[i + 2] === 48)) nonBg++;
    }
    return nonBg;
  });
  check('UV 画布预览已绘制', uvNonEmpty > 1000, `nonBgPixels=${uvNonEmpty}`);
  await page.screenshot({ path: resolve(shotDir, '02-painted.png') });

  // 5. 撤销 / 重做（此时栈中只有拖动的第一笔）
  const afterUndo = await page.evaluate(() => {
    const target = window.app.sceneView.listObjects()[0];
    const ok = target.engine.undo();
    const state = target.engine.getMaterialState(target.materialNames[0]);
    let painted = 0;
    for (let i = 3; i < state.paint.data.length; i += 4) {
      if (state.paint.data[i] > 0) painted++;
    }
    return { ok, painted, canRedo: target.engine.canRedo };
  });
  check('撤销清空当前笔画', afterUndo.ok && afterUndo.painted === 0);
  check('撤销后可重做', afterUndo.canRedo);
  await page.evaluate(() => {
    const target = window.app.sceneView.listObjects()[0];
    target.engine.redo();
  });
  const afterRedo = await page.evaluate(() => {
    const target = window.app.sceneView.listObjects()[0];
    const state = target.engine.getMaterialState(target.materialNames[0]);
    let painted = 0;
    for (let i = 3; i < state.paint.data.length; i += 4) {
      if (state.paint.data[i] > 0) painted++;
    }
    return painted;
  });
  check('重做恢复笔画', afterRedo === stats.painted, `painted=${afterRedo}`);

  // 5b. 接缝连续性：在 px/pz 共享棱 (0.5,y,0.5) 附近落一个大笔刷，
  // 验证真实光栅化路径在浏览器里把同一三维笔触写到接缝两侧的 UV 岛
  const seam = await page.evaluate(() => {
    const target = window.app.sceneView.listObjects()[0];
    const mat = target.materialNames[0];
    target.engine.beginStroke(
      mat,
      {
        radius: 0.15, hardness: 0.5, opacity: 1,
        color: { r: 20, g: 200, b: 60 }, eraser: false,
      },
      1024,
    );
    target.engine.addStrokePoint({ point: { x: 0.42, y: 0, z: 0.42 }, triangle: 0 });
    target.engine.endStroke();
    const state = target.engine.getMaterialState(mat);
    const res = state.resolution;
    const islandCount = new Array(6).fill(0);
    const layout = [
      [0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1],
    ];
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const a = state.paint.data[(y * res + x) * 4 + 3];
        if (!a) continue;
        const u = x / res;
        const v = 1 - y / res;
        const ix = Math.min(2, Math.floor(u * 3));
        const iy = Math.min(1, Math.floor(v * 2));
        const idx = layout.findIndex(([lx, ly]) => lx === ix && ly === iy);
        if (idx >= 0) islandCount[idx]++;
      }
    }
    return { islandCount, islandsWithPaint: islandCount.filter((n) => n > 0).length };
  });
  check(
    '接缝两侧 UV 岛同时被画到（>=2 个岛有像素）',
    seam.islandsWithPaint >= 2,
    `islands=${JSON.stringify(seam.islandCount)}`,
  );

  // 6. 棋盘基础纹理：基础层保持棋盘且绘画层独立
  const baseOk = await page.evaluate(() => {
    const target = window.app.sceneView.listObjects()[0];
    const state = target.engine.getMaterialState(target.materialNames[0]);
    // 棋盘格四角：(0,0) 亮，(cell,0) 暗
    const res = state.resolution;
    const cell = res / 8;
    const c00 = state.base.data[0];
    const c10 = state.base.data[(0 * res + Math.floor(cell)) * 4];
    const baseAlpha = state.base.data[3];
    return { c00, c10, baseAlpha };
  });
  check(
    '基础纹理为棋盘且不透明，绘画层独立',
    baseOk.baseAlpha === 255 && Math.abs(baseOk.c00 - baseOk.c10) > 50,
    JSON.stringify(baseOk),
  );

  // 7. 工程保存：拦截浏览器下载，读取真实「保存工程」按钮产出的文件内容
  await page.evaluate(() => {
    window.__savedProject = null;
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = async function () {
      if (this.download?.endsWith('.json') && this.href.startsWith('blob:')) {
        const blob = await fetch(this.href).then((r) => r.blob());
        window.__savedProject = {
          filename: this.download,
          text: await blob.text(),
        };
      } else {
        origClick.call(this);
      }
    };
  });
  await page.click('#btn-save');
  await page.waitForFunction(() => window.__savedProject, { timeout: 8000 });
  const saved = await page.evaluate(() => window.__savedProject);
  const project = JSON.parse(saved.text);
  const directProject = saved.text;
  check(
    '保存工程按钮产出合法工程文件',
    saved.filename.endsWith('.tpp.json') && project.app === 'meshpaint3d',
    saved.filename,
  );
  check(
    '工程文件含内嵌模型与两层 PNG',
    project.objects[0].modelFiles.length >= 2 &&
      project.objects[0].materials[0].basePng.startsWith('data:image/png') &&
      project.objects[0].materials[0].paintPng.startsWith('data:image/png'),
    `files=${project.objects[0].modelFiles.length}`,
  );
  writeFileSync(resolve(shotDir, 'project-sample.tpp.json'), directProject);

  // 8. 导出纹理 PNG + binding
  const exportInfo = await page.evaluate(async () => {
    const { exportLayerPng, buildBinding } = await import(
      '/src/state/project-store.ts'
    );
    const { TextureLayer, compositeLayers } = await import('/src/core/texture-layer.ts');
    const target = window.app.sceneView.listObjects()[0];
    const name = target.materialNames[0];
    const s = target.engine.getMaterialState(name);
    const composite = new TextureLayer(s.resolution, s.resolution);
    composite.data.set(compositeLayers(s.base, s.paint));
    const { blob, filename } = exportLayerPng(composite, target.name, name);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const binding = buildBinding(target.name, [
      { name, resolution: s.resolution, basePng: '', paintPng: '' },
    ]);
    // PNG 魔数
    const isPng =
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    return { isPng, filename, binding, size: buf.length };
  });
  check(
    '导出合成纹理为合法 PNG',
    exportInfo.isPng && exportInfo.filename.endsWith('.png'),
    `${exportInfo.filename} (${exportInfo.size} bytes)`,
  );
  check(
    'binding.json 记录材质-纹理绑定',
    exportInfo.binding.materials[0].textureFile.endsWith('.png') &&
      exportInfo.binding.materials[0].uvSet === 'uv0',
  );

  // 9. 工程恢复：用保存的 JSON 走真实「打开工程」文件选择流程
  const beforeReload = await page.evaluate(() => {
    const target = window.app.sceneView.listObjects()[0];
    const state = target.engine.getMaterialState(target.materialNames[0]);
    let painted = 0;
    for (let i = 3; i < state.paint.data.length; i += 4) {
      if (state.paint.data[i] > 0) painted++;
    }
    return painted;
  });
  // 把工程 JSON 写到临时文件，走 #file-project 的真实加载路径
  const projectPath = resolve(shotDir, 'project-sample.tpp.json');
  writeFileSync(projectPath, directProject);
  await page.$eval('#file-project', (el) => {
    el.removeAttribute('hidden');
  });
  const fileChooser = page.waitForFileChooser();
  await page.click('#btn-load');
  const chooser = await fileChooser;
  await chooser.accept([projectPath]);
  await page.waitForFunction(
    () => {
      const objs = window.app.sceneView.listObjects();
      if (!objs.length) return false;
      const state = objs[0].engine.getMaterialState(objs[0].materialNames[0]);
      let painted = 0;
      for (let i = 3; i < state.paint.data.length; i += 4) {
        if (state.paint.data[i] > 0) painted++;
      }
      return painted > 0;
    },
    { timeout: 10000 },
  );
  const reloadStats = await page.evaluate(() => {
    const target = window.app.sceneView.listObjects()[0];
    const state = target.engine.getMaterialState(target.materialNames[0]);
    let painted = 0;
    for (let i = 3; i < state.paint.data.length; i += 4) {
      if (state.paint.data[i] > 0) painted++;
    }
    return {
      paintRes: state.paint.width,
      baseRes: state.base.width,
      painted,
      objectCount: window.app.sceneView.listObjects().length,
      objectName: target.name,
    };
  });
  check(
    '工程恢复后模型、纹理尺寸与笔画像素完全一致',
    reloadStats.objectCount === 1 &&
      reloadStats.objectName === project.objects[0].name &&
      reloadStats.baseRes === 1024 &&
      reloadStats.paintRes === 1024 &&
      reloadStats.painted === beforeReload,
    JSON.stringify({
      res: reloadStats.paintRes,
      restored: reloadStats.painted,
      expected: beforeReload,
    }),
  );

  await page.screenshot({ path: resolve(shotDir, '03-final.png') });
  check('控制台无报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('E2E 执行异常', false, String(err && err.stack ? err.stack : err));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
