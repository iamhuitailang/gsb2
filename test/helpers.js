// 测试辅助：一个带 cookie jar、可处理重定向的最小"浏览器"，用于走完真实 HTTP 流程。
export class Browser {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  capture(res) {
    let raw = [];
    if (typeof res.headers.getSetCookie === 'function') raw = res.headers.getSetCookie();
    if (!raw.length) {
      const single = res.headers.get('set-cookie');
      if (single) raw = [single];
    }
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (/Max-Age=0\b/i.test(line) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, decodeURIComponent(value));
    }
  }

  async request(method, path, { form, headers = {} } = {}) {
    const url = path.startsWith('http') ? path : this.base + path;
    const init = { method, redirect: 'manual', headers: { ...headers } };
    const cookie = this.cookieHeader();
    if (cookie) init.headers.Cookie = cookie;
    if (form) {
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      // 支持同名多值（checkbox 数组）。
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) {
        if (Array.isArray(v)) v.forEach((item) => params.append(k, item));
        else if (v != null) params.append(k, v);
      }
      init.body = params.toString();
    }
    const res = await fetch(url, init);
    this.capture(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, headers: res.headers, location: res.headers.get('location'), text, json };
  }

  get(path, opts) { return this.request('GET', path, opts); }
  post(path, form, opts = {}) { return this.request('POST', path, { ...opts, form }); }

  // 跟随 302 链，返回最终响应；用于登录后跳转等。
  async follow(res, max = 5) {
    let current = res;
    for (let i = 0; i < max && current.status >= 300 && current.status < 400 && current.location; i += 1) {
      current = await this.get(current.location);
    }
    return current;
  }
}

// 从 HTML 中抽出一次性 CSRF 隐藏字段，模拟真实表单提交。
export function extractCsrf(html) {
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  return m ? m[1] : null;
}

// 从页面里解析出某个表单的隐藏字段（供 POST /oauth/authorize 复用）。
export function extractHiddenFields(html) {
  const out = {};
  const re = /<input type="hidden" name="([^"]+)" value="([^"]*)">/g;
  let m;
  while ((m = re.exec(html))) out[decodeURIComponent(m[1])] = decodeHtml(m[2]);
  return out;
}

export function extractApprovedScopes(html) {
  const scopes = [];
  const re = /name="approved_scope" value="([^"]+)" checked/g;
  let m;
  while ((m = re.exec(html))) scopes.push(decodeHtml(m[1]));
  return scopes;
}

function decodeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// 构造一个 PKCE verifier/challenge 对。
export async function pkcePair() {
  const crypto = await import('node:crypto');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
