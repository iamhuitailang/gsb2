import { createApp } from '../src/server.js';

/** 启动一个真实的 HTTP 服务，监听随机端口。 */
export async function startServer(options = {}) {
  const { server, store } = createApp({ demoMode: true, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    store,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * 一个「浏览器」的 Cookie 容器：多个标签页共享，模拟同一个客服账号在多标签下登录。
 */
export function createBrowser(origin) {
  const jar = new Map();

  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  function capture(response) {
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const line of setCookie) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => a.trim().toLowerCase() === 'max-age=0');
      if (expired || value === '') jar.delete(name);
      else jar.set(name, value);
    }
  }

  /** 相对路径会自动补上 origin；重定向不会被跟随（演示服务本身不重定向）。 */
  async function fetchImpl(input, init = {}) {
    const url = typeof input === 'string' && input.startsWith('/') ? `${origin}${input}` : input;
    const headers = new Headers(init.headers || {});
    const cookie = cookieHeader();
    if (cookie) headers.set('cookie', cookie);
    const response = await fetch(url, { ...init, headers, redirect: 'manual' });
    capture(response);
    return response;
  }

  return { fetch: fetchImpl, jar, origin };
}

export async function apiCall(browser, path, { method = 'GET', body } = {}) {
  const response = await browser.fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
