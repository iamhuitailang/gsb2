/* 端到端测试：通过 Chrome DevTools Protocol（Node 内置 WebSocket，无第三方依赖）
 * 驱动真实 Chrome 打开 file:// 页面，验证逐帧、标注、修订迁移、项目存取、导出。
 *
 * 运行方式：
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless=new --remote-debugging-port=9222 \
 *     --user-data-dir=/tmp/vrs-chrome-profile about:blank &
 *   node tests/e2e.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';
const REPO = path.resolve(__dirname, '..');
const DOWNLOAD_DIR = path.join(os.tmpdir(), 'vrs-test-downloads');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
const pageUrl = 'file://' + REPO + '/index.html?test=' + Date.now();
const v1Path = path.join(REPO, 'samples/sample_v1.mp4');
const v2Path = path.join(REPO, 'samples/sample_v2.mp4');

let msgId = 0;
const pending = new Map();

async function cdp(ws, method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ✓', msg);
};

async function evalJs(ws, expr) {
  const { result, exceptionDetails } = await cdp(ws, 'Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error('JS 异常: ' + (exceptionDetails.exception?.description || JSON.stringify(exceptionDetails)));
  }
  return result.value;
}

async function main() {
  // 新建标签页
  const created = await (await fetch(`${BASE}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, method } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${method} -> ${msg.error.message}`));
      else resolve(msg.result);
    }
  };

  await cdp(ws, 'Runtime.enable');
  await cdp(ws, 'Page.enable');
  await cdp(ws, 'DOM.enable');

  // 等页面脚本初始化
  for (let i = 0; i < 50; i++) {
    const ready = await evalJs(ws, '!!window.app');
    if (ready) break;
    await sleep(100);
  }
  assert(await evalJs(ws, '!!window.app'), '页面与 App 初始化成功（file:// 下所有模块加载正常）');

  // 关闭可能存在的 autosave 干扰（清存储 + 重置内存状态）
  await evalJs(ws, 'localStorage.clear(); app.store.reset();');

  // ---------- 1. 打开 v1 ----------
  console.log('\n[1] 打开本地视频 v1');
  await evalJs(ws, `(async () => {
    const buf = await ${readBufferExpr(v1Path)};
    const file = new File([buf], 'sample_v1.mp4', { type: 'video/mp4' });
    await app.openVideo(file);
    await new Promise(r => setTimeout(r, 300));
  })()`);
  const meta = await evalJs(ws, 'JSON.stringify({frames: app.player.frameCount, w: app.player.video.videoWidth, h: app.player.video.videoHeight, media: !!app.store.state.media})');
  const m = JSON.parse(meta);
  assert(m.frames === 90, `v1 识别为 90 帧（实际 ${m.frames}）`);
  assert(m.w === 960 && m.h === 540, `分辨率 960×540（实际 ${m.w}×${m.h}）`);
  assert(m.media === true, '素材信息已写入项目');

  // ---------- 2. 逐帧前进/后退与时间码 ----------
  console.log('\n[2] 逐帧控制与时间码');
  await evalJs(ws, 'app.player.seekToFrame(10)');
  await sleep(150);
  assert(await evalJs(ws, 'app.player.currentFrame') === 10, '跳转到第 10 帧');
  assert(await evalJs(ws, 'document.querySelector("#tc-current").textContent') === '00:00:00:10', '时间码显示 00:00:00:10，与帧位置对应');
  await evalJs(ws, 'app.player.step(1)');
  await sleep(150);
  assert(await evalJs(ws, 'app.player.currentFrame') === 11, '逐帧前进 → 11');
  await evalJs(ws, 'app.player.step(-1)');
  await sleep(150);
  assert(await evalJs(ws, 'app.player.currentFrame') === 10, '逐帧后退 → 10');

  // 时间码字符串跳转
  await evalJs(ws, `document.querySelector('#frame-jump').value='00:00:01:10'; app.jumpByInput()`);
  await sleep(150);
  assert(await evalJs(ws, 'app.player.currentFrame') === 40, '时间码字符串 00:00:01:10 跳转到第 40 帧');
  // 纯秒跳转
  await evalJs(ws, `document.querySelector('#frame-jump').value='1.5'; app.jumpByInput()`);
  await sleep(150);
  assert(await evalJs(ws, 'app.player.currentFrame') === 45, '秒数 1.5 跳转到第 45 帧');

  // ---------- 3. 添加点意见与矩形意见 ----------
  console.log('\n[3] 标注：点意见 / 矩形 / 时间段 / 同帧多条');
  await evalJs(ws, 'app.player.seekToFrame(12)');
  await sleep(150);
  const c1 = await evalJs(ws, `(async () => {
    const c = app.store.addComment({ startFrame: 12, endFrame: null, rect: {x:0.1,y:0.2,w:0.3,h:0.25}, text: '矩形意见：LOGO 留白', author: '测试员' });
    await app.player.seekToFrame(12);
    app.captureThumb(c);
    return c.id;
  })()`);
  const c2 = await evalJs(ws, `app.store.addComment({ startFrame: 25, endFrame: null, rect: null, text: '点意见 A', author: '测试员' }).id`);
  const c3 = await evalJs(ws, `app.store.addComment({ startFrame: 25, endFrame: null, rect: {x:0.6,y:0.6,w:0.1,h:0.1}, text: '同帧点意见 B', author: '测试员', status: 'done' }).id`);
  const c4 = await evalJs(ws, `app.store.addComment({ startFrame: 60, endFrame: 74, rect: null, text: '时间段意见', author: '测试员' }).id`);

  assert(await evalJs(ws, 'app.store.state.comments.length') === 4, '4 条意见已保存');
  assert(await evalJs(ws, 'app.store.sortedComments().map(c=>c.startFrame).join(",")') === '12,25,25,60', '列表按时间排序，同帧相邻');
  assert(await evalJs(ws, `CommentPanel.frameSequence(app.store.sortedComments(), app.store.getComment('${c3}'))`) === 2, '同帧第二条意见序号为 #2，可区分');
  assert(await evalJs(ws, `!!app.store.getComment('${c1}').thumbnail?.dataUrl`), '矩形意见已捕获缩略图');
  assert(await evalJs(ws, 'document.querySelectorAll("#marker-svg rect").length') === 2, 'SVG 层渲染 2 个矩形标记');

  // 缩放后标记位置仍正确（归一化坐标）
  await evalJs(ws, 'app.markerLayer.setZoom(2)');
  await sleep(100);
  const rectGeom = await evalJs(ws, `(() => {
    const r = document.querySelector('#marker-svg rect[data-id="${c1}"]');
    return { x: r.getAttribute('x'), y: r.getAttribute('y'), w: r.getAttribute('width'), h: r.getAttribute('height') };
  })()`);
  assert(rectGeom.x === '10.00%' && rectGeom.w === '30.00%', `200% 缩放后矩形仍为归一化位置 ${JSON.stringify(rectGeom)}`);
  await evalJs(ws, 'app.markerLayer.setZoom("fit")');

  // 点击列表跳转
  await evalJs(ws, `app.selectComment('${c4}')`);
  await sleep(200);
  assert(await evalJs(ws, 'app.player.currentFrame') === 60, '点击意见跳转到对应帧（60）');

  // 筛选
  await evalJs(ws, `document.querySelector('#filter-status').value='done'; app.panel.render(); app.panel.filtered().length`);
  const doneCount = await evalJs(ws, 'app.panel.filtered().length');
  assert(doneCount === 1, `状态筛选「已完成」只剩 1 条（实际 ${doneCount}）`);
  await evalJs(ws, `document.querySelector('#filter-status').value='all'; document.querySelector('#filter-text').value='LOGO'; app.panel.render()`);
  assert(await evalJs(ws, 'app.panel.filtered().length') === 1, '文字搜索筛选生效');
  await evalJs(ws, `document.querySelector('#filter-text').value=''; app.panel.render()`);

  // ---------- 4. 项目保存/恢复 ----------
  console.log('\n[4] 项目文件保存与恢复');
  const saved = await evalJs(ws, 'JSON.stringify(app.store.toJSON(true))');
  const parsed = JSON.parse(saved);
  assert(parsed.schemaVersion === 1 && parsed.comments.length === 4 && parsed.media.name === 'sample_v1.mp4', '项目 JSON 含素材信息、意见与标记');
  // 模拟重新打开项目（saved 本身就是 JSON 文本，直接作为对象字面量嵌入）
  await evalJs(ws, `app.store.loadJSON(${saved})`);
  assert(await evalJs(ws, 'app.store.state.comments.length') === 4, '从项目文件恢复后意见完整');
  assert(await evalJs(ws, 'app.store.getComment("' + c1 + '").rect.w') === 0.3, '矩形归一化坐标恢复正确');

  // ---------- 5. 替换修订版并验证迁移 ----------
  console.log('\n[5] 替换修订版：画面匹配迁移');
  await evalJs(ws, `(async () => {
    const buf = await ${readBufferExpr(v2Path)};
    const file = new File([buf], 'sample_v2.mp4', { type: 'video/mp4' });
    await app.replaceVideo(file);
  })()`);
  // 扫描 90+105 帧需要一些时间
  for (let i = 0; i < 60; i++) {
    const done = await evalJs(ws, 'app.store.state.revisions.length');
    if (done) break;
    await sleep(500);
  }
  assert(await evalJs(ws, 'app.store.state.revisions.length') === 1, '生成一条修订记录');
  assert(await evalJs(ws, 'app.store.state.revisions[0].from.frameCount') === 90, '修订记录旧版帧数保留为 90（回归：不被新视频元数据覆盖）');
  assert(await evalJs(ws, 'app.store.state.revisions[0].to.frameCount') === 105, '修订记录新版帧数为 105');
  assert(await evalJs(ws, 'app.player.frameCount') === 105, '当前视频切换为 v2（105 帧）');

  const migrated = await evalJs(ws, `JSON.stringify(app.store.state.comments.map(c => ({
    start: c.startFrame, end: c.endFrame, status: c.status,
    conf: c.history.length ? c.history[c.history.length-1].confidence : null
  })))`);
  const mm = JSON.parse(migrated);
  // 第 12、25 帧在插入点之前 → 原样保留且高置信
  assert(mm[0].start === 12 && mm[0].conf >= 0.85, `插入点前意见不动（帧 ${mm[0].start}, NCC ${mm[0].conf}）`);
  // 60..74 在插入点之后 → 应迁移到 75..89
  const range = mm.find((x) => x.end === 89);
  assert(range && range.start === 75, `插入点后时间段意见 60-74 → 75-89（实际 ${range ? range.start + '-' + range.end : '缺失'}）`);
  assert(range.conf >= 0.85, `迁移为高置信自动匹配（NCC ${range.conf}）`);
  // 同帧两条都还在且仍同帧
  assert(mm.filter((x) => x.start === 25).length === 2, '同帧两条意见迁移后仍可区分');

  // 人工确认流程：在真实迁移过的意见上模拟「待确认 → 人工确认」
  await evalJs(ws, `app.store.updateComment('${c4}', { status: 'needs-confirm' }); app.store.confirmMapping('${c4}')`);
  assert(await evalJs(ws, `app.store.getComment('${c4}').status`) === 'open', '人工确认后状态从待确认转为未完成');
  assert(await evalJs(ws, `app.store.getComment('${c4}').history.slice(-1)[0].confirmed`) === true, '迁移记录写入 confirmed=true');

  // ---------- 6. 标记在新版时间轴上渲染 ----------
  console.log('\n[6] 修订版上的标记与缩略图');
  await evalJs(ws, 'app.player.seekToFrame(75)');
  await sleep(200);
  assert(await evalJs(ws, 'app.player.currentFrame') === 75, '可跳到迁移后的帧位置');
  assert(await evalJs(ws, 'document.querySelectorAll("#marker-svg rect").length') === 2, '矩形标记随意见迁移后仍正常渲染');

  // ---------- 7. 导出 ----------
  console.log('\n[7] 导出报告 / JSON / CSV');
  let downloaded = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, method } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${method} -> ${msg.error.message}`));
      else resolve(msg.result);
    }
    if (msg.method === 'Page.downloadWillBegin') {
      downloaded.push(msg.params.suggestedFilename);
    }
    if (msg.method === 'Browser.downloadWillBegin') {
      downloaded.push(msg.params.suggestedFilename);
    }
  };
  await cdp(ws, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR, eventsEnabled: true });

  await evalJs(ws, 'Exporter.exportCSV(app.store)');
  await sleep(400);
  await evalJs(ws, 'Exporter.exportJSON(app.store)');
  await sleep(400);
  await evalJs(ws, 'Exporter.exportHTML(app.store, app.player)');
  await sleep(600);
  assert(downloaded.some((f) => f.endsWith('.csv')), `CSV 清单已导出（${downloaded.join(', ')}）`);
  assert(downloaded.some((f) => f.endsWith('.vrs.json')), '机器可读 JSON 已导出');
  assert(downloaded.some((f) => f.endsWith('.html')), 'HTML 审片报告已导出');

  const files = await listDownloads();
  const csv = files.find((f) => f.endsWith('.csv'));
  const csvContent = await readFileContent(path.join(DOWNLOAD_DIR, csv));
  assert(csvContent.includes('startTimecode') && csvContent.includes('00:00:02:15'), 'CSV 含时间码列与迁移后帧位置');
  const html = files.find((f) => f.endsWith('.html'));
  const htmlContent = await readFileContent(path.join(DOWNLOAD_DIR, html));
  assert(htmlContent.includes('data:image/jpeg') && htmlContent.includes('审片报告'), 'HTML 报告内嵌缩略图');
  const json = files.find((f) => f.endsWith('.vrs.json'));
  const jsonContent = JSON.parse(await readFileContent(path.join(DOWNLOAD_DIR, json)));
  assert(jsonContent.comments.length === 4 && jsonContent.revisions.length === 1, '导出 JSON 含全部意见与修订历史');

  // ---------- 8. 时间码解析边界 ----------
  console.log('\n[8] 时间码工具边界');
  assert(await evalJs(ws, 'Timecode.parseTc("00:00:01:10", 30)') === 40, 'parseTc HH:MM:SS:FF');
  assert(await evalJs(ws, 'Timecode.parseTc("90", 30)') === 90, 'parseTc 纯整数按帧号');
  assert(await evalJs(ws, 'Timecode.framesToTc(3723, 30)') === '00:02:04:03', 'framesToTc 长帧号换算');
  assert(await evalJs(ws, 'Timecode.parseTc("00:00:00:30", 30)') === null, '非法帧号（FF≥fps）拒绝');

  console.log('\n🎉 全部测试通过');
  ws.close();
}

// CDP 不能直接读本地文件：用 file:// XHR 不一定可用，改用 fetch file 同样受限。
// 因此通过 Page 侧的一个小技巧：用 Node 读文件 → base64 → 浏览器内还原。
function readBufferExpr(path) {
  const b64 = fs.readFileSync(path).toString('base64');
  return `(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  })()`;
}

async function listDownloads() {
  await sleep(200);
  return fs.readdirSync(DOWNLOAD_DIR);
}
async function readFileContent(p) {
  return fs.readFileSync(p, 'utf8');
}

main().catch((err) => {
  console.error('测试中断:', err);
  process.exitCode = 1;
});
