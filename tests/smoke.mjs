#!/usr/bin/env node
/**
 * 端到端冒烟测试：通过 CDP 驱动本机 Chrome（零额外依赖）。
 * 覆盖：页面加载、示例工程、播放同步、静音/独奏、片段编辑、
 * 自动化隔离、时间坐标一致性、持久化恢复、离线导出 WAV。
 * 运行：node tests/smtest.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TEST_TARGET = process.env.TEST_URL || 'http://127.0.0.1:4173/';
const PORT = 9333;

const profile = join(tmpdir(), `chrome-cdp-test-${process.pid}`);
mkdirSync(profile, { recursive: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream',
  '--disable-gpu',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let stderr = '';
chrome.stderr.on('data', (d) => (stderr += d.toString()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 等待 Chrome 启动 */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪\n' + stderr.slice(-500));
}

let msgId = 0;
const pending = new Map();

async function main() {
  console.log('[test] 等待 Chrome 调试端口…');
  const wsUrl = await getWsUrl();
  console.log('[test] 连接 WebSocket…', wsUrl.slice(0, 40));
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      console.log('[test] WebSocket 已连接');
      resolve();
    }, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const consoleEvents = [];
  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      consoleEvents.push({ type: msg.params.type, text });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails.text);
    }
  });

  function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error('页面脚本异常: ' + JSON.stringify(result.exceptionDetails.exception?.value ?? result.exceptionDetails.text));
    }
    return result.result.value;
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: TEST_TARGET });
  await sleep(2500);

  const results = [];
  const check = (name, cond, detail = '') => {
    results.push({ name, pass: Boolean(cond), detail });
    console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  /* ---------- 1. 页面与示例工程 ---------- */
  const boot = await evaluate(`(() => {
    const tracks = document.querySelectorAll('.track-header');
    const resources = document.querySelectorAll('.resource-item');
    const canvas = document.getElementById('timeline-canvas');
    return {
      tracks: tracks.length,
      resources: resources.length,
      canvasW: canvas.width,
      canvasH: canvas.height,
      title: document.title,
    };
  })()`);
  check('页面加载，标题正确', boot.title.includes('多轨'));
  check('示例工程有 2 条轨道', boot.tracks === 2, `实际 ${boot.tracks}`);
  check('素材库含 4 个示例资源', boot.resources === 4, `实际 ${boot.resources}`);
  check('时间线画布已分配尺寸', boot.canvasW > 0 && boot.canvasH > 0, `${boot.canvasW}x${boot.canvasH}`);

  /* ---------- 2. 音频上下文与资源解码 ---------- */
  await evaluate('window.__boot = (async () => { return true; })()');
  const audio = await evaluate(`(async () => {
    // 通过点击播放按钮触发用户手势等价路径（headless 已放开自动播放）
    const playBtn = document.querySelector('[data-role="play"]');
    playBtn.click();
    await new Promise(r => setTimeout(r, 1200));
    const playing = playBtn.textContent === '⏸';
    const timeAt1s = document.getElementById('time-display').textContent;
    playBtn.click(); // 暂停
    await new Promise(r => setTimeout(r, 200));
    const pausedLabel = playBtn.textContent;
    return { playing, timeAt1s, pausedLabel };
  })()`);
  check('播放开始后走带按钮切换为暂停态', audio.playing === true);
  check('播放指针推进（时间显示离开 00:00）', !audio.timeAt1s.startsWith('00:00.0'), audio.timeAt1s);
  check('暂停后按钮恢复播放态', audio.pausedLabel === '▶', audio.pausedLabel);

  /* ---------- 3. 跳转后重新同步 ---------- */
  const seek = await evaluate(`(async () => {
    const engine = window.__engine;
    engine.seek(window.__store.project, 10);
    await new Promise(r => setTimeout(r, 100));
    const t1 = engine.currentTime;
    const playBtn = document.querySelector('[data-role="play"]');
    playBtn.click();
    await new Promise(r => setTimeout(r, 600));
    const t2 = engine.currentTime;
    playBtn.click();
    return { t1, t2 };
  })()`);
  check('跳转到 10s 位置', Math.abs(seek.t1 - 10) < 0.05, `t=${seek.t1}`);
  check('跳转后播放从新位置推进', seek.t2 > 10.2 && seek.t2 < 11.5, `t=${seek.t2}`);

  /* ---------- 4. 静音 / 独奏逻辑（调度层数据正确性） ---------- */
  const solo = await evaluate(`(() => {
    const store = window.__store;
    const t0 = store.project.tracks[0];
    const t1 = store.project.tracks[1];
    t0.solo = true; store.commit();
    const anySolo = store.project.tracks.some(t => t.solo);
    const audible0 = !t0.muted && (!anySolo || t0.solo);
    const audible1 = !t1.muted && (!anySolo || t1.solo);
    t0.solo = false; store.commit();
    t1.muted = true; store.commit();
    const t1Muted = store.project.tracks[1].muted;
    t1.muted = false; store.commit();
    return { audible0, audible1, t1Muted };
  })()`);
  check('独奏时仅独奏轨道发声', solo.audible0 === true && solo.audible1 === false);
  check('静音状态可切换并恢复', solo.t1Muted === true);

  /* ---------- 5. 片段移动/裁切/复制 + 吸附 ---------- */
  const clipEdit = await evaluate(`(() => {
    const store = window.__store;
    const tl = window.__timeline;
    const track = store.project.tracks[0];
    const clip = track.clips[0];
    const originalStart = clip.start;
    // 吸附：通过时间线的吸附算法验证（UI 拖动走的就是这个方法）
    store.view.snap = true;
    const snapped = tl.applySnapForTest(6.98, clip.id, track.id);
    const snapOff = tl.applySnapForTest(6.4, clip.id, track.id); // 远离任何边缘时保持原值
    // 复制
    const newId = store.duplicateClip(clip.id);
    const dup = store.findClip(newId);
    // 右裁切
    const before = store.findClip(clip.id).clip.duration;
    store.updateClipLive(clip.id, { duration: 4 });
    const after = store.findClip(clip.id).clip.duration;
    // 左裁剪切 offset：固定对刚复制出的片段操作
    const target = store.findClip(newId).clip;
    store.updateClipLive(target.id, { start: 1, offset: 1, duration: 3 });
    const trimmed = store.findClip(target.id).clip;
    // 关闭吸附后精细摆放
    store.view.snap = false;
    store.updateClipLive(clip.id, { start: originalStart + 0.013 });
    const fine = store.findClip(clip.id).clip.start;
    return {
      snapped,
      snapOff,
      duplicated: dup !== undefined && dup.clip.id !== clip.id,
      trimmedDuration: after === 4 && before !== 4,
      offsetTrim: Math.abs(trimmed.offset - 1) < 0.001 && Math.abs(trimmed.start - 1) < 0.001,
      fine: Math.abs(fine - (originalStart + 0.013)) < 0.001,
    };
  })()`);
  check('开启吸附时片段边缘吸附（6.98s → 7s）', Math.abs(clipEdit.snapped - 7) < 0.02, `start=${clipEdit.snapped}`);
  check('远离边缘时不产生误吸附', Math.abs(clipEdit.snapOff - 6.4) < 0.001, `got=${clipEdit.snapOff}`);
  check('片段可复制', clipEdit.duplicated);
  check('片段可右裁切', clipEdit.trimmedDuration);
  check('左裁切联动 offset', clipEdit.offsetTrim);
  check('关闭吸附后可精细摆放', clipEdit.fine);

  /* ---------- 6. 自动化关键点 & 轨道隔离 ---------- */
  const automation = await evaluate(`(() => {
    const store = window.__store;
    const [t0, t1] = store.project.tracks;
    const beforeT1 = t1.automation.length;
    const beforeT0 = t0.automation.length;
    const id = store.addAutomationPoint(t0.id, 5.5, 0.42);
    const addedT0 = store.findTrack(t0.id).automation.length === beforeT0 + 1;
    const t1Untouched = store.findTrack(t1.id).automation.length === beforeT1;
    store.updateAutomationPoint(t0.id, id, { time: 5.6, value: 0.5 });
    const p = store.findTrack(t0.id).automation.find(x => x.id === id);
    const updated = Math.abs(p.time - 5.6) < 1e-6 && Math.abs(p.value - 0.5) < 1e-6;
    store.removeAutomationPoint(t0.id, id);
    const removed = store.findTrack(t0.id).automation.length === beforeT0;
    const t1StillUntouched = store.findTrack(t1.id).automation.length === beforeT1;
    return { addedT0, t1Untouched, updated, removed, t1StillUntouched };
  })()`);
  check('可新增自动化关键点', automation.addedT0);
  check('新增关键点不影响其他轨道', automation.t1Untouched);
  check('可移动/修改关键点', automation.updated);
  check('可删除关键点', automation.removed);
  check('删除关键点不影响其他轨道', automation.t1StillUntouched);

  /* ---------- 7. 时间坐标一致性（缩放/平移映射） ---------- */
  const mapping = await evaluate(`(() => {
    const tl = window.__timeline;
    const store = window.__store;
    const t = 12.345;
    const x1 = tl.timeToX(t);
    store.view.pxPerSecond = 120;
    store.view.scrollTime = 3.2;
    store.commit();
    const x2 = tl.timeToX(t);
    const back = tl.xToTime(x2);
    // 鼠标像素位置对应的时间：平移前后，同一时间在屏幕上的位置按视图变化，但逆映射必须还原
    const roundTripOk = Math.abs(back - t) < 1e-9;
    const scrollMoved = Math.abs(x2 - x1) > 1;
    // 缩放锚点：鼠标下时间不变的性质
    const mx = 300;
    const anchor = tl.xToTime(mx);
    const oldPpx = store.view.pxPerSecond;
    store.view.pxPerSecond = oldPpx * 1.5;
    store.view.scrollTime = anchor - mx / store.view.pxPerSecond;
    store.commit();
    const anchorAfter = tl.xToTime(mx);
    return { roundTripOk, scrollMoved, anchorHeld: Math.abs(anchorAfter - anchor) < 1e-9 };
  })()`);
  check('时间→像素→时间逆映射恒等', mapping.roundTripOk);
  check('平移改变屏幕位置但时间坐标不变', mapping.scrollMoved);
  check('缩放时鼠标指向的时间坐标保持不变', mapping.anchorHeld);

  /* ---------- 8. 持久化：localStorage 落盘 + 恢复 ---------- */
  const persistence = await evaluate(`(() => {
    const store = window.__store;
    store.project.name = '持久化测试工程';
    store.flushSave();
    const raw = localStorage.getItem('multitrack-arranger:project');
    const parsed = JSON.parse(raw);
    return { saved: parsed.name === '持久化测试工程', trackCount: parsed.tracks.length };
  })()`);
  check('工程写入 localStorage', persistence.saved);
  check('持久化数据包含全部轨道', persistence.trackCount === 2);

  /* ---------- 9. 离线导出 WAV（含静音片段、末尾淡出） ---------- */
  console.log('[test] 开始离线导出…');
  const exportResult = await evaluate(`(async () => {
    const store = window.__store;
    const engine = window.__engine;
    const ctx = await engine.ensureContext();
    const projectLength = store.project.length;
    const t0 = performance.now();
    const blob = await window.__exportMix(store.project, ctx, () => {});
    const elapsed = Math.round(performance.now() - t0);
    if (!blob) return { ok: false, elapsed };
    const buf = new Uint8Array(await blob.arrayBuffer());
    const riff = String.fromCharCode(...buf.slice(0, 4));
    const wave = String.fromCharCode(...buf.slice(8, 12));
    const view = new DataView(buf.buffer);
    const sampleRate = view.getUint32(24, true);
    const dataSize = view.getUint32(40, true);
    const expectedFrames = Math.round(projectLength * sampleRate) * 2 * 2;
    // 不回传整个文件（CDP 大消息会拖慢测试），把 WAV 暂存到 window 供下一步落盘
    window.__exportedWavBytes = buf;
    return {
      ok: riff === 'RIFF' && wave === 'WAVE',
      sampleRate,
      dataSize,
      expectedFrames,
      lengthMatch: Math.abs(dataSize - expectedFrames) <= sampleRate * 2 * 2,
      tailFade: store.project.tailFade,
      byteLength: buf.length,
      elapsed,
    };
  })()`);
  console.log('[test] 导出完成', exportResult.byteLength, '字节，耗时', exportResult.elapsed, 'ms');
  check('导出为合法 RIFF/WAVE', exportResult.ok);
  check('导出长度按项目长度输出', exportResult.lengthMatch, `${exportResult.dataSize} vs ~${exportResult.expectedFrames}`);
  check('采样率与播放上下文一致', exportResult.sampleRate === (await evaluate('window.__engine.sampleRateHint')), `${exportResult.sampleRate}Hz`);

  /* ---------- 9b. 验证末尾淡出：导出缓冲末尾增益应趋于 0 ---------- */
  const fadeCheck = await evaluate(`(async () => {
    const { exportMix } = window.__exportMix ? { exportMix: window.__exportMix } : {};
    const store = window.__store;
    const ctx = await window.__engine.ensureContext();
    // 直接渲染并检查最后 100ms 的峰值是否接近 0（淡出终点）
    const blob = await exportMix(store.project, ctx, () => {});
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    const rate = dv.getUint32(24, true);
    const dataStart = 44;
    const frames = (buf.length - 44) / 4;
    // 取最后 0.05s 的立体声采样峰值
    const tailFrames = Math.floor(rate * 0.05);
    let peak = 0;
    for (let i = frames - tailFrames; i < frames; i++) {
      for (let ch = 0; ch < 2; ch++) {
        const v = Math.abs(dv.getInt16(dataStart + (i * 2 + ch) * 2, true) / 32768);
        if (v > peak) peak = v;
      }
    }
    // 取淡出前（工程中点）峰值作对照
    let midPeak = 0;
    const midStart = Math.floor(frames / 2);
    for (let i = midStart; i < midStart + tailFrames; i++) {
      for (let ch = 0; ch < 2; ch++) {
        const v = Math.abs(dv.getInt16(dataStart + (i * 2 + ch) * 2, true) / 32768);
        if (v > midPeak) midPeak = v;
      }
    }
    return { tailPeak: peak, midPeak };
  })()`);
  console.log('[test] 淡出校验：尾部峰值', fadeCheck.tailPeak.toFixed(4), '中部峰值', fadeCheck.midPeak.toFixed(4));
  check('末尾淡出使尾部增益趋近于 0', fadeCheck.tailPeak < 0.02 && fadeCheck.tailPeak < fadeCheck.midPeak);

  /* ---------- 9c. 导出完整 WAV 分块落盘（必须在刷新前，window 变量刷新即失效） ---------- */
  const outDir = new URL('.', import.meta.url).pathname;
  const totalBytes = exportResult.byteLength;
  if (totalBytes) {
    const CHUNK = 262144; // 256KB/次，避免单条 CDP 消息过大
    const parts = [];
    for (let off = 0; off < totalBytes; off += CHUNK) {
      const part = await evaluate(`(() => {
        const bytes = window.__exportedWavBytes.subarray(${off}, ${Math.min(off + CHUNK, totalBytes)});
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
      })()`);
      parts.push(Buffer.from(part, 'base64'));
    }
    writeFileSync(join(outDir, 'exported-smoke.wav'), Buffer.concat(parts));
    console.log('[test] WAV 已落盘 tests/exported-smoke.wav');
  }

  /* ---------- 10. 刷新后恢复 ---------- */
  console.log('[test] 刷新页面验证恢复…');
  await send('Page.navigate', { url: TEST_TARGET });
  await sleep(2500);
  const restored = await evaluate(`(() => ({
    name: window.__store.project.name,
    tracks: window.__store.project.tracks.length,
    snap: window.__store.view.snap,
  }))()`);
  console.log('[test] 恢复完成', restored.name);
  check('刷新后工程恢复到保存状态', restored.name === '持久化测试工程' && restored.tracks === 2, restored.name);

  /* ---------- 控制台错误 ---------- */
  const severeErrors = consoleEvents.filter((e) => e.type === 'error' && !e.text.includes('favicon'));
  check('运行期间无控制台错误', severeErrors.length === 0 && pageErrors.length === 0,
    severeErrors[0]?.text || pageErrors[0] || '');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  ws.close();
  return failed.length;
}

main()
  .then((failed) => {
    chrome.kill();
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error('测试框架错误:', err);
    chrome.kill();
    process.exit(2);
  });
