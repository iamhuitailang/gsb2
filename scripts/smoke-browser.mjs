#!/usr/bin/env node
/*
 * smoke-browser.mjs —— 浏览器端冒烟测试（零依赖，走 Chrome DevTools Protocol）
 *
 * 前提：npm start 已在 8080 端口起静态服务（脚本也会自行尝试启动/清理）。
 * 流程：启动无头 Chrome -> 打开页面 -> 调用页面暴露的 window.__smoke
 *       全链路自检（两种模式 × 多速度的渲染/导出读回/漂移/异常分支/
 *       切模式源时间连续性）-> 真实播放冒烟 -> 截图。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8080;
const PAGE_URL = `http://127.0.0.1:${PORT}/index.html`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function pageAvailable(timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const req = http.get(PAGE_URL, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
    });
    if (ok) return true;
    await sleep(150);
  }
  return false;
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(e.error || new Error('WS error')));
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    }
    return r.result.value;
  }
  close() { this.ws.close(); }
}

async function main() {
  // 1. 确保静态服务在跑
  let server = null;
  if (!(await pageAvailable(1500))) {
    server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', 'public'], {
      stdio: 'ignore',
    });
    if (!(await pageAvailable(4000))) {
      throw new Error('本地静态服务启动失败，可先手动 npm start');
    }
  }

  // 2. 启动无头 Chrome 并读取 DevTools 端口
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=0',
    `--user-data-dir=/tmp/slow-practice-smoke-${process.pid}`,
    'about:blank',
  ]);

  let cdp;
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome 启动超时')), 15000);
      chrome.stderr.on('data', (chunk) => {
        const m = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
    });

    cdp = new Cdp(wsUrl);
    await cdp.ready;

    // 浏览器级 endpoint 先拿到一个 page target，再连它的 WS 才能用 Page/Runtime。
    // HTTP 基址的端口与浏览器 WS（ws://127.0.0.1:<port>/dev/browser/...）一致。
    const port = wsUrl.match(/127\.0\.0\.1:(\d+)/)[1];
    const httpBase = `http://127.0.0.1:${port}`;
    const targets = await new Promise((resolve, reject) => {
      http.get(httpBase + '/json', (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });
    const pageTarget = targets.find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('未找到页面 target');
    cdp.close();
    cdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    cdp.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        console.error('页面异常：', msg.params.exceptionDetails.exception?.description ||
          msg.params.exceptionDetails.text);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        console.error('页面 console.error：',
          msg.params.args.map((a) => a.value || a.description).join(' '));
      }
    });

    // 3. 打开页面并等待脚本就绪
    await cdp.send('Page.navigate', { url: PAGE_URL });
    let ready = false;
    for (let i = 0; i < 50; i++) {
      ready = await cdp.evaluate('typeof window.__smoke === "object"').catch(() => false);
      if (ready) break;
      await sleep(100);
    }
    if (!ready) throw new Error('页面脚本未就绪（window.__smoke 缺失）');

    // 4. 全链路自检
    const result = await cdp.evaluate('window.__smoke.runSelfCheck()');
    console.log(`\n浏览器自检：${result.passed}/${result.total} 通过`);
    for (const r of result.results) {
      console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    }

    // 5. 真实播放冒烟：确认播放头随时间推进
    const play = await cdp.evaluate(`(async () => {
      const frames = window.__smoke.loadSample('practice');
      window.__smoke.engine.setPlayback('pitch', 0.5);
      await window.__smoke.engine.play();
      const p1 = window.__smoke.engine.getSourcePosition();
      await new Promise(r => setTimeout(r, 400));
      const p2 = window.__smoke.engine.getSourcePosition();
      const playing = window.__smoke.engine.playing;
      window.__smoke.engine.stop();
      return { frames, p1: Math.round(p1), p2: Math.round(p2), playing, advanced: p2 > p1 };
    })()`);
    console.log('\n真实播放冒烟：', JSON.stringify(play));
    if (!play.advanced) throw new Error('播放头未随时间推进');

    // 6. 截图存档
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const tmpDir = path.join(__dirname, '..', 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const outPath = path.join(tmpDir, 'smoke-screenshot.png');
    fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
    console.log('截图已保存：', outPath);

    if (result.passed !== result.total) process.exitCode = 1;
  } finally {
    cdp?.close();
    chrome.kill('SIGTERM');
    if (server) server.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error('浏览器冒烟测试失败：', e.message);
  process.exit(1);
});
