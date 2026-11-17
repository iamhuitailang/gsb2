import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Store } from './src/store.js';
import { createRouter } from './src/routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || resolve(__dirname, 'data.json');

const store = await Store.load(DATA_FILE);

// 首次启动播种演示账号（明文密码不落盘，只存 scrypt 哈希）
if (!store.findUserByName('admin')) {
  store.createUser('admin', 'duty123');
  await store.flush();
}

const server = createServer(createRouter(store));

server.listen(PORT, () => {
  const actualPort = server.address().port;
  console.log(`值班后台已启动： http://localhost:${actualPort}`);
  console.log(`演示账号：admin / duty123 ；数据文件：${DATA_FILE}`);
});

async function shutdown() {
  try {
    await store.flush();
  } finally {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
