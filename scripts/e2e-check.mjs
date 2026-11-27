// 浏览器端到端冒烟测试: 生成 -> 校验 -> 放入试玩 -> 逐束查看 -> 转动 -> 无解 -> 导入冲突
// 运行: node scripts/e2e-check.mjs  (需先 npx vite --port 5199)
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5199/';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1360,1100'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1360, height: 1100 });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  // favicon/资源 404 与功能无关, 忽略
  const t = m.text();
  if (m.type() === 'error' && !t.includes('favicon') && !t.includes('Failed to load resource')) {
    errors.push(`console.error: ${t}`);
  }
});

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};

/** 在当前 DOM 里找第一个未锁定反光片的格子坐标 */
async function firstFreeMirrorPos() {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('.cell')].find(
      (c) => c.querySelector('.mirror-glyph') && !c.querySelector('.lock-badge'),
    );
    return el ? { r: el.dataset.r, c: el.dataset.c } : null;
  });
}

async function glyphAt(r, c) {
  return page.$eval(
    `.cell[data-r="${r}"][data-c="${c}"] .mirror-glyph`,
    (el) => el.textContent,
  );
}

try {
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.board');

  // 1. 生成种子 2 的关卡(内置样例 2 为三光源, 便于测逐束查看)
  await page.evaluate(() => {
    const input = document.querySelector('#seed-input');
    input.value = '2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const seedVal = await page.$eval('#seed-input', (el) => el.value);
  check('种子输入框值为 2', seedVal === '2', seedVal);
  await page.click('#btn-generate');
  await page.waitForFunction(
    () => document.querySelector('.message')?.textContent.includes('种子 2'),
    { timeout: 8000 },
  );
  const counts = await page.$$eval('.cell', (els) => ({
    sources: els.filter((e) => e.classList.contains('source-cell')).length,
    targets: els.filter((e) => e.classList.contains('target-cell')).length,
    mirrors: els.filter((e) => e.querySelector('.mirror-glyph')).length,
  }));
  check('生成后出现光源/收光点/反光片',
    counts.sources > 0 && counts.targets > 0 && counts.mirrors > 0,
    JSON.stringify(counts));

  // 2. 确定性: 同种子再生成, 棋盘 HTML 一致
  //    用渲染计数钩子精确等待第二轮生成完成(消息文本在两轮里相同, 无法据此区分)
  const htmlBefore = await page.$eval('.board', (el) => el.innerHTML);
  const rendersBefore = await page.evaluate(() => window.__renderCount);
  await page.click('#btn-generate');
  await page.waitForFunction(
    (n) => (window.__renderCount ?? 0) > n,
    { timeout: 15000 },
    rendersBefore,
  );
  const htmlAfter = await page.$eval('.board', (el) => el.innerHTML);
  if (htmlBefore !== htmlAfter) {
    // 定位差异: 逐格对比非空格内容
    const diff = await page.evaluate(() => {
      const snapshot = () =>
        [...document.querySelectorAll('.grid .cell')].map((el) => ({
          r: el.dataset.r,
          c: el.dataset.c,
          text: el.textContent.replace(/\s+/g, ' ').trim(),
          cls: el.className,
        }));
      return snapshot();
    });
    console.log('  第二次生成后的格子:', JSON.stringify(diff.filter((c) => c.text)));
  }
  check('同种子重复生成布局一致', htmlBefore === htmlAfter);

  // 3. 自动校验 -> 唯一解, 且报告写明搜索完整
  await page.click('#btn-solve');
  await page.waitForSelector('.badge.status-unique', { timeout: 8000 });
  const statusText = await page.$eval('.badge.status-unique', (el) => el.textContent);
  check('校验结果为唯一解', statusText === '唯一解');
  const reportText = await page.$eval('.panel .info-item', (el) => el.textContent);
  check('报告显示搜索完整(没把提前停止当唯一)', reportText.includes('搜索完整'),
    reportText.replace(/\s+/g, ' ').slice(0, 90));

  // 4. 放入试玩面板
  await page.click('[data-load-sol="0"]');
  await page.waitForFunction(
    () => document.querySelector('.mode-switch button.active')?.textContent === '试玩转动',
  );
  check('点击后切到试玩模式', true);

  // 5. 光束渲染
  await page.waitForSelector('.beam-layer path');
  const beamPaths = await page.$$eval('.beam-layer path', (els) => els.length);
  check('试玩面板渲染出光束', beamPaths >= 1, `${beamPaths} 条 SVG 路径`);

  // 6. 逐束查看: 选第一束, 其余被压暗(单束光时无其余可压暗, 属正常)
  const beamItems = await page.$$('[data-beam]');
  check('右栏光束项数 = 光束数 + 1(全部)', beamItems.length === beamPaths + 1,
    `${beamItems.length} 项`);
  await beamItems[1].click();
  const dimmed = await page.$$eval('.beam-layer path.dimmed', (els) => els.length);
  if (beamPaths > 1) {
    check('选中单束后其余光束被压暗', dimmed === beamPaths - 1, `${dimmed} 条压暗`);
  } else {
    check('单束光关卡: 选中后无多余光束可压暗', dimmed === 0);
  }
  // 切回显示全部
  await page.click('[data-beam="-1"]');
  const dimmedAfter = await page.$$eval('.beam-layer path.dimmed', (els) => els.length);
  check('切回显示全部后无压暗', dimmedAfter === 0);

  // 7. 转动未锁定反光片(每次点击前重新取坐标, 避免跨 render 失效句柄)
  const pos1 = await firstFreeMirrorPos();
  check('存在未锁定反光片', pos1 !== null);
  const g0 = await glyphAt(pos1.r, pos1.c);
  await page.click(`.cell[data-r="${pos1.r}"][data-c="${pos1.c}"]`);
  const g1 = await glyphAt(pos1.r, pos1.c);
  check('点击未锁定反光片会转动', g0 !== g1, `${g0} -> ${g1}`);
  // 再点一次回到原朝向
  await page.click(`.cell[data-r="${pos1.r}"][data-c="${pos1.c}"]`);
  const g2 = await glyphAt(pos1.r, pos1.c);
  check('再点一次恢复原朝向', g2 === g0, `${g1} -> ${g2}`);

  // 8. 锁定片在试玩模式不可转
  const lockedPos = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.cell')].find(
      (c) => c.querySelector('.mirror-glyph') && c.querySelector('.lock-badge'),
    );
    return el ? { r: el.dataset.r, c: el.dataset.c } : null;
  });
  if (lockedPos) {
    const lg0 = await glyphAt(lockedPos.r, lockedPos.c);
    await page.click(`.cell[data-r="${lockedPos.r}"][data-c="${lockedPos.c}"]`);
    const lg1 = await glyphAt(lockedPos.r, lockedPos.c);
    check('锁定反光片点击不转动', lg0 === lg1);
  } else {
    check('本关无锁定片, 跳过', true);
  }

  // 9. 回编辑, 构造不连通的无解布局(按当前棋盘实际尺寸取角格)
  await page.click('#back-edit');
  await page.waitForSelector('[data-tool="empty"]');
  const gridSize = await page.$$eval('.grid', (els) => {
    const n = Math.round(Math.sqrt(els[0].querySelectorAll('.cell').length));
    return n;
  });
  const last = gridSize - 1;
  await page.evaluate((n) => {
    document.querySelector('[data-tool="empty"]').click();
    document.querySelectorAll('.cell').forEach((el) => el.click());
    document.querySelector('[data-tool="source"]').click();
    document.querySelector('.cell[data-r="0"][data-c="0"]').click();
    document.querySelector('[data-tool="target"]').click();
    document.querySelector(`.cell[data-r="${n}"][data-c="${n}"]`).click();
  }, last);
  const boardBefore = await page.$eval('.board', (el) => el.innerHTML);
  await page.click('#btn-solve');
  await page.waitForSelector('.badge.status-unsat', { timeout: 8000 });
  check('不连通布局报无解', true);

  // 10. 导入冲突文件: 拦截文件选择器, 验证当前关卡被保留且消息指出冲突格
  const badJson = JSON.stringify({
    format: 'light-path-puzzle/v1',
    name: '坏关卡',
    size: 4,
    cells: [
      { r: 1, c: 1, kind: 'wall' },
      { r: 1, c: 1, kind: 'target', required: 0 },
      { r: 0, c: 0, kind: 'source', dir: 1, colors: 1 },
    ],
  });
  writeFileSync('/tmp/bad-level.json', badJson);
  const chooserPromise = page.waitForFileChooser();
  await page.click('#btn-import');
  const chooser = await chooserPromise;
  await chooser.accept(['/tmp/bad-level.json']);
  await page.waitForFunction(
    () => document.querySelector('.message.error')?.textContent.includes('(2, 2)'),
    { timeout: 5000 },
  );
  const msg = await page.$eval('.message.error', (el) => el.textContent);
  check('导入冲突消息指出具体格(2, 2)', msg.includes('(2, 2)'), msg.slice(0, 70));
  const boardAfter = await page.$eval('.board', (el) => el.innerHTML);
  check('冲突时保留上一份可用关卡(棋盘不变)', boardBefore === boardAfter);

  // 11. 导入合法文件成功切换
  const goodJson = JSON.stringify({
    format: 'light-path-puzzle/v1',
    name: '导入的好关卡',
    size: 4,
    cells: [
      { r: 0, c: 0, kind: 'source', dir: 1, colors: 3 },
      { r: 0, c: 2, kind: 'mirror', orient: 1, locked: false },
      { r: 2, c: 2, kind: 'target', required: 3 },
    ],
  });
  writeFileSync('/tmp/good-level.json', goodJson);
  const chooser2 = page.waitForFileChooser();
  await page.click('#btn-import');
  await (await chooser2).accept(['/tmp/good-level.json']);
  await page.waitForFunction(
    () => document.querySelector('.message.ok')?.textContent.includes('导入成功'),
    { timeout: 5000 },
  );
  const nameVal = await page.$eval('#level-name', (el) => el.value);
  check('合法文件导入成功并切换关卡', nameVal === '导入的好关卡');

  await page.screenshot({ path: '/tmp/shot-e2e.png' });
} catch (e) {
  errors.push(`fatal: ${e.stack}`);
} finally {
  await browser.close();
}

if (errors.length) {
  console.log('\n浏览器错误:');
  errors.forEach((e) => console.log('  ' + e));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length || errors.length ? 1 : 0);
