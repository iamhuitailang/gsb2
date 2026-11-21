/* 端到端验证：用 Playwright 加载真实页面，验证编辑→分析→轨迹→试玩整条链路。
   运行：node tests/e2e.mjs （需 npx playwright install chromium） */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';

// 从 npx 缓存里解析 playwright（仓库本身不装依赖）
const require = createRequire(import.meta.url);
function resolvePlaywright() {
  try { return require('playwright'); } catch {}
  const npxRoot = join(process.env.HOME, '.npm/_npx');
  for (const d of readdirSync(npxRoot)) {
    const p = join(npxRoot, d, 'node_modules/playwright');
    try { return require(p); } catch {}
  }
  throw new Error('未找到 playwright，请先 npx playwright install chromium');
}
const { chromium } = resolvePlaywright();

const root = dirname(fileURLToPath(import.meta.url));
const url = 'file://' + join(root, '..', 'index.html');

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url);
await page.waitForSelector('#stage');
await page.waitForTimeout(300);

// 1. 演示关卡自动加载，画布上有实体
const entCount = await page.evaluate(() => window.JR.app.level.entities.length);
assert(entCount === 7, `演示关卡加载 7 个实体（实际 ${entCount}）`);

// 2. 计算可达性
await page.click('#btn-analyze');
await page.waitForTimeout(500);
const landingRows = await page.$$eval('.land-row', (rows) => rows.map((r) => r.textContent.trim()));
assert(landingRows.length >= 4, `列出至少 4 个平台落脚结果（实际 ${landingRows.length}）`);
const okCount = landingRows.filter((t) => t.includes('可落脚')).length;
assert(okCount >= 3, `至少 3 个平台标记可落脚（${okCount}）`);
// 撞头标记：切到参数 B（弱弹跳弧线变化后低顶后平台变为撞头阻挡）
await page.click('.param-tab[data-set="B"]');
await page.waitForTimeout(200);
const rowsB = await page.$$eval('.land-row', (rows) => rows.map((r) => r.textContent.trim()));
const bonkCount = rowsB.filter((t) => t.includes('撞头')).length;
assert(bonkCount >= 1, `参数B 下至少 1 个平台标记撞头阻挡（${bonkCount}）`);
await page.click('.param-tab[data-set="A"]');
await page.waitForTimeout(100);

// 3. 目标判定给出可行跳法
const verdict = await page.textContent('#target-verdict');
assert(verdict.includes('可行跳法'), '目标平台给出可行跳法：' + verdict.trim().slice(0, 40));

// 4. 载入轨迹并逐步查看
await page.click('#btn-show-route');
await page.waitForTimeout(200);
const stepInfo = await page.textContent('#step-info');
assert(stepInfo.includes('策略'), '轨迹载入并显示策略说明');
const before = await page.textContent('#step-frame-num');
await page.click('#step-next');
const after = await page.textContent('#step-frame-num');
assert(after !== before && after.includes('帧 2'), '逐步播放推进到第 2 帧');
await page.click('#step-last');
const lastFrame = await page.textContent('#step-frame-num');
assert(/帧 \d+\//.test(lastFrame), '跳到轨迹末尾：' + lastFrame);

// 5. 切换参数集 B，连通性对比出现差异
await page.click('.param-tab[data-set="B"]');
await page.waitForTimeout(200);
const cmpText = await page.textContent('#compare-list');
assert(cmpText.includes('参数B') || cmpText.includes('不再可达'), '两套参数连通性差异已列出');
const verdictB = await page.textContent('#target-verdict');
assert(verdictB.includes('跳不过'), '参数B 对目标给出跳不过原因');

// 6. 试玩模式：进入后角色生成，按方向键移动
await page.click('.param-tab[data-set="A"]');
await page.click('#btn-play');
await page.waitForTimeout(300);
const playVisible = await page.$eval('#play-bar', (el) => getComputedStyle(el).display !== 'none');
assert(playVisible, '试玩栏显示');
// 先重置到出生点，避免之前的预览状态残留
await page.keyboard.press('KeyR');
await page.waitForTimeout(200);
const pfBefore = await page.evaluate(() => {
  const f = window.JR.app.playFrame;
  return f ? { x: f.x, y: f.y } : null;
});
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(500);
await page.keyboard.up('ArrowRight');
const pfAfter = await page.evaluate(() => {
  const f = window.JR.app.playFrame;
  return f ? { x: f.x, y: f.y } : null;
});
assert(pfBefore && pfAfter && Math.abs(pfAfter.x - pfBefore.x) > 5, `试玩角色响应右键移动（${pfBefore?.x.toFixed(1)} → ${pfAfter?.x.toFixed(1)}）`);

// 试玩跳跃：重置后原地起跳
await page.keyboard.press('KeyR');
await page.waitForTimeout(200);
const yBefore = (await page.evaluate(() => window.JR.app.playFrame)).y;
await page.keyboard.down('Space');
await page.waitForTimeout(250);
const yJump = (await page.evaluate(() => window.JR.app.playFrame)).y;
await page.keyboard.up('Space');
assert(yJump < yBefore - 10, `试玩跳跃生效（y ${yBefore.toFixed(1)} → ${yJump.toFixed(1)}）`);
await page.click('#btn-stop-play-2');
await page.waitForTimeout(200);

// 7. 存档：保存并出现在列表（dialog 监听必须先于点击注册）
page.once('dialog', (d) => d.accept('e2e测试关卡'));
await page.click('#btn-save');
await page.waitForTimeout(300);
const saveRows = await page.$$eval('.save-row', (r) => r.length);
assert(saveRows >= 1, `关卡保存到列表（${saveRows} 条）`);

// 8. 无 JS 错误
assert(errors.length === 0, errors.length ? '无页面错误：' + errors.join(' | ') : '全程无页面错误');

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
