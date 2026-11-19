// serve 命令：启动本地 Web 界面。
import { startServer } from '../web/server.js';

export async function runServe(flags) {
  const host = flags.host ?? '127.0.0.1';
  const port = Number(flags.port ?? 8080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`非法端口：${flags.port}`);
  }
  const server = await startServer({ host, port });
  const address = server.address();
  process.stderr.write(
    `lock-audit Web 界面已启动：http://${host}:${address.port}（仅监听本机，离线可用，Ctrl+C 退出）\n`,
  );
  return server;
}
