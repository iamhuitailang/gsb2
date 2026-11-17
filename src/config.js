import path from 'node:path';

/**
 * 三个源必须彼此隔离：
 * - business：采购系统业务页（持有登录会话与账号信息）
 * - report：隔离报告站点（只提供报告与随报告提供的资源）
 * - tracker：第二个本地站点，用来证明外部资源没有被请求
 *
 * 用不同的回环地址而不是不同端口：浏览器把不同主机视为不同的源，cookie 与
 * localStorage 也按主机隔离；只换端口的话 cookie 仍会跨端口共享。
 * 三个站点共用同一个端口号，便于阅读与核对。
 *
 * 若运行环境不允许绑定 127.0.0.2/127.0.0.3，启动时会自动退回
 * 127.0.0.1 + 三段相邻端口。此时隔离仍成立（端口不同即不同源），
 * 只是 cookie 作用域退化为“同主机”；报告内容依旧是不透明源、脚本全禁，
 * 业务 API 也会拒绝所有非 same-origin 请求。
 */
export const LOOPBACK_HOSTS = {
  business: '127.0.0.1',
  report: '127.0.0.2',
  tracker: '127.0.0.3',
};

export function createConfig(options = {}) {
  const basePort = options.basePort ?? Number(process.env.GSB_BASE_PORT ?? 4100);
  const dataDir = options.dataDir ?? process.env.GSB_DATA_DIR ?? path.resolve(process.cwd(), 'data');

  const config = {
    dataDir,
    hosts: { ...(options.hosts ?? LOOPBACK_HOSTS) },
    ports: { business: basePort, report: basePort, tracker: basePort },
    origins: {},
    labels: {
      business: '采购系统（业务）',
      report: '隔离报告站点',
      tracker: '第二个本地站点',
    },
  };
  syncOrigins(config);
  return config;
}

export function syncOrigins(config) {
  for (const key of ['business', 'report', 'tracker']) {
    config.origins[key] = `http://${config.hosts[key]}:${config.ports[key]}`;
  }
  return config;
}
