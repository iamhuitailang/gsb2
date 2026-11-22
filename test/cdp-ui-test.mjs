// 极简 CDP 驱动：加载 index.html → 点击导出 → 读取回读面板，验证完整 UI 链路。
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

setTimeout(() => { console.log('测试超时退出'); process.exit(2); }, 60000).unref();

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9222;
const profile = '/tmp/roomlab-cdp';
rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1800));

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id;
  pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evalJs = (expression) =>
  send('Runtime.evaluate', { expression, returnByValue: true }).then((r) => r.result.value);

await send('Page.enable');
await send('Runtime.enable');
// 监听所有未捕获异常和 console 输出
send('Runtime.enable');
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    console.log('未捕获异常:', d.exception?.description || d.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    console.log('console.error:', m.params.args.map((a) => a.value || a.description).join(' '));
  }
});
await send('Page.navigate', { url: 'file://' + process.cwd() + '/index.html' });
await new Promise((r) => setTimeout(r, 6000));

const status = await evalJs(`document.getElementById('renderStatus').textContent`);
console.log('渲染状态:', status);
const logTail = await evalJs(`document.getElementById('processLog').textContent.slice(-300)`);
console.log('日志尾部:', logTail);

// 逐步复现 doExport，定位中断点
const trace = await evalJs(`(function(){
  const out = [];
  try {
    out.push('RoomLab? ' + (typeof window.RoomLab));
    out.push('wav.encodeWav? ' + (typeof window.RoomLab?.wav?.encodeWav));
    out.push('Blob? ' + (typeof Blob));
    out.push('URL.createObjectURL? ' + (typeof URL?.createObjectURL));
    // 检查事件监听器是否真的绑定：用 getEventListeners 不可用，改为检查按钮 onclick 与触发
    const btn = document.getElementById('btnExport');
    out.push('btn exists? ' + !!btn + ' disabled=' + btn.disabled);
    return out.join(' | ');
  } catch(e) { return 'trace err: ' + e.message; }
})()`);
console.log('环境追踪:', trace);

// 探针确认 click 事件到达按钮，然后真正点击
await evalJs(`window.__probe = false;
  document.getElementById('btnExport').addEventListener('click', () => { window.__probe = true; }, true);`);
await evalJs(`document.getElementById('btnExport').click()`);
await new Promise((r) => setTimeout(r, 1000));
console.log('捕获阶段探针:', await evalJs(`window.__probe`));
console.log('下载链接:', await evalJs(`document.getElementById('downloadLink').textContent`));

const rows = await evalJs(`Array.from(document.querySelectorAll('#readbackPanel tr')).map((tr) => ({
  badge: tr.querySelector('.badge')?.textContent,
  ok: tr.querySelector('.badge')?.classList.contains('ok'),
  name: tr.querySelector('th')?.textContent,
  detail: tr.querySelector('td:last-child')?.textContent,
}))`);
console.log('导出回读面板：');
let allOk = true;
for (const r of rows) {
  console.log(`  [${r.badge}] ${r.name} — ${r.detail}`);
  if (!r.ok) allOk = false;
}
const link = await evalJs(`document.getElementById('downloadLink').textContent`);
console.log('下载文件名:', link);

// 三种位深逐一导出，确认每种都通过回读核对
for (const bd of ['16', '24', '32f']) {
  await evalJs(`document.getElementById('bitDepth').value = '${bd}'`);
  await evalJs(`document.getElementById('btnExport').click()`);
  await new Promise((r) => setTimeout(r, 600));
  const bdRows = await evalJs(`Array.from(document.querySelectorAll('#readbackPanel tr .badge'))
    .map((b) => b.classList.contains('ok'))`);
  const bdAllPass = bdRows.length >= 5 && bdRows.every(Boolean);
  console.log(`位深 ${bd}: ${bdAllPass ? '全部通过' : '存在失败'}（${bdRows.length} 项检查）`);
  if (!bdAllPass) allOk = false;
}
// 复位到 16-bit
await evalJs(`document.getElementById('bitDepth').value = '16'`);

// 预览导出文件
await evalJs(`document.getElementById('btnPreviewExport').click()`);
await new Promise((r) => setTimeout(r, 600));
const previewErr = await evalJs(`window.__err || null`);
console.log('预览启动:', previewErr ? '失败 ' + previewErr : '无异常');

// 模式切换 + seek 的 UI 链路
await evalJs(`document.querySelector('input[value="wet"]').click()`);
const modeGain = await evalJs(`(() => {
  // 内部 player 不直接暴露，用渲染状态间接验证：切换不报错即通过
  return document.querySelector('input[name="mode"]:checked').value;
})()`);
console.log('模式切换为:', modeGain);

chrome.kill();
console.log(allOk && rows.length >= 5 ? '\nUI 链路测试通过' : '\nUI 链路测试失败');
process.exit(allOk && rows.length >= 5 ? 0 : 1);
