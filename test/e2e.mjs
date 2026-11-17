import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { launchChrome, openPage, closePage, findChrome } from './cdp.mjs';

/**
 * 端到端校验，覆盖需求里的全部验收点：
 *   1. 预览能读到表格文字与本地图片；
 *   2. 指向第二个本地站点的图片没有发起任何请求（计数为 0）；
 *   3. 报告内脚本不运行（标题未被改、按钮没绑定、信标没发出）；
 *   4. 报告页拿不到业务页的账号信息，也不能替业务页发起操作；
 *   5. 列表预览与独立预览地址使用同一套隔离规则；
 *   6. 关闭报告后业务页的会话仍然可用。
 */

const chromeAvailable = Boolean(await findChrome());

async function withApp(fn) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gsb2-data-'));
    const basePort = 4400 + attempt * 7 + Math.floor(Math.random() * 5);
    const app = createApp({ dataDir, basePort });
    try {
      const { config } = await app.start();
      try {
        await fn({ app, config });
      } finally {
        await app.stop();
      }
      await fs.rm(dataDir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await app.stop().catch(() => {});
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
      if (!/EADDRINUSE|EADDRNOTAVAIL/.test(String(error.message))) throw error;
    }
  }
  throw lastError;
}

/**
 * 用原始 HTTP 发请求。Node 的 fetch 会按 Fetch 规范丢弃 `Sec-` 前缀与
 * `Origin` 这类 forbidden header，而浏览器发出的跨站请求一定带 Origin，
 * 因此跨站场景必须用原始请求来模拟。
 */
function rawRequest(origin, pathname, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(origin + pathname);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // 非 JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, text, body: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const hostHeader = (config, key) => `${config.hosts[key]}:${config.ports[key]}`;

async function api(config, pathname, options = {}) {
  const response = await fetch(`${config.origins.business}${pathname}`, {
    ...options,
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function importSample(config) {
  const { status, body } = await api(config, '/api/samples/import', { method: 'POST' });
  assert.equal(status, 201);
  return body.report;
}

async function trackerCount(config) {
  const response = await fetch(`${config.origins.tracker}/count`);
  return (await response.json()).count;
}

async function waitInFrame(page, urlPart, expression, timeout = 25000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await page.evaluateInFrame(urlPart, expression);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`子框架求值超时: ${urlPart}${lastError ? `（${lastError.message}）` : ''}`);
}

// ------------------------------------------------------------ 服务端契约

test('样例报告导入后：表格、本地图片、外部引用被正确分类', async () => {
  await withApp(async ({ config }) => {
    const report = await importSample(config);
    assert.equal(report.summary.loaded, 2, '本地图片 + 本地样式表');
    assert.equal(report.summary.external, 1, '一个指向第二站点的图片');
    assert.equal(report.externalCount, 1);

    const detail = (await api(config, `/api/reports/${report.id}`)).body;
    assert.equal(detail.check.externalResources.length, 1);
    assert.ok(detail.check.externalResources[0].url.startsWith(config.origins.tracker));
    assert.equal(detail.check.externalResources[0].loaded, false);
    assert.ok(detail.check.resources.some((r) => r.kind === 'image' && r.status === 'local'));

    const content = await (await fetch(
      `${config.origins.report}/r/${report.id}/${report.token}/content`,
    )).text();
    assert.doesNotMatch(content, /<script/i, '正文里不能残留脚本');
    assert.ok(!content.includes(config.origins.tracker), '正文里不能残留第二站点地址');
    assert.match(content, /B-2026-1101/, '表格内容保留');
    assert.match(content, /\/a\/[a-z0-9_]+\/[a-f0-9]{64}\/asset-\d+\.png/, '本地图片指向报告站点资源');
  });
});

test('报告正文与独立预览外壳的隔离响应头', async () => {
  await withApp(async ({ config }) => {
    const report = await importSample(config);
    const contentResponse = await fetch(`${config.origins.report}/r/${report.id}/${report.token}/content`);
    const shellResponse = await fetch(`${config.origins.report}/r/${report.id}/${report.token}`);
    const contentCsp = contentResponse.headers.get('content-security-policy');
    const shellCsp = shellResponse.headers.get('content-security-policy');

    assert.match(contentResponse.headers.get('content-type'), /text\/html/);
    for (const directive of [
      "default-src 'none'", "script-src 'none'", "connect-src 'none'",
      "form-action 'none'", "base-uri 'none'", "object-src 'none'", "frame-src 'none'",
      "style-src 'unsafe-inline'",
    ]) {
      assert.ok(contentCsp.includes(directive), `正文缺少 ${directive}`);
    }
    assert.ok(contentCsp.includes(`img-src ${config.origins.report} data:`),
      `正文的 img-src 必须指向报告源，实际：${contentCsp}`);
    assert.ok(contentCsp.includes(`frame-ancestors ${config.origins.business} ${config.origins.report}`));
    assert.ok(/(^|;\s*)sandbox(;|$)/.test(contentCsp), '正文必须以不透明源运行');

    assert.ok(shellCsp.includes("script-src 'self'"));
    assert.ok(shellCsp.includes("connect-src 'none'"));
    assert.ok(shellCsp.includes(`frame-src ${config.origins.report}`));
    assert.ok(shellCsp.includes(`frame-ancestors ${config.origins.business} ${config.origins.report}`));

    assert.equal((await fetch(`${config.origins.report}/r/${report.id}/wrong-token`)).status, 404);
    assert.equal((await fetch(`${config.origins.report}/r/${report.id}/${report.token}/content?x=1`)).status, 200);
  });
});

test('业务 API 拒绝跨站来源并留下记录', async () => {
  await withApp(async ({ config }) => {
    // 模拟浏览器里报告页对业务 API 的跨站调用：带 Origin 和 Sec-Fetch-Site。
    const response = await rawRequest(config.origins.business, '/api/me', {
      headers: {
        Host: hostHeader(config, 'business'),
        Origin: config.origins.report,
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'cross-site request rejected');
    assert.equal(response.headers['set-cookie'], undefined, '跨站请求连会话 cookie 都拿不到');

    const { body } = await api(config, '/api/security');
    assert.ok(body.crossSiteAttempts.length >= 1);
    assert.equal(body.crossSiteAttempts[0].origin, config.origins.report);
  });
});

test('报告站点只读、只提供报告与本地资源', async () => {
  await withApp(async ({ config }) => {
    const report = await importSample(config);

    assert.equal((await fetch(`${config.origins.report}/nothing-here`)).status, 404);
    assert.equal((await fetch(`${config.origins.report}/api/me`)).status, 404);

    const assetName = report.assets.find((a) => a.contentType === 'image/png').storedName;
    const assetUrl = `${config.origins.report}/a/${report.id}/${report.token}/${assetName}`;
    const asset = await fetch(assetUrl);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('content-type'), 'image/png');
    assert.ok(asset.headers.get('content-security-policy').includes("script-src 'none'"));
    assert.equal(
      (await fetch(`${config.origins.report}/a/${report.id}/wrong-token/${assetName}`)).status,
      404,
      '没有正确 token 取不到图片',
    );

    const traversal = await fetch(`${config.origins.report}/a/${report.id}/${report.token}/..%2Fmeta.json`);
    assert.notEqual(traversal.status, 200);

    const post = await fetch(`${config.origins.report}/r/${report.id}/${report.token}/content`, {
      method: 'POST',
    });
    assert.equal(post.status, 405);
  });
});

test('用户导入的标题与文件名只按文本展示', async () => {
  await withApp(async ({ config }) => {
    const hostileTitle = '<img src=x onerror="window.__pwned=1">标题';
    const hostileFile = '<script>window.__f=1</script>.html';
    const created = await api(config, '/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: hostileTitle, fileName: hostileFile, html: '<p>hi</p>' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.report.title, hostileTitle, '标题按纯文本原样保存');
    assert.equal(created.body.report.fileName, hostileFile);

    const { report } = created.body;
    const shell = await (await fetch(`${config.origins.report}/r/${report.id}/${report.token}`)).text();
    assert.doesNotMatch(shell, /<img src=x onerror=/);
    assert.ok(shell.includes('&lt;img src=x onerror=&quot;window.__pwned=1&quot;&gt;标题'));
    assert.doesNotMatch(shell, /<script>window\.__f=1<\/script>/);
  });
});

test('HTML 危险构造被移除：脚本、内联事件、表单、自动跳转、外部框架', async () => {
  await withApp(async ({ config }) => {
    const html = `<h2>标题</h2>
      <script>window.__ran = 1<\/script>
      <button onclick="window.__ran = 2">按钮</button>
      <form action="${config.origins.business}/api/me"><input name="x"></form>
      <meta http-equiv="refresh" content="0;url=${config.origins.tracker}/">
      <iframe src="${config.origins.business}/"></iframe>
      <img src="${config.origins.tracker}/pixel.png">`;
    const created = await api(config, '/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '危险构造', fileName: 'x.html', html }),
    });
    assert.equal(created.status, 201);

    const content = await (await fetch(
      `${config.origins.report}/r/${created.body.report.id}/${created.body.report.token}/content`,
    )).text();
    assert.doesNotMatch(content, /<script/i);
    assert.doesNotMatch(content, /onclick/i);
    assert.doesNotMatch(content, /<form/i);
    assert.doesNotMatch(content, /http-equiv/i);
    assert.doesNotMatch(content, /<iframe/i);
    assert.ok(!content.includes(config.origins.tracker));
    assert.ok(content.includes('外部图片未载入'));

    const check = (await api(config, `/api/reports/${created.body.report.id}`)).body.check;
    assert.equal(check.removed.scripts, 1);
    assert.equal(check.removed.inlineHandlers, 1);
    assert.equal(check.removed.forms, 1);
    assert.equal(check.removed.metaRefreshes, 1);
    assert.equal(check.removed.frames, 1);
  });
});

// ------------------------------------------------------------ 浏览器

test('浏览器：预览可读表格与本地图片、不联网、不跑脚本、关闭后会话保持', { skip: !chromeAvailable }, async () => {
  await withApp(async ({ config }) => {
    const chrome = await launchChrome();
    try {
      const page = await openPage(chrome.cdp);
      await page.navigate(`${config.origins.business}/`);
      const sessionId = await page.waitFor(
        '(() => { const n = document.getElementById("sess-id"); return n && n.textContent.startsWith("sess_") ? n.textContent : null; })()',
      );
      assert.match(sessionId, /^sess_/);

      const beforeSession = await page.evaluate(`(async () => {
        const me = await (await fetch('/api/me')).json();
        return { id: me.id, requests: me.requests };
      })()`);

      // 生成样例报告 → 列表预览自动打开。
      await page.evaluate(`document.getElementById('import-sample').click()`);
      await page.waitFor('!document.getElementById("preview-panel").hidden');

      // 沙箱文档里的图片是异步加载的，先等到它完成再整体取值。
      await waitInFrame(page, '/content',
        '(() => { const i = document.getElementById("local-chart"); return Boolean(i && i.complete && i.naturalWidth > 0); })()');

      const preview = await waitInFrame(page, '/content', `(() => {
        const table = document.querySelector('table');
        const img = document.getElementById('local-chart');
        return {
          title: document.title,
          h1: document.querySelector('h1')?.textContent ?? null,
          headers: [...(table?.querySelectorAll('thead th') ?? [])].map((n) => n.textContent.trim()),
          firstBatch: table?.querySelector('tbody td')?.textContent ?? null,
          imageLoaded: Boolean(img && img.complete && img.naturalWidth > 0),
          imageSrc: img?.getAttribute('src') ?? null,
          approveResult: document.getElementById('approve-result')?.textContent ?? null,
          scriptRan: Boolean(window.__gsb2ReportScriptRan),
          blocked: [...document.querySelectorAll('.gsb2-blocked')].map((n) => n.textContent),
        };
      })()`);

      assert.equal(preview.title, '交付质量周报（本地样例）', '标题没有被报告内脚本改写');
      assert.equal(preview.h1, '交付质量周报');
      assert.deepEqual(preview.headers, ['批次号', '抽检数', '合格数', '不良率']);
      assert.equal(preview.firstBatch, 'B-2026-1101');
      assert.equal(preview.imageLoaded, true, '本地图片应显示');
      assert.match(preview.imageSrc, /^\/a\/rpt_[a-f0-9]{16}\/[a-f0-9]{64}\/asset-\d+\.png$/);
      assert.equal(preview.scriptRan, false, '报告内脚本不应运行');
      assert.equal(preview.approveResult, '（脚本未运行）');
      assert.ok(preview.blocked.some((t) => t.includes('外部图片未载入')));

      // 报告内的按钮点了也没有任何反应。
      await waitInFrame(page, '/content', `document.getElementById('approve')?.click(); true`);
      assert.equal(
        await waitInFrame(page, '/content', `document.getElementById('approve-result')?.textContent`),
        '（脚本未运行）',
      );

      // 第二个本地站点：零请求。
      assert.equal(await trackerCount(config), 0, '列表预览不应向第二站点发起任何请求');

      // 报告内容读不到业务页 DOM。
      const isolation = await waitInFrame(page, '/content', `(() => {
        try { return { parentReadable: Boolean(window.parent && window.parent.document.body) }; }
        catch (error) { return { parentReadable: false, error: error.name }; }
      })()`);
      assert.equal(isolation.parentReadable, false);

      // 报告站点没有任何业务接口。
      assert.equal((await fetch(`${config.origins.report}/api/me`)).status, 404);

      // 独立预览地址：同样的隔离结果。
      const reports = (await api(config, '/api/reports')).body.reports;
      const standaloneUrl = `${config.origins.report}/r/${reports[0].id}/${reports[0].token}`;
      const standalone = await openPage(chrome.cdp, standaloneUrl);
      await waitInFrame(standalone, '/content',
        '(() => { const i = document.getElementById("local-chart"); return Boolean(i && i.complete && i.naturalWidth > 0); })()');
      const standalonePreview = await waitInFrame(standalone, '/content', `(() => ({
        title: document.title,
        scriptRan: Boolean(window.__gsb2ReportScriptRan),
        imageLoaded: Boolean(document.getElementById('local-chart')?.naturalWidth > 0),
        tableRows: document.querySelectorAll('tbody tr').length,
        blocked: document.querySelectorAll('.gsb2-blocked').length,
        parentReadable: (() => { try { return Boolean(window.parent.document.body); } catch (e) { return false; } })(),
      }))()`);
      assert.equal(standalonePreview.title, '交付质量周报（本地样例）');
      assert.equal(standalonePreview.scriptRan, false);
      assert.equal(standalonePreview.imageLoaded, true);
      assert.equal(standalonePreview.tableRows, 3);
      assert.equal(standalonePreview.blocked, 1);
      assert.equal(standalonePreview.parentReadable, false);
      assert.equal(await trackerCount(config), 0, '独立预览同样不应联网');
      await closePage(chrome.cdp, standalone);

      // 关闭报告 → 回到业务页 → 同一个会话仍可操作。
      await page.evaluate('document.getElementById("close-preview").click()');
      await page.waitFor('document.getElementById("preview-panel").hidden');
      const afterClose = await page.evaluate(`(async () => {
        const me = await (await fetch('/api/me')).json();
        return { id: me.id, requests: me.requests };
      })()`);
      assert.equal(afterClose.id, beforeSession.id, '关闭报告后仍是同一个业务会话');
      assert.ok(afterClose.requests > beforeSession.requests, '业务页还能正常访问接口');

      // 业务页仍能发起操作：记下当前操作数，点击后等它真的增加。
      const actionsBefore = Number(await page.evaluate(
        'document.getElementById("sess-actions").textContent',
      ));
      await page.evaluate('document.getElementById("session-ping").click()');
      await page.waitFor(
        `Number(document.getElementById("sess-actions").textContent) > ${actionsBefore}`,
      );
      assert.ok(Number(await page.evaluate('document.getElementById("sess-actions").textContent'))
        > actionsBefore, '业务页仍能发起操作');

      // 全程没有向第二站点发出请求。
      assert.equal(await trackerCount(config), 0);
      const security = (await api(config, '/api/security')).body;
      assert.ok(Array.isArray(security.reportSiteBlocked));
    } finally {
      await chrome.close();
    }
  });
});
