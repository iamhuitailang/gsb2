#!/usr/bin/env node
/**
 * 真实浏览器冒烟测试：用 Chrome DevTools Protocol 驱动本地 file:// 页面，
 * 走完整四步流程并收集 console 错误/异常。仅连接本机浏览器，不访问网络。
 *
 * 用法：node scripts/browser-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await sleep(150);
  }
  throw new Error(`等待超时: ${last?.message || '条件未满足'}`);
}
async function readPort(f) {
  const txt = await readFile(f, 'utf8');
  return Number(txt.split('\n')[0]);
}
async function fetchJson(u) {
  await waitFor(() => fetch(u).then((x) => x.ok).catch(() => false), 10000);
  return (await fetch(u)).json();
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = path.resolve(path.join(import.meta.dirname, '..', 'src', 'web', 'index.html'));
const userDir = await mkdtemp(path.join(os.tmpdir(), 'sanlog-chrome-'));

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=0',
  `--user-data-dir=${userDir}`,
  pathToFileURL(PAGE).href,
], { stdio: ['ignore', 'pipe', 'pipe'] });

const errors = [];
let cdp;
try {
  const portFile = path.join(userDir, 'DevToolsActivePort');
  const port = await waitFor(() => readPort(portFile), 15000);
  const list0 = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  let target = list0.find((t) => t.type === 'page' && t.url.startsWith('file:'));
  if (!target) {
    // 页面尚未导航完成，轮询等待 file:// target
    await waitFor(async () => {
      const l = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      target = l.find((t) => t.type === 'page' && t.url.startsWith('file:'));
      return !!target;
    }, 10000);
  }

  cdp = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { cdp.onopen = res; cdp.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  const dialogs = [];
  cdp.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      return;
    }
    if (!m.method) return;
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(`未捕获异常: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errors.push(`console 错误: ${m.params.entry.text}`);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    }
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(m.params.message);
      send('Page.handleJavaScriptDialog', { accept: true });
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      cdp.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面执行失败: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = async (id) => evalJs(`document.getElementById(${JSON.stringify(id)}).click()`);

  // 等页面脚本初始化
  await waitFor(async () => (await evalJs(`!!window.SanLog && document.querySelectorAll('.panel').length === 4`)) === true, 10000);

  // 步骤 1：载入演示日志并解析
  await click('btnLoadDemo');
  const loaded = await evalJs(`document.getElementById('rawInput').value.length`);
  assert(loaded > 500, '演示日志未载入');
  await click('btnParse');
  await waitFor(async () => (await evalJs(`document.getElementById('okCount').textContent`)) === '12', 8000);
  const failCount = await evalJs(`document.getElementById('failCount').textContent`);
  assert(failCount === '1', `失败行数应为 1，实际 ${failCount}`);

  // 步骤 2：规则卡片渲染、默认规则统计
  const ruleCards = await evalJs(`document.querySelectorAll('.rule-card').length`);
  assert(ruleCards >= 20, `规则卡片数量异常: ${ruleCards}`);
  await click('btnToReview');

  // 步骤 3：命中清单 + 标记一致性表
  await waitFor(async () => {
    const n = await evalJs(`document.getElementById('findingCount').textContent`);
    return Number(n) > 10;
  }, 8000);
  const findings = await evalJs(`Number(document.getElementById('findingCount').textContent)`);
  const markerRows = await evalJs(`document.querySelectorAll('.marker-table tbody tr').length`);
  assert(markerRows > 5, `标记表行数异常: ${markerRows}`);

  // 把第一条命中切换为「保留」
  await evalJs(`document.querySelector('.finding-item .mini-btn.active-keep, .finding-item .mini-btn:last-child').click()`);
  const kept = await evalJs(`document.querySelectorAll('.finding-item.keep').length`);
  assert(kept >= 1, '保留操作未生效');

  // 步骤 4：应用并导出
  await click('btnApply');
  await waitFor(async () => (await evalJs(`document.getElementById('panel-export').classList.contains('active')`)), 8000);
  const banner = await evalJs(`document.getElementById('safetyBanner').textContent`);
  assert(/可以导出|安全自检/.test(banner), `安全横幅缺失: ${banner}`);
  assert(/明确选择「保留」/.test(banner), '保留项未在横幅中提示');
  const masked = await evalJs(`document.getElementById('maskedOutput').value`);
  const report = await evalJs(`document.getElementById('reportOutput').value`);
  assert(masked.includes('[REDACTED:') && masked.includes('__sanlog_unprocessable__'), '脱敏导出内容缺失标记或失败包装');
  assert(!report.includes('13812345678'), '处理记录泄漏手机号');
  assert(!masked.includes('AKIAIOSFODNN7EXAMPLE'), '脱敏副本泄漏云密钥');

  // 再导入验证弹窗：存在 1 个保留项，命中应与保留项一致
  await click('btnReimportMasked');
  await waitFor(() => dialogs.length > 0, 5000);
  assert(/属于预期/.test(dialogs[0]), `再导入验证弹窗异常: ${dialogs[0]}`);

  // 全部设为处理后重新应用，再导入应为零新命中
  await click('btnBackToReview');
  await waitFor(async () => (await evalJs(`document.getElementById('panel-review').classList.contains('active')`)) === true, 5000);
  await click('btnAllRedact');
  await click('btnApply');
  await waitFor(async () => (await evalJs(`document.getElementById('panel-export').classList.contains('active')`)) === true, 5000);
  await click('btnReimportMasked');
  await waitFor(() => dialogs.length > 1, 5000);
  assert(/零新命中/.test(dialogs[1]), `全量处理后再导入应零命中: ${dialogs[1]}`);

  // Tab 切换
  await evalJs(`document.querySelector('.tab[data-tab="report"]').click()`);
  const reportPaneActive = await evalJs(`document.getElementById('tab-report').classList.contains('active')`);
  assert(reportPaneActive, '处理记录 Tab 未切换');

  if (errors.length) throw new Error('页面错误：\n' + errors.join('\n'));
  console.log(`✅ 浏览器冒烟通过：${findings} 条命中、${markerRows} 个替代标记、失败行 1、再导入零新命中、无 console 错误`);
} finally {
  cdp?.close();
  chrome.kill();
  await new Promise((res) => chrome.on('exit', res)).catch(() => {});
  await sleep(300);
  // Chrome 偶尔仍持有文件柄，删除做有限重试
  for (let i = 0; i < 5; i++) {
    try {
      await rm(userDir, { recursive: true, force: true });
      break;
    } catch (_) {
      await sleep(300);
    }
  }
}
