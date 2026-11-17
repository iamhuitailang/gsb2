import { createApp } from './server.js';

const { server, config } = createApp();

server.listen(config.port, config.host, () => {
  const address = server.address();
  console.log(`本地登录演示服务已启动: http://${address.address}:${address.port}/`);
  console.log(`账号窗口: ${config.accountLimit} 次 / ${config.accountWindowMs / 60000} 分钟`);
  console.log(`来源窗口: ${config.sourceLimit} 次 / ${config.sourceWindowMs / 60000} 分钟`);
  if (!config.demoEnabled) {
    console.log('演示入口已关闭（DEMO_MODE=0 或 NODE_ENV=production）');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
