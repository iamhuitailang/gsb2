import { createServer } from 'node:http';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const { handler } = createApp();
const server = createServer(handler);

server.listen(PORT, HOST, () => {
  console.log(`凭据管理演示服务已启动: http://${HOST}:${PORT}`);
});
