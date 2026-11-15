'use strict';

/**
 * 本地模拟后台：一个只能在网页里按编号查商品、编辑价格的旧式管理界面。
 * 没有对外 JSON API —— 一切都要通过浏览器里的表单完成，和真实老后台一样。
 *
 * 页面：
 *   GET  /            商品列表（按编号搜索）
 *   GET  /product?code=...   商品详情 + 改价表单
 *   POST /change      提交改价（自动化和人工共用）
 *   GET  /history     改价历史（带操作编号）
 *   GET  /manual      手动改价入口
 */

const http = require('http');
const { URL } = require('url');
const store = require('./store');
const { parseMoneyToCents, formatCents } = require('../lib/money');

const PORT = Number(process.env.PORT || 4310);
const HOST = '127.0.0.1';

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; font-family: -apple-system, "PingFang SC", "Segoe UI", sans-serif;
  background: #f4f5f7; color: #1c1e21; font-size: 14px;
}
.wrap { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 32px 0 12px; }
.sub { color: #6b7280; margin: 0 0 20px; }
.card { background: #fff; border: 1px solid #dcdfe4; border-radius: 8px; padding: 20px; }
label { display: block; font-weight: 600; margin: 0 0 6px; }
input[type=text] {
  width: 100%; padding: 9px 11px; border: 1px solid #c6cbd4; border-radius: 6px;
  font-size: 14px; font-family: inherit; background: #fff;
}
input[readonly] { background: #f1f2f5; color: #4b5160; }
button {
  padding: 9px 18px; border-radius: 6px; border: 1px solid #1f5fd0;
  background: #2563eb; color: #fff; font-size: 14px; font-family: inherit; cursor: pointer;
}
button.secondary { background: #fff; color: #2563eb; }
button.danger { background: #c0392b; border-color: #a93226; }
.row { display: flex; gap: 12px; align-items: flex-end; }
.row > div { flex: 1; }
.msg { padding: 12px 14px; border-radius: 6px; margin: 0 0 18px; border: 1px solid; }
.msg.ok { background: #ecfdf5; border-color: #a7f3d0; color: #065f46; }
.msg.err { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #eceef2; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
.badge.auto { background: #e0ecff; color: #1d4ed8; }
.badge.manual { background: #fdf0d5; color: #92400e; }
a { color: #2563eb; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.nav { margin: 0 0 18px; font-size: 13px; }
.nav a { margin-right: 16px; }
.empty { color: #6b7280; padding: 16px 0; }
`;

function layout(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 商品价格模拟后台</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="nav">
    <a href="/">商品列表</a>
    <a href="/manual">手动改价</a>
    <a href="/history">改价历史</a>
  </div>
  ${body}
</div>
</body>
</html>`;
}

function priceCell(cents) {
  return `<span data-price-cents="${cents}">${formatCents(cents)}</span>`;
}

function renderList(db, { q, msg }) {
  const keyword = (q || '').trim();
  const rows = keyword
    ? db.products.filter((p) => p.code.includes(keyword))
    : db.products;

  const results = rows.length
    ? `<table>
  <thead><tr><th>商品编号</th><th>名称</th><th class="num">当前价（元）</th><th>版本</th><th></th></tr></thead>
  <tbody>
  ${rows
    .map(
      (p) => `<tr data-code="${esc(p.code)}">
    <td class="mono">${esc(p.code)}</td>
    <td>${esc(p.name)}</td>
    <td class="num" data-current-price>${priceCell(p.priceCents)}</td>
    <td class="mono" data-version="${p.version}">v${p.version}</td>
    <td><a href="/product?code=${encodeURIComponent(p.code)}">查看 / 改价</a></td>
  </tr>`
    )
    .join('\n')}
  </tbody>
</table>`
    : `<div class="empty">没有匹配“${esc(keyword)}”的商品。</div>`;

  return layout('商品列表', `
  <h1>商品列表</h1>
  <p class="sub">按商品编号查询，再进入详情页修改价格。</p>
  ${msg || ''}
  <div class="card">
    <form id="search-form" method="get" action="/">
      <label for="q">商品编号</label>
      <div class="row">
        <div><input id="q" name="q" type="text" value="${esc(keyword)}" autocomplete="off" placeholder="例如 P-1001"></div>
        <button type="submit" id="search-button">查询</button>
      </div>
    </form>
  </div>
  <h2>查询结果（${rows.length}）</h2>
  <div class="card" id="results">${results}</div>
  <span id="result-count" class="mono" hidden>${rows.length}</span>`);
}

function renderProduct(db, { code, msg }) {
  const product = store.findProduct(db, code);
  if (!product) {
    return layout('商品不存在', `
      <h1>商品不存在</h1>
      <p class="sub">没有编号为 <span class="mono">${esc(code || '')}</span> 的商品。</p>
      <p><a href="/">返回商品列表</a></p>`);
  }

  const history = db.history.filter((h) => h.code === product.code).slice().reverse();
  const historyRows = history.length
    ? history
        .map(
          (h) => `<tr data-op-id="${esc(h.opId)}" data-seq="${h.seq}" data-code="${esc(
            h.code
          )}" data-old-cents="${h.oldPriceCents}" data-new-cents="${h.newPriceCents}" data-source="${esc(
            h.source
          )}" data-at="${esc(h.at)}">
      <td class="mono">#${h.seq}</td>
      <td class="mono">${esc(h.opId)}</td>
      <td class="num">${formatCents(h.oldPriceCents)}</td>
      <td class="num">${formatCents(h.newPriceCents)}</td>
      <td><span class="badge ${h.source === 'automation' ? 'auto' : 'manual'}">${h.source === 'automation' ? '自动' : '手动'}</span></td>
      <td class="mono">${esc(h.at)}</td>
    </tr>`
        )
        .join('\n')
    : `<tr><td colspan="6" class="empty">暂无改价记录</td></tr>`;

  return layout(`商品 ${product.code}`, `
  <h1>商品详情</h1>
  <p class="sub"><span class="mono">${esc(product.code)}</span> · ${esc(product.name)}</p>
  ${msg || ''}
  <div class="card">
    <table>
      <tr><th>当前价（元）</th><td class="num" id="current-price" data-price-cents="${product.priceCents}">${priceCell(product.priceCents)}</td></tr>
      <tr><th>版本号</th><td class="mono" id="product-version" data-version="${product.version}">v${product.version}</td></tr>
      <tr><th>最后更新</th><td class="mono">${esc(product.updatedAt)}</td></tr>
    </table>
  </div>

  <h2>改价</h2>
  <div class="card">
    <form id="change-form" method="post" action="/change">
      <input type="hidden" name="code" value="${esc(product.code)}">
      <input type="hidden" name="expectedVersion" value="${product.version}">
      <input type="hidden" name="expectedOldPrice" value="${formatCents(product.priceCents)}">
      <div class="row">
        <div>
          <label for="old-price">预计旧价（元）</label>
          <input id="old-price" name="oldPrice" type="text" readonly value="${formatCents(product.priceCents)}">
        </div>
        <div>
          <label for="new-price">新价（元）</label>
          <input id="new-price" name="newPrice" type="text" autocomplete="off" placeholder="例如 18.00">
        </div>
        <div>
          <label for="op-id">操作编号</label>
          <input id="op-id" name="opId" type="text" autocomplete="off" placeholder="留空则自动生成">
        </div>
      </div>
      <p class="sub" style="margin:14px 0 0">保存时后台会重新校验当前价是否仍为预计旧价；若已被人改动，将拒绝覆盖。</p>
      <div style="margin-top:16px"><button type="submit" id="save-button">保存改价</button></div>
    </form>
  </div>

  <h2>本商品改价历史</h2>
  <div class="card">
    <table id="product-history">
      <thead><tr><th>序号</th><th>操作编号</th><th class="num">旧价</th><th class="num">新价</th><th>来源</th><th>时间</th></tr></thead>
      <tbody>${historyRows}</tbody>
    </table>
  </div>`);
}

function renderManual(db, { msg }) {
  const options = db.products
    .map(
      (p) =>
        `<option value="${esc(p.code)}">${esc(p.code)} · ${esc(p.name)}（当前 ${formatCents(
          p.priceCents
        )} 元）</option>`
    )
    .join('\n');

  return layout('手动改价', `
  <h1>手动改价</h1>
  <p class="sub">这是后台留给你人工操作的普通入口，效果与自动化改价完全一致。</p>
  ${msg || ''}
  <div class="card">
    <form id="manual-form" method="post" action="/change">
      <input type="hidden" name="source" value="manual">
      <label for="manual-code">商品编号</label>
      <input id="manual-code" name="code" type="text" list="product-options" autocomplete="off" placeholder="例如 P-1002">
      <datalist id="product-options">${options}</datalist>
      <label for="manual-price" style="margin-top:14px">新价（元）</label>
      <input id="manual-price" name="newPrice" type="text" autocomplete="off" placeholder="例如 29.00">
      <div style="margin-top:16px"><button type="submit" id="manual-save-button">手动保存</button></div>
    </form>
  </div>`);
}

function renderHistory(db, { msg }) {
  const rows = db.history.length
    ? db.history
        .slice()
        .reverse()
        .map(
          (h) => `<tr data-op-id="${esc(h.opId)}" data-seq="${h.seq}" data-code="${esc(
            h.code
          )}" data-old-cents="${h.oldPriceCents}" data-new-cents="${h.newPriceCents}" data-source="${esc(
            h.source
          )}" data-at="${esc(h.at)}">
      <td class="mono">#${h.seq}</td>
      <td class="mono">${esc(h.opId)}</td>
      <td class="mono">${esc(h.code)}</td>
      <td class="num">${formatCents(h.oldPriceCents)}</td>
      <td class="num">${formatCents(h.newPriceCents)}</td>
      <td><span class="badge ${h.source === 'automation' ? 'auto' : 'manual'}">${h.source === 'automation' ? '自动' : '手动'}</span></td>
      <td class="mono">${esc(h.at)}</td>
    </tr>`
        )
        .join('\n')
    : `<tr><td colspan="7" class="empty">暂无改价记录</td></tr>`;

  return layout('改价历史', `
  <h1>改价历史</h1>
  <p class="sub">每次改价都记录操作编号，便于与执行台对账。</p>
  ${msg || ''}
  <div class="card">
    <table id="history-table">
      <thead><tr><th>序号</th><th>操作编号</th><th>商品</th><th class="num">旧价</th><th class="num">新价</th><th>来源</th><th>时间</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`);
}

function flashPage({ title, message, kind, backHref, extra }) {
  const cls = kind === 'ok' ? 'ok' : 'err';
  return layout(title, `
  <h1>${esc(title)}</h1>
  <div class="msg ${cls}">${esc(message)}</div>
  ${extra || ''}
  <p><a href="${esc(backHref)}">返回</a> · <a href="/history">改价历史</a></p>`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleChange(req, res) {
  const raw = await readBody(req);
  const form = new URLSearchParams(raw);
  const code = (form.get('code') || '').trim();
  const newPriceRaw = (form.get('newPrice') || '').trim();
  const sourceField = form.get('source');
  const opId = (form.get('opId') || '').trim();
  const expectedOldRaw = (form.get('expectedOldPrice') || '').trim();
  const expectedVersionRaw = (form.get('expectedVersion') || '').trim();

  if (sourceField === 'manual') {
    const newPrice = parseMoneyToCents(newPriceRaw);
    if (!newPrice.ok) {
      return sendHtml(
        res,
        400,
        flashPage({
          title: '手动改价失败',
          message: newPrice.error,
          kind: 'err',
          backHref: '/manual',
        })
      );
    }
    if (!code) {
      return sendHtml(
        res,
        400,
        flashPage({
          title: '手动改价失败',
          message: '请填写商品编号',
          kind: 'err',
          backHref: '/manual',
        })
      );
    }
    const db = store.readStore();
    const result = store.applyChange(db, {
      code,
      newPriceCents: newPrice.cents,
      opId: null,
      source: 'manual',
      actor: 'web-ui',
    });
    if (!result.ok) {
      return sendHtml(
        res,
        result.error === 'NOT_FOUND' ? 404 : 409,
        flashPage({
          title: '手动改价失败',
          message: result.message,
          kind: 'err',
          backHref: `/product?code=${encodeURIComponent(code)}`,
        })
      );
    }
    return sendHtml(
      res,
      200,
      flashPage({
        title: '手动改价成功',
        message: `${result.entry.code} 已从 ${formatCents(result.entry.oldPriceCents)} 元改为 ${formatCents(
          result.entry.newPriceCents
        )} 元，操作编号 ${result.entry.opId}，序号 #${result.entry.seq}`,
        kind: 'ok',
        backHref: `/product?code=${encodeURIComponent(code)}`,
        extra: `<p class="sub">操作编号：<span class="mono" id="result-op-id">${esc(
          result.entry.opId
        )}</span></p>`,
      })
    );
  }

  // 详情页表单路径：必须有预计旧价快照；操作编号留空则自动生成一个可追溯的编号
  const newPrice = parseMoneyToCents(newPriceRaw);
  if (!newPrice.ok) {
    return sendHtml(
      res,
      400,
      flashPage({
        title: '改价失败',
        message: newPrice.error,
        kind: 'err',
        backHref: `/product?code=${encodeURIComponent(code)}`,
      })
    );
  }
  const effectiveOpId =
    opId || `WEB-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  // 带了操作编号的是自动化提交；详情页上人工直接改价则按手动记录
  const effectiveSource = opId ? 'automation' : 'manual';

  const expectedOld = parseMoneyToCents(expectedOldRaw);
  if (!expectedOld.ok) {
    // 详情页改价必须带上预计旧价快照，否则后台无从校验，直接拒绝
    return sendHtml(
      res,
      400,
      flashPage({
        title: '改价被拒绝',
        message: '改价必须带有效的预计旧价',
        kind: 'err',
        backHref: `/product?code=${encodeURIComponent(code)}`,
        extra: `<p class="sub">错误码：<span class="mono" id="result-error-code">MISSING_EXPECTED_PRICE</span>，操作编号：<span class="mono" id="result-op-id">${esc(
          effectiveOpId
        )}</span></p>`,
      })
    );
  }
  const expectedVersion = expectedVersionRaw === '' ? null : Number(expectedVersionRaw);
  const db = store.readStore();
  const result = store.applyChange(db, {
    code,
    newPriceCents: newPrice.cents,
    expectedOldPriceCents: expectedOld.cents,
    expectedVersion: Number.isFinite(expectedVersion) ? expectedVersion : null,
    opId: effectiveOpId,
    source: effectiveSource,
    actor: opId ? 'executor' : 'web-ui',
  });

  if (!result.ok) {
    return sendHtml(
      res,
      409,
      flashPage({
        title: '改价被拒绝',
        message: `${result.message}（错误码 ${result.error}，操作编号 ${effectiveOpId}）`,
        kind: 'err',
        backHref: `/product?code=${encodeURIComponent(code)}`,
        extra: `<p class="sub">错误码：<span class="mono" id="result-error-code">${esc(
          result.error
        )}</span>，操作编号：<span class="mono" id="result-op-id">${esc(
          effectiveOpId
        )}</span></p>`,
      })
    );
  }

  const note = result.duplicate ? '（该操作编号此前已保存，本次未重复写入）' : '';
  return sendHtml(
    res,
    200,
    flashPage({
      title: result.duplicate ? '改价已存在' : '改价成功',
      message: `${result.entry.code} 已从 ${formatCents(result.entry.oldPriceCents)} 元改为 ${formatCents(
        result.entry.newPriceCents
      )} 元${note}，序号 #${result.entry.seq}`,
      kind: 'ok',
      backHref: `/product?code=${encodeURIComponent(code)}`,
      extra: `<p class="sub">操作编号：<span class="mono" id="result-op-id">${esc(
        effectiveOpId
      )}</span>，序号：<span class="mono" id="result-seq">${result.entry.seq}</span></p>`,
    })
  );
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        const q = url.searchParams.get('q') || '';
        const db = store.readStore();
        return sendHtml(res, 200, renderList(db, { q }));
      }
      if (req.method === 'GET' && url.pathname === '/product') {
        const code = (url.searchParams.get('code') || '').trim();
        const db = store.readStore();
        return sendHtml(res, 200, renderProduct(db, { code }));
      }
      if (req.method === 'GET' && url.pathname === '/manual') {
        const db = store.readStore();
        return sendHtml(res, 200, renderManual(db, {}));
      }
      if (req.method === 'GET' && url.pathname === '/history') {
        const db = store.readStore();
        return sendHtml(res, 200, renderHistory(db, {}));
      }
      if (req.method === 'POST' && url.pathname === '/change') {
        return await handleChange(req, res);
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }
      sendHtml(res, 404, layout('页面不存在', `<h1>页面不存在</h1><p><a href="/">返回</a></p>`));
    } catch (err) {
      sendHtml(
        res,
        500,
        layout('服务器错误', `<h1>服务器错误</h1><div class="msg err">${esc(err.message)}</div>`)
      );
    }
  });
}

function start() {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`模拟后台已启动: http://${HOST}:${PORT}`);
  });
  return server;
}

if (require.main === module) {
  start();
}

module.exports = { createServer, start, PORT, HOST };
