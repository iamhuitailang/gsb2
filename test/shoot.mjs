/**
 * 用系统 Chrome 做真实浏览器验证并截图（不纳入默认测试）：
 *   node test/shoot.mjs
 * 产出 /tmp/shot-*.png，并在有 console/page 错误时非零退出。
 */
import { existsSync } from 'node:fs';

let puppeteer;
try {
  ({ default: puppeteer } = await import('puppeteer-core'));
} catch {
  console.log('未安装 puppeteer-core（npm i -D puppeteer-core），跳过真实浏览器截图。');
  process.exit(0);
}

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.log('未找到 Chrome/Chromium，跳过真实浏览器截图。');
  process.exit(0);
}

const url = 'file://' + process.cwd() + '/index.html';
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--allow-file-access-from-files', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));

await page.goto(url + '#play', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 400));

// 切成日语，截试玩页（含跨语言回退徽章）
const selects = await page.$$('.controls select');
await selects[0].select('ja-JP');
await new Promise((r) => setTimeout(r, 200));
await page.screenshot({ path: '/tmp/shot-play-ja.png', fullPage: true });

// 回到中文并把数量设为 0，验证零数量
await selects[0].select('zh-CN');
await page.click('.btn-preset[data-count="0"]');
await new Promise((r) => setTimeout(r, 150));
await page.screenshot({ path: '/tmp/shot-play-zero.png', fullPage: false });
await page.click('.btn-preset[data-count="2"]');

// 质检页
await page.evaluate(() => location.replace('#qa'));
await page.waitForSelector('.issue');
await new Promise((r) => setTimeout(r, 200));
await page.screenshot({ path: '/tmp/shot-qa.png', fullPage: true });

// Diff 页：填入修订 -> 应用
await page.evaluate(() => location.replace('#diff'));
await new Promise((r) => setTimeout(r, 200));
const buttons = await page.$$('button');
for (const b of buttons) {
  const t = await b.evaluate((el) => el.textContent);
  if (t?.includes('填入 ja-JP 示例修订')) await b.click();
}
await new Promise((r) => setTimeout(r, 150));
for (const b of await page.$$('button')) {
  const t = await b.evaluate((el) => el.textContent);
  if (t?.includes('应用更新并对比')) await b.click();
}
await page.waitForSelector('.diff-row');
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: '/tmp/shot-diff.png', fullPage: true });

const rowCount = await page.$$eval('.diff-row', (els) => els.length);
const textChanged = await page.$$eval('.diff-text-changed', (els) => els.length);
const sourceOnly = await page.$$eval('.diff-source-only', (els) => els.length);
console.log(`browser ok: diff rows=${rowCount} text=${textChanged} source-only=${sourceOnly}`);

await browser.close();

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('screenshots: /tmp/shot-play-ja.png /tmp/shot-play-zero.png /tmp/shot-qa.png /tmp/shot-diff.png');
