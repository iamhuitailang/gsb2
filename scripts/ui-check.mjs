import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4199/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DIR = 'tmp/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (c, m) => (c ? console.log('  ✓', m) : (fails.push(m), console.error('  ✗', m)));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__CD__ && window.__CD__.getState()');
await sleep(800);

const wpCount = () => page.evaluate(() => window.__CD__.getProject().route.waypoints.length);

// 路线 Tab
const tabs = await page.$$('.tab-btn');
await tabs[2].click();
await sleep(300);
check((await page.$$('.wp-card')).length === 10, '路线 Tab 渲染 10 张路径点卡片');
await page.screenshot({ path: `${DIR}/05-route-tab.png` });

// 在角色位置追加
const before = await wpCount();
await page.evaluate(() => [...document.querySelectorAll('.tab-route .btn')].find((b) => b.textContent.includes('在假角色当前位置追加')).click());
await sleep(200);
check((await wpCount()) === before + 1, '在角色当前位置追加路径点生效');
check((await page.$$('.wp-card')).length === before + 1, '新路径点卡片已渲染');

// 地面点击加点
await page.evaluate(() => [...document.querySelectorAll('.tab-route .btn')].find((b) => b.textContent.includes('点击地面添加')).click());
await sleep(150);
const canvas = await page.$('#three-canvas');
const box = await canvas.boundingBox();
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.62);
await sleep(250);
check((await wpCount()) === before + 2, '点击地面成功添加路径点');

// 删除一张卡
const cards = await page.$$('.wp-card');
const del = await cards[cards.length - 1].$('.icon-btn.danger');
await del.click();
await sleep(200);
check((await wpCount()) === before + 1, '删除路径点生效');

// 跟随/遮挡 Tab
(await page.$$('.tab-btn'))[1].click();
await sleep(300);
await page.screenshot({ path: `${DIR}/06-camera-tab.png` });
check(!!(await page.$('.tab-camera')), '跟随/遮挡 Tab 正常渲染');

// 回到区域 Tab，展开边界段并截图
(await page.$$('.tab-btn'))[0].click();
await sleep(200);
const heads = await page.$$('.section-head');
// 第 5 个 section 是「镜头边界」
await heads[4].click().catch(() => {});
await sleep(200);
await page.screenshot({ path: `${DIR}/07-zone-bounds.png` });

check(errors.length === 0, `UI 操作无运行时错误${errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
console.log(fails.length ? `\nUI 巡检失败 ${fails.length}\n` : '\nUI 巡检全部通过 ✅\n');
process.exit(fails.length ? 1 : 0);
