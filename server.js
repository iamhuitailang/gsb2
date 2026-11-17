import http from 'node:http';
import { createApp } from './src/app.js';

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const { handler } = createApp();

const server = http.createServer(handler);
server.listen(port, host, () => {
  console.log(`客服工作台演示已启动：http://${host}:${port}`);
  console.log('验收入口：打开 http://%s:%d/ ，点击“并排打开甲乙两个标签”', host, port);
});
