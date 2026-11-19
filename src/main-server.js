'use strict';
// 业务页(采购系统):账号会话 + 报告库列表 + 导入 + 检查结果 + 列表预览。
// 报告内容一律通过隔离预览源(127.0.0.1)的 sandbox iframe 展示,
// 报告无法读取本页账号信息,也无法替本页发起操作。
const http = require('node:http');
const crypto = require('node:crypto');
const { escapeHtml } = require('./html-utils');

function renderCheck(check) {
  const lines = [];
  if (check.local.length) {
    lines.push(`本地资源(随报告载入): ${check.local.map((r) => escapeHtml(r.url)).join(', ')}`);
  }
  if (check.external.length) {
    lines.push('报告作者引用的外部资源(预览时未载入):');
    lines.push(...check.external.map((r) => `  · [${r.kind}] ${escapeHtml(r.url)}`));
  }
  if (check.inlineScripts > 0 || check.scriptUrls.length > 0) {
    const parts = [];
    if (check.inlineScripts > 0) parts.push(`内联脚本 ${check.inlineScripts} 段`);
    if (check.scriptUrls.length > 0) parts.push(`脚本地址 ${check.scriptUrls.length} 个`);
    lines.push(`脚本(预览中不执行): ${parts.join(', ')}`);
  }
  if (!lines.length) lines.push('未发现外部资源或脚本。');
  return lines.join('\n');
}

function renderPage({ account, reports, previewId, previewBase }) {
  const rows = reports.map((r) => `
    <tr>
      <td>${escapeHtml(r.title)}</td>
      <td>${escapeHtml(r.originalFileName)}</td>
      <td>${escapeHtml(r.importedAt)}</td>
      <td><pre class="check">${renderCheck(r.check)}</pre></td>
      <td>
        <a href="/?preview=${encodeURIComponent(r.id)}">列表预览</a> |
        <a href="${previewBase}/report/${encodeURIComponent(r.id)}/" target="_blank" rel="noopener">独立预览地址</a>
      </td>
    </tr>`).join('');

  const preview = previewId ? `
    <section>
      <h2>报告预览(隔离区域) <a href="/">关闭报告</a></h2>
      <iframe title="report-preview" sandbox="" referrerpolicy="no-referrer"
              src="${previewBase}/report/${encodeURIComponent(previewId)}/"
              style="width:100%;height:480px;border:1px solid #999"></iframe>
    </section>` : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>采购系统 · 本地报告库</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #ccc; padding: 6px 8px; vertical-align: top; }
  .account { background: #eef3fb; padding: 8px 12px; }
  .check { margin: 0; white-space: pre-wrap; font-size: 12px; }
</style>
</head>
<body>
  <h1>采购系统 · 本地报告库</h1>
  <p class="account">当前账号:${escapeHtml(account.name)}(${escapeHtml(account.id)}) · 会话正常</p>

  <h2>导入报告</h2>
  <form method="post" action="/import">
    <label>标题 <input name="title" required></label>
    <label>本地 HTML 路径 <input name="sourcePath" size="50" required
      placeholder="例如 public/samples/sample-report.html"></label>
    <button type="submit">导入</button>
  </form>

  <h2>报告列表</h2>
  <table>
    <tr><th>标题</th><th>文件名</th><th>导入时间</th><th>检查结果</th><th>操作</th></tr>
    ${rows || '<tr><td colspan="5">暂无报告</td></tr>'}
  </table>
  ${preview}
</body>
</html>`;
}

function createMainServer({ store, previewBase }, port = 18080) {
  const sessions = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://main.local');

    // 会话:HttpOnly Cookie,仅属于 localhost;预览源(127.0.0.1)拿不到
    let sid = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([\w-]+)/)?.[1];
    if (!sid || !sessions.has(sid)) {
      sid = crypto.randomBytes(16).toString('hex');
      sessions.set(sid, { id: 'PROC-0042', name: '采购员-王芳' });
      res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
    }
    const account = sessions.get(sid);

    if (url.pathname === '/') {
      const previewId = url.searchParams.get('preview');
      const html = renderPage({
        account,
        reports: store.list(),
        previewId: previewId && store.get(previewId) ? previewId : null,
        previewBase,
      });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url.pathname === '/import' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        try {
          store.import({ title: params.get('title'), sourcePath: params.get('sourcePath') });
          res.writeHead(303, { Location: '/' }).end();
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`导入失败: ${err.message}`);
        }
      });
      return;
    }

    if (url.pathname === '/api/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(account));
      return;
    }

    // 业务操作端点:报告内脚本试图冒充用户调用它;隔离生效时计数恒为 0
    if (url.pathname === '/api/report-action' && req.method === 'POST') {
      server.reportActionCount += 1;
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reportActionCount: server.reportActionCount }));
      return;
    }

    res.writeHead(404).end('not found');
  });
  server.reportActionCount = 0;
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      server.baseUrl = `http://localhost:${server.address().port}`;
      resolve(server);
    });
  });
}

module.exports = { createMainServer };
