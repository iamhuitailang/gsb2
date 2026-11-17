import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 极小的 Chrome DevTools Protocol 客户端，避免引入外部依赖。 */
export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`无法连接 CDP: ${url}`)), { once: true });
    });
    return new CDP(ws);
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000).unref();
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // 忽略
    }
  }
}

export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // 继续找
    }
  }
  return null;
}

export async function launchChrome() {
  const binary = await findChrome();
  if (!binary) throw new Error('未找到 Chrome/Chromium，无法运行浏览器端校验');
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gsb2-chrome-'));
  const child = spawn(binary, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-proxy-server',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-pings',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  let port = null;
  for (let i = 0; i < 200; i += 1) {
    try {
      const content = await fs.readFile(portFile, 'utf8');
      const first = content.split('\n')[0].trim();
      if (first) {
        port = Number(first);
        break;
      }
    } catch {
      // 还没写好
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!port) {
    child.kill('SIGKILL');
    throw new Error(`Chrome 未能启动\n${stderr.join('').slice(-2000)}`);
  }

  let browserWs = null;
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        browserWs = (await response.json()).webSocketDebuggerUrl;
        if (browserWs) break;
      }
    } catch {
      // 继续重试
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!browserWs) {
    child.kill('SIGKILL');
    throw new Error('Chrome DevTools 端点不可用');
  }

  const cdp = await CDP.connect(browserWs);
  return {
    cdp,
    port,
    async close() {
      cdp.close();
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000).unref();
      });
      await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * 打开一个页面并支持在指定框架里求值。
 *
 * 跨源子框架在 Chrome 里是独立 target（OOPIF），需要 Target.setAutoAttach；
 * 同源子框架则留在父 target 里，只是拥有自己的 executionContext。
 * 这里两者都跟踪，所以“列表预览”（跨源 iframe）与“独立预览”（报告站点
 * 自己的外壳 + 同源 iframe）都能按 URL 定位到同一个正文框架。
 */
export async function openPage(cdp, url = 'about:blank') {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  }, sessionId);

  /** sessionId -> { frames: Map(frameId -> url), contexts: Map(frameId -> contextId) } */
  const states = new Map([[sessionId, { frames: new Map(), contexts: new Map() }]]);
  const childSessions = new Set();

  cdp.onMessage((message) => {
    const state = states.get(message.sessionId);
    if (state) {
      if (message.method === 'Page.frameNavigated') {
        state.frames.set(message.params.frame.id, message.params.frame.url);
      } else if (message.method === 'Runtime.executionContextCreated') {
        const { id, auxData } = message.params.context;
        if (auxData?.frameId) state.contexts.set(auxData.frameId, id);
      } else if (message.method === 'Runtime.executionContextsCleared') {
        state.contexts.clear();
      }
    }

    if (message.method === 'Target.attachedToTarget' && states.has(message.sessionId)) {
      const childSession = message.params.sessionId;
      if (childSession === sessionId || states.has(childSession)) return;
      childSessions.add(childSession);
      states.set(childSession, { frames: new Map(), contexts: new Map() });
      (async () => {
        try {
          await cdp.send('Page.enable', {}, childSession);
          await cdp.send('Runtime.enable', {}, childSession);
          await cdp.send('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
          }, childSession);
        } catch {
          // 子 target 可能已关闭
        }
      })();
    }

    if (message.method === 'Target.detachedFromTarget' && states.has(message.sessionId)) {
      const childSession = message.params.sessionId;
      childSessions.delete(childSession);
      states.delete(childSession);
    }
  });

  const navigate = (target) => cdp.send('Page.navigate', { url: target }, sessionId);
  const evaluateIn = async (targetSession, expression, contextId) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      ...(contextId ? { contextId } : {}),
    }, targetSession);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? '页面脚本异常');
    }
    return result.result.value;
  };

  const evaluate = (expression) => evaluateIn(sessionId, expression);

  const waitFor = async (expression, { timeout = 20000, interval = 100 } = {}) => {
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const value = await evaluate(expression);
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error(`等待超时: ${expression}${lastError ? `（${lastError.message}）` : ''}`);
  };

  const frameTreeOf = async (targetSession) => {
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, targetSession);
    return frameTree;
  };

  /**
   * 在“某个框架 URL 命中指定片段”的位置求值。
   * 跨源 iframe 是独立 target（OOPIF），求值要发到它自己的会话；
   * 同源子框架则用该框架的执行上下文。两种都通过 URL 定位同一个正文框架。
   */
  const evaluateInFrame = async (urlPart, expression, { timeout = 20000 } = {}) => {
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
      for (const targetSession of [sessionId, ...childSessions]) {
        let tree;
        try {
          tree = await frameTreeOf(targetSession);
        } catch {
          continue;
        }
        const known = (frame) => {
          if (frame.url.includes(urlPart)) return true;
          const seen = states.get(targetSession)?.frames.get(frame.id);
          return Boolean(seen && seen.includes(urlPart));
        };
        const walk = (node, parent) => {
          if (known(node.frame)) return { frame: node.frame, root: parent === null };
          for (const child of node.childFrames ?? []) {
            const found = walk(child, node.frame);
            if (found) return found;
          }
          return null;
        };
        const found = walk(tree, null);
        if (!found) continue;
        try {
          if (found.root) return await evaluateIn(targetSession, expression);
          let contextId = states.get(targetSession)?.contexts.get(found.frame.id);
          if (contextId === undefined) {
            // 重新 enable 会让浏览器重放已有的执行上下文，补上启动竞态漏掉的那条。
            await cdp.send('Runtime.enable', {}, targetSession).catch(() => {});
            contextId = states.get(targetSession)?.contexts.get(found.frame.id);
          }
          if (contextId !== undefined) return await evaluateIn(targetSession, expression, contextId);
        } catch (error) {
          lastError = error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`未能在匹配 ${urlPart} 的框架里求值${lastError ? `（${lastError.message}）` : ''}`);
  };

  const frameUrls = async () => {
    const urls = [];
    for (const targetSession of [sessionId, ...childSessions]) {
      try {
        urls.push((await frameTreeOf(targetSession)).frame.url);
      } catch {
        // 忽略已关闭的 target
      }
    }
    return urls;
  };

  if (url && url !== 'about:blank') {
    await navigate(url);
  }

  return { sessionId, targetId, navigate, evaluate, waitFor, evaluateInFrame, frameUrls };
}

/** 关闭一个页面 target，释放它的 iframe 与事件监听。 */
export async function closePage(cdp, page) {
  try {
    await cdp.send('Target.closeTarget', { targetId: page.targetId });
  } catch {
    // target 可能已经不存在
  }
}
