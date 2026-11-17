import { createApp } from './app.js';

const app = createApp();
const { config } = await app.start();

console.log('供应商报告库已启动');
console.log(`  业务页      ${config.origins.business}/`);
console.log(`  隔离报告站  ${config.origins.report}/`);
console.log(`  第二站点    ${config.origins.tracker}/count  （用于验证外部资源未被加载）`);
console.log(`  数据目录    ${config.dataDir}`);
console.log('按 Ctrl+C 退出。');

const shutdown = async () => {
  await app.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
