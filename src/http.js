// 极简 HTTP 工具：路由匹配、JSON/HTML 响应、请求体解析、重定向。
import http from 'node:http';
import { escapeHtml } from './util.js';

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const clean = pattern.replace(/^\//, '');
    const segs = clean === '' ? [] : clean.split('/');
    const source = segs.map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '/([^/]+)';
      }
      return '/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    const regex = new RegExp('^' + (source || '/') + '$');
    routes.push({ method, regex, keys, handler });
  };
  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.regex.exec(pathname);
        if (m) {
          const params = {};
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
          return { handler: r.handler, params };
        }
      }
      return null;
    },
    allowedMethods(pathname) {
      return [...new Set(routes.filter((r) => r.regex.test(pathname)).map((r) => r.method))];
    },
  };
}

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

export function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // 不使用 form-action：授权成功后会 302 跳到应用自己的 origin，
    // 部分浏览器会把 form-action 限制套用到重定向目标上，导致回调被阻断。
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    ...headers,
  });
  res.end(html);
}

export function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readForm(req) {
  const raw = await readBody(req);
  const params = new URLSearchParams(raw);
  const out = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

// 同名多值表单（例如多个 checkbox）。first 取最后一个值，all 保留全部。
export async function readFormAll(req) {
  const raw = await readBody(req);
  const params = new URLSearchParams(raw);
  const all = {};
  for (const [k, v] of params) (all[k] ||= []).push(v);
  const first = {};
  for (const [k, vs] of Object.entries(all)) first[k] = vs[vs.length - 1];
  return { all, first };
}

export function query(req) {
  return new URL(req.url, 'http://placeholder').searchParams;
}

export function layout({ title, body, user = null, nav = '', csrf = null }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #1f2329; }
  header { background: #1f2d3d; color: #fff; padding: 12px 20px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  header .brand { font-weight: 600; letter-spacing: .3px; }
  header a { color: #cfe0f5; text-decoration: none; font-size: 14px; }
  header a:hover { color: #fff; text-decoration: underline; }
  header .spacer { flex: 1; }
  main { max-width: 860px; margin: 28px auto; padding: 0 20px 60px; }
  .card { background: #fff; border: 1px solid #e3e6eb; border-radius: 10px; padding: 22px 24px; margin-bottom: 18px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
  h1 { font-size: 21px; margin: 0 0 16px; }
  h2 { font-size: 17px; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #eef0f3; vertical-align: top; }
  th { color: #5b6572; font-weight: 600; background: #fafbfc; }
  tr:last-child td { border-bottom: 0; }
  .muted { color: #6b7684; font-size: 13px; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; background: #eef2f7; color: #3c4a5a; }
  .pill.read { background: #e8f3ff; color: #0b5cad; }
  .pill.update { background: #fff2e2; color: #9a5b00; }
  .pill.ok { background: #e7f6ec; color: #1a7f37; }
  .pill.bad { background: #fdecec; color: #b42318; }
  label.scope { display: block; border: 1px solid #e3e6eb; border-radius: 8px; padding: 12px 14px; margin: 10px 0; cursor: pointer; }
  label.scope:hover { border-color: #b9c6d6; background: #fafcff; }
  label.scope input { margin-right: 8px; }
  label.scope.locked { cursor: default; opacity: .75; }
  .actions { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
  button, .btn { font: inherit; border-radius: 8px; padding: 9px 16px; border: 1px solid transparent; cursor: pointer; text-decoration: none; display: inline-block; }
  .primary { background: #1a6fd4; color: #fff; }
  .primary:hover { background: #155cb0; }
  .danger { background: #fff; color: #b42318; border-color: #f0b4ae; }
  .danger:hover { background: #fdecec; }
  .secondary { background: #fff; color: #1f2d3d; border-color: #cfd6df; }
  .secondary:hover { background: #f2f5f9; }
  .notice { padding: 10px 14px; border-radius: 8px; margin: 12px 0; font-size: 14px; }
  .notice.err { background: #fdecec; color: #b42318; }
  .notice.ok { background: #e7f6ec; color: #1a7f37; }
  .notice.info { background: #eef4ff; color: #1a4f9c; }
  code { background: #f1f3f6; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  pre { background: #0f1720; color: #d7e2ee; padding: 14px 16px; border-radius: 8px; overflow: auto; font-size: 13px; }
  .empty { padding: 22px; text-align: center; color: #6b7684; }
</style>
</head>
<body>
<header>
  <span class="brand">工单系统</span>
  <a href="/settings">已授权应用</a>
  <a href="/docs">接口说明</a>
  <span class="spacer"></span>
  ${user ? `<span class="muted" style="color:#cfe0f5">${escapeHtml(user.displayName)}（${escapeHtml(user.username)}）</span>
  <form method="post" action="/logout" style="margin:0">${csrf ? `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` : ''}<button class="secondary" style="padding:5px 12px">退出</button></form>` : ''}
</header>
<main>${nav}${body}</main>
</body>
</html>`;
}

export function createServer(handler) {
  return http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (res.headersSent) { res.destroy(); return; }
      const status = err.statusCode || 500;
      if (req.url?.startsWith('/api/')) {
        sendJson(res, status, { error: err.code || 'server_error', message: status === 500 ? '服务器内部错误' : err.message });
      } else {
        sendHtml(res, status, layout({ title: '出错了', body: `<div class="card"><h1>出错了</h1><p>${escapeHtml(status === 500 ? '服务器内部错误' : err.message)}</p></div>` }));
      }
      if (status === 500) console.error('[error]', err);
    });
  });
}
