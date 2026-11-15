'use strict';

/**
 * 极简 CDP 浏览器驱动：只用 Node 内置的 WebSocket / fetch，
 * 不依赖 Playwright 等第三方包。所有操作都真正发生在 Chrome 页面里：
 * 打开页面、填写搜索框、提交表单、读取 DOM。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('未找到 Chrome/Chromium，可通过环境变量 CHROME_PATH 指定可执行文件路径');
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForDevTools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const info = await res.json();
        if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(100);
  }
  throw new Error(`Chrome 调试端口未就绪${lastError ? `：${lastError.message}` : ''}`);
}

class CDP {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  static async connect(wsUrl, timeoutMs = 15000) {
    const cdp = new CDP();
    await cdp._open(wsUrl, timeoutMs);
    return cdp;
  }

  _open(wsUrl, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('连接 Chrome 调试通道超时')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.message || 'CDP 调用失败'}（${msg.error.code}）`));
          else res(msg.result || {});
        } else if (msg.method) {
          const listeners = this.events.get(msg.method) || [];
          for (const fn of listeners) fn(msg.params, msg.sessionId);
        }
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`无法连接 Chrome 调试通道：${wsUrl}`));
      });
      ws.addEventListener('close', () => {
        for (const { reject: rej } of this.pending.values()) rej(new Error('Chrome 调试通道已关闭'));
        this.pending.clear();
      });
    });
  }

  on(method, fn) {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method).push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.loadWaiters = [];
    cdp.on('Page.loadEventFired', (params, eventSessionId) => {
      if (eventSessionId !== this.sessionId) return;
      const waiters = this.loadWaiters.splice(0, this.loadWaiters.length);
      for (const resolve of waiters) resolve();
    });
  }

  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }

  waitForLoad(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.loadWaiters.indexOf(settle);
        if (idx !== -1) this.loadWaiters.splice(idx, 1);
        reject(new Error('等待页面加载超时'));
      }, timeoutMs);
      const settle = () => {
        clearTimeout(timer);
        resolve();
      };
      this.loadWaiters.push(settle);
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const detail =
        (res.exceptionDetails.exception && res.exceptionDetails.exception.description) ||
        res.exceptionDetails.text ||
        '未知错误';
      throw new Error(`页面脚本执行失败：${detail}`);
    }
    return res.result ? res.result.value : undefined;
  }

  async goto(url) {
    // 比对完整 URL，防止「目标页与当前页路径相同」时提前判定加载完成
    const expected = new URL(url).href;
    const current = await this.evaluate('location.href').catch(() => null);
    const loaded = this.waitForLoad();
    if (current === expected) {
      // 已经在目标页：强制重载，确保读到的是最新数据而不是上一次的 DOM
      await this.send('Page.reload', { ignoreCache: true });
    } else {
      await this.send('Page.navigate', { url });
    }
    await loaded.catch(() => {});
    await this.waitFor(
      `document.readyState === 'complete' && location.href === ${JSON.stringify(expected)}`,
      `打开页面 ${url}`
    );
  }

  async waitFor(expression, description, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(expression);
        if (value) return value;
        last = value;
      } catch (err) {
        last = err.message;
      }
      await sleep(60);
    }
    throw new Error(
      `等待超时：${description}${last === null ? '' : `（最后取值：${JSON.stringify(last)}）`}`
    );
  }

  async fill(selector, value) {
    const ok = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`找不到输入框：${selector}`);
  }

  async submit(selector) {
    const ok = await this.evaluate(`(() => {
      const form = document.querySelector(${JSON.stringify(selector)});
      if (!form) return false;
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return true;
    })()`);
    if (!ok) throw new Error(`找不到表单：${selector}`);
  }

  async text(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? el.textContent.trim() : null;
    })()`);
  }
}

async function launchOnce({ headless, extraArgs }) {
  const chromePath = findChrome();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsb2-chrome-'));
  const port = await getFreePort();
  const args = [];
  if (headless) args.push('--headless');
  args.push(
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--remote-allow-origins=*',
    ...extraArgs,
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    'about:blank'
  );

  const proc = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  // 及时排空 Chrome 的 stderr，避免管道写满导致浏览器卡住
  proc.stderr.on('data', () => {});
  let cleanupDone = false;
  const cleanup = () => {
    if (cleanupDone) return;
    cleanupDone = true;
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  process.once('exit', cleanup);
  proc.once('exit', () => {
    // Chrome 自己退出时不再需要杀进程，但临时目录仍要清理
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  let wsUrl;
  try {
    wsUrl = await waitForDevTools(port, 20000);
  } catch (err) {
    cleanup();
    throw err;
  }

  const cdp = await CDP.connect(wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.setLifecycleEventsEnabled', { enabled: false }, sessionId).catch(() => {});

  const page = new Page(cdp, sessionId);

  return {
    page,
    close: async () => {
      try {
        await cdp.send('Browser.close');
      } catch {
        /* ignore */
      }
      cdp.close();
      cleanup();
    },
  };
}

/**
 * 启动浏览器。个别 Chrome 构建在无头模式下对新的 /tmp 配置目录不友好，
 * 因此失败时依次尝试几组兼容参数。
 */
async function launch({ headless = true } = {}) {
  const attempts = [{ extraArgs: [] }];
  if (headless) {
    attempts.push({ extraArgs: ['--no-sandbox', '--disable-dev-shm-usage'] });
    attempts.push({ headless: false, extraArgs: [] });
  }
  let lastError = null;
  for (const attempt of attempts) {
    try {
      return await launchOnce({
        headless: attempt.headless === undefined ? headless : attempt.headless,
        extraArgs: attempt.extraArgs,
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

module.exports = { launch, sleep, findChrome, Page, CDP };
