// 零依赖 CDP 冒烟测试：启动 headless Chrome，验证编辑器核心交互
// 用法：node tests/e2e.cjs （需要先 node scripts/serve.js）
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH
  || `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const PORT = 9333;
const URL = 'http://localhost:5173/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      // 取页面级 target（带 Page/Runtime 域），而非浏览器级 endpoint
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { await sleep(100); }
  }
  throw new Error('Chrome 调试端口未就绪');
}

let msgId = 0;
function cdp(ws) {
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method) events.push(m);
    void events;
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
};

async function main() {
  const chrome = spawn(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    const wsUrl = await getWsUrl();
    const ws = new WebSocket(wsUrl);
    await once(ws, 'open');
    const send = cdp(ws);
    await send('Page.enable');
    await send('Runtime.enable');

    const consoleErrors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push(m.params.args.map((a) => a.value || a.description).join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      }
    });

    await send('Page.navigate', { url: URL });
    await sleep(1200);

    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };

    // 1. 初始空白文档
    check('初始加载无 JS 错误', consoleErrors.length === 0, consoleErrors.join(' | '));
    const layerCount0 = await evalJs('document.querySelectorAll(".layer-row").length');
    check('初始图层面板为空', layerCount0 === 0);

    // 2. 载入样例（心形）
    await evalJs('document.querySelector("#sample-menu").hidden = false');
    await sleep(50);
    await evalJs('document.querySelector("#sample-menu .menu-item").click()');
    await sleep(200);
    const sampleLayers = await evalJs('document.querySelectorAll(".layer-row").length');
    check('载入心形样例后出现 2 个图层', sampleLayers === 2, `实际 ${sampleLayers}`);
    const heartD = await evalJs('document.querySelector(".shape").getAttribute("d").slice(0, 30)');
    check('样例路径已渲染为 SVG path', heartD.startsWith('M'));

    // 3. 切换到矩形工具并模拟绘制
    await evalJs(`
      (() => {
        const btn = document.querySelector('[data-tool="rect"]');
        btn.click();
        const svg = document.querySelector('.stage');
        const r = svg.getBoundingClientRect();
        const opts = { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 200, clientY: r.top + 150 };
        svg.dispatchEvent(new PointerEvent('pointerdown', opts));
        window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: r.left + 350, clientY: r.top + 300 }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0, clientX: r.left + 350, clientY: r.top + 300 }));
      })()
    `);
    await sleep(200);
    const afterRect = await evalJs('document.querySelectorAll(".layer-row").length');
    check('矩形工具绘制后新增图层', afterRect === 3, `实际 ${afterRect}`);
    const undoCount = await evalJs('document.querySelector("#btn-undo").disabled');
    check('绘制操作进入撤销栈', undoCount === false);

    // 4. 修改填充色（属性面板）
    await evalJs(`
      (() => {
        const input = document.querySelector('.color-control input[type="color"]');
        input.value = '#ff0000';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    await sleep(150);
    const fill = await evalJs('document.querySelector(".shape:last-of-type").getAttribute("fill")');
    check('属性面板修改填充生效', fill === '#ff0000', `实际 ${fill}`);

    // 5. 撤销恢复
    await evalJs('document.querySelector("#btn-undo").click()');
    await sleep(100);
    const fillAfterUndo = await evalJs('document.querySelector(".shape:last-of-type").getAttribute("fill")');
    check('撤销恢复样式', fillAfterUndo !== '#ff0000');

    // 6. 图层显隐/锁定（两次操作间等待重渲染，避免点击到被替换的旧节点）
    const targetId = await evalJs(`document.querySelector('.layer-row').dataset.id`);
    await evalJs(`document.querySelector('.layer-row[data-id="${targetId}"] [data-action="toggle-visible"]').click()`);
    await sleep(120);
    await evalJs(`document.querySelector('.layer-row[data-id="${targetId}"] [data-action="toggle-lock"]').click()`);
    await sleep(120);
    const stateInfo = await evalJs(`document.querySelector('.layer-row[data-id="${targetId}"]').className`);
    check('图层支持隐藏与锁定状态', stateInfo.includes('is-hidden') && stateInfo.includes('is-locked'), stateInfo);

    // 7. SVG 导出内容完整性
    const svg = await evalJs(`window.__testApi.docToSvgString(window.__storeForTest.doc)`);
    check('导出 SVG 含 <svg> 与 path', svg.includes('<svg') && svg.includes('<path'));
    check('导出保留 data-name 与图层结构', svg.includes('data-name'));

    // 8. 工程保存/重开结构一致
    const roundtrip = await evalJs(`
      (() => {
        const before = JSON.stringify(window.__storeForTest.doc);
        const reopened = window.__testApi.deserializeDoc(before);
        return JSON.stringify(reopened) === before;
      })()
    `);
    check('工程 JSON 保存重开结构一致', roundtrip === true);

    // 9. PNG 导出（栅格化）
    const pngOk = await evalJs(`
      (async () => {
        const blob = await window.__testApi.docToPngBlob(window.__storeForTest.doc, { width: 256 });
        return blob && blob.type === 'image/png' && blob.size > 1000;
      })()
    `);
    check('PNG 导出成功且非空', pngOk === true);

    // 10. 自相交 evenodd 不整块消失：载入星月样例并检查填充区域
    await evalJs(`
      (() => {
        const items = document.querySelectorAll("#sample-menu .menu-item");
        document.querySelector("#sample-menu").hidden = false;
        items[1].click();
      })()
    `);
    await sleep(200);
    const evenodd = await evalJs(`
      Array.from(document.querySelectorAll('.shape')).some(p => p.getAttribute('fill-rule') === 'evenodd')
    `);
    check('自相交样例使用 evenodd 填充规则', evenodd === true);
    const moonVisible = await evalJs(`
      (() => {
        const p = document.querySelector('.shape');
        const b = p.getBBox();
        return b.width > 0 && b.height > 0;
      })()
    `);
    check('evenodd 路径仍有可见包围盒（未整块消失）', moonVisible === true);

    // 11. 缩放后坐标变换正确：toDoc 在不同 zoom 下回算一致
    const coordOk = await evalJs(`
      (() => {
        const c = window.__canvasForTest;
        const r = c.svg.getBoundingClientRect();
        // 屏幕中心点，先在当前 zoom 下转文档坐标
        const sx = r.left + r.width / 2, sy = r.top + r.height / 2;
        const d1 = c.toDoc(sx, sy);
        // 放大 4 倍后同一屏幕点对应的文档坐标应不同，但 toScreen 往返一致
        c.zoomButton(4);
        const d2 = c.toDoc(sx, sy);
        const back = c.toScreen(d2);
        const roundtrip = Math.abs(back.x - sx) < 0.5 && Math.abs(back.y - sy) < 0.5;
        const zoomChanged = window.__storeForTest.view.zoom > 1;
        c.fitView();
        return roundtrip && zoomChanged;
      })()
    `);
    check('缩放后屏幕↔文档坐标往返一致（命中位置正确）', coordOk === true);

    // 12. 钢笔工具：点击加点、拖出控制柄、闭合
    const penOk = await evalJs(`
      (() => {
        const store = window.__storeForTest;
        const c = window.__canvasForTest;
        store.setTool('pen');
        const r = c.svg.getBoundingClientRect();
        const pts = [
          [r.left + 300, r.top + 200],
          [r.left + 400, r.top + 250],
          [r.left + 350, r.top + 350],
        ];
        const down = (x, y) => c.svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, button: 0, clientX: x, clientY: y }));
        const up = (x, y) => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2, button: 0, clientX: x, clientY: y }));
        for (const [x, y] of pts) { down(x, y); up(x, y); }
        const draftCount = store.penDraft ? store.penDraft.anchors.length : 0;
        // 点回起点闭合
        const first = pts[0];
        down(first[0], first[1]); up(first[0], first[1]);
        const layers = document.querySelectorAll('.layer-row').length;
        store.setTool('select');
        return { draftCount, layers, closed: store.doc.layers.some(n => n.type === 'path' && n.subpaths.some(sp => sp.closed)) };
      })()
    `);
    check('钢笔工具可加点并闭合生成路径', penOk.draftCount === 3 && penOk.closed === true, JSON.stringify(penOk));

    // 13. 拆分/合并/闭合等结构操作可用
    const structOk = await evalJs(`
      (() => {
        const store = window.__storeForTest;
        const before = store.doc.layers.filter(n => n.type === 'path').length;
        // 选中刚画的闭合路径并拆分（按子路径）
        const last = store.doc.layers.filter(n => n.type === 'path').pop();
        store.select([last.id]);
        document.querySelector('#layers-panel [data-action="split"]').click();
        const afterSplit = store.doc.layers.filter(n => n.type === 'path').length;
        // 全选后合并
        const ids = store.doc.layers.filter(n => n.type === 'path').map(n => n.id);
        store.select(ids);
        document.querySelector('#layers-panel [data-action="merge"]').click();
        const afterMerge = store.doc.layers.filter(n => n.type === 'path').length;
        return { before, afterSplit, afterMerge };
      })()
    `);
    check('路径拆分与合并结构操作生效', structOk.afterMerge === 1, JSON.stringify(structOk));

    // 14. SVG 导入往返：导出的 SVG 重新导入后图层可继续编辑
    const importOk = await evalJs(`
      (() => {
        const store = window.__storeForTest;
        const svgText = window.__testApi.docToSvgString(store.doc);
        const { doc, warnings } = window.__testApi.importSvg(svgText);
        const countPaths = (ns) => ns.reduce((acc, n) => {
          if (n.type === 'path') return acc + 1;
          if (n.type === 'group') return acc + countPaths(n.children);
          return acc;
        }, 0);
        const pathCount = countPaths(doc.layers);
        // 导入后锚点模型完整、可再导出
        const reExport = window.__testApi.docToSvgString(doc);
        return {
          pathCount,
          hasAnchors: doc.layers.some(n => n.type === 'path' && n.subpaths[0].anchors.length > 0),
          reExportable: reExport.includes('<path'),
          warnings: warnings.length,
        };
      })()
    `);
    check('SVG 导入后锚点模型完整且可重新导出', importOk.hasAnchors && importOk.reExportable, JSON.stringify(importOk));

    // 15. PNG 等比缩放：不同导出宽度下高宽比与画布一致
    const ratioOk = await evalJs(`
      (async () => {
        const store = window.__storeForTest;
        const b1 = await window.__testApi.docToPngBlob(store.doc, { width: 200 });
        const b2 = await window.__testApi.docToPngBlob(store.doc, { width: 400 });
        // 尺寸通过位图头读取宽高（PNG IHDR 在 16-24 字节）
        const dims = async (blob) => {
          const buf = new Uint8Array(await blob.arrayBuffer());
          const w = (buf[16] << 24) + (buf[17] << 16) + (buf[18] << 8) + buf[19];
          const h = (buf[20] << 24) + (buf[21] << 16) + (buf[22] << 8) + buf[23];
          return { w, h };
        };
        const d1 = await dims(b1), d2 = await dims(b2);
        const expectRatio = store.doc.height / store.doc.width;
        return d1.w === 200 && d2.w === 400
          && Math.abs(d1.h / d1.w - expectRatio) < 0.01
          && Math.abs(d2.h / d2.w - expectRatio) < 0.01;
      })()
    `);
    check('PNG 导出等比缩放不改变路径比例', ratioOk === true);

    check('全程无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    ws.close();
  } finally {
    chrome.kill();
  }

  const failed = results.filter((r) => !r.ok);
  writeFileSync('/tmp/e2e-results.json', JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
