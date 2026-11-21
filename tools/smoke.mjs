/* 浏览器冒烟测试（非项目运行依赖，仅用于本机验证） */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// 项目本身零依赖；冒烟脚本复用本机已有的 playwright（全局或 npx 缓存）
const require = createRequire(import.meta.url);
function loadPlaywright() {
  const candidates = [];
  try { candidates.push(path.join(execSync('npm root -g').toString().trim(), 'playwright')); } catch {}
  const npxRoot = path.join(process.env.HOME, '.npm/_npx');
  if (existsSync(npxRoot)) {
    for (const d of readdirSync(npxRoot)) {
      candidates.push(path.join(npxRoot, d, 'node_modules', 'playwright'));
    }
  }
  for (const c of candidates) {
    if (existsSync(c)) return require(c);
  }
  throw new Error('未找到 playwright，可执行: npm i -g playwright');
}
const { chromium } = loadPlaywright();

const here = path.dirname(fileURLToPath(import.meta.url));
const url = 'file://' + path.join(here, '..', 'index.html');
const shot = (n) => path.join(here, n + '.png');

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(url);
await page.waitForTimeout(600);

const checks = [];
const check = (name, cond) => { checks.push({ name, pass: !!cond }); if (!cond) console.error('FAIL:', name); };

// 1. 自检徽标
const badge = await page.textContent('#selftest-badge');
check('浏览器内自检全过', /自检 \d+\/\d+ 通过/.test(badge));

// 2. 两个面板都渲染出角色（canvas 非空）
async function canvasNonBlank(sel) {
  return page.$eval(sel, (c) => {
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
    return false;
  });
}
check('A 面板有渲染', await canvasNonBlank('#panel-a-root canvas.stage'));
check('B 面板有渲染', await canvasNonBlank('#panel-b-root canvas.stage'));

// 3. 切到缺素材版 + 西方向：应显示镜像替代
await page.selectOption('#panel-b-root select', 'missing');
// 用拖转盘方式把 B 镜头转到 270°
const dial = await page.$('#panel-b-root .dial');
const db = await dial.boundingBox();
// 直接点转盘左侧（W 方位，270°，缺方向）
await page.mouse.click(db.x + db.width * 0.18, db.y + db.height / 2);
await page.waitForTimeout(300);
await page.waitForTimeout(300);
const pillB = await page.textContent('#panel-b-root .badge-pill.subst, #panel-b-root .badge-pill.unresolved');
check('B 在缺方向时出现替代/未解决徽标', !!pillB);

// 4. 关掉镜像：应变为 unresolved
const mirrorChk = await page.$('#panel-b-root .panel-head input[type=checkbox]');
check('镜像复选框存在', !!mirrorChk);
await mirrorChk.uncheck();
await page.waitForTimeout(200);
const unresolved = await page.$('#panel-b-root .badge-pill.unresolved');
check('关闭镜像后显示无素材占位', !!unresolved);
await page.screenshot({ path: shot('smoke-missing-mirror-off') });
await mirrorChk.check();

// 5. 同步：拖动 A 的舞台，B 镜头角度跟随
const stageA = await page.$('#panel-a-root canvas.stage');
const sa = await stageA.boundingBox();
const before = await page.$$eval('.badge-pill', (els) => els[0].textContent);
await page.mouse.move(sa.x + 100, sa.y + sa.height / 2);
await page.mouse.down();
await page.mouse.move(sa.x + 260, sa.y + sa.height / 2, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
const rows = await page.$$eval('.badge-pill', (els) => els.map((e) => e.textContent));
check('同步开启时双面板镜头角度一致', rows[0] === rows[2]);
await page.screenshot({ path: shot('smoke-synced-panels') });

// 6. 短过渡模式可切换
const blendRadio = await page.$('#panel-a-root input[value=blend]');
await blendRadio.check();
await page.mouse.move(sa.x + 260, sa.y + sa.height / 2);
await page.mouse.down();
await page.mouse.move(sa.x + 60, sa.y + sa.height / 2, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(120);
const transitPill = await page.$('#panel-a-root .badge-pill.transit');
check('短过渡期间出现过渡徽标', !!transitPill);
await page.waitForTimeout(400);

// 7. 扫掠按钮
await page.click('#btn-sweep');
await page.waitForTimeout(3400);
const toast = await page.textContent('#toast');
check('扫掠完成且首尾一致', /扫掠完成/.test(toast) && /✓/.test(toast));

// 8. 导出按钮触发下载
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#panel-a-root .exportBtn'),
]);
check('面板配置可下载', download.suggestedFilename().endsWith('.config.json'));

// 9. 锚点对齐开关 + 锚点编辑不报错
await page.click('#panel-a-root .filmstrip .thumb:nth-child(2)');
const axInput = await page.$('#panel-a-root .anchor-fields input[type=number]:first-of-type');
await axInput.fill('95');
await axInput.dispatchEvent('change');
await page.waitForTimeout(150);
const ax = await axInput.inputValue();
check('锚点 X 可编辑并回显', ax === '95');
const alignChk = await page.$('#panel-a-root .side-box input[type=checkbox]:first-of-type');
await alignChk.uncheck();
await page.waitForTimeout(150);
check('关闭锚点对齐仍正常渲染', await canvasNonBlank('#panel-a-root canvas.stage'));
await page.screenshot({ path: shot('smoke-anchor-edited') });

// 10. 报告区有内容
const reportItems = await page.$$eval('#panel-b-root .report .item', (els) => els.length);
check('缺素材面板报告列出缺口', reportItems >= 2);

check('全程无 JS 错误', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));

let pass = 0;
for (const c of checks) {
  console.log((c.pass ? '✓' : '✗') + ' ' + c.name);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} 冒烟检查通过`);
await browser.close();
process.exit(pass === checks.length ? 0 : 1);
