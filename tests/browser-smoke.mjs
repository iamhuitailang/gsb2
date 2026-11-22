/*
 * 无头浏览器冒烟测试（零依赖）：
 *   1. 启动 chrome-headless-shell（remote-debugging-port + 临时 profile）
 *   2. 通过 http://127.0.0.1:<port>/json 拿到 page target 的 WebSocket
 *   3. Node 内置 WebSocket 走 CDP 驱动页面
 *
 * 运行：node tests/browser-smoke.mjs
 * 前置：python3 -m http.server 8931（仓库根目录）
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const CHROME = process.env.CHROME_BIN ||
  '/Users/sunmengmeng/.cache/puppeteer/chrome-headless-shell/mac_arm-149.0.7827.22/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const URL = process.env.TARGET_URL || 'http://127.0.0.1:8931/index.html';
const PORT = 8944;

const userDir = await mkdtemp(join(tmpdir(), 'cdp-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${userDir}`,
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const consoleLogs = [];
let msgId = 0;
const pending = new Map();
let ws;

function cdp(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function waitFor(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function evalJs(expression) {
  // 间接 eval：每次调用都是全新声明式词法环境，
  // 多次求值里的 const 同名变量不会互相冲突，且能返回语句完成值。
  const wrapped = `(0, eval)(${JSON.stringify(expression)})`;
  const res = await cdp('Runtime.evaluate', {
    expression: wrapped,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.text + ' ' +
      (res.exceptionDetails.exception?.description || ''));
  }
  return res.result.value;
}

async function connect() {
  // 等调试端口起来
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) {}
    await waitFor(100);
  }
  throw new Error('Chrome 调试端口未就绪');
}

async function step(name, fn) {
  await fn();
  console.log('  ✓ ' + name);
}

try {
  const wsUrl = await connect();
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      consoleLogs.push(`[console.${msg.params.type}] ` +
        msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleLogs.push(`[exception] ${d.exception?.description || d.text}`);
    }
  });

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: URL });
  await waitFor(1200);

  await step('页面加载且标题正确', async () => {
    assert.equal(await evalJs('document.title'),
      '动态压缩试听台 · 音量动态调整试验页');
  });

  await step('载入内置样音并完成首遍处理', async () => {
    await evalJs("document.getElementById('loadSampleBtn').click()");
    await waitFor(500);
    assert.match(await evalJs("document.getElementById('fileName').textContent"), /内置样音/);
    assert.match(await evalJs("document.getElementById('statGr').textContent"), /dB/);
    assert.equal(await evalJs('document.querySelectorAll("canvas").length'), 3);
  });

  await step('三个画布均已实际绘制（非空白）', async () => {
    const lit = await evalJs(`
      Array.from(document.querySelectorAll('canvas')).map((c) => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
      })
    `);
    for (const n of lit) assert.ok(n > 500, `画布有效像素 ${n} 太少`);
  });

  await step('调阈值后统计更新', async () => {
    const before = await evalJs("document.getElementById('statGr').textContent");
    await evalJs(`
      const t = document.getElementById('threshold');
      t.value = -8; t.dispatchEvent(new Event('input', {bubbles:true}));
    `);
    await waitFor(400);
    assert.notEqual(before,
      await evalJs("document.getElementById('statGr').textContent"));
  });

  await step('慢起效对短峰压得少、快起效应明显压', async () => {
    const grFor = (attack) => evalJs(`
      new Promise((resolve) => {
        const a = document.getElementById('attack');
        a.value = ${attack};
        a.dispatchEvent(new Event('input', {bubbles:true}));
        setTimeout(() => resolve(parseFloat(
          document.getElementById('statGr').textContent)), 400);
      })
    `);
    const slow = await grFor(150);
    const fast = await grFor(0.5);
    assert.ok(fast > slow * 1.5, `快 ${fast} 应显著大于慢 ${slow}`);
  });

  await step('大补偿增益触发削波告警', async () => {
    await evalJs(`
      const m = document.getElementById('makeup');
      m.disabled = false;
      m.value = 20;
      m.dispatchEvent(new Event('input', {bubbles:true}));
    `);
    await waitFor(300);
    assert.match(await evalJs("document.getElementById('clipWarning').className"), /serious/);
    assert.match(await evalJs("document.getElementById('clipWarning').textContent"), /削波/);
  });

  await step('同响度对照自动补偿并停用滑块', async () => {
    await evalJs(`
      const c = document.getElementById('loudnessMatch');
      c.checked = true;
      c.dispatchEvent(new Event('change', {bubbles:true}));
    `);
    await waitFor(300);
    assert.equal(await evalJs("document.getElementById('makeup').disabled"), true);
    assert.match(await evalJs("document.getElementById('matchInfo').textContent"), /自动补偿/);
  });

  await step('试听来源切换', async () => {
    await evalJs("document.getElementById('listenOriginal').click()");
    assert.match(await evalJs("document.getElementById('listenOriginal').className"), /active/);
    await evalJs("document.getElementById('quickToggle').click()");
    assert.match(await evalJs("document.getElementById('listenProcessed').className"), /active/);
  });

  await step('播放后播放头推进、暂停生效', async () => {
    await evalJs("document.getElementById('playBtn').click()");
    await waitFor(700);
    assert.equal(await evalJs("document.getElementById('playBtn').textContent"), '暂停');
    const t = parseFloat(await evalJs("document.getElementById('timeReadout').textContent"));
    assert.ok(t > 0.3, `播放头未推进: ${t}`);
    await evalJs("document.getElementById('playBtn').click()");
    await waitFor(150);
    assert.equal(await evalJs("document.getElementById('playBtn').textContent"), '播放');
  });

  await step('点击画布跳转播放位置', async () => {
    await evalJs(`
      const c = document.getElementById('inputCanvas');
      const r = c.getBoundingClientRect();
      c.dispatchEvent(new PointerEvent('pointerdown',
        {clientX: r.left + r.width * 0.5, clientY: r.top + 10, bubbles:true,
         pointerId: 1, isPrimary: true}));
    `);
    await waitFor(200);
    const sec = parseFloat(await evalJs("document.getElementById('timeReadout').textContent"));
    assert.ok(sec > 2.5 && sec < 3.5, `跳转位置异常: ${sec}`);
  });

  await step('A/B 预设保存与调出恢复参数', async () => {
    await evalJs("document.getElementById('saveA').click()");
    assert.doesNotMatch(
      await evalJs("document.getElementById('presetAInfo').textContent"), /^空$/);
    await evalJs(`
      const t = document.getElementById('threshold');
      t.value = -30;
      t.dispatchEvent(new Event('input', {bubbles:true}));
    `);
    await waitFor(400);
    await evalJs("document.getElementById('loadA').click()");
    await waitFor(300);
    assert.equal(await evalJs("document.getElementById('threshold').value"), '-8');
  });

  await step('单声道素材：R 表行隐藏、联动禁用且仍可正常处理', async () => {
    // 用 OfflineAudioContext 造一个 1s 单声道 WAV Blob 走真实导入路径
    const monoWav = await evalJs(`
      (async () => {
        const sr = 22050, n = sr;
        const dsp = window.DSP;
        const data = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          data[i] = (i > sr * 0.4 && i < sr * 0.7 ? 0.6 : 0)
            * Math.sin(2 * Math.PI * 660 * i / sr);
        }
        return dsp.encodeWav16([data], sr, 0).arrayBuffer()
          .then((b) => Array.from(new Uint8Array(b)));
      })()
    `);
    await evalJs(`
      const bytes = new Uint8Array(${JSON.stringify(monoWav)});
      const file = new File([bytes], 'mono-test.wav', {type: 'audio/wav'});
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', {bubbles:true}));
    `);
    await waitFor(600);
    assert.equal(
      await evalJs("document.getElementById('meterRowR').classList.contains('hidden')"),
      true);
    assert.equal(await evalJs("document.getElementById('linked').disabled"), true);
    assert.match(await evalJs("document.getElementById('statGr').textContent"), /dB/);
    // 回到内置立体声样音，保证后续步骤前提一致
    await evalJs("document.getElementById('loadSampleBtn').click()");
    await waitFor(400);
    assert.equal(
      await evalJs("document.getElementById('meterRowR').classList.contains('hidden')"),
      false);
  });

  await step('导出 WAV：双声道、长度与素材逐采样一致', async () => {
    await evalJs(`
      const c = document.getElementById('loudnessMatch');
      c.checked = false;
      c.dispatchEvent(new Event('change', {bubbles:true}));
      const m = document.getElementById('makeup');
      m.value = 0;
      m.dispatchEvent(new Event('input', {bubbles:true}));
      window.__lastBlob = null;
      URL.createObjectURL = (b) => { window.__lastBlob = b; return 'blob:test'; };
      HTMLAnchorElement.prototype.click = function() {};
    `);
    await waitFor(200);
    await evalJs("document.getElementById('exportBtn').click()");
    await waitFor(200);
    const bytes = await evalJs(`
      window.__lastBlob.arrayBuffer().then((b) => Array.from(new Uint8Array(b)))
    `);
    const dv = new DataView(new Uint8Array(bytes).buffer);
    const tag = (o) => String.fromCharCode(
      dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    assert.equal(tag(0), 'RIFF');
    assert.equal(tag(8), 'WAVE');
    assert.equal(dv.getUint16(22, true), 2);
    const n = 48000 * 6;
    assert.equal(dv.getUint32(40, true), n * 2 * 2);
    assert.equal(bytes.length, 44 + n * 2 * 2);
  });

  await step('首尾静音统计在处理前后一致', async () => {
    const s = await evalJs("document.getElementById('statSilence').textContent");
    const [a, b] = s.split('→').map((x) => x.trim());
    assert.equal(a, b, `静音长度被改动: ${s}`);
  });

  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(
    join(process.cwd(), 'tests', 'smoke-screenshot.png'),
    Buffer.from(shot.data, 'base64')
  );

  const errors = consoleLogs.filter((l) =>
    l.includes('[exception]') || /\[console\.error\]/.test(l));
  if (errors.length) {
    console.log('\n浏览器日志:\n' + consoleLogs.join('\n'));
    throw new Error('存在运行时错误:\n' + errors.join('\n'));
  }
  console.log('\n全部浏览器冒烟测试通过，截图: tests/smoke-screenshot.png\n');
} finally {
  chrome.kill();
}
