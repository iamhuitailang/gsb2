// 截图验证: multi 两解展示 与 回路高亮
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5199/';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1360,1200'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1360, height: 1200 });

async function importJson(json) {
  writeFileSync('/tmp/lvl.json', JSON.stringify(json));
  const chooser = page.waitForFileChooser();
  await page.click('#btn-import');
  await (await chooser).accept(['/tmp/lvl.json']);
  // 文件读取是异步的, 等消息条明确出现导入结论(不能只看渲染计数, 初始渲染就 >0)
  await page.waitForFunction(
    () => {
      const t = document.querySelector('.message')?.textContent ?? '';
      return t.includes('导入成功') || t.includes('导入被拒绝');
    },
    { timeout: 8000 },
  );
}

// ---- 场景 1: 多解布局(两个独立块, 每块的自由片两朝向都能把光送到本块目标 => 2x2=4 解) ----
// 布局取自 solver 单元测试中已验证 status=multi 的用例
await page.goto(URL, { waitUntil: 'networkidle0' });
await page.waitForSelector('.board');
// 先把棋盘调到 8x8(默认 6x6), 等待重渲染稳定
const rendersAtStart = await page.evaluate(() => window.__renderCount);
await page.select('#size-select', '8');
await page.waitForFunction(
  (n) => (window.__renderCount ?? 0) > n,
  { timeout: 5000 },
  rendersAtStart,
);
const multiLevel = {
  format: 'light-path-puzzle/v1',
  name: '多解验证关',
  size: 8,
  cells: [
    // 块 A
    { r: 2, c: 0, kind: 'source', dir: 1, colors: 1 },
    { r: 2, c: 2, kind: 'mirror', orient: 0, locked: false },
    { r: 4, c: 2, kind: 'mirror', orient: 1, locked: true },
    { r: 4, c: 4, kind: 'mirror', orient: 0, locked: true },
    { r: 0, c: 2, kind: 'mirror', orient: 0, locked: true },
    { r: 0, c: 4, kind: 'mirror', orient: 1, locked: true },
    { r: 3, c: 4, kind: 'target', required: 0 },
    // 块 B(右下)
    { r: 5, c: 3, kind: 'source', dir: 1, colors: 2 },
    { r: 5, c: 5, kind: 'mirror', orient: 0, locked: false },
    { r: 7, c: 5, kind: 'mirror', orient: 1, locked: true },
    { r: 7, c: 7, kind: 'mirror', orient: 0, locked: true },
    { r: 3, c: 5, kind: 'mirror', orient: 0, locked: true },
    { r: 3, c: 7, kind: 'mirror', orient: 1, locked: true },
    { r: 6, c: 7, kind: 'target', required: 0 },
  ],
};
await importJson(multiLevel);
const importMsg = await page.$eval('.message', (el) => el.textContent);
console.log('导入消息:', importMsg.replace(/\s+/g, ' ').trim());
await page.click('#btn-solve');
try {
  await page.waitForSelector('.badge.status-multi', { timeout: 8000 });
} catch {
  const anyBadge = await page.$eval('.badge', (el) => el.textContent).catch(() => '无徽章');
  const msg = await page.$eval('.message', (el) => el.textContent).catch(() => '无消息');
  console.log('实际徽章:', anyBadge, '| 消息:', msg.replace(/\s+/g, ' ').trim());
  throw new Error('multi 关卡未得到 multi 结论');
}
const solPanels = await page.$$('[data-load-sol]');
console.log('multi 摆法按钮数:', solPanels.length);
const seq = await page.$$eval('.solution-list code', (els) => els.map((e) => e.textContent));
console.log('两组摆法朝向:', JSON.stringify(seq));
await page.screenshot({ path: '/tmp/shot-multi.png' });

// 点第二组放入试玩
await page.click('[data-load-sol="1"]');
await page.waitForFunction(
  () => document.querySelector('.mode-switch button.active')?.textContent === '试玩转动',
);
await page.waitForSelector('.beam-layer path');
await page.screenshot({ path: '/tmp/shot-multi-play.png' });

// ---- 场景 2: 回路(光源射回自身) ----
await page.click('#back-edit');
const loopLevel = {
  format: 'light-path-puzzle/v1',
  name: '回路验证关',
  size: 5,
  cells: [
    { r: 0, c: 0, kind: 'source', dir: 1, colors: 1 },
    { r: 0, c: 3, kind: 'mirror', orient: 1, locked: true }, // \ 东->南
    { r: 3, c: 3, kind: 'mirror', orient: 0, locked: true }, // / 南->西
    { r: 3, c: 0, kind: 'mirror', orient: 1, locked: true }, // \ 西->北, 回到源
    { r: 4, c: 4, kind: 'target', required: 0 },
  ],
};
await importJson(loopLevel);
await page.waitForSelector('.beam-layer path.loop');
const loopCells = await page.$$eval('.cell.loop-cell', (els) => els.length);
console.log('回路高亮格子数:', loopCells);
const endText = await page.$eval('[data-beam="0"]', (el) => el.textContent);
console.log('光束列表终止描述:', endText.replace(/\s+/g, ' ').trim());
await page.screenshot({ path: '/tmp/shot-loop.png' });

await browser.close();
console.log('截图完成: /tmp/shot-multi.png /tmp/shot-multi-play.png /tmp/shot-loop.png');
