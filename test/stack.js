// 测试设施：每个用例启动一套独立的三服务（内存存储、随机端口），互不干扰。
import http from 'node:http';
import { Store } from '../src/store.js';
import { seedAll } from '../src/seed.js';
import { createAuthApp } from '../src/auth/server.js';
import { createDemoApp } from '../src/apps/demo-app.js';
import { createServer } from '../src/http.js';

// 先占随机端口，再据此生成 redirect_uri 与注册凭据，避免固定端口冲突。
export async function startStack() {
  const blanks = [http.createServer(), http.createServer(), http.createServer()];
  const ports = {};
  await Promise.all(blanks.map((s, i) => new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      ports[['auth', 'appA', 'appB'][i]] = s.address().port;
      resolve();
    });
  })));

  const redirectUris = {
    'app-a': `http://127.0.0.1:${ports.appA}/callback`,
    'app-b': `http://127.0.0.1:${ports.appB}/callback`,
  };

  const store = await Store.open({ persist: false });
  const { credentials } = await seedAll(store, { clientsFile: null, redirectUris });

  const handlers = [
    createAuthApp(store),
    createDemoApp({ appKey: 'app-a', credentials: credentials['app-a'], store, redirectUri: redirectUris['app-a'], authOrigin: `http://127.0.0.1:${ports.auth}` }),
    createDemoApp({ appKey: 'app-b', credentials: credentials['app-b'], store, redirectUri: redirectUris['app-b'], authOrigin: `http://127.0.0.1:${ports.auth}` }),
  ];
  blanks.forEach((server, i) => server.on('request', (req, res) => { handlers[i](req, res); }));

  return {
    store,
    credentials,
    ports,
    redirectUris,
    origin: `http://127.0.0.1:${ports.auth}`,
    appA: `http://127.0.0.1:${ports.appA}`,
    appB: `http://127.0.0.1:${ports.appB}`,
    async close() {
      await Promise.all(blanks.map((s) => new Promise((r) => {
        s.closeAllConnections?.();
        s.close(r);
      })));
    },
  };
}

// 直接以应用身份调令牌端点。
export async function tokenRequest(stack, clientId, clientSecret, params) {
  const res = await fetch(`${stack.origin}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
