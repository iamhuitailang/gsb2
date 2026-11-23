// 真实浏览器冒烟测试：构建产物 + headless Chromium（SwiftShader WebGL2）
// 运行：node tests/smoke.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://127.0.0.1:4173';
const shotsDir = new URL('./screenshots/', import.meta.url);
await mkdir(shotsDir, { recursive: true });

const server = spawn(
  'npx',
  ['vite', 'preview', '--port', '4173', '--strictPort', '--host', '127.0.0.1'],
  { cwd: new URL('..', import.meta.url), stdio: 'ignore' },
);
// 轮询端口直到服务可用
for (let i = 0; i < 50; i++) {
  try {
    const res = await fetch(BASE);
    if (res.ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.log(`  ✗ ${name} ${detail}`);
    failures.push(name);
  }
};

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#st-total')?.textContent !== '0',
    { timeout: 10000 });

  // 1. 稀疏场景统计
  const stats1 = await statsOf(page);
  console.log('稀疏场景统计:', stats1);
  check('稀疏场景 11 个实例', stats1.total === 11, JSON.stringify(stats1));
  check('3 个逻辑批次', stats1.batches === 3);
  check('分块 draw call = ceil(11/32)=1', stats1.calls === 1);
  check('无控制台错误', errors.length === 0, errors.join(' | '));

  // 2. 点击标签 #3 正下方（标签定位在实例上方 14px），应命中 #3
  const canvas = page.locator('#gl');
  const box = await canvas.boundingBox();
  await clickLabel(page, 3);
  await page.waitForFunction(() => {
    const t = document.querySelector('#pk-id')?.textContent ?? '';
    return t.startsWith('#');
  }, { timeout: 5000 });
  const pick1 = await pickInfo(page);
  console.log('首次点选:', pick1);
  check('标签下方点击命中实例 #3', pick1.hitId === 3, JSON.stringify(pick1));
  check('命中面为 ±X/Y/Z', /^[+-][XYZ]$/.test(pick1.face), pick1.face);
  check('有世界命中点', pick1.world !== '—');
  check('有局部命中点', pick1.local !== '—');
  check('深度在 0~1 区间', pick1.depth >= 0 && pick1.depth < 1, String(pick1.depth));
  check('邻域网格 25 格', await page.locator('.neighbor .cell').count() === 25);
  check('十字准星显示', await page.locator('#crosshair').isVisible());

  // 3. 点击画面角落（HUD 不拦截指针事件）应返回背景
  await page.mouse.click(box.x + 3, box.y + 3);
  await page.waitForTimeout(150);
  const pickBg = await pickInfo(page);
  check('空白处点击返回背景', pickBg.rawId.includes('背景'), pickBg.rawId);

  // 4. 密集场景：125 实例、5 批、ceil(125/32)=4 次 draw call
  await page.click('#btn-dense');
  await page.waitForFunction(() => document.querySelector('#st-total')?.textContent === '125');
  const stats2 = await statsOf(page);
  console.log('密集场景统计:', stats2);
  check('密集场景 125 个实例', stats2.total === 125);
  check('5 个逻辑批次', stats2.batches === 5);
  check('draw call = 4', stats2.calls === 4, String(stats2.calls));
  check('缓冲容量 >= 125', stats2.capacity >= 125, String(stats2.capacity));

  // 5. 密集场景多点几次：点编号标签下方，核对“标签编号 vs 实际最前实例”
  // 标签可能被更近的实例遮挡——此时点选必须返回遮挡者（深度点选的核心保证）
  const ids = new Set();
  const labelTexts = await page.locator('.inst-label').allTextContents();
  const sampleIds = [...new Set(labelTexts.map((t) => Number(t.match(/#(\d+)/)[1])))]
    .filter((n) => n > 0)
    .slice(0, 6);
  let occlusionObserved = false;
  for (const id of sampleIds) {
    await clickLabel(page, id);
    await page.waitForTimeout(120);
    const p = await pickInfo(page);
    check(`点标签 #${id} 下方返回真实存在的实例`, p.hitId > 0 && p.hitId <= 125,
      `got ${p.hitId}`);
    if (p.hitId !== id) occlusionObserved = true;
    if (p.hitId) ids.add(p.hitId);
  }
  console.log('多点选命中的编号集合:', [...ids], '遮挡发生:', occlusionObserved);
  check('多点选至少命中 3 个不同实例', ids.size >= 3, JSON.stringify([...ids]));
  // 对未被遮挡的标签，点选编号必须与标签完全一致
  await clickLabel(page, 2);
  await page.waitForTimeout(100);
  check('无遮挡时标签编号与点选一致', (await pickInfo(page)).hitId === 2);

  // 6. 重排顺序：slot 变化但稳定编号不变
  const selBefore = await page.locator('#sel-id').textContent();
  const slotBefore = await page.locator('#sel-slot').textContent();
  await page.click('#btn-shuffle');
  await page.waitForTimeout(150);
  const selAfter = await page.locator('#sel-id').textContent();
  const slotAfter = await page.locator('#sel-slot').textContent();
  check('重排后稳定编号不变', selBefore === selAfter, `${selBefore} vs ${selAfter}`);
  check('重排后 slot 可能变化（编号/slot 同时展示）',
    /slot -?\d+/.test(slotAfter), `${slotBefore} => ${slotAfter}`);

  // 7. 删除选中：编号消失，slot 补位，再点不会选到已删编号
  const deletedId = (await pickInfo(page)).hitId;
  await page.click('#btn-sel-delete');
  await page.waitForTimeout(150);
  const stats3 = await statsOf(page);
  check('删除后总数 124', stats3.total === 124, String(stats3.total));
  // 在被删实例原标签位置附近点击，结果不应再是已删编号
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(150);
  const afterDelete = await pickInfo(page);
  check('删除后不会选中已消失编号', afterDelete.hitId !== deletedId,
    `deleted=${deletedId} now=${afterDelete.hitId}`);

  // 8. 批量隐藏 + 全部显示：先显式选中一个确定命中的实例
  const hideId = await pickAnyHit(page);
  await page.click('#btn-hide-selected');
  await page.waitForTimeout(150);
  const stats4 = await statsOf(page);
  check('隐藏后可见数 = 总数 - 1', stats4.visible === stats4.total - 1,
    `${stats4.visible} vs ${stats4.total}`);
  check('实画数量随隐藏减少', stats4.drawn === stats4.total - 1);
  await page.click('#btn-show-all');
  await page.waitForTimeout(150);
  const stats5 = await statsOf(page);
  check('全部显示后 drawn=total', stats5.drawn === stats5.total);

  // 9. 冻结视角 + 按记录坐标重测：冻结后旋转相机，重测仍按记录的物理像素执行
  const beforeFreeze = await pickAnyHitResult(page);
  const expectedId = beforeFreeze.hitId;
  check('冻结前取得有效命中', expectedId > 0, JSON.stringify(beforeFreeze));
  await page.click('#btn-freeze');
  await page.waitForFunction(
    () => document.querySelector('#hud-mode')?.textContent === 'FROZEN',
    { timeout: 5000 },
  );
  check('HUD 显示 FROZEN', (await page.locator('#hud-mode').textContent()) === 'FROZEN');
  // 冻结期间旋转视角（相机仍可交互，冻结的是“重测基准”的记录语义）
  await page.mouse.move(box.x + 400, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 260, { steps: 5 });
  await page.mouse.up();
  await page.click('#btn-repick');
  await page.waitForTimeout(150);
  const repick = await pickInfo(page);
  check('重测返回有效结果（编号或背景，均为真实渲染判定）',
    repick.rawId.includes('背景') || repick.hitId > 0, repick.rawId);
  check('点选日志带冻结标记',
    (await page.locator('#pick-log li').first().textContent()).includes('[冻结]'));
  // 解除冻结并恢复视角，再按同一坐标重测应回到原编号
  await page.click('#btn-freeze');
  await page.click('#btn-restore');
  await page.waitForTimeout(200);
  await page.click('#btn-repick');
  await page.waitForTimeout(150);
  const restored = await pickInfo(page);
  check('恢复视角后重测回到原编号', restored.hitId === expectedId,
    `${expectedId} vs ${restored.hitId}`);

  // 10. DPR=2 下物理像素 = CSS × 2
  await page.setViewportSize({ width: 1280, height: 800 });
  const dprPage = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  dprPage.on('pageerror', (e) => errors.push(String(e)));
  await dprPage.goto(BASE, { waitUntil: 'networkidle' });
  await dprPage.waitForFunction(() => document.querySelector('#st-total')?.textContent !== '0');
  const dpr = await dprPage.evaluate(() => window.devicePixelRatio);
  const c2 = await dprPage.locator('#gl').boundingBox();
  await dprPage.mouse.click(c2.x + 300, c2.y + 250);
  await dprPage.waitForTimeout(200);
  const pxText = await dprPage.locator('#pk-px').textContent();
  const m = pxText.match(/([\d.]+), ([\d.]+) \/ (\d+), (\d+)/);
  check('DPR=2 生效', dpr === 2, String(dpr));
  if (m) {
    const [, cssX, cssY, physX, physY] = m;
    check('物理像素 ≈ 2×CSS 像素',
      Math.abs(Number(physX) - Number(cssX) * 2) <= 2 &&
      Math.abs(Number(physY) - Number(cssY) * 2) <= 2,
      pxText);
  } else check('物理像素换算可解析', false, pxText);
  await dprPage.close();

  // 11. 选中实例后修改 transform 输入框，场景即时变化且仍选中同一编号
  const tId = await pickAnyHit(page);
  check(`#${tId} 选中成功`, tId > 0);
  // 输入框在 #panel 滚动容器内，直接滚容器再等待可见
  await page.evaluate(() => {
    const card = document.querySelector('#selection-card');
    document.querySelector('#panel').scrollTop = card.offsetTop;
  });
  await page.locator('#in-tx').waitFor({ state: 'visible' });
  await page.fill('#in-tx', '3.5');
  await page.dispatchEvent('#in-tx', 'change');
  await page.waitForTimeout(150);
  const panelId = await page.locator('#sel-id').textContent();
  check('移动后面板仍显示同一稳定编号', panelId.includes(`#${tId}`), panelId);

  // 12. localStorage 保存/刷新恢复
  await page.click('#btn-save');
  await page.waitForTimeout(200);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#st-total')?.textContent !== '0');
  const stats6 = await statsOf(page);
  check('刷新后从 localStorage 恢复布局', stats6.total === 124, String(stats6.total));
  const logCount = await page.locator('#pick-log li').count();
  check('点选记录持久化恢复', logCount > 0, String(logCount));

  // 13. 视锥剔除：平移相机让部分实例出屏，实画数量应严格下降
  await page.click('#btn-dense');
  await page.waitForFunction(() => document.querySelector('#st-total')?.textContent === '125');
  const full = await statsOf(page);
  await page.check('#chk-frustum');
  // Shift+左拖平移相机，把目标点移走，让边缘实例落到视锥外
  await page.mouse.move(box.x + 300, box.y + 400);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(box.x + 700, box.y + 400, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
  const culled = await statsOf(page);
  console.log('剔除前/后 drawn:', full.drawn, culled.drawn);
  check('视锥剔除使实画数量严格下降', culled.drawn < full.drawn,
    `${full.drawn} -> ${culled.drawn}`);
  await page.uncheck('#chk-frustum');
  await page.waitForTimeout(150);
  const unculled = await statsOf(page);
  check('关闭剔除后恢复全部绘制', unculled.drawn === unculled.total,
    `${unculled.drawn} vs ${unculled.total}`);

  await page.screenshot({
    path: new URL('dense.png', shotsDir).pathname,
    fullPage: false,
  });
  await page.click('#btn-sparse');
  await page.waitForTimeout(300);
  await page.screenshot({ path: new URL('sparse.png', shotsDir).pathname });
} catch (e) {
  failures.push(`异常: ${e.stack}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(`\n${failures.length === 0 ? '全部通过' : failures.length + ' 项失败'}`);
if (failures.length) console.log(failures.join('\n'));
process.exit(failures.length === 0 ? 0 : 1);

async function statsOf(p) {
  const txt = async (sel) =>
    Number((await p.locator(sel).textContent()).trim());
  const cap = await p.locator('#st-capacity').textContent();
  return {
    total: await txt('#st-total'),
    visible: await txt('#st-visible'),
    drawn: await txt('#st-drawn'),
    batches: await txt('#st-batches'),
    calls: await txt('#st-calls'),
    capacity: Number(cap.split('/')[0].trim()),
  };
}

async function pickInfo(p) {
  const rawId = (await p.locator('#pk-id').textContent()) || '';
  const m = rawId.match(/#(\d+)/);
  return {
    rawId,
    hitId: m ? Number(m[1]) : 0,
    face: (await p.locator('#pk-face').textContent()).trim(),
    world: (await p.locator('#pk-world').textContent()).trim(),
    local: (await p.locator('#pk-local').textContent()).trim(),
    depth: Number((await p.locator('#pk-depth').textContent()).trim()),
  };
}

// 点击编号标签下方的实例本体
async function clickLabel(p, id) {
  const loc = p
    .locator('.inst-label')
    .filter({ hasText: new RegExp(`^#${id}\\s`) })
    .first();
  await loc.waitFor({ state: 'visible', timeout: 5000 });
  const b = await loc.boundingBox();
  await p.mouse.click(b.x + b.width / 2, b.y + 26);
}

// 在可见标签里逐个尝试，直到点选真实命中一个实例（规避遮挡/出屏的偶然性）
async function pickAnyHitResult(p) {
  const ids = await visibleLabelIds(p);
  for (const id of ids) {
    await clickLabel(p, id);
    await p.waitForTimeout(100);
    const info = await pickInfo(p);
    if (info.hitId > 0) return info;
  }
  throw new Error('所有可见标签都未命中实例');
}

async function pickAnyHit(p) {
  return (await pickAnyHitResult(p)).hitId;
}

async function visibleLabelIds(p) {
  return p.locator('.inst-label').evaluateAll((els) => {
    const stage = document.querySelector('#stage').getBoundingClientRect();
    return els
      .filter((el) => {
        if (el.style.display === 'none') return false;
        const r = el.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.top >= stage.top &&
          r.bottom + 30 <= stage.bottom &&
          r.left >= stage.left &&
          r.right <= stage.right
        );
      })
      .map((el) => Number(el.textContent.match(/#(\d+)/)[1]));
  });
}

// 返回当前屏幕上可见、且标签下方 30px（实例本体所在）也在画布内的第一个标签 id
async function firstVisibleLabelId(p) {
  const ids = await visibleLabelIds(p);
  if (!ids.length) throw new Error('屏幕上没有可见标签');
  return ids[0];
}
