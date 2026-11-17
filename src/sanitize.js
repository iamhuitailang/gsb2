/**
 * 报告 HTML 的检查与净化。
 *
 * 两层防护：
 * 1. 服务端在这里把报告改写成只含文本/表格/本地图片的安全文档，同时产出一份
 *    “资源检查结果”，告诉用户哪些外部资源被拦下、哪些本地资源缺失。
 * 2. 报告站点对所有响应附加 CSP（script-src 'none'、connect-src 'none'、
 *    frame-src 'none'、form-action 'none'、sandbox …）。即使这里的字符串
 *    处理漏掉某个向量，浏览器也不会执行脚本或自动联网。
 *
 * 这里不做完整的 HTML5 解析，只做保守的标记级重写；无法识别的构造一律丢弃。
 */

import { escapeHtml } from './util.js';

const TRANSPARENT_GIF =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/**
 * 只移除起始标签、保留内部回退内容的元素。它们的结束标签一并丢弃，
 * 避免报告里的 `</video>` 之类残片出现在输出里。
 */
const UNWRAP_ELEMENTS = new Set(['iframe', 'object', 'applet', 'embed', 'video', 'audio']);

/**
 * 允许内嵌的 data: 图片只限光栅格式。`data:image/svg+xml` 能携带标记，
 * 这里直接不接受，避免把可执行的文档当图片嵌入。
 */
const DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp|bmp|avif)[;,]/i;

/** 这些元素的起始标签连同内部内容一起丢弃（结束标签另行忽略）。 */
const DROP_CONTENT = new Set(['script', 'template', 'noscript', 'title']);

/**
 * 文档级标签由库自己负责生成，报告中出现的这些标签一律丢弃，
 * 否则它们会干扰外壳文档结构（例如把 <title> 提到 head 里）。
 */
const DROP_TAGS = new Set(['html', 'head', 'body']);

/**
 * 无论如何都不保留的 URL 类属性。真正需要保留 URL 的元素会先经过各自处理，
 * 再用 safe 标记写回（例如 img 的本地 src），因此这里只拦截未被处理的残留。
 */
const DROP_URL_ATTRS = new Set([
  'ping', 'formaction', 'manifest', 'profile', 'icon', 'codebase', 'archive',
  'classid', 'longdesc', 'usemap', 'cite', 'data', 'action', 'href',
  'src', 'srcset', 'poster', 'background', 'lowsrc', 'dynsrc', 'xlink:href',
]);

const ATTR_RE = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;

/**
 * 可能承载地址的属性。只有这些属性的值需要做 javascript: 判定；
 * 对 alt、title 这类纯文本属性做判定会把正常文字误删。
 */
const URL_ATTRS = new Set([
  ...DROP_URL_ATTRS,
  'data-src', 'data-href', 'data-url', 'lowsrc', 'dynsrc', 'poster', 'background',
]);

/**
 * 手写的线性扫描器：报告是不可信输入，不能用带嵌套量词的正则切标记
 * （长文本上会退化成平方级回溯）。这里的每个字符最多看一遍。
 */
function tokenize(html) {
  const tokens = [];
  const length = html.length;
  let index = 0;
  let textStart = 0;

  const pushText = (end) => {
    if (end > textStart) tokens.push({ type: 'text', raw: html.slice(textStart, end) });
  };

  while (index < length) {
    const lt = html.indexOf('<', index);
    if (lt === -1) break;

    const next = html[lt + 1] ?? '';
    if (next === '!') {
      pushText(lt);
      // 注释、doctype、CDATA：统一当作注释整段丢弃。
      if (html.startsWith('<!--', lt)) {
        const end = html.indexOf('-->', lt + 4);
        const stop = end === -1 ? length : end + 3;
        tokens.push({ type: 'markup', raw: html.slice(lt, stop) });
        index = stop;
      } else {
        const end = html.indexOf('>', lt + 2);
        const stop = end === -1 ? length : end + 1;
        tokens.push({ type: 'markup', raw: html.slice(lt, stop) });
        index = stop;
      }
      textStart = index;
      continue;
    }

    if (next !== '/' && next !== '?' && !/[a-zA-Z]/.test(next)) {
      // 不是标记起始的 `<`，作为普通文本继续（稍后会被转义）。
      index = lt + 1;
      continue;
    }

    // 扫到匹配的 `>`，跳过引号内的内容。
    let cursor = lt + 1;
    let quote = '';
    while (cursor < length) {
      const ch = html[cursor];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      cursor += 1;
    }
    if (cursor >= length) {
      // 未闭合的标记：整体当作文本，交给转义处理。
      break;
    }

    pushText(lt);
    tokens.push({ type: 'markup', raw: html.slice(lt, cursor + 1) });
    index = cursor + 1;
    textStart = index;
  }

  pushText(length);
  return tokens;
}

function parseTag(raw) {
  if (!raw.startsWith('<') || raw.startsWith('<!') || raw.startsWith('<?')) return null;
  const selfClosingBySlash = /\/>$/.test(raw);
  const inner = raw.slice(1, selfClosingBySlash ? -2 : -1).trim();
  const isEnd = inner.startsWith('/');
  const body = isEnd ? inner.slice(1).trim() : inner;
  const nameMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(body);
  if (!nameMatch) return null;
  const rawName = nameMatch[1];
  const nameLower = rawName.toLowerCase();
  const attrs = [];
  if (!isEnd) {
    const rest = body.slice(rawName.length);
    ATTR_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_RE.exec(rest))) {
      attrs.push({ name: m[1], nameLower: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? '' });
    }
  }
  return {
    rawName,
    nameLower,
    isEnd,
    attrs,
    selfClosing: selfClosingBySlash || VOID_ELEMENTS.has(nameLower),
  };
}

/** 把报告里的相对路径归一化，用于和导入时携带的资源做精确匹配。 */
export function normalizeAssetKey(url) {
  let value = String(url).trim();
  value = value.split('#')[0].split('?')[0];
  try {
    value = decodeURIComponent(value);
  } catch {
    // 保留原样
  }
  value = value.replaceAll('\\', '/').replace(/^\.\//, '');
  const parts = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

function parseSrcset(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [url, ...descriptors] = item.split(/\s+/);
      return { url, descriptor: descriptors.join(' ') };
    });
}

function serializeAttrs(attrs) {
  return attrs
    .filter((a) => /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(a.name))
    .map((a) => `${a.name}="${escapeHtml(a.value)}"`)
    .join(' ');
}

function tagHtml(name, attrs) {
  const rendered = serializeAttrs(attrs);
  return `<${name}${rendered ? ` ${rendered}` : ''}>`;
}

/**
 * 构造一个属性。处理阶段会先把 URL 属性取出来判定，再按需写回；
 * 写回时必须补齐 nameLower，后续的通用清理依赖它。
 */
function makeAttr(name, value, safe = false) {
  return { name, nameLower: String(name).toLowerCase(), value, safe };
}

/**
 * 文本里残留的 `<` 只可能来自被截断的伪标签（完整标记已被分词器整体取走）。
 * 统一转义，避免报告末尾出现 `<script` 这类残缺标记被浏览器续接执行。
 */
function escapeStrayAngle(text) {
  return text.replace(/<(?=[a-zA-Z/!])/g, '&lt;');
}

/**
 * 解析 URL 前先把字符实体还原，只用于“判断 scheme”。
 * 浏览器会解码 `javascript&#58;` 这类写法，若不还原就会漏判。
 */
function decodeEntities(value) {
  const fromCodePoint = (code) => {
    // 超出 Unicode 范围的码点在浏览器里被当作 U+FFFD；这里同样兜住，绝不抛异常。
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '�';
    if (code >= 0xd800 && code <= 0xdfff) return '�';
    return String.fromCodePoint(code);
  };
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|colon|tab|newline);/gi, (match, body) => {
    const lower = body.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'colon') return ':';
    if (lower === 'tab') return '\t';
    if (lower === 'newline') return '\n';
    if (lower.startsWith('#x')) return fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return match;
  });
}

/** 判断 URL 的 scheme 时用的归一化探测串：解码实体、去控制字符、转小写。 */
function schemeProbeOf(value) {
  return decodeEntities(value)
    .replace(/[\u0000- \u007f]/g, '')
    .toLowerCase();
}

function isJsUrl(value) {
  const probe = schemeProbeOf(value);
  return probe.startsWith('javascript:') || probe.startsWith('vbscript:');
}

/**
 * @param {object} input
 * @param {string} input.html 供应商报告原文
 * @param {string} input.reportId 报告 ID，用于生成本地资源地址
 * @param {string} input.token 预览凭据；本地资源地址里也带上，避免只凭报告 ID 取图
 * @param {Map<string, {storedName: string, contentType?: string, content?: string}>} input.assets
 * @returns {{ body: string, check: object }}
 */
export function sanitizeReport({ html, reportId, token, assets }) {
  const resources = [];
  const resourceKeys = new Set();
  const removed = {
    scripts: 0,
    inlineHandlers: 0,
    jsUrls: 0,
    forms: 0,
    metaRefreshes: 0,
    frames: 0,
    stylesheets: 0,
    baseTags: 0,
    links: 0,
    comments: 0,
  };

  const record = (kind, status, url) => {
    const key = `${kind}|${status}|${url}`;
    if (resourceKeys.has(key)) return;
    resourceKeys.add(key);
    resources.push({ kind, status, url });
  };

  const normalizeStatus = (status) => (status === 'js' ? 'blocked' : status);

  /** 分类一个引用：本地随附 / 内嵌 data: / 外部 / 本地缺失 / 被阻止 / 片段等。 */
  const resolveUrl = (raw) => {
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (!url) return { status: 'empty', url: '' };
    if (url.startsWith('#')) return { status: 'fragment', url };
    // 控制字符与实体编码都可能被浏览器忽略/解码，判断 scheme 前先归一化。
    const probe = schemeProbeOf(url);
    if (probe.startsWith('javascript:') || probe.startsWith('vbscript:')) {
      return { status: 'js', url: url.slice(0, 64) };
    }
    // data: 的媒体类型也可能被实体编码。只有原文就是干净的光栅图片 data: 才内嵌，
    // 需要解码才能认出来的写法一律按“被阻止”处理（写回时也无法原样保留）。
    if (probe.startsWith('data:')) {
      return DATA_IMAGE_RE.test(url)
        ? { status: 'embedded', url }
        : { status: 'blocked', url: url.slice(0, 64) };
    }
    // 协议相对和任意 scheme 都按外部处理：预览不联网，也不猜测作者意图。
    if (url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/.test(probe)) {
      return { status: 'external', url };
    }
    const asset = assets.get(normalizeAssetKey(url));
    if (asset) return { status: 'local', url, asset };
    return { status: 'missing', url };
  };

  const localHref = (entry) => `/a/${reportId}/${token}/${entry.asset.storedName}`;

  const sanitizeCss = (css) => {
    let output = String(css);
    output = output.replace(/@import\s+(?:url\()?\s*(['"]?)([^'");]+)\1/gi, (match, quote, url) => {
      removed.stylesheets += 1;
      // 记下真正被拦下的地址，而不是整段 @import 语句。
      record('stylesheet', 'external', String(url).trim().slice(0, 200));
      return '';
    });
    output = output.replace(/expression\s*\(/gi, () => {
      removed.jsUrls += 1;
      return 'blocked-expression(';
    });
    for (const pattern of [/behavior\s*:[^;}]*;?/gi, /-moz-binding\s*:[^;}]*;?/gi]) {
      output = output.replace(pattern, () => {
        removed.jsUrls += 1;
        return '';
      });
    }
    output = output.replace(/url\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi, (match, quote, url) => {
      const entry = resolveUrl(url);
      if (entry.status === 'local') {
        record('image', 'local', entry.url);
        return `url("${localHref(entry)}")`;
      }
      if (entry.status === 'embedded') return match;
      if (entry.status === 'fragment' || entry.status === 'empty') return 'none';
      if (entry.status === 'js') removed.jsUrls += 1;
      else record('image', normalizeStatus(entry.status), entry.url);
      return `url("${TRANSPARENT_GIF}")`;
    });
    return output;
  };

  const blockedPlaceholder = (noun, entry) => {
    const reason = entry.status === 'external'
      ? `外部${noun}未载入`
      : entry.status === 'missing'
        ? `本地${noun}缺失`
        : `${noun}已阻止`;
    // 外部地址只出现在资源检查清单里，不写进报告正文，避免正文携带外部链接文本。
    const detail = entry.status === 'missing' && entry.url ? `：${entry.url}` : '';
    return `<span class="gsb2-blocked" data-gsb2-blocked="${escapeHtml(noun)}">${escapeHtml(reason + detail)}</span>`;
  };

  /** 清理通用属性；元素特有的 URL 属性在此之前已处理（标记 safe）。 */
  const cleanAttrs = (attrs) => {
    const kept = [];
    for (const attr of attrs) {
      const lower = attr.nameLower ?? String(attr.name).toLowerCase();
      if (lower.startsWith('on')) {
        removed.inlineHandlers += 1;
        continue;
      }
      if (lower === 'srcdoc') continue;
      if (!attr.safe && DROP_URL_ATTRS.has(lower)) continue;
      let value = attr.value;
      if (lower === 'style') {
        value = sanitizeCss(value);
        if (!value.trim()) continue;
      } else if (URL_ATTRS.has(lower) && isJsUrl(value)) {
        removed.jsUrls += 1;
        continue;
      }
      // 保留 nameLower：后续步骤（例如判断是否还有可加载的 src）还要读它。
      kept.push(makeAttr(attr.name, value, attr.safe));
    }
    return kept;
  };

  const makeAnchor = (attrs) => {
    const hrefName = ['href', 'xlink:href'].find((n) => attrs.some((a) => a.nameLower === n));
    const hrefAttr = hrefName ? attrs.find((a) => a.nameLower === hrefName) : null;
    const filtered = cleanAttrs(attrs.filter((a) => a !== hrefAttr));
    if (!hrefAttr) return filtered;
    const entry = resolveUrl(hrefAttr.value);
    removed.links += 1;
    if (entry.status === 'fragment' || entry.status === 'empty') {
      filtered.push(makeAttr(hrefAttr.name, hrefAttr.value));
    } else if (entry.status === 'js') {
      removed.jsUrls += 1;
    } else {
      record('link', normalizeStatus(entry.status), entry.url);
    }
    return filtered;
  };

  /** 处理一个 URL 属性：本地资源改写成报告站点地址，其余换成占位说明。 */
  const processUrlAttr = (attrs, attrName, kind, noun) => {
    const idx = attrs.findIndex((a) => a.nameLower === attrName);
    if (idx === -1) return { attrs, blocked: null };
    const attr = attrs[idx];
    const entry = resolveUrl(attr.value);
    const rest = attrs.filter((_, i) => i !== idx);
    if (entry.status === 'local') {
      record(kind, 'local', entry.url);
      return { attrs: [...rest, makeAttr(attrName, localHref(entry), true)], blocked: null };
    }
    if (entry.status === 'embedded' && kind === 'image') {
      record(kind, 'embedded', entry.url.slice(0, 64));
      return { attrs: [...rest, makeAttr(attrName, attr.value, true)], blocked: null };
    }
    if (entry.status === 'empty' || entry.status === 'fragment') return { attrs: rest, blocked: null };
    if (entry.status === 'js') {
      removed.jsUrls += 1;
      return { attrs: rest, blocked: null };
    }
    record(kind, normalizeStatus(entry.status), entry.url);
    return { attrs: rest, blocked: blockedPlaceholder(noun, entry) };
  };

  const processSrcset = (attrs, kind, noun) => {
    const idx = attrs.findIndex((a) => a.nameLower === 'srcset');
    if (idx === -1) return { attrs, blocked: null };
    const attr = attrs[idx];
    const rest = attrs.filter((_, i) => i !== idx);
    const output = [];
    let firstBlocked = null;
    for (const item of parseSrcset(attr.value)) {
      const entry = resolveUrl(item.url);
      const descriptor = item.descriptor ? ` ${item.descriptor}` : '';
      if (entry.status === 'local') {
        record(kind, 'local', entry.url);
        output.push(`${localHref(entry)}${descriptor}`);
      } else if (entry.status === 'embedded') {
        record(kind, 'embedded', entry.url.slice(0, 64));
        output.push(`${item.url}${descriptor}`);
      } else if (entry.status === 'js') {
        removed.jsUrls += 1;
      } else if (entry.status !== 'empty' && entry.status !== 'fragment') {
        // 外部/缺失候选只记进检查结果；只要还有可用的本地候选，元素本身照常渲染。
        record(kind, normalizeStatus(entry.status), entry.url);
        if (!firstBlocked) firstBlocked = entry;
      }
    }
    if (output.length) rest.push(makeAttr('srcset', output.join(', '), true));
    return { attrs: rest, blocked: output.length ? null : (firstBlocked ? blockedPlaceholder(noun, firstBlocked) : null) };
  };

  const tokens = tokenize(html);
  const out = [];

  const skipToEnd = (index, name) => {
    for (let j = index + 1; j < tokens.length; j += 1) {
      const token = tokens[j];
      if (token.type !== 'markup') continue;
      const tag = parseTag(token.raw);
      if (tag && tag.isEnd && tag.nameLower === name) return j + 1;
    }
    return tokens.length;
  };

  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];

    if (token.type === 'text') {
      out.push(escapeStrayAngle(token.raw));
      index += 1;
      continue;
    }

    if (token.raw.startsWith('<!')) {
      // 注释、doctype、条件注释一律丢弃，避免藏匿标记。
      removed.comments += 1;
      index += 1;
      continue;
    }

    const tag = parseTag(token.raw);
    if (!tag) { index += 1; continue; }
    const name = tag.nameLower;

    if (tag.isEnd) {
      if (DROP_TAGS.has(name) || name === 'form' || DROP_CONTENT.has(name) || UNWRAP_ELEMENTS.has(name)) {
        index += 1;
        continue;
      }
      // 保留原始大小写：SVG 里有 linearGradient 这类大小写敏感的元素。
      out.push(`</${tag.rawName}>`);
      index += 1;
      continue;
    }

    if (DROP_TAGS.has(name)) { index += 1; continue; }

    if (name === 'style') {
      if (tag.selfClosing) { index += 1; continue; }
      const end = skipToEnd(index, 'style');
      const lastInner = tokens[end - 1]?.raw.startsWith('</') ? end - 1 : end;
      const css = tokens
        .slice(index + 1, lastInner)
        .filter((t) => t.type === 'text')
        .map((t) => t.raw)
        .join('');
      out.push(`<style>${sanitizeCss(css)}</style>`);
      index = end;
      continue;
    }

    if (name === 'script' || name === 'template' || name === 'noscript' || name === 'title') {
      if (name === 'script') {
        removed.scripts += 1;
        const src = tag.attrs.find((a) => a.nameLower === 'src');
        if (src) {
          const entry = resolveUrl(src.value);
          if (entry.status === 'js') removed.jsUrls += 1;
          else if (entry.status !== 'empty') record('script', normalizeStatus(entry.status), entry.url);
        }
      }
      // 整段内容都必须带走；即便起始标签写成自闭合也不能只丢标签，
      // 否则其中的文本会漏进正文。
      const end = skipToEnd(index, name);
      index = end;
      continue;
    }

    if (name === 'base') {
      removed.baseTags += 1;
      index += 1;
      continue;
    }

    if (name === 'meta') {
      const httpEquiv = tag.attrs.find((a) => a.nameLower === 'http-equiv');
      const nameAttr = tag.attrs.find((a) => a.nameLower === 'name');
      const contentAttr = tag.attrs.find((a) => a.nameLower === 'content');
      // 作者声明的外部资源：只进检查清单，绝不加载。
      if (/^(x-)?(gsb2-)?external(-resource)?$/i.test(nameAttr?.value ?? '')
        && contentAttr?.value) {
        record('declared', 'external', contentAttr.value.trim().slice(0, 2000));
      }
      if ((httpEquiv?.value ?? '').toLowerCase() === 'refresh') {
        removed.metaRefreshes += 1;
        // 自动跳转不是“外部资源”，用 blocked 记在检查结果里但不进外部资源清单。
        record('refresh', 'blocked', (contentAttr?.value ?? '').slice(0, 120));
      }
      index += 1;
      continue;
    }

    if (name === 'link') {
      const rel = (tag.attrs.find((a) => a.nameLower === 'rel')?.value ?? '')
        .toLowerCase()
        .split(/\s+/);
      const hrefAttr = tag.attrs.find((a) => a.nameLower === 'href');
      const entry = resolveUrl(hrefAttr?.value ?? '');
      if (rel.includes('stylesheet') && entry.status === 'local' && typeof entry.asset.content === 'string') {
        out.push(`<style>${sanitizeCss(entry.asset.content)}</style>`);
        record('stylesheet', 'local', entry.url);
      } else if (rel.includes('stylesheet')) {
        removed.stylesheets += 1;
        if (entry.status === 'js') removed.jsUrls += 1;
        else if (entry.status !== 'empty') record('stylesheet', normalizeStatus(entry.status), entry.url);
      } else {
        removed.links += 1;
        if (hrefAttr) {
          if (entry.status === 'js') removed.jsUrls += 1;
          else if (entry.status !== 'empty' && entry.status !== 'fragment') {
            record('link', normalizeStatus(entry.status), entry.url);
          }
        }
      }
      index += 1;
      continue;
    }

    if (name === 'iframe' || name === 'object' || name === 'applet') {
      removed.frames += 1;
      const urlAttr = tag.attrs.find((a) => a.nameLower === 'src' || a.nameLower === 'data');
      const entry = resolveUrl(urlAttr?.value ?? '');
      if (entry.status !== 'empty' && entry.status !== 'fragment') {
        if (entry.status === 'js') removed.jsUrls += 1;
        else record('frame', normalizeStatus(entry.status), entry.url);
        out.push(blockedPlaceholder('框架', entry));
      }
      // 起始标签去掉后，框架内的回退文本会作为普通文字保留；
      // 它不携带任何可执行能力，也不会发起请求。
      index += 1;
      continue;
    }

    if (name === 'embed') {
      removed.frames += 1;
      const entry = resolveUrl(tag.attrs.find((a) => a.nameLower === 'src')?.value ?? '');
      if (entry.status !== 'empty' && entry.status !== 'fragment') {
        if (entry.status === 'js') removed.jsUrls += 1;
        else record('frame', normalizeStatus(entry.status), entry.url);
        out.push(blockedPlaceholder('框架', entry));
      }
      index += 1;
      continue;
    }

    if (name === 'form') {
      // 表单标签移除，但内部只读文本保留（例如说明文字）。
      removed.forms += 1;
      const action = tag.attrs.find((a) => a.nameLower === 'action');
      if (action) {
        const entry = resolveUrl(action.value);
        if (entry.status === 'js') removed.jsUrls += 1;
        else if (entry.status !== 'empty') record('form', normalizeStatus(entry.status), entry.url);
      }
      index += 1;
      continue;
    }

    if (name === 'input') {
      // 表单控件在预览里没有用途，一律去掉；只把 type=image 的图片记进检查结果。
      if ((tag.attrs.find((a) => a.nameLower === 'type')?.value ?? '').toLowerCase() === 'image') {
        const src = tag.attrs.find((a) => a.nameLower === 'src');
        if (src) {
          const entry = resolveUrl(src.value);
          if (entry.status === 'js') removed.jsUrls += 1;
          else if (entry.status !== 'empty' && entry.status !== 'fragment') {
            record('image', normalizeStatus(entry.status), entry.url);
          }
        }
      }
      index += 1;
      continue;
    }

    if (name === 'img' || name === 'image' || name === 'video' || name === 'audio'
      || name === 'source' || name === 'track') {
      const isMedia = name === 'video' || name === 'audio' || name === 'source' || name === 'track';
      const kind = isMedia ? 'media' : 'image';
      const noun = isMedia ? '媒体' : '图片';
      let attrs = tag.attrs;
      let blocked = null;
      // SVG 的 <image> 用 href/xlink:href 引用图片，也要走同一套判定。
      for (const attrName of ['src', 'href', 'xlink:href', 'poster']) {
        const result = processUrlAttr(attrs, attrName, kind, noun);
        attrs = result.attrs;
        if (result.blocked) blocked = result.blocked;
      }
      const srcset = processSrcset(attrs, kind, noun);
      attrs = srcset.attrs;
      if (srcset.blocked) blocked = srcset.blocked;
      attrs = cleanAttrs(attrs);

      // 只要还留着可加载的本地地址（src/srcset/href），就不需要用占位符替换元素。
      const hasRenderable = attrs.some((a) => ['src', 'srcset', 'href', 'xlink:href']
        .includes(a.nameLower));
      if (blocked && !hasRenderable) {
        // SVG 里放不了 HTML 占位符，直接丢弃该引用元素。
        if (name !== 'image') out.push(blocked);
        index += 1;
        continue;
      }
      out.push(tagHtml(tag.rawName, attrs));
      index += 1;
      continue;
    }

    if (name === 'a') {
      out.push(tagHtml('a', makeAnchor(tag.attrs)));
      index += 1;
      continue;
    }

    if (name === 'use' || name === 'feimage') {
      const hrefAttr = tag.attrs.find((a) => a.nameLower === 'href' || a.nameLower === 'xlink:href');
      const entry = hrefAttr ? resolveUrl(hrefAttr.value) : { status: 'empty', url: '' };
      const rest = hrefAttr ? tag.attrs.filter((a) => a !== hrefAttr) : tag.attrs;
      if (hrefAttr && entry.status === 'local') {
        record('image', 'local', entry.url);
        out.push(tagHtml(tag.rawName, cleanAttrs([
          ...rest,
          makeAttr(hrefAttr.name, localHref(entry), true),
        ])));
        index += 1;
        continue;
      }
      if (hrefAttr && (entry.status === 'fragment' || entry.status === 'empty')) {
        // 文档内引用（例如 #icon）不联网，保留原值。
        out.push(tagHtml(tag.rawName, cleanAttrs([
          ...rest,
          makeAttr(hrefAttr.name, hrefAttr.value, true),
        ])));
        index += 1;
        continue;
      }
      if (hrefAttr) {
        // SVG 引用无法用占位符表达，直接丢弃整个元素。
        if (entry.status === 'js') removed.jsUrls += 1;
        else record('image', normalizeStatus(entry.status), entry.url);
        index += 1;
        continue;
      }
      out.push(tagHtml(tag.rawName, cleanAttrs(tag.attrs)));
      index += 1;
      continue;
    }

    const background = tag.attrs.find((a) => a.nameLower === 'background');
    if (background) {
      const result = processUrlAttr(tag.attrs, 'background', 'image', '背景图片');
      if (result.blocked) out.push(result.blocked);
      out.push(tagHtml(tag.rawName, cleanAttrs(result.attrs)));
      index += 1;
      continue;
    }

    // 其余元素保留原始大小写：SVG 里 linearGradient 这类名称大小写敏感。
    out.push(tagHtml(tag.rawName, cleanAttrs(tag.attrs)));
    index += 1;
  }

  const summary = {
    loaded: resources.filter((r) => r.status === 'local' || r.status === 'embedded').length,
    notLoaded: resources.filter((r) => r.status !== 'local' && r.status !== 'embedded').length,
    external: resources.filter((r) => r.status === 'external').length,
    missing: resources.filter((r) => r.status === 'missing').length,
    blocked: resources.filter((r) => r.status === 'blocked').length,
  };

  return { body: out.join(''), check: { resources, summary, removed } };
}
