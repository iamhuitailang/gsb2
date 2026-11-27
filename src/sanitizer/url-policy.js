// 地址安全策略:所有链接(href)与资源地址(src/poster 等)统一在这里判定。
// 设计原则——
//  1. 判定前先做与浏览器一致的预处理:剥离控制字符与空白、解码一遍实体;
//  2. 协议白名单制,任何不在白名单内的 scheme(含 javascript:/vbscript:/
//     data: 非图片/blob:/filesystem: 等)一律拒绝;
//  3. 预览运行在 default-src 'none' 的隔离帧中,网络资源本就无法加载,
//     这里再做一次应用层拦截,被拒地址同时从标记中改写掉;
//  4. 不依赖任何在线服务,也不维护真实域名名单。

import { decodeEntities } from './entities.js';

// C0/C1 控制字符、BOM、零宽字符、软连字符等——浏览器取 URL 时会忽略
// 其中部分字符,这里统一剥离,防止 "java\tscript:" 式插空白/控制符绕过
const STRIP_CHARS = new Set([
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, // 制表/换行等
  0x0020,                                  // 普通空格
  0x00ad,                                  // 软连字符
  0x061c,                                  // ARABIC LETTER MARK
  0x180e,                                  // MONGOLIAN VOWEL SEPARATOR
  0x200b, 0x200c, 0x200d, 0x2060,          // 零宽系列
  0xfeff                                   // BOM
]);

function stripObfuscationChars(s) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f) ||
        STRIP_CHARS.has(cp)) {
      continue;
    }
    out += ch;
  }
  return out;
}

// 归一化:模拟浏览器取 URL 时对空白/控制字符的剥离,
// 使 "java\tscript:alert(1)" 这类插入空白的混淆无法绕过 scheme 判断。
export function normalizeUrl(raw) {
  const decoded = decodeEntities(String(raw ?? ''));
  return stripObfuscationChars(decoded).trim();
}

const SAFE_IMAGE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'image/avif', 'image/bmp', 'image/x-icon'
]);

function splitScheme(url) {
  // scheme 首字符为字母,其后为字母/数字/+/-/.;冒号前结束
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  return m ? { scheme: m[1].toLowerCase(), rest: url.slice(m[0].length) } : null;
}

// 仅允许图片类 data: URI,且必须是 base64;SVG(可带脚本)、HTML、
// text/script 等类型全部拒绝。
function inspectDataUri(rest, url) {
  const comma = rest.indexOf(',');
  if (comma === -1) return { ok: false, url, reason: 'data-uri-malformed' };
  const meta = rest.slice(0, comma).toLowerCase();
  const payload = rest.slice(comma + 1);
  const isBase64 = /(?:^|;)base64$/.test(meta);
  const mimeMatch = /^([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*)/.exec(meta);
  const mime = mimeMatch ? mimeMatch[1] : 'text/plain'; // 缺省类型按 text/plain
  if (!SAFE_IMAGE_TYPES.has(mime)) {
    return { ok: false, url, reason: 'data-uri-type-not-allowed', mime };
  }
  if (!isBase64) {
    return { ok: false, url, reason: 'data-uri-must-be-base64', mime };
  }
  // base64 字符集校验,防止参数区夹带内容
  if (!/^[a-z0-9+/=\s]+$/i.test(payload)) {
    return { ok: false, url, reason: 'data-uri-bad-payload', mime };
  }
  return { ok: true, url, scheme: 'data' };
}

// context: 'href' 用于超链接(允许页内锚点),'resource' 用于会发起请求的地址
// preDecoded: 调用方已完成实体解码时传 true,避免重复解码
export function evaluateUrl(rawValue, context = 'resource', preDecoded = false) {
  const url = preDecoded
    ? stripObfuscationChars(String(rawValue ?? '')).trim()
    : normalizeUrl(rawValue);
  if (!url) {
    return { ok: false, url, reason: 'empty-url' };
  }

  // 协议相对地址 //evil.example/x —— 必然发起外站请求,拒绝
  if (url.startsWith('//')) {
    return { ok: false, url, reason: 'protocol-relative-url' };
  }
  // 反斜杠伪装:浏览器对 / 与 \ 在 URL 层级有兼容处理,
  // 含反斜杠的地址一律拒绝,避免绕过 scheme/来源判断
  if (url.startsWith('\\') || url.includes('\\')) {
    return { ok: false, url, reason: 'backslash-obfuscation' };
  }

  // 页内锚点:不发起任何请求、不导航出帧,仅在 href 上下文允许
  if (url.startsWith('#')) {
    return context === 'href'
      ? { ok: true, url, scheme: 'fragment' }
      : { ok: false, url, reason: 'fragment-not-allowed-as-resource' };
  }
  // 纯相对路径:预览帧 default-src 'none' 下无法加载,统一拒绝并报告,
  // 避免用户误以为图片等资源会显示,也杜绝未来放开 CSP 时的外连隐患
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../') ||
      !url.includes(':')) {
    return { ok: false, url, reason: context === 'href'
      ? 'relative-link-not-resolvable-in-sandbox'
      : 'relative-resource-blocked' };
  }

  const parsed = splitScheme(url);
  if (!parsed) {
    return { ok: false, url, reason: 'unparseable-url' };
  }
  const { scheme, rest } = parsed;

  switch (scheme) {
    case 'http':
    case 'https':
      // 隔离帧 CSP 禁止一切外联;应用层同步拒绝,保证清理结果自带安全性
      return { ok: false, url, reason: 'network-request-blocked-by-policy', scheme };
    case 'data':
      return inspectDataUri(rest, url);
    case 'javascript':
    case 'vbscript':
    case 'jscript':
    case 'livescript':
      return { ok: false, url, reason: 'script-scheme', scheme };
    case 'blob':
    case 'filesystem':
      return { ok: false, url, reason: `${scheme}-uri-not-allowed`, scheme };
    default:
      // 白名单之外的一切 scheme 拒绝(含 file:、about:、mailto:、tel:、
      // 自定义协议等),避免弹窗/拉起外部程序等副作用
      return { ok: false, url, reason: 'scheme-not-allowed', scheme };
  }
}
