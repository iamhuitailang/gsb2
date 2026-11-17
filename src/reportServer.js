import fs from 'node:fs/promises';
import { send } from './util.js';
import { reportContentHeaders, reportShellHeaders, reportAssetHeaders } from './security.js';

/**
 * 隔离报告站点。它只做三件事：
 *   1. 返回报告正文（/r/<id>/<token>/content）——这是唯一的报告渲染路径，
 *      列表预览的 iframe 与独立预览地址里的 iframe 都指向它，
 *      因此两种预览不可能拿到不同的隔离规则；
 *   2. 返回独立预览外壳（/r/<id>/<token>）——库自己的 UI，承载正文与资源检查；
 *   3. 返回随报告导入的本地图片。
 *
 * 这里没有任何业务接口。报告内容里的外部地址若被自动请求，只会落到 404，
 * 并被记录进 blockedRequests（用于验证第二站点计数为零）。
 */

export function createReportServer({ config, store, events }) {
  const recordBlocked = (req, url, reason) => {
    events.blockedRequests.push({
      at: new Date().toISOString(),
      host: req.headers.host ?? '',
      path: url,
      reason,
    });
    if (events.blockedRequests.length > 200) events.blockedRequests.shift();
  };

  const plain = (res, status, text) =>
    send(res, status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }, text);

  const notFound = (res) => plain(res, 404, '未找到');

  const loadReport = async (id, token) => {
    if (!/^rpt_[a-f0-9]{16}$/.test(id ?? '')) return null;
    try {
      const meta = await store.getMeta(id);
      if (!token || meta.token !== token) return null;
      const check = await store.getCheck(id);
      return { meta, check };
    } catch {
      return null;
    }
  };

  const handler = async (req, res) => {
    // 报告站点只接受自己的 Host，避免被当作别的主机使用（DNS 重绑定防线）。
    if (req.headers.host !== `${config.hosts.report}:${config.ports.report}`) {
      recordBlocked(req, req.url, 'host-mismatch');
      return send(res, 421, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }, 'Host 不被接受');
    }

    const url = new URL(req.url, config.origins.report);
    const segments = url.pathname.split('/').filter(Boolean);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      recordBlocked(req, req.url, `method:${req.method}`);
      return plain(res, 405, '报告站点只读');
    }

    // 独立预览外壳自带的唯一脚本，由库提供，不属于报告内容。
    if (url.pathname === '/shell.js') {
      return send(res, 200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      }, SHELL_SCRIPT);
    }

    if (url.pathname === '/health') {
      return send(res, 200, { 'Content-Type': 'application/json' }, '{"ok":true}');
    }

    if (!segments.length) {
      return send(res, 200, reportShellHeaders(config), indexHtml(config));
    }

    // 报告：/r/<id>/<token>（或 ?t=token）为外壳，/r/<id>/<token>/content 为正文。
    if (segments[0] === 'r' && segments[1] && segments.length <= 4) {
      const token = segments[2] ?? url.searchParams.get('t') ?? '';
      const loaded = await loadReport(segments[1], token);
      if (!loaded) {
        recordBlocked(req, req.url, 'bad-preview-token');
        return notFound(res);
      }
      if (segments[3] === 'content') {
        if (segments.length !== 4) return notFound(res);
        const body = await store.readBody(segments[1]);
        return send(res, 200, reportContentHeaders(config), documentHtml(loaded.meta, body));
      }
      if (segments.length > 3) return notFound(res);
      return send(res, 200, reportShellHeaders(config), shellPage(config, loaded, segments[1], token));
    }

    // 随报告导入的本地图片：/a/<id>/<token>/<name>
    if (segments[0] === 'a' && segments[1] && segments[2] && segments[3] && segments.length === 4) {
      let meta;
      try {
        meta = await store.getMeta(segments[1]);
      } catch {
        return notFound(res);
      }
      if (meta.token !== segments[2]) {
        recordBlocked(req, req.url, 'bad-asset-token');
        return notFound(res);
      }
      const asset = meta.assets.find((a) => a.storedName === segments[3]);
      if (!asset) return notFound(res);
      try {
        const data = await fs.readFile(store.assetPath(segments[1], segments[3]));
        return send(res, 200, reportAssetHeaders(asset.contentType), data);
      } catch {
        return notFound(res);
      }
    }

    recordBlocked(req, url.pathname + url.search, 'unknown-path');
    return notFound(res);
  };

  return { handler };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function shellPage(config, { meta, check }, id, token) {
  const external = check.externalResources ?? [];
  const local = check.resources.filter((r) => r.status === 'local');
  const missing = check.resources.filter((r) => r.status === 'missing');
  const embedded = check.resources.filter((r) => r.status === 'embedded');
  const blocked = check.resources.filter((r) => r.status === 'blocked');
  const contentUrl = `/r/${id}/${token}/content`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)} · 隔离预览</title>
<style>${SHELL_CSS}</style>
</head>
<body data-business-origin="${escapeHtml(config.origins.business)}">
<div class="bar">
  <strong title="标题按纯文本展示">${escapeHtml(meta.title)}</strong>
  <span class="tag">独立预览地址</span>
  <span class="tag warn" title="报告内的脚本不会运行">脚本已禁用</span>
  <span class="tag warn" title="外部资源不会自动加载">外部资源未自动加载</span>
  <span class="meta" title="${escapeHtml(meta.fileName)}">文件：${escapeHtml(meta.fileName)}</span>
  <span class="spacer"></span>
  <button type="button" id="toggle-check">资源检查</button>
  <button type="button" id="close-preview">关闭报告</button>
</div>
<div class="body">
  <div class="stage">
    <iframe title="报告内容（隔离区域）" sandbox="" referrerpolicy="no-referrer"
      src="${escapeHtml(contentUrl)}"></iframe>
  </div>
  <aside class="check" id="check-panel">
    <h2>资源检查结果</h2>
    <section>
      <p class="muted">预览不会自动联网。下列外部资源均未载入；只有你手动点击“手动打开”时才会访问对应地址。</p>
      <h3>外部资源（未载入）</h3>
      ${block(external, (item) => `${escapeHtml(item.url)}${
        item.kinds.length ? `（${escapeHtml(item.kinds.join('、'))}）` : ''
      }`, '未载入', 'bad', true)}
      <h3>随报告提供的本地资源（已载入）</h3>
      ${block(local, (item) => escapeHtml(item.url), '已载入', 'ok')}
      <h3>内嵌图片（data:）</h3>
      ${block(embedded, (item) => `${escapeHtml(item.url.slice(0, 40))}…`, '已载入', 'ok')}
      <h3>缺失的本地资源</h3>
      ${block(missing, (item) => escapeHtml(item.url), '缺失', 'bad')}
      <h3>被阻止的构造</h3>
      ${block(blocked, (item) => escapeHtml(`${item.kind}：${item.url}`), '已阻止', 'bad')}
      <h3>已移除的危险构造</h3>
      ${removedList(check.removed)}
    </section>
  </aside>
</div>
<script src="/shell.js"></script>
</body>
</html>`;
}

function block(items, label, statusText, className, withOpen = false) {
  if (!items.length) return '<p class="muted">无。</p>';
  return `<ul>${items.map((item) => `<li><code>${label(item)}</code>
    <span class="${className}">${statusText}</span>
    ${withOpen && isHttpUrl(item.url)
      ? `<a class="open-ext" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer nofollow">手动打开</a>`
      : ''}
  </li>`).join('')}</ul>`;
}

/** 只有 http(s) 才做成可点击的“手动打开”，其他 scheme 仅以文本展示。 */
function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function removedList(removed) {
  const labels = {
    scripts: '脚本',
    inlineHandlers: '内联事件处理器',
    jsUrls: 'javascript: / 危险 CSS',
    forms: '表单',
    metaRefreshes: '自动跳转',
    frames: '嵌套框架',
    stylesheets: '外部样式表',
    baseTags: 'base 标签',
    links: '外部链接',
    comments: '注释/doctype',
  };
  const items = Object.entries(removed ?? {})
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `<li>${escapeHtml(labels[key] ?? key)}：${count}</li>`);
  return items.length ? `<ul>${items.join('')}</ul>` : '<p class="muted">无。</p>';
}

function documentHtml(meta, body) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<style>${CONTENT_CSS}</style>
</head>
<body>
<p class="gsb2-notice">供应商报告（隔离预览）：报告内脚本不会运行，外部资源不会自动加载。</p>
${body}
</body>
</html>`;
}

const SHELL_SCRIPT = `
// 独立预览外壳自己的脚本：只负责开合资源面板与关闭报告，从不接触报告内容。
(() => {
  const panel = document.getElementById('check-panel');
  const toggle = document.getElementById('toggle-check');
  if (toggle && panel) {
    let open = true;
    const sync = () => {
      panel.hidden = !open;
      toggle.textContent = open ? '收起资源检查' : '资源检查';
    };
    toggle.addEventListener('click', () => { open = !open; sync(); });
    sync();
  }
  const close = document.getElementById('close-preview');
  if (close) {
    close.addEventListener('click', () => {
      if (window.opener) {
        window.close();
      } else if (history.length > 1 && document.referrer) {
        history.back();
      } else {
        // 独立地址被直接打开时没有可返回的业务页，回到报告库的入口。
        location.replace(document.body.dataset.businessOrigin || '/');
      }
    });
  }
})();
`;

const SHELL_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; }
body { display: flex; flex-direction: column; background: #f6f8fa; color: #1f2328;
  font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 10px 16px;
  border-bottom: 1px solid #d0d7de; background: #fff; }
.bar strong { font-size: 15px; max-width: 40ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px;
  font-size: 12px; background: #ddf4ff; color: #0a3069; border: 1px solid #54aeff66; white-space: nowrap; }
.tag.warn { background: #fff8c5; color: #7d4e00; border-color: #d4a72c66; }
.bar .spacer { flex: 1; }
.bar .meta { font-size: 12px; color: #59636e; }
.bar button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid #d0d7de;
  background: #f6f8fa; cursor: pointer; }
.bar button:hover { background: #eef1f4; }
.body { flex: 1; display: flex; min-height: 0; }
.stage { flex: 1; min-width: 0; background: #fff; }
.stage iframe { display: block; width: 100%; height: 100%; border: 0; }
.check { width: 350px; flex: none; overflow: auto; border-left: 1px solid #d0d7de; background: #fff;
  padding: 0 0 24px; }
.check[hidden] { display: none; }
.check h2 { margin: 0; padding: 14px 16px 6px; font-size: 13px; letter-spacing: .04em; color: #59636e; }
.check section { padding: 0 16px; }
.check h3 { margin: 14px 0 4px; font-size: 13px; }
.check ul { margin: 0; padding-left: 18px; }
.check li { margin: 3px 0; word-break: break-all; }
.check li code { font-size: 12px; }
.open-ext { margin-left: 6px; font-size: 12px; color: #0969da; }
.muted { color: #59636e; }
.ok { color: #1a7f37; }
.bad { color: #cf222e; }
@media (max-width: 760px) {
  .body { flex-direction: column; }
  .check { width: auto; border-left: 0; border-top: 1px solid #d0d7de; }
}
`.trim();

const CONTENT_CSS = `
:root { color-scheme: light; }
body { margin: 0; padding: 20px 24px 32px; font: 15px/1.7 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2328; background: #fff; }
h1, h2, h3 { line-height: 1.35; }
table { border-collapse: collapse; margin: 16px 0; max-width: 100%; }
th, td { border: 1px solid #d0d7de; padding: 6px 12px; text-align: left; }
th { background: #f6f8fa; }
img { max-width: 100%; height: auto; }
.gsb2-blocked { display: inline-block; margin: 4px 0; padding: 2px 8px; border: 1px dashed #cf222e; border-radius: 4px; color: #a40e26; background: #ffebe9; font-size: 13px; }
.gsb2-notice { margin: 0 0 16px; padding: 8px 12px; border-left: 3px solid #bf8700; background: #fff8c5; color: #4d2d00; font-size: 13px; }
`.trim();

function indexHtml(config) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>隔离报告站点</title>
<style>body{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;padding:24px;color:#1f2328}</style></head>
<body>
<h1>隔离报告站点</h1>
<p>该站点只提供报告内容与随报告导入的本地资源，不提供任何业务接口。</p>
<p>业务页：<a href="${escapeHtml(config.origins.business)}/">${escapeHtml(config.origins.business)}</a></p>
</body></html>`;
}
