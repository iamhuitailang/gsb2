import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { insertLog, markStaleInterrupted } from './db.js';
import jobsRouter from './routes/jobs.js';
import mockRouter, { mockSiteDir } from './routes/mock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// 仅监听本机，不对外暴露

// —— 本地模拟业务网站（静态页面 + 模拟 API）——
app.use('/mock', mockRouter);
app.use('/mock', express.static(mockSiteDir));

// —— RPA 执行台后端 API ——
app.use('/api', jobsRouter);

// 录入成功后的截图（本地文件）
app.use('/screenshots', express.static(config.screenshotDir));

// 执行台构建产物（npm run build:console 后由后端同源托管）
const consoleDist = path.resolve(__dirname, '../../console/dist');
if (fs.existsSync(consoleDist)) {
  app.use(express.static(consoleDist));
  app.get(/^\/(?!api|mock|screenshots).*/, (req, res) => {
    res.sendFile(path.join(consoleDist, 'index.html'));
  });
}

// 统一错误处理（错误文本同样经过 PII 兜底遮蔽由各模块负责，这里不回显堆栈）
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || '服务器内部错误' });
});

// 重启恢复：上次没跑完的任务显式标记为 interrupted，而不是假装在运行
const staleCount = markStaleInterrupted();
if (staleCount > 0) {
  insertLog({
    level: 'warn',
    event: 'restart_recovery',
    message: `服务重启：检测到 ${staleCount} 个未完成任务，已标记为中断，可在执行台手动恢复`,
  });
}

app.listen(config.port, config.host, () => {
  console.log('─'.repeat(60));
  console.log('  本地 RPA 执行台已启动（仅监听 127.0.0.1，不连接任何外部系统）');
  console.log(`  执行台 API:   http://${config.host}:${config.port}/api`);
  console.log(`  模拟业务网站: http://${config.host}:${config.port}/mock/`);
  if (fs.existsSync(consoleDist)) {
    console.log(`  执行台界面:   http://${config.host}:${config.port}/`);
  } else {
    console.log('  执行台界面:   开发模式请另行运行 npm run dev:console（Vite 5173 端口）');
  }
  console.log('─'.repeat(60));
});
