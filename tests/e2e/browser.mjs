/**
 * 浏览器端到端测试：真实 Chromium + 真实 Web Audio。
 * 自包含启动 Vite，跑完自动关闭。运行：npm run test:e2e
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = 5199;
const BASE = `http://localhost:${PORT}`;
const EXECUTABLE =
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1255/` +
  'chrome-headless-shell-mac-arm64/chrome-headless-shell';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.error(`  ✖ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error('Vite dev server 启动超时');
}

const repoRoot = new URL('../..', import.meta.url).pathname;
const vite = spawn(`${repoRoot}node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
});
vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

try {
  await waitForServer(BASE);
  await page.goto(BASE);

  // ---- 启动遮罩 ----
  await page.getByRole('button', { name: '开始演奏' }).click();
  await page.waitForFunction(
    () => document.querySelector('#engine-status')?.textContent?.includes('就绪'),
    { timeout: 10000 },
  );
  const status = await page.textContent('#engine-status');
  check('引擎就绪且 14/16 样本可用', status === '就绪 · 14/16 个样本可用', status);

  // ---- 坏样本横幅指出键区 ----
  const banner = await page.textContent('#load-banner');
  check('横幅指出 E3·重敲损坏', banner.includes('E3 · 重敲'), banner);
  check('横幅指出 G4·轻敲缺失', banner.includes('G4 · 轻敲'), banner);
  check('横幅给出文件名', banner.includes('52-hard.wav') && banner.includes('67-soft.wav'));

  // ---- 样本状态面板 ----
  const okRows = await page.locator('.status-row.ok').count();
  const badRows = await page.locator('.status-row.bad').count();
  check('状态面板 14 条可用', okRows === 14, `实际 ${okRows}`);
  check('状态面板 2 条故障', badRows === 2, `实际 ${badRows}`);
  const badText = (await page.locator('.status-row.bad').allInnerTexts()).join('');
  check('故障行包含损坏与缺失描述', badText.includes('解码失败') && badText.includes('文件缺失'));

  // ---- 琴键故障标记 ----
  const faultKeys = await page.locator('.key.fault').count();
  check('两个故障键区在键盘上打叉', faultKeys === 2, `实际 ${faultKeys}`);

  // ---- 弹一个音：发声日志显示实际样本 ----
  await page.keyboard.press('q'); // C4 = 60，重敲层（默认力度 96）
  await page.waitForSelector('.voice-row.start');
  const firstRow = await page.locator('.voice-row.start').first().innerText();
  check('发声日志记录 C4', firstRow.includes('C4'), firstRow);
  check('日志展示实际样本根音与理由', firstRow.includes('样本 C4') && firstRow.includes('根音精确匹配'), firstRow);
  check('琴键上浮层显示命中样本', (await page.locator('.key-used').count()) >= 1);

  // ---- 轻敲力度：换层 + 移调 ----
  await page.getByRole('button', { name: '轻敲' }).click();
  await page.keyboard.press('w'); // D4 = 62，无 62 根音，应移调
  await sleep(100);
  const rows = await page.locator('.voice-row.start').allInnerTexts();
  const softRow = rows.find((r) => r.includes('D4'));
  check('低力度走轻敲层', !!softRow && softRow.includes('轻敲'), softRow ?? '');
  check('无精确根音时展示移调倍率与来源', !!softRow && softRow.includes('移调'), softRow ?? '');

  // ---- 持续段：按住可续、松开进尾音 ----
  await page.getByRole('button', { name: '重敲' }).click();
  // 先等之前的一次性钟声自然衰减完，避免声部计数互相干扰
  await page.waitForFunction(
    () => document.querySelector('#voice-count')?.textContent?.includes('活动声部 0'),
    { timeout: 8000 },
  );
  await page.keyboard.down('q'); // C4 是循环样本
  await sleep(250);
  const heldCount = await page.textContent('#voice-count');
  check('按住期间声部保持活动（恰好 1 个）', heldCount.includes('活动声部 1'), heldCount);
  await page.keyboard.up('q');
  await page.waitForFunction(
    () => document.querySelector('.voice-rows')?.textContent?.includes('松开进尾音'),
    { timeout: 6000 },
  );
  check('松开后产生 released 尾音记录', true);

  // ---- 接头试听面板 ----
  // 6 个循环样本声明中 G4·轻敲是缺失样本，加载后可用 5 个
  const spliceOptions = await page.locator('#splice-panel select option').count();
  check('接头面板列出 5 个可用循环样本（故障的 G4·轻敲已隔离）', spliceOptions === 5, `实际 ${spliceOptions}`);
  await page.locator('#splice-panel input[type=range]').fill('0');
  await page.getByRole('button', { name: '试听原始接头（0ms）' }).click();
  await sleep(300);
  await page.locator('#splice-panel input[type=range]').fill('40');
  await sleep(300);
  const xfText = await page.textContent('.xf-value');
  check('交叉淡化可调到 40ms', xfText.includes('40'), xfText);

  // ---- 录音 / 重放 ----
  await page.getByRole('button', { name: /录制/ }).click();
  for (const key of ['q', 'w', 'e']) {
    await page.keyboard.press(key);
    await sleep(80);
  }
  await page.getByRole('button', { name: '■ 停止' }).click();
  const recStatus = await page.textContent('.rec-status');
  check('录音停止后显示 6 个事件（3 on + 3 off）', /已记录 6 个事件/.test(recStatus), recStatus);

  const beforeReplay = await page.locator('.voice-row.start').count();
  await page.getByRole('button', { name: '▶ 重放' }).click();
  await page.waitForFunction(
    (n) => document.querySelectorAll('.voice-row.start').length > n,
    beforeReplay,
  );
  check('重放产生新的发声记录', true);

  // ---- 导出 JSON ----
  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出 JSON' }).click(),
  ]);
  check('JSON 导出文件名正确', jsonDownload.suggestedFilename() === 'bell-recording.json');
  const jsonPath = await jsonDownload.path();
  check('JSON 文件已落盘', !!jsonPath && existsSync(jsonPath));

  // ---- 导出 WAV（离线渲染，与试听同一引擎路径）----
  const [wavDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出 WAV' }).click(),
  ]);
  check('WAV 导出文件名正确', wavDownload.suggestedFilename() === 'bell-recording.wav');
  const stream = await wavDownload.createReadStream();
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const buf = Buffer.concat(chunks);
  check('WAV 以 RIFF 头开始', buf.subarray(0, 4).toString() === 'RIFF');
  check('WAV 包含 PCM 数据（大于 44 字节头）', buf.length > 44, `实际 ${buf.length}`);

  // ---- 发声上限规则：边按边轮询，活动声部永远不超过上限 ----
  await page.waitForFunction(
    () => document.querySelector('#voice-count')?.textContent?.includes('活动声部 0'),
    { timeout: 8000 },
  );
  await page.locator('#voice-policy input[type=range]').fill('4');
  await page.locator('h1').click(); // 让滑块失焦，避免焦点吞键
  const observedCounts = [];
  for (const key of ['z', 'x', 'c', 'v', 'b', 'n']) {
    await page.keyboard.down(key);
    await sleep(80);
    const badge = await page.textContent('#voice-count');
    observedCounts.push(Number((badge.match(/\d+/) ?? ['0'])[0]));
  }
  for (const key of ['z', 'x', 'c', 'v', 'b', 'n']) await page.keyboard.up(key);
  check(
    '6 键齐奏、上限 4 时活动声部从未超过 4',
    observedCounts.every((n) => n <= 4) && Math.max(...observedCounts) === 4,
    `观测序列 ${observedCounts.join(',')}`,
  );
  // 抢断刚发生时，最新两条结束行应是 voice-limit
  const endRows = await page.locator('.voice-row.end').allInnerTexts();
  const latestSteals = endRows.slice(0, 2).filter((r) => r.includes('超上限抢断')).length;
  check('最新两条结束记录为超上限抢断', latestSteals === 2, endRows.slice(0, 2).join(' | '));
  // 一次性样本自然衰减最长约 3.5s，等它们全部自然结束，验证没有长鸣音
  await page.waitForFunction(
    () => document.querySelector('#voice-count')?.textContent?.includes('活动声部 0'),
    { timeout: 8000 },
  );
  check('自然衰减后活动声部归零（无长鸣音）', true);

  // ---- Panic ----
  for (const key of ['z', 'x', 'c']) await page.keyboard.down(key);
  await sleep(150);
  await page.getByRole('button', { name: /全部停止/ }).click();
  await sleep(300);
  const afterPanic = await page.textContent('#voice-count');
  check('Panic 后活动声部归零', afterPanic.includes('活动声部 0'), afterPanic);
  for (const key of ['z', 'x', 'c']) await page.keyboard.up(key);

  // ---- 控制台无意外错误 ----
  const unexpected = consoleErrors.filter((e) => !e.includes('favicon'));
  check('浏览器控制台无错误', unexpected.length === 0, unexpected.join(' | '));
} catch (err) {
  failures++;
  console.error('  ✖ 端到端流程异常：', err);
} finally {
  await browser.close();
  vite.kill();
}

console.log(failures === 0 ? '\n全部端到端检查通过' : `\n${failures} 项端到端检查失败`);
process.exit(failures === 0 ? 0 : 1);
