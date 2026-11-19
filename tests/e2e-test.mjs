// e2e-test.mjs — 通过 Chrome DevTools Protocol 驱动真实浏览器页面做端到端验证。
// 零依赖：使用浏览器自带 WebSocket（需以 --remote-debugging-port 启动 Chrome）。
// 用法：node tests/e2e-test.mjs
import { spawn } from 'node:child_process';
import { rmSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav } from '../js/wav-codec.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const BASE = 'http://localhost:8745';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.error(`  ✗ ${name} ${detail}`); }
}

// ---- 极简 CDP 客户端（Node 24 内置 WebSocket） ----
async function cdpConnect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return {
    send,
    eval: async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true,
      });
      if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result.result.value;
    },
    close: () => ws.close(),
  };
}

const profile = mkdtempSync(join(tmpdir(), 'chrome-e2e-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

try {
  // 等待调试端口就绪
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(250); }
  }
  const cdp = await cdpConnect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  console.log('1) 通过 ?sample= 自动导入立体声样音');
  await cdp.send('Page.navigate', { url: `${BASE}/index.html?sample=samples/demo-stereo.wav` });
  await sleep(2500);
  const imported = await cdp.eval(`(() => {
    const s = window.__state__ || null;
    return {
      totalDur: document.getElementById('totalDur').textContent,
      opButtonsEnabled: !document.querySelector('.op-btn').disabled,
      exportEnabled: !document.getElementById('btnExport').disabled,
      canvasW: document.querySelector('.wave-canvas').width,
    };
  })()`);
  check('样音自动导入，总时长 8s', imported.totalDur.includes('00:08.000'), imported.totalDur);
  check('操作按钮已启用', imported.opButtonsEnabled);
  check('导出按钮已启用', imported.exportEnabled);
  check('波形 canvas 已绘制', imported.canvasW > 100);

  console.log('2) 模拟选区并依次添加 静音→增益→淡入→淡出 操作链');
  const opsResult = await cdp.eval(`(async () => {
    // 直接通过内部事件路径构造选区并打开各对话框不便，改为调用页面暴露的测试钩子
    return window.__e2e__.buildChain();
  })()`);
  check('处理链包含 4 个操作', opsResult.opsCount === 4, `count=${opsResult.opsCount}`);
  check('处理后时长保持 8s（无剪切）', Math.abs(opsResult.duration - 8) < 1e-6, String(opsResult.duration));
  check('静音区间采样为 0', opsResult.mutedZero === true);
  check('淡入起点为 0', opsResult.fadeStartZero === true);
  check('原始 PCM 未被修改（非破坏）', opsResult.sourceIntact === true);

  console.log('3) 归一化：实际峰值计算与处理前后变化');
  const norm = await cdp.eval(`window.__e2e__.normalizeTest()`);
  check('归一化前实测峰值接近满幅（样音含近满幅短脉冲）', norm.beforePeak > 0.95, String(norm.beforePeak));
  check('归一化后峰值达到目标 -1 dBFS', Math.abs(norm.afterPeakDb - (-1)) < 0.1, String(norm.afterPeakDb));
  check('增益为负值（防止削波的衰减）', norm.gainDb < 0, String(norm.gainDb));

  console.log('4) 全静音文件给出清楚结果');
  await cdp.send('Page.navigate', { url: `${BASE}/index.html?sample=samples/demo-silence.wav` });
  await sleep(2000);
  const silent = await cdp.eval(`window.__e2e__.silentTest()`);
  check('静音文件识别 isSilent', silent.isSilent === true);
  check('归一化静音区间返回 silent=true', silent.planSilent === true);
  check('归一化后仍为全 0', silent.stillZero === true);
  check('界面显示静音横幅', silent.bannerShown === true);

  console.log('5) 标记 + 剪切：波形、标尺、标记位置一致');
  await cdp.send('Page.navigate', { url: `${BASE}/index.html?sample=samples/demo-stereo.wav` });
  await sleep(2000);
  const cut = await cdp.eval(`window.__e2e__.cutWithMarkers()`);
  check('剪切后时长缩短为 7s', Math.abs(cut.durationAfter - 7) < 1e-6, String(cut.durationAfter));
  check('剪切点之前的标记不动', cut.beforeMarkerKept === true);
  check('删除区间内的标记被隐藏', cut.insideMarkerRemoved === true);
  check('剪切点之后的标记界面位置左移 1s', Math.abs(cut.afterMarkerTime - 2.0) < 1e-9, String(cut.afterMarkerTime));
  check('原始标记数据保留（旁路剪切可恢复）', cut.rawStillThere === true);
  check('撤销后恢复 8s 且标记还原', Math.abs(cut.undoDuration - 8) < 1e-6 && cut.undoMarkers === 3,
    `${cut.undoDuration}/${cut.undoMarkers}`);

  console.log('5b) 剪切旁路/重排后其他操作命中同一段原始音频');
  const bypass = await cdp.eval(`window.__e2e__.cutBypassTest()`);
  check('启用剪切时增益命中正确原始帧', bypass.activeHitsGain === true);
  check('旁路剪切后增益仍命中同一原始帧（坐标不漂移）', bypass.bypassHitsSameFrame === true);
  check('旁路剪切后时长恢复', bypass.bypassRestoresLength === true);
  check('重排序后输出一致', bypass.reorderIdentical === true);

  console.log('6) 工程保存 → 重新打开 → 继续编辑');
  const proj = await cdp.eval(`window.__e2e__.projectRoundTrip()`);
  check('工程 JSON 含浮点 PCM 与处理链', proj.hasAudio && proj.opsCount === 2);
  check('重新打开后采样逐点一致', proj.samplesIdentical === true);
  check('重新打开后操作链与标记恢复', proj.stateRestored === true);

  console.log('7) WAV 导出一致性校验（16/24-bit）');
  const exp = await cdp.eval(`window.__e2e__.exportWav()`);
  check('16-bit 导出采样率/声道/帧数与界面一致', exp.ok16 === true, JSON.stringify(exp.detail16));
  check('24-bit 导出采样率/声道/帧数与界面一致', exp.ok24 === true, JSON.stringify(exp.detail24));
  check('导出时长与界面一致', Math.abs(exp.exportDuration - exp.uiDuration) < 1e-6);

  console.log('8) 撤销/重做栈');
  const hist = await cdp.eval(`window.__e2e__.historyTest()`);
  check('撤销/重做可用且状态正确', hist.ok === true, JSON.stringify(hist));

  cdp.close();
} catch (e) {
  fails.push(`异常: ${e.message}`);
  console.error(e);
} finally {
  chrome.kill();
  // Chrome 退出与释放 profile 文件存在竞态，重试清理
  for (let i = 0; i < 10; i++) {
    try { rmSync(profile, { recursive: true, force: true }); break; }
    catch { await sleep(200); }
  }
}

console.log(`\nE2E 结果：${pass} 通过，${fails.length} 失败`);
process.exit(fails.length ? 1 : 0);
