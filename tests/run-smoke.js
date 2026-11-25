#!/usr/bin/env node
/*
 * run-smoke.js — 端到端冒烟测试启动器
 * 自动拉起无头 Chrome（远程调试），执行 tests/smoke.js，结束后清理进程。
 * 前置：本机装有 Google Chrome（macOS 默认路径见下方 CHROME_CANDIDATES）。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = 9222;
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gimc-smoke-'));

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  process.env.CHROME_BIN
].filter(Boolean);

function waitForDebugger(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(`http://127.0.0.1:${PORT}/json/version`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      }).on('error', retry);
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('Chrome 调试端口未就绪'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

async function main() {
  const chromeBin = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chromeBin) {
    console.error('未找到 Chrome，请设置环境变量 CHROME_BIN 指向可执行文件。');
    process.exit(2);
  }
  const chrome = spawn(chromeBin, [
    '--headless', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    'file://' + path.join(ROOT, 'index.html')
  ], { stdio: 'ignore' });

  let exitCode = 1;
  try {
    await waitForDebugger(8000);
    await new Promise((resolve, reject) => {
      const test = spawn(process.execPath, [path.join(ROOT, 'tests', 'smoke.js')], { stdio: 'inherit' });
      test.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('冒烟测试失败'))));
    });
    exitCode = 0;
  } finally {
    chrome.kill();
    // Chrome 退出时可能仍持有临时文件，延迟重试一次；清理失败不影响测试结论
    setTimeout(() => {
      try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }, 300);
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
