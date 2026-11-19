'use strict';
// HTML 工具:文本转义 + 报告资源引用提取。
// 用户导入的标题、文件名一律经 escapeHtml 后按纯文本展示。

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TAG_KIND = {
  img: 'image', script: 'script', link: 'stylesheet', iframe: 'iframe',
  source: 'media', video: 'media', audio: 'media', embed: 'embed', object: 'embed',
};

/**
 * 从报告 HTML 中提取资源引用(src/href)。
 * 返回 { resources: [{ tag, kind, url }], inlineScripts: 内联脚本段数 }。
 */
function extractResources(html) {
  const resources = [];
  const tagRe = /<(img|script|link|iframe|source|video|audio|embed|object)\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrRe = tag === 'link' ? /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i
                                  : /\b(?:src|data)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;
    const a = attrRe.exec(m[0]);
    if (!a) continue;
    const url = a[2] ?? a[3] ?? a[4] ?? '';
    if (url) resources.push({ tag, kind: TAG_KIND[tag], url });
  }
  const inlineScripts = (html.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi) || []).length;
  return { resources, inlineScripts };
}

/**
 * 资源 URL 分类:
 *  local      相对路径,随报告一同入库,预览时由隔离源提供
 *  external   绝对 http(s)/协议相对地址,预览时不联网载入,列入检查结果
 *  inline     data: 内联数据
 *  script-url javascript: 伪协议
 */
function classifyUrl(url) {
  const u = url.trim();
  if (/^https?:\/\//i.test(u) || /^\/\//.test(u)) return 'external';
  if (/^data:/i.test(u)) return 'inline';
  if (/^javascript:/i.test(u)) return 'script-url';
  if (/^(#|mailto:|tel:)/i.test(u)) return 'inline';
  return 'local';
}

/** 汇总一份报告的检查结果,供业务页展示。 */
function buildCheckResult(html) {
  const { resources, inlineScripts } = extractResources(html);
  const check = { local: [], external: [], inline: [], scriptUrls: [], inlineScripts };
  for (const r of resources) {
    const cls = classifyUrl(r.url);
    if (cls === 'local') check.local.push(r);
    else if (cls === 'external') {
      check.external.push(r);
      if (r.kind === 'script') check.scriptUrls.push(r);
    } else if (cls === 'script-url') check.scriptUrls.push(r);
    else check.inline.push(r);
  }
  return check;
}

module.exports = { escapeHtml, extractResources, classifyUrl, buildCheckResult };
