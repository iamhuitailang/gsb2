import http from 'node:http';
import { createConfig, syncOrigins, LOOPBACK_HOSTS } from './config.js';
import { ReportStore } from './store.js';
import { SessionStore } from './session.js';
import { createBusinessServer } from './businessServer.js';
import { createReportServer } from './reportServer.js';
import { createTrackerServer } from './trackerServer.js';

/** 把所有异步处理器的异常收口，避免未处理的 Promise 拒绝把进程带崩。 */
function safeHandler(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const body = Buffer.from('服务器内部错误', 'utf8');
      res.writeHead(500, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(body);
      process.stderr.write(`[gsb2] ${req.method} ${req.url}: ${error?.stack ?? error}\n`);
    });
  };
}

export function createApp(options = {}) {
  const config = options.config ?? createConfig(options);
  const store = new ReportStore(config.dataDir);
  const sessions = new SessionStore();
  const events = { blockedRequests: [], trackerRequests: [] };
  let started = false;

  const servers = {
    business: http.createServer(safeHandler(createBusinessServer({ config, store, sessions, events }).handler)),
    report: http.createServer(safeHandler(createReportServer({ config, store, events }).handler)),
    tracker: http.createServer(safeHandler(createTrackerServer({ config, events }).handler)),
  };

  const listen = (server, host, port) =>
    new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });

  const closeAll = () => Promise.all(Object.values(servers).map((server) => new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));

  /**
   * 候选绑定方案：
   * 1. 三个回环地址 + 同一端口（主机不同 ⇒ 三个独立的源，cookie 与存储也按主机隔离）；
   * 2. 端口顺延，重复 1；
   * 3. 环境不允许绑定 127.0.0.2/127.0.0.3 时，退回 127.0.0.1 + 三段相邻端口。
   *    此时源隔离仍成立（端口不同即不同源），但 cookie 作用域会退化到“同主机”；
   *    报告内容本身仍是不透明源、脚本全禁，业务 API 也仍拒绝非 same-origin 请求，
   *    因此“报告读不到账号信息、不能替业务页操作”这一约束不受影响。
   *    这里不使用 localhost 作主机名：它可能解析到 ::1，而我们只监听 IPv4 回环。
   */
  function* candidates(basePort) {
    for (let bump = 0; bump < 8; bump += 1) {
      const port = basePort + bump;
      yield { hosts: { ...LOOPBACK_HOSTS }, ports: { business: port, report: port, tracker: port } };
    }
    for (let bump = 0; bump < 8; bump += 1) {
      const port = basePort + bump * 3;
      yield {
        hosts: { business: '127.0.0.1', report: '127.0.0.1', tracker: '127.0.0.1' },
        ports: { business: port, report: port + 1, tracker: port + 2 },
      };
    }
  }

  async function start() {
    await store.init();

    let lastError = null;
    for (const candidate of candidates(config.ports.business)) {
      try {
        for (const key of ['business', 'report', 'tracker']) {
          await listen(servers[key], candidate.hosts[key], candidate.ports[key]);
        }
        config.hosts = { ...candidate.hosts };
        config.ports = { ...candidate.ports };
        syncOrigins(config);
        started = true;
        return { config, ports: { ...config.ports } };
      } catch (error) {
        lastError = error;
        await closeAll();
        if (error.code !== 'EADDRINUSE' && error.code !== 'EADDRNOTAVAIL') throw error;
      }
    }
    throw lastError ?? new Error('无法绑定端口');
  }

  async function stop() {
    if (!started) return;
    started = false;
    await closeAll();
  }

  return { config, store, sessions, events, servers, start, stop };
}
