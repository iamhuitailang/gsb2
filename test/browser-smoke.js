/* CDP 冒烟验证：加载页面、收集 console 与异常、执行交互断言、截图。 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9300 + Math.floor(Math.random() * 600);
const TARGET = 'file://' + path.resolve(__dirname, '..', 'index.html');
const SHOT = path.join(__dirname, 'smoke.png');

function getJSON(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profileDir = '/tmp/chrome-smoke-' + Date.now();
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profileDir,
    '--window-size=1600,1000',
    TARGET
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const tabs = await getJSON('/json');
      const page = tabs.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (e) {}
    await sleep(250);
  }
  if (!wsUrl) { console.error('CDP 未就绪'); process.exit(1); }

  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];
  const exceptions = [];

  function send(method, params) {
    const mid = ++id;
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
  }

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map((a) => a.value ?? a.description).join(' ');
      logs.push(msg.params.type + ': ' + args);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      const url = (d.scriptId || '') + ' ' + (d.url || '') + ':' + (d.lineNumber ?? '') + ':' + (d.columnNumber ?? '');
      exceptions.push(url + ' :: ' + (d.exception?.description || d.text));
    }
  });

  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(1500);

  // 诊断：先看初始化是否成功、TT 命名空间与脚本加载情况
  const diag = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      tt: typeof window.TT,
      modules: window.TT ? Object.keys(window.TT) : [],
      editorLen: document.getElementById('editor')?.value.length,
      glyphs: document.querySelectorAll('.tt-glyph').length,
      pills: document.querySelectorAll('.pill').length,
      btnPlay: !!document.getElementById('btnPlay'),
      bodyChildren: document.body.children.length
    })`,
    returnByValue: true
  });
  console.log('诊断:', diag.result.value);
  console.log('早期 console:', logs.join('\n  ') || '(无)');
  console.log('早期异常:', exceptions.join('\n  ') || '(无)');

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result.value;
  };

  const checks = [];
  function check(name, cond, extra) {
    checks.push({ name, ok: !!cond, extra: extra ?? '' });
  }

  // 1. 初始化
  check('编辑器已载入示例文本', (await evalJs(`document.getElementById('editor').value.length`)) > 20);
  const glyphCount = await evalJs(`document.querySelectorAll('.tt-glyph').length`);
  check('舞台渲染了字形 span', glyphCount > 10, glyphCount + ' spans');
  const charReadout = await evalJs(`document.getElementById('charCountReadout').textContent`);
  check('字形统计读数存在', /字形/.test(charReadout), charReadout);

  // 2. 字形完整性：emoji 不拆开
  const emojiWhole = await evalJs(`Array.from(document.querySelectorAll('.tt-glyph')).some(n => n.textContent === '👨‍👩‍👧')`);
  check('ZWJ emoji 是单个 span', emojiWhole);
  const flagWhole = await evalJs(`Array.from(document.querySelectorAll('.tt-glyph')).some(n => n.textContent === '🇨🇳')`);
  check('国旗 emoji 是单个 span', flagWhole);

  // 3. 播放（先重置到起点，避免初始状态干扰）
  await evalJs(`document.getElementById('btnReset').click()`);
  await sleep(100);
  await evalJs(`document.getElementById('btnPlay').click()`);
  await sleep(600);
  const midReveal = await evalJs(`document.querySelectorAll('.tt-glyph:not(.tt-hidden)').length`);
  check('播放后部分字形已显示', midReveal > 0 && midReveal < glyphCount, midReveal + '/' + glyphCount);
  await evalJs(`document.getElementById('btnPause').click()`);
  const pausedCount = await evalJs(`document.querySelectorAll('.tt-glyph:not(.tt-hidden)').length`);
  check('暂停后显示数冻结', pausedCount === midReveal, pausedCount);

  // 4. seek
  await evalJs(`(function(){const s=document.getElementById('seek'); s.value=3; s.dispatchEvent(new Event('input'));})()`);
  const seekCount = await evalJs(`document.querySelectorAll('.tt-glyph:not(.tt-hidden)').length`);
  check('seek 到第 3 字只显示 3 个', seekCount === 3, seekCount);

  // 5. 全文
  await evalJs(`document.getElementById('btnShowAll').click()`);
  const allCount = await evalJs(`document.querySelectorAll('.tt-glyph:not(.tt-hidden)').length`);
  check('全文显示所有字形', allCount === glyphCount, allCount + '/' + glyphCount);

  // 6. 改尺寸后进度对应：调小行宽触发重排版，再检查 seek 3
  await evalJs(`(function(){const w=document.getElementById('cfgLineWidth'); w.value=240; w.dispatchEvent(new Event('input'));})()`);
  await sleep(400);
  const newGlyphs = await evalJs(`document.querySelectorAll('.tt-glyph').length`);
  check('改尺寸后字形总数不变', newGlyphs === glyphCount, newGlyphs);
  const stillThree = await evalJs(`document.querySelectorAll('.tt-glyph:not(.tt-hidden)').length`);
  check('改尺寸后进度保持（全文态仍全部可见）', stillThree === glyphCount, stillThree);

  // 6b. 播放途中改尺寸：进度应保持且自动续播，已显示文字与字形序号对应
  await evalJs(`document.getElementById('btnReset').click()`);
  await sleep(100);
  await evalJs(`document.getElementById('btnPlay').click()`);
  await sleep(400);
  const beforeResize = await evalJs(`document.querySelectorAll('.tt-glyph:not(.tt-hidden)').length`);
  await evalJs(`(function(){const f=document.getElementById('cfgFontSize'); f.value=26; f.dispatchEvent(new Event('input'));})()`);
  await sleep(700); // 等待 160ms 防抖重排版 + 续播推进
  const afterResize = await evalJs(`document.querySelectorAll('.tt-glyph:not(.tt-hidden)').length`);
  const badgeText = await evalJs(`document.getElementById('stateBadge').textContent`);
  check('播放中改尺寸后自动续播', afterResize > beforeResize, `重排前 ${beforeResize} → 后 ${afterResize}（${badgeText}）`);
  // 已显示的字形序号必须连续对应（前 N 个可见，其余隐藏）
  const contiguous = await evalJs(`(function(){const nodes=document.querySelectorAll('.tt-glyph');let hiddenSeen=false;for(let i=0;i<nodes.length;i++){const hid=nodes[i].classList.contains('tt-hidden');if(!hid&&hiddenSeen)return false;if(hid)hiddenSeen=true;}return true;})()`);
  check('已显示文字与字形序号连续对应', contiguous);
  await evalJs(`document.getElementById('btnPause').click()`);

  // 7. 最终版面 tab 与对照 tab 不报错
  await evalJs(`document.querySelector('[data-tab=final]').click()`);
  await sleep(300);
  const finalVisible = await evalJs(`document.querySelectorAll('.tt-glyph:not(.tt-hidden)').length`);
  check('最终版面全部可见', finalVisible === glyphCount);
  await evalJs(`document.querySelector('[data-tab=compare]').click()`);
  await sleep(400);
  const cards = await evalJs(`document.querySelectorAll('.compare-card').length`);
  check('对照视图生成 3 张配置卡', cards === 3, cards);
  const cardOverflow = await evalJs(`document.querySelector('.compare-card .badge')?.textContent || ''`);
  check('对照卡包含溢出/正常徽标', cardOverflow.length > 0, cardOverflow);

  // 8. 导出（在正常样本上验证完整结构）
  const exportOk = await evalJs(`(function(){ try { const pre=document.getElementById('jsonPreview'); return pre.textContent.includes('"pages"') && pre.textContent.includes('"markers"') && pre.textContent.includes('"lines"'); } catch(e){ return false; } })()`);
  check('导出 JSON 含 pages/markers/lines', exportOk);

  // 9. 错误样本：先切回播放 tab（对照视图有 3 份字形，避免计数干扰），再载入 errors 示例
  await evalJs(`document.querySelector('[data-tab=play]').click()`);
  await sleep(300);
  await evalJs(`document.querySelectorAll('.pill')[1].click()`);
  await sleep(400);
  const errorIssues = await evalJs(`document.querySelectorAll('#errorList .issue.error').length`);
  check('错误样本产生定位问题项', errorIssues >= 3, errorIssues);
  // 切换到字形数不同的样本后，滑条 max/读数必须与新字形数一致（回归 163/124 问题）
  const seekSync = await evalJs(`(function(){
    const s=document.getElementById('seek');
    const main=document.querySelectorAll('#stageHost .tt-glyph').length;
    const compare=document.querySelectorAll('.compare-card .tt-glyph').length;
    const n=document.querySelectorAll('.tt-glyph').length;
    const readoutN=parseInt(document.getElementById('seekReadout').textContent.split('/').pop().trim(),10);
    return {ok: parseInt(s.max,10)===main && readoutN===main, max:parseInt(s.max,10), main, compare, total:n, readoutN};
  })()`);
  check('切样本后播放滑条与新字形数同步', seekSync.ok, JSON.stringify(seekSync));
  const issueLocs = await evalJs(`Array.from(document.querySelectorAll('#errorList .issue .loc')).slice(0,3).map(n=>n.textContent).join(' | ')`);
  // 含错误时导出仍可生成，并带 errors 字段
  const exportWithErrors = await evalJs(`document.getElementById('jsonPreview').textContent.includes('"errors"')`);
  check('含错误标记时导出仍可用并带 errors', exportWithErrors);

  // 10. 预设保存
  await evalJs(`document.getElementById('presetName').value='冒烟预设'; document.getElementById('btnSavePreset').click()`);
  const presetSaved = await evalJs(`document.getElementById('presetList').textContent.includes('冒烟预设')`);
  check('预设可保存并列出', presetSaved);

  // 回到播放页并截图
  await evalJs(`document.querySelector('[data-tab=play]').click()`);
  await sleep(300);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));

  console.log('\n=== 浏览器冒烟结果 ===');
  let fail = 0;
  for (const c of checks) {
    console.log((c.ok ? '  ✓ ' : '  ✗ ') + c.name + (c.extra ? '  [' + c.extra + ']' : ''));
    if (!c.ok) fail++;
  }
  console.log('\nConsole 输出:', logs.length ? logs.join('\n  ') : '(无)');
  console.log('未捕获异常:', exceptions.length ? exceptions.join('\n  ') : '(无)');
  console.log('问题定位示例:', issueLocs || '(无)');
  console.log('截图:', SHOT);

  ws.close();
  chrome.kill();
  process.exit(fail || exceptions.length ? 1 : 0);
})().catch((e) => {
  console.error('脚本失败:', e);
  process.exit(1);
});
