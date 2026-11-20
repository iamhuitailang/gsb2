// CSP 源表达式（source expression）的解析模型与 URL 匹配引擎。
// 所有判断均在本地完成：不发起任何网络请求，也不执行输入内容。

import { NO_DEFAULT_FALLBACK } from './directives.js';

// 关键字源（CSP3）
export const KEYWORD_SOURCES = new Set([
  "'self'",
  "'none'",
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'wasm-unsafe-eval'",
  "'unsafe-hashes'",
  "'strict-dynamic'",
  "'report-sample'",
]);

// 可用于放宽内联/求值的危险关键字
export const INLINE_KEYWORDS = new Set(["'unsafe-inline'", "'unsafe-hashes'"]);
export const EVAL_KEYWORDS = new Set(["'unsafe-eval'"]);

export const HASH_PREFIXES = ["'sha256-", "'sha384-", "'sha512-"];
export const NONCE_PREFIX = "'nonce-";

// 未显式给端口时，各协议的默认端口
export const DEFAULT_PORTS = {
  'http:': '80',
  'https:': '443',
  'ws:': '80',
  'wss:': '443',
  'ftp:': '21',
};

// 主机源未写 scheme 时，按规范只匹配这些协议
const HOST_DEFAULT_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*$/;
const TOKEN_RE = /^[!-~]+$/; // 一个 CSP token 不含空白与控制字符

/**
 * 解析单个源 token。
 * 返回 { ok: true, source } 或 { ok: false, error: { message, hint } }。
 * source 结构：
 *   { kind, raw, ... }
 *   kind: keyword | nonce | hash | scheme | host | wildcard-host
 */
export function parseSourceToken(raw) {
  const token = raw;
  if (!token || !TOKEN_RE.test(token)) {
    return {
      ok: false,
      error: { message: `源表达式 "${raw}" 包含空白或非法字符`, hint: '多个来源之间应以空格分隔' },
    };
  }

  // 1. 带引号的：关键字 / nonce / hash
  if (token.startsWith("'")) {
    const lower = token.toLowerCase();
    if (!token.endsWith("'")) {
      return {
        ok: false,
        error: {
          message: `带引号的源表达式 "${raw}" 缺少结尾的单引号`,
          hint: `如果想写关键字，正确形式例如 'self'、'unsafe-inline'；nonce/哈希形如 'nonce-<值>'、'sha256-<摘要>'`,
        },
      };
    }
    if (KEYWORD_SOURCES.has(lower)) {
      return { ok: true, source: { kind: 'keyword', value: lower.slice(1, -1), raw: token } };
    }
    if (lower.startsWith(NONCE_PREFIX)) {
      const value = token.slice(NONCE_PREFIX.length, token.endsWith("'") ? -1 : undefined);
      if (!token.endsWith("'")) {
        return { ok: false, error: { message: `nonce 源 "${raw}" 缺少结尾的单引号`, hint: "格式应为 'nonce-<base64值>'" } };
      }
      if (!value) {
        return { ok: false, error: { message: `nonce 源 "${raw}" 缺少 nonce 值`, hint: "格式应为 'nonce-<base64值>'" } };
      }
      if (!BASE64_RE.test(value)) {
        return { ok: false, error: { message: `nonce 源 "${raw}" 的值不是合法 base64`, hint: 'nonce 值只能包含 A-Z a-z 0-9 + / 以及末尾填充 =' } };
      }
      return { ok: true, source: { kind: 'nonce', value, raw: token } };
    }
    const hashPrefix = HASH_PREFIXES.find((p) => lower.startsWith(p));
    if (hashPrefix) {
      if (!token.endsWith("'")) {
        return { ok: false, error: { message: `哈希源 "${raw}" 缺少结尾的单引号`, hint: "格式应为 'sha256-<base64哈希>'" } };
      }
      const algo = hashPrefix.slice(1, -1); // sha256 / sha384 / sha512
      const value = token.slice(hashPrefix.length, -1);
      if (!value) {
        return { ok: false, error: { message: `哈希源 "${raw}" 缺少哈希值`, hint: "格式应为 'sha256-<base64哈希>'" } };
      }
      if (!BASE64_RE.test(value)) {
        return { ok: false, error: { message: `哈希源 "${raw}" 的哈希值不是合法 base64`, hint: '哈希值只能包含 A-Z a-z 0-9 + / 以及末尾填充 =' } };
      }
      const expectedLen = { sha256: 44, sha384: 64, sha512: 88 }[algo];
      if (value.length !== expectedLen) {
        return {
          ok: false,
          error: {
            message: `哈希源 "${raw}" 的长度为 ${value.length} 个字符，${algo} 的 base64 长度应为 ${expectedLen}`,
            hint: '请确认使用了正确的哈希算法与完整摘要',
          },
        };
      }
      return { ok: true, source: { kind: 'hash', algo, value, raw: token } };
    }
    return {
      ok: false,
      error: {
        message: `未知的带引号关键字 "${raw}"`,
        hint: "常见关键字包括 'self'、'none'、'unsafe-inline'、'unsafe-eval'、'strict-dynamic' 等",
      },
    };
  }

  // 2. 未加引号却写了关键字（最常见的新手错误）
  const asKeyword = `'${token.toLowerCase()}'`;
  if (KEYWORD_SOURCES.has(asKeyword)) {
    return {
      ok: false,
      error: { message: `关键字必须带单引号："${raw}" 应写为 ${asKeyword}`, hint: `改为 ${asKeyword}` },
    };
  }

  // 3. scheme-source，如 https:  data:
  const colonIdx = token.indexOf(':');
  if (colonIdx !== -1 && !token.includes('/')) {
    const scheme = token.slice(0, colonIdx).toLowerCase();
    if (!SCHEME_RE.test(scheme)) {
      return { ok: false, error: { message: `"${raw}" 的协议名 "${scheme}" 不合法`, hint: '协议名应以字母开头，只含字母、数字、+、-、.' } };
    }
    if (token.length === colonIdx + 1) {
      return { ok: true, source: { kind: 'scheme', scheme: scheme + ':', raw: token } };
    }
    return { ok: false, error: { message: `"${raw}" 不是合法的源表达式`, hint: '协议源应只写协议名加冒号，例如 https: 或 data:' } };
  }

  // 4. host-source：[scheme://] host [:port] [path]
  return parseHostSource(token, raw);
}

function parseHostSource(token, raw) {
  let rest = token;
  let scheme = null;
  const schemeMatch = rest.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase() + ':';
    rest = rest.slice(schemeMatch[0].length);
  }

  if (!rest) {
    return { ok: false, error: { message: `"${raw}" 缺少主机名`, hint: '例如 https://cdn.example.com' } };
  }

  // 拆出 path（第一个 / 之后）
  let hostPort = rest;
  let path = null;
  const slashIdx = rest.indexOf('/');
  if (slashIdx !== -1) {
    hostPort = rest.slice(0, slashIdx);
    path = rest.slice(slashIdx);
    if (path === '/') path = '/';
  }

  // 拆 port
  let host = hostPort;
  let port = null;
  const portIdx = hostPort.lastIndexOf(':');
  if (portIdx !== -1) {
    host = hostPort.slice(0, portIdx);
    const portRaw = hostPort.slice(portIdx + 1);
    if (portRaw === '*') {
      port = '*';
    } else if (/^\d+$/.test(portRaw)) {
      const n = Number(portRaw);
      if (n < 1 || n > 65535) {
        return { ok: false, error: { message: `"${raw}" 的端口 ${n} 超出范围 (1-65535)` } };
      }
      port = String(n);
    } else {
      return { ok: false, error: { message: `"${raw}" 的端口 "${portRaw}" 不合法`, hint: '端口应为数字或通配符 *，例如 https://host:8443 或 https://host:*' } };
    }
  }

  if (!host) {
    return { ok: false, error: { message: `"${raw}" 缺少主机名` } };
  }

  // 校验 host：* / *.domain / domain（含 IPv4 与 IPv6 容错）
  let wildcard = false;
  let hostCheck = host;
  if (host === '*') {
    wildcard = true;
  } else if (host.startsWith('*.')) {
    wildcard = true;
    hostCheck = host.slice(2);
  }
  if (host !== '*') {
    if (hostCheck.includes('*')) {
      return { ok: false, error: { message: `"${raw}" 的通配符位置不合法`, hint: '通配符只能单独使用（*）或作为主机名前缀（*.example.com）' } };
    }
    if (!isValidHost(hostCheck)) {
      return { ok: false, error: { message: `"${raw}" 的主机名 "${hostCheck}" 格式不合法`, hint: '主机名只含字母、数字、点和连字符；IPv6 地址请用方括号包裹' } };
    }
  }

  if (path !== null && !path.startsWith('/')) {
    return { ok: false, error: { message: `"${raw}" 的路径必须以 / 开头`, hint: '例如 https://example.com/app/ ' } };
  }

  return {
    ok: true,
    source: {
      kind: 'host',
      scheme,
      host: host === '*' ? '*' : host.toLowerCase(),
      wildcard,
      port,
      path,
      raw: token,
    },
  };
}

function isValidHost(h) {
  if (!h || h.length > 253) return false;
  if (h.startsWith('[') && h.endsWith(']')) return /^\[[0-9a-fA-F:]+\]$/.test(h);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    return h.split('.').every((p) => Number(p) <= 255);
  }
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(h) && !h.includes('..') && !h.startsWith('-') && !h.startsWith('.');
}

/**
 * 规范化 token 字符串（用于比较与稳定输出）。解析失败时返回 null。
 */
export function canonicalToken(raw) {
  const r = parseSourceToken(raw);
  if (!r.ok) return null;
  return canonicalSource(r.source);
}

export function canonicalSource(s) {
  if (s.kind === 'keyword') return `'${s.value}'`;
  if (s.kind === 'nonce') return `'nonce-${s.value}'`;
  if (s.kind === 'hash') return `'${s.algo}-${s.value}'`;
  if (s.kind === 'scheme') return s.scheme;
  // host
  let out = '';
  if (s.scheme) out += `${s.scheme}//`;
  out += s.host;
  if (s.port) out += `:${s.port}`;
  if (s.path) out += s.path;
  return out;
}

/**
 * 安全解析 URL，失败返回 null（绝不抛异常给调用方）。
 */
export function parseUrl(input, base) {
  try {
    const u = base ? new URL(input, base) : new URL(input);
    return {
      href: u.href,
      scheme: u.protocol, // 含冒号，如 https:
      host: u.hostname,
      port: u.port || DEFAULT_PORTS[u.protocol] || '',
      path: u.pathname + u.search,
      origin: u.origin,
      isOpaque: u.origin === 'null',
    };
  } catch {
    return null;
  }
}

/**
 * 判断单个源是否匹配 URL。
 * context: { documentOrigin?: string }
 */
export function sourceMatches(source, urlInfo, context = {}) {
  switch (source.kind) {
    case 'keyword':
      return matchKeyword(source.value, urlInfo, context);
    case 'scheme':
      return urlInfo.scheme === source.scheme;
    case 'host':
      return matchHost(source, urlInfo);
    case 'nonce':
    case 'hash':
      return false; // nonce/hash 只用于内联判定，不匹配外部 URL
    default:
      return false;
  }
}

function matchKeyword(value, urlInfo, context) {
  if (value === 'none') return false;
  if (value === 'self') {
    if (!context.documentOrigin) return false;
    if (urlInfo.scheme === 'blob:' || urlInfo.scheme === 'data:') {
      // blob: 继承创建者源；data: 为不透明源，不视为同源
      if (urlInfo.scheme === 'blob:') {
        const inner = parseUrl(urlInfo.href.slice('blob:'.length));
        return inner ? inner.origin === context.documentOrigin : false;
      }
      return false;
    }
    return urlInfo.origin === context.documentOrigin;
  }
  // unsafe-inline / unsafe-eval / strict-dynamic 等不参与外部 URL 匹配
  return false;
}

function matchHost(source, urlInfo) {
  const { scheme, host, wildcard, port, path } = source;

  // 处理 blob:/data:：主机源按内部源判断 blob
  let effective = urlInfo;
  if (urlInfo.scheme === 'blob:') {
    const inner = parseUrl(urlInfo.href.slice('blob:'.length));
    if (!inner) return false;
    effective = inner;
  } else if (urlInfo.scheme === 'data:') {
    return false; // 主机源不匹配 data:，需要显式 data: 协议源
  }

  if (scheme) {
    if (effective.scheme !== scheme) return false;
  } else if (!HOST_DEFAULT_SCHEMES.has(effective.scheme)) {
    return false;
  }

  // 主机匹配
  if (host !== '*') {
    const urlHost = effective.host.toLowerCase();
    const srcHost = wildcard ? host.slice(2) : host;
    if (wildcard) {
      // *.example.com 只匹配子域，不匹配裸 example.com
      if (!urlHost.endsWith(`.${srcHost}`)) return false;
    } else if (urlHost !== srcHost) {
      return false;
    }
  }

  // 端口匹配
  if (port === '*') {
    // 任意端口
  } else if (port) {
    if (effective.port !== port) return false;
  } else if (DEFAULT_PORTS[effective.scheme] && effective.port !== DEFAULT_PORTS[effective.scheme]) {
    return false; // 源未写端口时，URL 必须使用协议默认端口
  }

  // 路径前缀匹配（规范使用区分大小写的字符串前缀）
  if (path && !effective.path.startsWith(path)) return false;

  return true;
}

/**
 * 源的“宽泛程度”排序值：数值越小越宽泛。供比较与检查使用。
 */
export function breadthRank(source) {
  switch (source.kind) {
    case 'host':
      if (source.host === '*' && !source.scheme && !source.port && !source.path) return 10;
      if (source.host === '*') return 12;
      if (source.wildcard && !source.path) return source.port ? 26 : 24;
      if (source.path) return 40;
      return source.port ? 34 : 30;
    case 'scheme':
      if (source.scheme === 'http:' || source.scheme === 'https:') return 16;
      return 20; // data: blob: 等
    case 'keyword':
      if (source.value === 'self') return 50;
      if (source.value === 'none') return 90;
      return 60;
    case 'nonce':
    case 'hash':
      return 80;
    default:
      return 100;
  }
}

// frame-ancestors 等指令对允许的源类型有限制
export function sourceAllowedForDirective(source, directive) {
  if (NO_DEFAULT_FALLBACK.has(directive)) {
    if (source.kind === 'keyword') {
      if (directive === 'frame-ancestors' && ['self', 'none'].includes(source.value)) return true;
      if (directive !== 'frame-ancestors' && source.value !== 'none') return true;
      return false;
    }
    if (source.kind === 'nonce' || source.kind === 'hash') return false;
  }
  return true;
}
