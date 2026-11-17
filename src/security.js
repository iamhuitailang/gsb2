/**
 * 三类站点使用不同的响应头集合。
 *
 * 核心不变量：
 * - 报告正文（/r/<id>/<token>/content）只有一份响应、一套最严格策略。
 *   列表预览与独立预览都加载这个地址，所以隔离规则不可能不一致。
 * - 报告外壳只承载“库的 UI”，不承载报告内容；它允许自己的 /shell.js，
 *   但不允许任何外部连接。
 * - 业务站点不允许自己被嵌套，只允许把隔离报告站点嵌进预览区域。
 *
 * 注意：CSP 里同一指令重复出现时浏览器采用第一条，因此下面每个策略都只
 * 声明一次每条指令。
 */

export function reportContentHeaders(config) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      // 显式写出报告源：CSP sandbox 会把文档变成不透明源，此时 'self' 不可靠。
      `img-src ${config.origins.report} data:`,
      `media-src ${config.origins.report}`,
      "script-src 'none'",
      "font-src 'none'",
      "connect-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      // 正文会被业务页（列表预览）与报告外壳（独立预览）同时嵌入。
      `frame-ancestors ${config.origins.business} ${config.origins.report}`,
      // 不透明源 + 禁用脚本：即使净化漏掉某个向量，浏览器也不会执行。
      'sandbox',
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy':
      'accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  };
}

export function reportShellHeaders(config) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `img-src ${config.origins.report} data:`,
      `media-src ${config.origins.report}`,
      // 外壳自己的脚本只从报告源加载；报告内容里的脚本另有响应头禁止。
      "script-src 'self'",
      "font-src 'none'",
      "connect-src 'none'",
      "object-src 'none'",
      `frame-src ${config.origins.report}`,
      "worker-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      `frame-ancestors ${config.origins.business} ${config.origins.report}`,
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy':
      'accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  };
}

export function reportAssetHeaders(contentType) {
  const safeType = /^image\/[a-z0-9.+-]+$/i.test(String(contentType))
    ? contentType
    : 'application/octet-stream';
  return {
    'Content-Type': safeType,
    'Content-Security-Policy': "default-src 'none'; script-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  };
}

export function businessHeaders(config) {
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      // 业务页只允许嵌入隔离报告站点，绝不反过来。
      `frame-src ${config.origins.report}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  };
}

/**
 * 业务 API 的跨站检查：报告页是另一个源，拿不到 SameSite=Lax 的会话 cookie；
 * 即便拿到了，也会在这里被拒绝并记录。
 */
export function crossSiteReason(req, config) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return `sec-fetch-site:${site}`;
  const origin = req.headers.origin;
  if (origin && origin !== config.origins.business) return `origin:${origin}`;
  return null;
}
