'use strict';

/**
 * 同时启动两个不同来源（不同端口）的本地站点：
 *   来源 A 预约后台   http://localhost:5001
 *   来源 B 通知页     http://localhost:5002
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const BACKEND_PORT = process.env.BACKEND_PORT || 5001;
const NOTIFY_PORT = process.env.NOTIFY_PORT || 5002;

const children = [];

function start(label, file, env) {
  const child = spawn(process.execPath, [path.join(__dirname, file)], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = Buffer.from(`[${label}] `);
  const prefix = (buf) =>
    buf
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => process.stdout.write(Buffer.concat([tag, Buffer.from(line + '\n')])));
  child.stdout.on('data', prefix);
  child.stderr.on('data', prefix);
  child.on('exit', (code) => {
    console.log(`[runner] ${label} 退出，code=${code}`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

function shutdown(code) {
  for (const c of children) {
    if (!c.killed) c.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('backend', 'backend/server.js', { BACKEND_PORT: String(BACKEND_PORT) });
start('notify', 'notification/server.js', {
  NOTIFY_PORT: String(NOTIFY_PORT),
  BACKEND_URL: `http://localhost:${BACKEND_PORT}`,
});

console.log('──────────────────────────────────────────────────────');
console.log(` 预约后台（来源 A）: http://localhost:${BACKEND_PORT}`);
console.log(` 通知页  （来源 B）: http://localhost:${NOTIFY_PORT}`);
console.log(' Ctrl+C 停止全部服务');
console.log('──────────────────────────────────────────────────────');
