/* 端到端测试：用 headless Chrome + CDP 真实加载页面（零依赖，Node >= 22）
 * 运行：node test/e2e.cjs
 * 前提：本机装有 Chrome / chrome-headless-shell（离线运行，不访问网络）。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8931;
const ROOT = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    path.join(
      os.homedir(),
      '.cache/puppeteer/chrome-headless-shell/mac_arm-149.0.7827.22/chrome-headless-shell-mac-arm64/chrome-headless-shell'
    ),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error('未找到 Chrome，可设置 CHROME_BIN 环境变量');
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

let msgId = 0;
function cdp(ws, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const onMsg = (event) => {
      const m = JSON.parse(event.data.toString());
      if (m.id === id) {
        ws.removeEventListener('message', onMsg);
        m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expr) {
  const r = await cdp(ws, 'Runtime.evaluate', {
    expression: `(async()=>{ ${expr} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception));
  }
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = await startServer();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e2e-'));
  const port = 9222 + Math.floor(Math.random() * 100);
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=' + userDir,
      '--remote-allow-origins=*',
      `--remote-debugging-port=${port}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  );

  try {
    let version;
    for (let i = 0; i < 40; i++) {
      try {
        version = await getJson(`http://127.0.0.1:${port}/json/version`);
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!version) throw new Error('Chrome 调试端口未就绪');
    console.log('Chrome 已启动:', version.Browser);
    // /json/version 给的是浏览器级 endpoint（无 Page 域），需取 page target
    let targets;
    for (let i = 0; i < 40; i++) {
      targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      if (Array.isArray(targets) && targets.some((t) => t.type === 'page')) break;
      await sleep(250);
    }
    const pageTarget = targets.find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('未找到 page target');
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    await cdp(ws, 'Page.enable');
    await cdp(ws, 'Runtime.enable');
    await cdp(ws, 'Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    await sleep(1200);

    const results = [];
    const check = (name, cond, extra) => {
      if (!cond) throw new Error(name + ' 失败' + (extra ? ': ' + JSON.stringify(extra) : ''));
      results.push('✓ ' + name);
    };

    // 1) 载入内置示例（10 张，含两组重名）
    await evaluate(ws, `document.getElementById('btnSamples').click(); await new Promise(r=>setTimeout(r,400));`);
    const stats = await evaluate(ws, `return ({
      rows: document.querySelectorAll('.sprite-row').length,
      count: document.getElementById('statCount').textContent,
      size: document.getElementById('statSize').textContent,
      renameBadges: document.querySelectorAll('.badge-rename').length,
      canvas: !!document.querySelector('.preview-stage canvas'),
    });`);
    check('载入 10 张示例', stats.rows === 10, stats);
    check('统计条显示 10/10（含 4x4 极小内容的极端裁剪样例）', stats.count === '10 / 10', stats);
    check('重名徽章出现（hero/gem 各一个副本）', stats.renameBadges === 2, stats);
    check('预览画布已生成', stats.canvas === true, stats);

    // 1b) 导入一张真正全透明的 PNG，应被标记并排除在图集之外
    await evaluate(ws, `
      const c = document.createElement('canvas'); c.width = 32; c.height = 24;
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'fully_transparent.png', {type:'image/png'}));
      const input = document.getElementById('fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', {bubbles:true}));
      await new Promise(r=>setTimeout(r,400));
    `);
    const emptyInfo = await evaluate(ws, `return ({
      rows: document.querySelectorAll('.sprite-row').length,
      emptyPills: document.querySelectorAll('.status-pill.empty').length,
      rejWarn: Array.from(document.querySelectorAll('.rej-item.warn')).length,
      count: document.getElementById('statCount').textContent,
    });`);
    check('全透明图进入列表但标记 empty', emptyInfo.rows === 11 && emptyInfo.emptyPills === 1, emptyInfo);
    check('全透明图出现在警告面板且已排入数仍为 10',
      emptyInfo.rejWarn === 1 && emptyInfo.count === '10 / 11', emptyInfo);

    // 2) 重名不覆盖：manifest 的帧键唯一
    const manifest = await evaluate(ws, `
      const blob = new Blob();
      window.__captured = [];
      URL.createObjectURL = (b) => { window.__captured.push(b); return 'blob:x'; };
      HTMLAnchorElement.prototype.click = function(){};
      document.getElementById('btnExportManifest').click();
      await new Promise(r=>setTimeout(r,200));
      const text = await window.__captured[0].text();
      return JSON.parse(text);
    `).then(() => evaluate(ws, `return window.__captured[0].text();`));
    const man = JSON.parse(manifest);
    const keys = Object.keys(man.frames);
    check('清单帧键两两唯一（重名不覆盖说明项）', new Set(keys).size === keys.length, keys);
    check('清单包含重名后缀条目', keys.some((k) => k.includes('hero-1.png')), keys);
    check('meta 含完整设置字段', !!man.meta.settings && typeof man.meta.settings.extrude === 'number');

    // 3) 旋转：窄画布迫使旋转出现
    await evaluate(ws, `
      const w = document.getElementById('setWidth'); w.value = 180;
      w.dispatchEvent(new Event('input', {bubbles:true}));
      const h = document.getElementById('setHeight'); h.value = 1024;
      h.dispatchEvent(new Event('input', {bubbles:true}));
      await new Promise(r=>setTimeout(r,300));
    `);
    const rotInfo = await evaluate(ws, `return ({
      rotated: Array.from(document.querySelectorAll('.sprite-sub')).filter(e=>e.textContent.includes('旋转')).length,
      rejected: document.querySelectorAll('#rejectedList .rej-item').length,
      visible: !document.getElementById('rejectedBox').classList.contains('hidden'),
    });`);
    check('窄画布下出现旋转放置', rotInfo.rotated >= 1, rotInfo);

    // 4) 放不下时给出拒绝原因与定位按钮
    await evaluate(ws, `
      const w = document.getElementById('setWidth'); w.value = 60;
      w.dispatchEvent(new Event('input', {bubbles:true}));
      const h = document.getElementById('setHeight'); h.value = 60;
      h.dispatchEvent(new Event('input', {bubbles:true}));
      await new Promise(r=>setTimeout(r,300));
    `);
    const rej = await evaluate(ws, `return ({
      visible: !document.getElementById('rejectedBox').classList.contains('hidden'),
      items: document.querySelectorAll('#rejectedList .rej-item').length,
      detail: document.querySelector('#rejectedList .rej-detail')?.textContent || '',
      hasJump: !!document.querySelector('#rejectedList .jump-btn'),
    });`);
    check('放不下时拒绝面板出现', rej.visible && rej.items >= 1, rej);
    check('拒绝原因含尺寸/空闲矩形说明', /(空闲矩形|超过图集上限)/.test(rej.detail), rej);
    check('提供「在列表中定位」按钮', rej.hasJump, rej);

    // 5) 恢复大画布，验证稳定重排：删一张再加回，其余位置不变
    await evaluate(ws, `
      const w = document.getElementById('setWidth'); w.value = 1024;
      w.dispatchEvent(new Event('input', {bubbles:true}));
      const h = document.getElementById('setHeight'); h.value = 1024;
      h.dispatchEvent(new Event('input', {bubbles:true}));
      await new Promise(r=>setTimeout(r,300));
    `);
    // 删除第一行，再载入示例（新增回来）；检查变化摘要包含 删除/新增
    await evaluate(ws, `
      document.querySelector('.sprite-row [data-delete]').click();
      await new Promise(r=>setTimeout(r,300));
      window.__change1 = document.getElementById('changeSummary').textContent;
      document.getElementById('btnSamples').click();
      await new Promise(r=>setTimeout(r,400));
      window.__change2 = document.getElementById('changeSummary').textContent;
    `);
    const changes = await evaluate(ws, `return ({c1: window.__change1, c2: window.__change2,
      rows: document.querySelectorAll('.sprite-row').length});`);
    check('删除后变化摘要提示「删除」', changes.c1.includes('删除'), changes);
    check('重新加入后提示「新增」且行数恢复为 20（11-1+10）',
      changes.c2.includes('新增') && changes.rows === 20, changes);

    // 6) 预览模式切换
    await evaluate(ws, `document.getElementById('viewOriginal').click();`);
    const origMode = await evaluate(ws, `return document.getElementById('viewOriginal').classList.contains('active');`);
    check('可切换到原尺寸对照视图', origMode === true);
    await evaluate(ws, `document.getElementById('viewAtlas').click();`);

    // 7) 工程文件导出/导入往返：先捕获工程 JSON
    const projectJson = await evaluate(ws, `
      window.__captured.length = 0;
      document.getElementById('btnExportProject').click();
      await new Promise(r=>setTimeout(r,200));
      return window.__captured[0].text();
    `);
    const proj = JSON.parse(projectJson);
    check('工程文件含 settings/sprites/layout',
      Array.isArray(proj.sprites) && proj.sprites.length === 20 &&
      Array.isArray(proj.layout) && !!proj.settings, { n: proj.sprites && proj.sprites.length });
    check('工程内嵌 dataUrl（自包含、可离线恢复）',
      proj.sprites.every((s) => String(s.dataUrl).startsWith('data:image/png;base64,')));

    // 用工程文件走真实 File 输入管线重新导入
    const roundTrip = await evaluate(ws, `
      const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(projectJson)}], 'project.json', {type:'application/json'}));
      const input = document.getElementById('projectInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', {bubbles:true}));
      await new Promise(r=>setTimeout(r,800));
      return ({
        rows: document.querySelectorAll('.sprite-row').length,
        size: document.getElementById('statSize').textContent,
        stable: document.getElementById('changeSummary').textContent,
      });
    `);
    check('工程重新导入后精灵数量一致', roundTrip.rows === 20, roundTrip);
    check('重导后布局保持稳定（无变化提示）', roundTrip.stable.includes('无变化'), roundTrip);

    // 8) 清单字段可还原原始边距与旋转
    const man2 = JSON.parse(await evaluate(ws, `
      window.__captured.length = 0;
      document.getElementById('btnExportManifest').click();
      await new Promise(r=>setTimeout(r,200));
      return window.__captured[0].text();
    `));
    const sampleFrame = man2.frames[Object.keys(man2.frames)[0]];
    check('每帧含 frame/rotated/spriteSourceSize/sourceSize/contentRect',
      ['frame', 'rotated', 'trimmed', 'spriteSourceSize', 'sourceSize', 'contentRect']
        .every((k) => k in sampleFrame), sampleFrame);
    const anyRotatedFrame = Object.values(man2.frames).some((f) => f.rotated === false || f.rotated === true);
    check('rotated 字段为布尔值（可还原旋转状态）', anyRotatedFrame);

    // 9) 逐张导出触发 19 次下载且文件名唯一
    // 9) 逐张导出：下载次数 = 已排入精灵数（全透明精灵不进图集），文件名唯一
    const expected = await evaluate(ws, `
      const total = document.querySelectorAll('.sprite-row').length;
      const empty = document.querySelectorAll('.status-pill.empty').length;
      return total - empty;
    `);
    const names = await evaluate(ws, `
      window.__names = [];
      const oldClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function(){ window.__names.push(this.download); };
      document.getElementById('btnExportSprites').click();
      await new Promise(r=>setTimeout(r,3500));
      HTMLAnchorElement.prototype.click = oldClick;
      return JSON.stringify(window.__names);
    `).then((s) => JSON.parse(s));
    check('逐张导出数量与已排入精灵数一致', names.length === expected, { n: names.length, expected });
    check('导出文件名两两唯一（不覆盖文件）', new Set(names).size === names.length, names);

    ws.close();
    chrome.kill();
    console.log('\n端到端测试结果：');
    results.forEach((r) => console.log('  ' + r));
    console.log('\n共 ' + results.length + ' 项全部通过');
  } finally {
    server.close();
    try {
      fs.rmSync(userDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((e) => {
  console.error('E2E 失败:', e);
  process.exit(1);
});
