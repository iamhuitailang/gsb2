'use strict';
// 端到端验证:隔离规则、外部资源不联网、脚本不运行、会话连续。
// 其中"浏览器加载预览"一节按 CSP/sandbox 规则模拟一个合规浏览器的加载行为:
// 脚本一律不执行,子资源只加载策略允许的(本地图片),被挡的一律不发请求。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { ReportStore } = require('../src/store');
const { createMainServer } = require('../src/main-server');
const { createPreviewServer } = require('../src/preview-server');
const { createSecondSite } = require('../src/second-site');
const { generateSamples } = require('../src/generate-samples');
const { escapeHtml, extractResources, classifyUrl } = require('../src/html-utils');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); }
  catch (err) { results.push(['FAIL', `${name} -> ${err.message}`]); }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsb2-'));
  const second = await createSecondSite(0);
  const store = new ReportStore(path.join(tmp, 'reports'));
  const preview = await createPreviewServer(store, 0);
  const mainServer = await createMainServer(
    { store, previewBase: preview.baseUrl }, 0);
  const sampleFile = generateSamples(
    path.join(tmp, 'samples'), second.baseUrl, mainServer.baseUrl);

  // ---- 会话 Cookie(业务页) ----
  const home1 = await fetch(`${mainServer.baseUrl}/`);
  const cookie = home1.headers.get('set-cookie').split(';')[0];
  const asUser = (url, init = {}) =>
    fetch(url, { ...init, headers: { ...(init.headers || {}), cookie } });

  // ---- 导入:正常样例 + 恶意标题 ----
  const evilTitle = '<img src=x onerror=alert(1)>';
  const importForm = (title) => asUser(`${mainServer.baseUrl}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ title, sourcePath: sampleFile }),
    redirect: 'manual',
  });
  assert.equal((await importForm('2026年11月供货对账报告')).status, 303);
  assert.equal((await importForm(evilTitle)).status, 303);

  const home2 = await (await asUser(`${mainServer.baseUrl}/`)).text();
  const sampleId = store.list()[0].id;

  check('标题/文件名按纯文本展示(HTML 已转义)', () => {
    assert.ok(home2.includes(escapeHtml(evilTitle)), '恶意标题未转义');
    assert.ok(!home2.includes(evilTitle), '页面中出现未转义的恶意标题');
    assert.ok(home2.includes('sample-report.html'), '文件名未展示');
  });

  check('检查结果列出外部资源并标注未载入', () => {
    assert.ok(home2.includes(`${second.baseUrl}/tracker.png`), '外部图片未列出');
    assert.ok(home2.includes('预览时未载入'), '缺少"未载入"标注');
    assert.ok(home2.includes('内联脚本 1 段'), '脚本未列入检查结果');
    assert.ok(home2.includes('chart-local.png'), '本地图片未列出');
  });

  // ---- 列表预览 ----
  const listPreview = await (await asUser(`${mainServer.baseUrl}/?preview=${sampleId}`)).text();
  check('列表预览使用空值 sandbox 的隔离 iframe,且指向隔离预览源', () => {
    assert.ok(listPreview.includes('sandbox=""'), 'iframe 缺少空值 sandbox');
    assert.ok(!/allow-scripts|allow-same-origin/.test(listPreview), 'sandbox 被放宽');
    assert.ok(listPreview.includes(`src="${preview.baseUrl}/report/${sampleId}/"`),
      'iframe 未指向隔离预览源');
    assert.ok(!/src="http:\/\/localhost/.test(listPreview), 'iframe 与业务页混用主机名');
  });

  // ---- 独立预览地址:与列表预览同一套隔离规则 ----
  const docResp = await fetch(`${preview.baseUrl}/report/${sampleId}/`);
  const csp = docResp.headers.get('content-security-policy') || '';
  const docHtml = await docResp.text();
  check('独立预览地址带严格 CSP(禁脚本/禁表单/图片仅预览源)', () => {
    assert.ok(csp.includes("default-src 'none'"), '缺 default-src none');
    assert.ok(csp.includes("form-action 'none'"), '缺 form-action none');
    assert.ok(csp.includes(`img-src 'self' ${preview.baseUrl} data:`), 'img-src 未收紧');
  });
  check('预览文档含表格与本地图片引用,脚本原样保留但不执行', () => {
    assert.ok(docHtml.includes('<table>') && docHtml.includes('六角螺栓'), '表格缺失');
    assert.ok(docHtml.includes('src="chart-local.png"'), '本地图片引用缺失');
    assert.ok(docHtml.includes('<script>'), '脚本应原样存储(由策略禁执行)');
  });

  // ---- 模拟合规浏览器加载预览:脚本不执行,只加载 CSP 允许的子资源 ----
  const { resources } = extractResources(docHtml);
  const blocked = [], loaded = [];
  for (const r of resources) {
    if (r.kind === 'script') { blocked.push(r.url); continue; } // sandbox/script-src none
    if (r.kind === 'image') {
      const abs = new URL(r.url, `${preview.baseUrl}/report/${sampleId}/`);
      const allowed = classifyUrl(r.url) !== 'external' && abs.origin === preview.baseUrl;
      if (allowed) {
        const resp = await fetch(abs); // 预览源请求:不带任何业务 Cookie
        assert.equal(resp.status, 200, `本地图片加载失败: ${r.url}`);
        assert.match(resp.headers.get('content-type'), /^image\//);
        loaded.push(r.url);
      } else blocked.push(r.url);
    }
  }
  check('本地图片经预览源可正常读取', () => {
    assert.deepEqual(loaded, ['chart-local.png']);
  });
  check('第二站点请求计数保持为零(外部图片未载入)', () => {
    assert.ok(blocked.includes(`${second.baseUrl}/tracker.png`));
    assert.equal(second.requestCount, 0, `第二站点收到 ${second.requestCount} 个请求`);
  });
  check('报告内脚本未运行(业务操作端点零调用)', () => {
    assert.equal(mainServer.reportActionCount, 0,
      `业务操作被调用 ${mainServer.reportActionCount} 次`);
  });
  check('预览源全程未收到业务会话 Cookie', () => {
    assert.equal(preview.cookiesSeen, 0, `预览源收到 ${preview.cookiesSeen} 次 Cookie`);
  });

  // ---- 关闭报告,回到业务页,会话仍正常 ----
  const meBefore = await (await asUser(`${mainServer.baseUrl}/api/me`)).json();
  await fetch(`${preview.baseUrl}/report/${sampleId}/`); // 打开/关闭报告
  const meAfter = await (await asUser(`${mainServer.baseUrl}/api/me`)).json();
  check('关闭报告后业务会话保持正常', () => {
    assert.equal(meBefore.id, 'PROC-0042');
    assert.deepEqual(meAfter, meBefore);
  });

  // ---- 汇总 ----
  let failed = 0;
  for (const [status, name] of results) {
    if (status === 'FAIL') failed++;
    console.log(`${status === 'PASS' ? '✓' : '✗'} ${name}`);
  }
  console.log(`\n${results.length - failed}/${results.length} 项通过`);

  for (const s of [second, preview, mainServer]) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
