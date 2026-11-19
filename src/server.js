// 统一入口：启动授权服务 + 两个演示应用（同一进程，三个端口）。
// 生产语义下三者是独立部署；本地演示合并启动，但凭据与数据边界仍严格按应用区分。
import path from 'node:path';
import { Store } from './store.js';
import { seedAll } from './seed.js';
import {
  APP_A_PORT,
  APP_B_PORT,
  AUTH_PORT,
  ROOT,
  dataPaths,
} from './config.js';
import { createAuthApp } from './auth/server.js';
import { createDemoApp } from './apps/demo-app.js';
import { createServer } from './http.js';

const DEFAULT_DATA_DIR = process.env.GSB_DATA_DIR || path.join(ROOT, 'data');

// 组装所有部件。ports 仅用于日志/链接展示；真实监听在 listenAll 里。
export async function bootstrap({ dataDir = DEFAULT_DATA_DIR, persist = true } = {}) {
  const paths = dataPaths(dataDir);
  const store = await Store.open({
    file: persist ? paths.state : null,
    auditFile: persist ? paths.audit : null,
    persist,
  });
  const { credentials } = await seedAll(store, { clientsFile: persist ? paths.clients : null });

  const authApp = createAuthApp(store);
  // 每个演示应用拿到的是“自己那一条”凭据，验证应用使用自己的凭据访问接口。
  const appA = createDemoApp({ appKey: 'app-a', credentials: credentials['app-a'], store });
  const appB = createDemoApp({ appKey: 'app-b', credentials: credentials['app-b'], store });

  await store.sweep();
  return { store, authApp, appA, appB, credentials, paths };
}

export function createServers({ authApp, appA, appB }) {
  return {
    auth: createServer(authApp),
    appA: createServer(appA),
    appB: createServer(appB),
  };
}

export async function listenAll(servers, ports = {}) {
  const [auth, appA, appB] = await Promise.all([
    listen(servers.auth, ports.auth || AUTH_PORT),
    listen(servers.appA, ports.appA || APP_A_PORT),
    listen(servers.appB, ports.appB || APP_B_PORT),
  ]);
  return { auth, appA, appB };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export async function closeAll(servers) {
  await Promise.all(Object.values(servers).map((s) => new Promise((resolve) => {
    s.closeAllConnections?.();
    s.close(resolve);
  })));
}

// 直接运行：node src/server.js
const isMain = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isMain) {
  const ctx = await bootstrap();
  const servers = createServers(ctx);
  await listenAll(servers);
  const line = (name, port) => `  ${name.padEnd(24)} http://127.0.0.1:${port}/`;
  console.log('工单系统已启动：');
  console.log(line('授权服务 / 工单 API', AUTH_PORT));
  console.log(line('甲应用（只读）', APP_A_PORT));
  console.log(line('乙应用（可更新）', APP_B_PORT));
  console.log('\n演示账号：alice / bob，密码：ticket-demo-pass');
  console.log(`数据目录：${DEFAULT_DATA_DIR}`);
}
