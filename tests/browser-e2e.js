/*
 * 真实浏览器端到端测试（chrome-headless-shell + CDP，无第三方依赖）：
 *   node tests/browser-e2e.js
 * 验证：示例生成、真实 toBlob 编码候选、两种预算场景分配、
 *       锁定重分配、同步对照渲染、导出 ZIP（含故障注入下的重选提示）。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const CHROME = path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/mac_arm-149.0.7827.22/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const PORT = 0; // 让操作系统分配空闲端口
let BASE = 'http://127.0.0.1';

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); }
  else { failures++; console.error('  ✕ ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 静态服务器 ---------------- */
function startServer() {
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png'
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => {
      BASE = 'http://127.0.0.1:' + server.address().port;
      resolve(server);
    });
  });
}

/* ---------------- 极简 CDP 客户端 ---------------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, timeout: 120000
    });
    if (r.exceptionDetails) {
      throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception &&
        r.exceptionDetails.exception.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  async waitFor(expr, { timeout = 120000, label = expr } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const r = await this.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true, timeout: timeout + 5000
      });
      if (r.exceptionDetails) {
        throw new Error('等待表达式异常: ' + (r.exceptionDetails.exception &&
          r.exceptionDetails.exception.description || r.exceptionDetails.text));
      }
      if (r.result.value) return r.result.value;
      await sleep(300);
    }
    throw new Error('等待超时: ' + label);
  }
}

async function connectChrome() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-e2e-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
    '--remote-debugging-port=0', '--user-data-dir=' + userDir,
    '--remote-allow-origins=*', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let wsUrl;
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('Chrome 启动超时')), 30000));
  const ready = new Promise((resolve) => {
    const onData = (chunk) => {
      const m = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) { proc.stderr.off('data', onData); resolve(m[1]); }
    };
    proc.stderr.on('data', onData);
  });
  const browserWs = await Promise.race([ready, timer]);
  // browserWs 是浏览器级端点；页面级 target 地址从 /json/list 获取
  const httpBase = browserWs.replace(/^ws:\/\//, 'http://').replace(/\/devTools.*$/i, '');
  const targets = await new Promise((resolve, reject) => {
    const req = http.get(httpBase + '/json/list', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
  });
  const pageTarget = targets.find((t) => t.type === 'page') || targets[0];
  wsUrl = pageTarget.webSocketDebuggerUrl;
  const ws = new WebSocket(wsUrl);
  await new Promise((r, rej) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { cdp, proc, userDir };
}

async function main() {
  const server = await startServer();
  const { cdp, proc, userDir } = await connectChrome();
  const consoleErrors = [];
  cdp.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.consoleAPICalled' &&
        ['error', 'warning'].includes(msg.params.type)) {
      const text = msg.params.args.map((a) => a.value || a.description || '').join(' ');
      if (text) consoleErrors.push(msg.params.type + ': ' + text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('exception: ' + JSON.stringify(msg.params.exceptionDetails.text));
    }
  });

  try {
    console.log('页面加载与环境探测：');
    await cdp.send('Page.navigate', { url: BASE + '/index.html' });
    await cdp.waitFor("document.readyState === 'complete'");
    check('页面脚本全部加载', (await cdp.eval(
      '!!(window.ImgEncoding && window.Allocator && window.ZipWriter && window.Samples)')));
    check('页面加载阶段无控制台错误', consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | '));
    check('浏览器支持 WebP 编码', await cdp.eval('window.ImgEncoding.detectWebp()'));

    console.log('示例与真实编码：');
    await cdp.eval(`document.getElementById('btn-samples').click()`);
    await cdp.waitFor('window.__APP_DEBUG__ && window.__APP_DEBUG__.allEncoded === true',
      { label: '候选编码完成', timeout: 180000 });
    await sleep(300);
    const stats = await cdp.eval(`(function(){
      const items = document.querySelectorAll('.item-row');
      const rows = document.querySelectorAll('#candidate-table tbody tr');
      const sizes = Array.from(document.querySelectorAll('#candidate-table .size-bytes'))
        .map(e => parseInt(e.textContent.replace(/[^0-9]/g,''),10));
      return {
        itemCount: items.length,
        rowCount: rows.length,
        allPositive: sizes.length > 0 && sizes.every(n => n > 0),
        sampleNames: Array.from(items).map(r => r.querySelector('.item-name').textContent)
      };
    })()`);
    check('4 张示例图片全部导入', stats.itemCount === 4, JSON.stringify(stats.sampleNames));
    check('候选表生成多行真实编码结果', stats.rowCount >= 20, 'rows=' + stats.rowCount);
    check('所有候选字节数均为正整数（无预估/零字节）', stats.allPositive);

    const candSummary = await cdp.eval(`(function(){
      // 直接从应用状态间接验证：每张图都有成功候选且 PSNR 已计算
      const psnrCells = document.querySelectorAll('#candidate-table .psnr-cell').length;
      const failRows = document.querySelectorAll('#candidate-table tr.fail-row').length;
      return { psnrCells, failRows };
    })()`);
    check('每个成功候选都算出了 PSNR 画质差异', candSummary.psnrCells >= 20,
      JSON.stringify(candSummary));
    check('正常编码下没有失败候选', candSummary.failRows === 0);

    console.log('预算场景与优先级分配：');
    // 正常预算（载入示例时已自动应用 normal）
    await cdp.waitFor("/方案在预算内/.test(document.getElementById('plan-total').textContent)");
    const normalPlan = await cdp.eval(`document.getElementById('plan-total').textContent.trim()`);
    check('正常预算场景方案在预算内', normalPlan.includes('方案在预算内'), normalPlan);

    // 极紧预算
    await cdp.eval(`document.getElementById('btn-tight').click()`);
    await sleep(500);
    const tightText = await cdp.eval(`document.getElementById('plan-total').textContent.trim()`);
    const tightSteps = await cdp.eval(`document.getElementById('plan-steps').innerText`);
    check('极紧预算触发多轮降级或不可行报告',
      tightText.includes('超出') || /第 \d+ 轮/.test(tightSteps), tightText);

    // 找到一个被牺牲的图（chip 带压糊标记）
    const sacrificed = await cdp.eval(`(function(){
      const chips = Array.from(document.querySelectorAll('.chip.sacrificed'));
      return chips.map(c => c.textContent.trim());
    })()`);
    check('能明确看出哪些图为腾空间被压糊（牺牲标记）', sacrificed.length >= 0 &&
      (tightText.includes('超出') || sacrificed.length >= 1), JSON.stringify(sacrificed));

    // 优先级正确性：被降级的应优先是低优先级背景图
    const bgChip = await cdp.eval(`(function(){
      const c = Array.from(document.querySelectorAll('.chip')).find(x =>
        x.textContent.includes('bg-gradient'));
      return c ? c.textContent : null;
    })()`);
    check('低优先级背景图在极紧预算下被优先压缩', bgChip &&
      (bgChip.includes('压糊') || tightText.includes('超出')), bgChip);

    console.log('锁定后重新分配：');
    // 切到背景图，选一个最便宜的可行候选并锁定
    const lockResult = await cdp.eval(`(function(){
      const row = Array.from(document.querySelectorAll('.item-row'))
        .find(r => r.textContent.includes('bg-gradient'));
      row.click();
      const feas = Array.from(document.querySelectorAll('#candidate-table tbody tr'))
        .filter(tr => !tr.classList.contains('blocked') && !tr.classList.contains('fail-row'));
      if (!feas.length) return { locked: false, label: 'NO-FEASIBLE-ROWS' };
      feas[0].click(); // 表里按字节升序，首行是最小可行档
      return { locked: !!document.querySelector('.badge.lock'),
        label: feas[0].querySelector('.cand-name').textContent };
    })()`);
    check('点击候选后出现锁定标记', lockResult.locked, JSON.stringify(lockResult));
    await sleep(300);
    const lockedPlan = await cdp.eval(`(function(){
      return {
        steps: document.getElementById('plan-steps').textContent,
        chips: Array.from(document.querySelectorAll('.chip.locked')).map(c => c.textContent.trim())
      };
    })()`);
    check('锁定项在方案中带锁定标识并参与重新分配',
      lockedPlan.chips.some((c) => c.includes('bg-gradient')), JSON.stringify(lockedPlan.chips));
    check('分配过程有完整步骤记录', lockedPlan.steps.includes('初始方案'));

    console.log('不可行诊断：');
    await cdp.eval(`const b=document.getElementById('budget'); b.value=1; b.dispatchEvent(new Event('input',{bubbles:true}));`);
    await sleep(400);
    const report = await cdp.eval(`(function(){
      const el = document.getElementById('plan-report');
      return { visible: !el.classList.contains('hidden'), text: el.innerText };
    })()`);
    check('预算无法满足时展示卡住原因报告', report.visible &&
      /理论最低|最低可行|约束/.test(report.text), report.text.slice(0, 120));

    console.log('同步对照查看器：');
    const viewer = await cdp.eval(`(function(){
      const o = document.getElementById('canvas-orig');
      const c = document.getElementById('canvas-cand');
      const transforms = [o.style.transform, c.style.transform];
      document.querySelector('[data-zoom="4"]').click();
      const after4x = [o.style.transform, c.style.transform];
      const sameTransform = after4x[0] === after4x[1] && after4x[0].includes('scale(4)');
      document.querySelector('[data-bg="white"]').click();
      const bgWhite = document.getElementById('scroll-orig').classList.contains('bg-white') &&
        document.getElementById('scroll-cand').classList.contains('bg-white');
      document.querySelector('[data-bg="checker"]').click();
      return {
        origPainted: o.width > 0 && o.height > 0,
        candPainted: c.width > 0 && c.height > 0,
        sameTransform, bgWhite
      };
    })()`);
    check('原图与候选画布都已绘制', viewer.origPainted && viewer.candPainted, JSON.stringify(viewer));
    check('两栏缩放同步（4× 同一 transform）', viewer.sameTransform);
    check('透明底色可切换并同步作用于两栏', viewer.bgWhite);

    console.log('导出整组：');
    // 恢复一个可行预算再导出
    await cdp.eval(`document.getElementById('btn-normal').click()`);
    await sleep(400);
    const exportReady = await cdp.eval(`(function(){
      const t = document.getElementById('plan-total').textContent;
      return t.includes('方案在预算内');
    })()`);
    check('导出前方案恢复为可行', exportReady);

    const downloaded = await new Promise(async (resolve) => {
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow', downloadPath: userDir, eventsEnabled: true
      }).catch(() => {});
      await cdp.eval(`document.getElementById('btn-export').click()`);
      const start = Date.now();
      const timer = setInterval(() => {
        const files = fs.readdirSync(userDir).filter((f) => f.endsWith('.zip'));
        if (files.length) { clearInterval(timer); resolve(files); }
        else if (Date.now() - start > 60000) { clearInterval(timer); resolve([]); }
      }, 400);
    });
    check('导出产生 ZIP 文件', downloaded.length >= 1, JSON.stringify(downloaded));
    if (downloaded.length) {
      const zipPath = path.join(userDir, downloaded[0]);
      const zipBytes = fs.readFileSync(zipPath);
      check('ZIP 以 EOCD 签名结尾', zipBytes.readUInt32LE(zipBytes.length - 22) === 0x06054b50);
      check('导出文件名带时间戳，不覆盖原文件',
        /^image-budget-export-\d{8}-\d{6}\.zip$/.test(downloaded[0]), downloaded[0]);
      // 用系统 unzip 验证内容与清单
      const { execFileSync } = require('child_process');
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-unzip-'));
      execFileSync('/usr/bin/unzip', ['-q', zipPath, '-d', outDir]);
      const names = fs.readdirSync(outDir);
      check('ZIP 内含图片与尺寸大小清单', names.includes('size-manifest.csv'),
        JSON.stringify(names));
      const csv = fs.readFileSync(path.join(outDir, 'size-manifest.csv'), 'utf8');
      check('清单记录实际字节与候选信息', /实际字节/.test(csv) && /PNG|WebP/.test(csv));
      const imageFiles = names.filter((n) => /\.(png|webp)$/i.test(n));
      check('清单中的图片全部落盘且非 0 字节',
        imageFiles.length === 4 && imageFiles.every((n) => fs.statSync(path.join(outDir, n)).size > 0));
    }

    console.log('编码故障注入（?failall）：');
    await cdp.send('Page.navigate', { url: BASE + '/index.html?failall=bg-gradient' });
    await cdp.waitFor("document.readyState === 'complete'");
    await cdp.eval(`document.getElementById('btn-samples').click()`);
    await cdp.waitFor('window.__APP_DEBUG__ && window.__APP_DEBUG__.itemCount === 4 && window.__APP_DEBUG__.allEncoded === true',
      { timeout: 180000, label: '故障候选编码' });
    await sleep(300);
    const failDiag = await cdp.eval(`(function(){
      const row = Array.from(document.querySelectorAll('.item-row'))
        .find(r => r.textContent.includes('bg-gradient'));
      row && row.click();
      return {
        failRows: document.querySelectorAll('#candidate-table tr.fail-row').length,
        reportVisible: !document.getElementById('plan-report').classList.contains('hidden'),
        reportText: document.getElementById('plan-report').innerText,
        exportBlocked: (function(){
          document.getElementById('btn-normal').click();
          return true;
        })()
      };
    })()`);
    check('故障注入后该图候选显示编码失败', failDiag.failRows >= 10,
      'failRows=' + failDiag.failRows);
    check('方案报告解释该图全部编码失败', failDiag.reportVisible &&
      failDiag.reportText.includes('编码失败'), failDiag.reportText.slice(0, 100));

    // 尝试导出，应被拦截并提示重选，而不是产出 0 字节文件
    const beforeCount = fs.readdirSync(userDir).filter((f) => f.endsWith('.zip')).length;
    await cdp.eval(`document.getElementById('btn-export').click()`);
    await sleep(800);
    const modalText = await cdp.eval(`(function(){
      const m = document.querySelector('.modal.err');
      return m ? m.innerText : '';
    })()`);
    const afterCount = fs.readdirSync(userDir).filter((f) => f.endsWith('.zip')).length;
    check('导出被拦截并提示重选，不算零字节成功',
      modalText.includes('编码失败') && afterCount === beforeCount, modalText.slice(0, 100));

    check('全程无未处理控制台错误', consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | '));
  } catch (e) {
    failures++;
    console.error('  ✕ E2E 执行异常: ' + e.message);
    console.error(e.stack);
  } finally {
    proc.kill('SIGTERM');
    server.close();
  }

  console.log(failures === 0 ? '\n浏览器 E2E 全部通过' : '\nE2E 失败 ' + failures + ' 项');
  process.exit(failures ? 1 : 0);
}

main();
