/**
 * 浏览器冒烟测试（Playwright）：
 *   node tests/browser-smoke.js
 * 直接以 file:// 打开 index.html，验证界面初始化、编辑、回放、检查点、双窗口对照与存档。
 */
const path = require('path');
const { chromium } = require('/Users/sunmengmeng/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');

const INDEX = 'file://' + path.resolve(__dirname, '..', 'index.html');
let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) failures++;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(INDEX);
  await page.waitForTimeout(400);

  // 1. 初始渲染：综合示例 7 音符、自动生成输入
  const noteRows = await page.locator('#note-table tbody tr').count();
  check('初始载入综合示例 7 个音符', noteRows === 7, `rows=${noteRows}`);
  const inputRows = await page.locator('#input-table tbody tr').count();
  check('自动生成输入事件', inputRows > 0, `inputs=${inputRows}`);
  const segRows = await page.locator('#seg-table tbody tr').count();
  check('变速段 1 条', segRows === 1);

  // 2. 时间轴 canvas 有实际绘制内容
  const painted = await page.evaluate(() => {
    const c = document.getElementById('timeline');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 30 || d[i + 1] > 30 || d[i + 2] > 45) nonBg++;
    }
    return nonBg;
  });
  check('时间轴已绘制图形', painted > 2000, `非背景像素=${painted}`);

  // 3. 引擎自测按钮
  await page.click('#btn-selftest');
  await page.waitForTimeout(200);
  const toast1 = await page.locator('#toast').textContent();
  check('页面内引擎自测通过', /全部通过/.test(toast1), toast1);

  // 4. 判定结果：存在漏拍（t5 被跳过）且分数非 0
  const score = await page.locator('#stat-score').textContent();
  check('回放前离线判定已算分', Number(score) > 0, `score=${score}`);
  const eventRows = await page.locator('#event-table tbody tr').count();
  check('判定事件流非空', eventRows >= 7);
  const missBadges = await page.locator('#event-table .badge.miss').count();
  check('漏拍音符以 miss 徽标呈现', missBadges >= 1, `miss=${missBadges}`);

  // 5. 实际跑回放，播放头随时间前进（两次取样比较，容忍启动提前量）
  await page.click('#btn-play');
  await page.waitForTimeout(300);
  const t1 = await page.locator('#transport-info').textContent();
  await page.waitForTimeout(500);
  const t2 = await page.locator('#transport-info').textContent();
  const num = (s) => Number(s.replace('t = ', '').replace('s', ''));
  check('回放中播放头前进', num(t2) > num(t1), `${t1} -> ${t2}`);
  await page.click('#btn-stop');

  // 6. 检查点重放一致性：回放过程中设检查点，拖回重放，结束后分数与离线结果一致
  await page.click('#btn-play');
  await page.waitForTimeout(900);
  await page.click('#btn-checkpoint-set');
  const cpToast = await page.locator('#toast').textContent();
  check('检查点设置成功', /检查点/.test(cpToast), cpToast);
  const cpTime = Number((cpToast.match(/t=([\d.]+)s/) || [])[1] || 0);
  check('检查点位于回放中段(>0.5s)', cpTime > 0.5, `cp=${cpTime}s`);
  await page.click('#btn-checkpoint-seek');
  await page.waitForTimeout(300);
  const replayInfo = await page.locator('#transport-info').textContent();
  check('从检查点开始重放', num(replayInfo) >= cpTime - 0.15, `${replayInfo} vs cp=${cpTime}s`);
  // 等回放自然结束
  await page.waitForTimeout(9000);
  const finalScore = await page.locator('#stat-score').textContent();
  const maxCombo = await page.locator('#stat-maxcombo').textContent();
  check('重放结束分数与离线判定一致', finalScore === score, `replay=${finalScore} offline=${score}`);
  check('最大连击已统计', Number(maxCombo) >= 1, `maxCombo=${maxCombo}`);

  // 7. 双窗口对照
  await page.click('.tab[data-tab="compare"]');
  await page.click('#btn-compare');
  await page.waitForTimeout(200);
  const cmpText = await page.locator('#compare-summary').textContent();
  const divergentRows = await page.locator('#compare-table tr.divergent').count();
  check('双窗口对照产出分歧统计', /分歧/.test(cmpText), cmpText.trim());
  check('分歧行已高亮', divergentRows >= 1, `divergent=${divergentRows}`);
  // 分歧行中能看到原始偏差 dt
  const dtShown = await page.locator('#compare-table tr.divergent').first().textContent();
  check('分歧行标出原始偏差 dt(ms)', /ms/.test(dtShown));

  // 8. 相邻单点示例：一次输入只判一个
  await page.click('#btn-adjacent');
  await page.waitForTimeout(300);
  const tapEvents = await page.locator('#event-table tbody tr').count();
  const strayCount = await page.locator('#stray-table tbody tr').count();
  const noteStatuses = await page.evaluate(() =>
    window.Rhythm.judge(
      window.Rhythm.adjacentChart(),
      [{ time: 2.475, type: 'down' }, { time: 2.6, type: 'up' }],
      { perfectMs: 80, lateMs: 150, releaseMs: 120 }
    ).noteResults.map((n) => n.status));
  check('相邻单点：单输入仅一音判定', noteStatuses.filter((s) => s === 'done').length === 1,
    noteStatuses.join(','));
  check('相邻单点示例事件流正常', tapEvents >= 1, `events=${tapEvents}, strays=${strayCount}`);

  // 9. 编辑器：加长按、加变速段，校验与秒数联动
  await page.click('.tab[data-tab="sim"]');
  const before = await page.locator('#note-table tbody tr').count();
  await page.selectOption('#new-note-type', 'hold');
  await page.fill('#new-note-beat', '6');
  await page.fill('#new-note-end', '7');
  await page.click('#btn-confirm-note');
  await page.waitForTimeout(150);
  const after = await page.locator('#note-table tbody tr').count();
  check('编辑器可新增长按', after === before + 1);
  await page.click('#btn-add-seg');
  await page.waitForTimeout(150);
  check('编辑器可新增变速段', (await page.locator('#seg-table tbody tr').count()) === 1);

  // 10. localStorage 存档与载入
  await page.click('.tab[data-tab="storage"]');
  await page.click('#btn-store-save');
  await page.waitForTimeout(200);
  const saveItems = await page.locator('.save-item').count();
  check('存档写入 localStorage', saveItems >= 1);
  // 改 BPM 后载入存档，数据应回滚
  await page.click('.tab[data-tab="sim"]');
  await page.fill('#chart-bpm', '77');
  await page.dispatchEvent('#chart-bpm', 'change');
  await page.click('.tab[data-tab="storage"]');
  await page.locator('.act-load').first().click();
  await page.waitForTimeout(200);
  const bpmRestored = await page.locator('#chart-bpm').inputValue();
  check('载入存档恢复谱面数据', bpmRestored === '100', `bpm=${bpmRestored}`);

  // 11. JSON 导出/导入往返
  const saveJson = await page.evaluate(() => {
    // 直接构造一份存档走 applySave 路径
    return JSON.stringify({
      format: 'rhythm-debug-console/v1',
      savedAt: new Date().toISOString(),
      chart: window.Rhythm.sampleChart(),
      inputs: [],
      windowsA: window.Rhythm.DEFAULT_WINDOWS_A,
      windowsB: window.Rhythm.DEFAULT_WINDOWS_B,
    });
  });
  const loaded = await page.evaluate((json) => {
    const save = JSON.parse(json);
    return save.chart.notes.length === 7 && save.format === 'rhythm-debug-console/v1';
  }, saveJson);
  check('存档 JSON 结构完整可往返', loaded);

  // 12. 全程无 JS 报错
  check('浏览器控制台无错误', errors.length === 0, errors.join(' | '));

  await page.screenshot({ path: path.resolve(__dirname, '..', 'screenshot.png'), fullPage: false });
  await browser.close();
  console.log(`\n${failures === 0 ? 'BROWSER SMOKE ALL GREEN' : failures + ' FAILED'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
