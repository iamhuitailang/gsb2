/**
 * 无头巡检：连接本机 Chrome，打开预览页面，沿整条路线逐点检查
 *  - 无 console / page 错误
 *  - 4 个区域都能进入
 *  - 至少出现一次非 clear 遮挡避让，且原因是中文非空
 *  - 暂停时检查器 DOM 有当前区域 / 最终参数
 *  - 保存项目 / 导出运行时配置会下载合法 JSON
 *  - 产出若干截图到 tmp/shots
 *
 * 用法：先 `npm run build && npm run preview`，再 `node scripts/headless-check.mjs`
 * 可用 BASE_URL / CHROME_PATH 覆盖默认值。
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173/';
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOT_DIR = 'tmp/shots';
const DOWNLOAD_DIR = 'tmp/downloads';
mkdirSync(SHOT_DIR, { recursive: true });
mkdirSync(DOWNLOAD_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=1600,900',
  ],
  defaultViewport: { width: 1600, height: 900 },
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  // 下载行为
  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: new URL(`file://${process.cwd()}/${DOWNLOAD_DIR}`).pathname,
    eventsEnabled: true,
  });

  console.log(`打开 ${BASE}`);
  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForFunction('window.__CD__ && window.__CD__.getState()', { timeout: 15000 });
  await sleep(1200); // 让首帧 / 阴影 / 混合稳定

  check(errors.length === 0, `页面加载无错误${errors.length ? `：\n    ${errors.join('\n    ')}` : ''}`);

  await page.screenshot({ path: join(SHOT_DIR, '01-plaza-debug.png') });

  // 切到往返并暂停，逐点巡检
  await page.evaluate(() => {
    const sel = document.getElementById('select-loop');
    sel.value = 'pingpong';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    window.__CD__.pause();
  });

  const duration = await page.evaluate(() => {
    // 通过时间轴 max 比例反推：直接读 time-label 不方便，改读 project route 计算
    return window.__CD__.getProject().route.waypoints.reduce((acc, w, i) => {
      if (i === 0) return acc + w.hold;
      return acc + w.moveTime + w.hold;
    }, 0);
  });

  const samples = [];
  const STEPS = 48;
  for (let i = 0; i <= STEPS; i++) {
    const t = (duration * i) / STEPS;
    await page.evaluate((tt) => window.__CD__.setTime(tt, true), t);
    await sleep(90); // 等待 snap 后的渲染帧
    const s = await page.evaluate(() => {
      const st = window.__CD__.getState();
      return {
        t: window.__CD__.getTime(),
        zone: st.zoneId,
        zoneName: st.zoneName,
        occ: st.occlusion.kind,
        reason: st.occlusion.reason,
        clamped: st.boundsClamped,
        pos: st.finalPosition,
        trans: st.transition.active,
      };
    });
    samples.push(s);
  }

  const zonesHit = new Set(samples.map((s) => s.zone).filter(Boolean));
  console.log('  巡检经过区域：', [...zonesHit].join(', '));

  // 打印 区域/遮挡 状态变化时间线，便于调机位与摆放
  let lastKey = '';
  console.log('  —— 状态时间线（变化时）——');
  for (const s of samples) {
    const key = `${s.zone}|${s.occ}`;
    if (key !== lastKey) {
      lastKey = key;
      console.log(
        `   t=${s.t.toFixed(1).padStart(5)}s ${(s.zoneName ?? '无区域').padEnd(8)} occ=${s.occ.padEnd(11)} clamp=${s.clamped ? 1 : 0} ${s.occ !== 'clear' ? '· ' + s.reason : ''}`,
      );
    }
  }
  console.log('  ————————————————————————');

  check(zonesHit.has('zone_plaza'), '进入过 开阔广场');
  check(zonesHit.has('zone_door'), '进入过 门洞区域');
  check(zonesHit.has('zone_alley'), '进入过 窄路区域');
  check(zonesHit.has('zone_overlook'), '进入过 转角观景区域');

  const occKinds = new Set(samples.map((s) => s.occ));
  console.log('  出现遮挡类型：', [...occKinds].join(', '));
  check(occKinds.has('pull-in') || occKinds.has('side-shift') || occKinds.has('combined') || occKinds.has('raise') || occKinds.has('forced'), '至少出现一次真实避让');

  const badReason = samples.find((s) => s.occ !== 'clear' && (!s.reason || s.reason.length < 4));
  check(!badReason, '每次避让都有非空中文原因');

  const nonFinite = samples.find((s) => s.pos.some((v) => !Number.isFinite(v)));
  check(!nonFinite, '所有镜头位置均为有限数值');

  // 边界 clamp 至少在门洞 / 窄路生效过（设计上会触边）
  check(samples.some((s) => s.clamped), '镜头边界至少触发过一次 clamp');

  check(errors.length === 0, `巡检过程无运行时错误${errors.length ? `：\n    ${errors.slice(0, 5).join('\n    ')}` : ''}`);

  // 找一个遮挡最明显的点截图
  const occSample = samples.find((s) => s.occ === 'pull-in' || s.occ === 'forced' || s.occ === 'combined') ?? samples.find((s) => s.occ !== 'clear');
  if (occSample) {
    await page.evaluate((t) => window.__CD__.setTime(t, true), occSample.t);
    await sleep(300);
    await page.screenshot({ path: join(SHOT_DIR, '02-occlusion-debug.png') });
    console.log(`  遮挡截图 t=${occSample.t.toFixed(2)}s kind=${occSample.occ} reason=${occSample.reason}`);
  }

  // 门洞点 + 游戏视角截图
  const doorT = await page.evaluate(() => {
    const wps = window.__CD__.getProject().route.waypoints;
    // wp_4 穿过门洞
    let t = 0;
    for (let i = 0; i < wps.length; i++) {
      if (i > 0) t += wps[i].moveTime;
      if (wps[i].id === 'wp_4') return t;
      t += wps[i].hold;
    }
    return 0;
  });
  await page.evaluate((t) => window.__CD__.setTime(t, true), doorT);
  await sleep(300);
  await page.screenshot({ path: join(SHOT_DIR, '03-door-debug.png') });
  await page.evaluate(() => window.__CD__.setViewMode('game'));
  await sleep(500);
  await page.screenshot({ path: join(SHOT_DIR, '04-door-game-view.png') });
  await page.evaluate(() => window.__CD__.setViewMode('debug'));

  // 暂停检查器 DOM 内容
  const insp = await page.evaluate(() => ({
    zone: document.getElementById('insp-zone')?.textContent?.trim(),
    reason: document.getElementById('insp-occ-reason')?.textContent?.trim(),
    finalPos: document.getElementById('insp-final-pos')?.textContent?.trim(),
    bounds: document.getElementById('insp-bounds')?.textContent?.trim(),
  }));
  check(!!insp.zone && insp.zone !== '—', `暂停时检查器显示区域：${insp.zone}`);
  check(!!insp.finalPos && insp.finalPos.includes('('), `暂停时检查器显示最终机位：${insp.finalPos}`);
  check(!!insp.reason, '暂停时检查器显示遮挡原因');
  console.log('  检查器边界：', insp.bounds);

  // 时间轴播放 / 暂停按钮
  await page.click('#btn-play');
  await sleep(300);
  const btnText = await page.$eval('#btn-play', (el) => el.textContent);
  check(btnText.includes('暂停'), '播放按钮切换为暂停态');
  await page.click('#btn-play');

  // 导出运行时配置
  const before = new Set(readdirSync(DOWNLOAD_DIR));
  await page.click('#btn-export-runtime');
  await waitForNewFile(DOWNLOAD_DIR, before, 8000);
  const runtimeFile = newestJson(DOWNLOAD_DIR, 'camera-config.runtime');
  check(!!runtimeFile, '运行时配置文件已下载');
  if (runtimeFile) {
    const json = JSON.parse(readFileSync(join(DOWNLOAD_DIR, runtimeFile), 'utf8'));
    check(json.format === 'tpc-camera-config' && json.formatVersion === 1, '运行时配置 format 正确');
    check(Array.isArray(json.zones) && json.zones.length === 4, `运行时配置含 4 个区域（实际 ${json.zones?.length}）`);
    check(json.zones[0].shape.type === 'box' && json.zones[0].transition, '区域含 shape / transition 运行时结构');
  }

  // 保存项目
  const before2 = new Set(readdirSync(DOWNLOAD_DIR));
  await page.click('#btn-save');
  await waitForNewFile(DOWNLOAD_DIR, before2, 8000);
  const projectFile = newestJson(DOWNLOAD_DIR, 'camera-debugger-project');
  check(!!projectFile, '项目 JSON 已下载');
  if (projectFile) {
    const json = JSON.parse(readFileSync(join(DOWNLOAD_DIR, projectFile), 'utf8'));
    check(Array.isArray(json.zones) && Array.isArray(json.route.waypoints), '项目 JSON 含区域与路线');
  }

  // localStorage 自动恢复数据
  const stored = await page.evaluate(() => localStorage.getItem('tp-camera-debugger-project-v1'));
  check(!!stored && JSON.parse(stored).route.waypoints.length >= 10, 'localStorage 已持久化项目');

  // 刷新后应自动恢复区域与路线
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction('window.__CD__ && window.__CD__.getState()');
  await sleep(600);
  const restored = await page.evaluate(() => {
    const p = window.__CD__.getProject();
    return { zones: p.zones.length, wps: p.route.waypoints.length, name: p.name };
  });
  check(restored.zones === 4 && restored.wps >= 10, `刷新后恢复 ${restored.zones} 个区域 / ${restored.wps} 个路径点`);

  check(errors.length === 0, `收尾时仍无错误${errors.length ? `：\n    ${errors.slice(0, 5).join('\n    ')}` : ''}`);
} catch (err) {
  failures.push(`脚本异常: ${err.stack || err.message}`);
  console.error(err);
} finally {
  await browser.close();
}

console.log(failures.length === 0 ? '\n无头巡检全部通过 ✅\n' : `\n${failures.length} 项失败 ❌\n`);
process.exit(failures.length === 0 ? 0 : 1);

async function waitForNewFile(dir, beforeSet, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const files = readdirSync(dir);
    if (files.some((f) => !beforeSet.has(f) && !f.endsWith('.crdownload'))) return;
    await sleep(150);
  }
}
function newestJson(dir, prefix) {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();
  return files.at(-1) ?? null;
}
